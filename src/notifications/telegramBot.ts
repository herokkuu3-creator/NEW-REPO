import { config } from '../config';
import { logger } from '../logger';
import { sendTelegramMessage } from './telegram';
import { getAllSystemState, latestRun } from '../database/models';
import { applySessionRenewal } from '../browser/sessionRenewal';
import { triggerRun } from '../scheduler/dailyWorker';

/**
 * Telegram command bot — the interactive half of session renewal.
 *
 * Long polling (getUpdates), so it needs NO public webhook setup and works
 * on Render's free web service as-is. Commands:
 *
 *   /renew   — step-by-step instructions, then paste/upload the cookies
 *   /status  — auth state + last run
 *   /help    — command list
 *   /cancel  — abort a renewal in progress
 *
 * Security: messages from ANY chat other than TELEGRAM_CHAT_ID are ignored —
 * the bot token is semi-public (anyone can message the bot), the chat ID is
 * the access control. Cookie payloads are validated against LeetCode before
 * anything is stored, and are never logged or echoed back.
 *
 * Large exports: Telegram splits pasted text at ~4096 characters, which
 * corrupts JSON — so Cookie-Editor exports can also be sent as .txt/.json
 * FILE attachments (handled via getFile + download).
 */

const POLL_TIMEOUT_S = 25;
const MAX_DOC_BYTES = 1_000_000;

interface TgDocument {
  file_id: string;
  file_name?: string;
  file_size?: number;
  mime_type?: string;
}

interface TgMessage {
  message_id: number;
  chat: { id: number | string };
  text?: string;
  document?: TgDocument;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

const HELP_TEXT = [
  '🤖 LeetCode Daily Agent',
  '',
  '/renew — refresh an expired LeetCode session (cookies from your own browser)',
  '/status — auth state + last run',
  '/cancel — abort a renewal in progress',
  '/help — this message',
].join('\n');

const RENEW_INSTRUCTIONS = [
  '🔄 LeetCode session renewal (~2 minutes)',
  '',
  'The reliable way — sign in from YOUR OWN browser (Cloudflare trusts it, unlike the server):',
  '',
  'On any computer (Windows/Mac/Linux) OR an Android phone with the Termux app:',
  '',
  '1. Get the repo:  git clone <your-repo-url> && cd NEW-REPO',
  '2. Install:  npm install && npx playwright install chromium',
  '3. Run the capture:',
  '   AGENT_URL=https://<your-service>.onrender.com SETUP_TOKEN=<your-token> npm run capture',
  '',
  'A normal Chrome window opens on the LeetCode sign-in page. Sign in like always — any "verify you are human" check is yours to complete, it is your own browser. The script detects the sign-in by itself, uploads the session to the service, and today\'s run starts automatically. Nothing to copy or paste.',
  '',
  'Alternative: paste cookies here — LEETCODE_SESSION=...; csrftoken=..., a Cookie-Editor export, or a storageState JSON (long ones as a .txt/.json file) — and I will validate them.',
  '',
  '/status — current state · /cancel — nothing pending is ever held',
].join('\n');

export function startTelegramBot(): () => void {
  if (!config.telegram.enabled || !config.telegram.commands) {
    logger.info('telegram command bot disabled (set TELEGRAM_BOT_TOKEN/CHAT_ID, TELEGRAM_COMMANDS=true)');
    return () => undefined;
  }

  let stopped = false;

  void (async () => {
    // A leftover webhook makes getUpdates fail with HTTP 409 — drop it once.
    await tgApi('deleteWebhook', { drop_pending_updates: true }).catch((err) =>
      logger.warn({ err: errText(err) }, 'telegram deleteWebhook failed — continuing anyway'),
    );
    logger.info('telegram command bot polling started (/renew, /status, /help)');

    let offset = 0;
    while (!stopped) {
      try {
        const updates = await tgApi<TgUpdate[]>(
          'getUpdates',
          { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message'] },
          (POLL_TIMEOUT_S + 15) * 1000,
        );
        for (const update of updates) {
          offset = update.update_id + 1;
          if (update.message) {
            await handleMessage(update.message).catch((err) =>
              logger.warn({ err: errText(err) }, 'telegram message handling failed'),
            );
          }
        }
      } catch (err) {
        if (stopped) break;
        logger.warn({ err: errText(err) }, 'telegram polling error — retrying in 5s');
        await sleep(5_000);
      }
    }
  })();

  return () => {
    stopped = true;
  };
}

async function handleMessage(msg: TgMessage): Promise<void> {
  // Access control: one allowed chat only.
  if (String(msg.chat.id) !== config.telegram.chatId) {
    logger.warn('telegram: ignored a message from an unknown chat');
    return;
  }

  const text = (msg.text ?? '').trim();
  if (text.startsWith('/')) {
    const cmd = text.split(/[\s@]+/)[0]?.toLowerCase();
    switch (cmd) {
      case '/start':
      case '/help':
        await reply(HELP_TEXT);
        return;
      case '/renew':
        await reply(RENEW_INSTRUCTIONS);
        return;
      case '/status':
        await reply(await statusText());
        return;
      case '/cancel':
        await reply('Nothing is pending on my side — whenever you are ready, send /renew and then the cookies.');
        return;
      default:
        await reply('Unknown command. Available: /renew, /status, /cancel, /help');
        return;
    }
  }

  // Non-command message: a cookie payload (pasted text or an uploaded file).
  let payload = text;
  if (!payload && msg.document) {
    payload = await downloadDocument(msg.document);
  }
  if (!payload) {
    await reply('Send /renew to refresh the LeetCode session, or /status for the current state.');
    return;
  }
  if (!looksLikeCookiePayload(payload)) {
    await reply('That does not look like cookies — send /renew for the step-by-step instructions.');
    return;
  }

  await reply('⏳ Validating the new session with LeetCode…');
  const result = await applySessionRenewal(payload);

  if (!result.ok) {
    await reply(`❌ Renewal failed\n\n${result.error}\n\nSend /renew to see the steps again.`);
    return;
  }

  // Session restored — immediately recover today's run if it failed/was skipped.
  const trigger = await triggerRun('session-renewal');
  const followUp = trigger.started
    ? "Today's challenge run is starting now — I will report the result here."
    : `Today's run was not started: ${trigger.message}`;
  await reply(
    `✅ Session renewed — signed in as ${result.username} (${result.cookieCount} cookies, ${result.format}).\n\n${followUp}`,
  );
}

async function statusText(): Promise<string> {
  const [sys, last] = await Promise.all([getAllSystemState(), latestRun()]);
  const lines = [
    '📊 Agent status',
    '',
    `Auth: ${sys['authStatus'] ?? 'unknown'}${sys['authUsername'] ? ` (${sys['authUsername']})` : ''}`,
  ];
  if (last) {
    lines.push(
      `Last run: ${last.date} · ${last.title} · ${last.state}${last.submissionStatus ? ` (${last.submissionStatus})` : ''}`,
    );
  } else {
    lines.push('Last run: none yet');
  }
  if (sys['lastError']) lines.push(`Last error: ${sys['lastError'].slice(0, 300)}`);
  return lines.join('\n');
}

function looksLikeCookiePayload(text: string): boolean {
  const t = text.trim();
  return (
    t.includes('LEETCODE_SESSION') ||
    t.includes('csrftoken') ||
    t.startsWith('{') ||
    t.startsWith('[')
  );
}

async function downloadDocument(doc: TgDocument): Promise<string> {
  if (doc.file_size && doc.file_size > MAX_DOC_BYTES) {
    throw new Error('file too large');
  }
  const file = await tgApi<{ file_path?: string }>('getFile', { file_id: doc.file_id });
  if (!file.file_path) throw new Error('telegram returned no file path for the document');
  const res = await fetch(
    `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!res.ok) throw new Error(`telegram file download failed: HTTP ${res.status}`);
  return res.text();
}

async function reply(text: string): Promise<void> {
  await sendTelegramMessage(text);
}

async function tgApi<T = unknown>(
  method: string,
  body: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!res.ok || !json.ok) {
    throw new Error(`telegram ${method} failed: HTTP ${res.status} ${json.description ?? ''}`.trim());
  }
  return json.result as T;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}