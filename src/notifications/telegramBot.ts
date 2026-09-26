import { config } from '../config';
import { logger } from '../logger';
import { sendTelegramMessage } from './telegram';
import { getAllSystemState, latestRun } from '../database/models';
import { applySessionRenewal } from '../browser/sessionRenewal';
import { triggerRun } from '../scheduler/dailyWorker';

/**
 * Telegram command bot â€” the interactive half of session renewal.
 *
 * Long polling (getUpdates), so it needs NO public webhook setup and works
 * on Render's free web service as-is. Commands:
 *
 *   /renew   â€” step-by-step instructions, then paste/upload the cookies
 *   /status  â€” auth state + last run
 *   /help    â€” command list
 *   /cancel  â€” abort a renewal in progress
 *
 * Security: messages from ANY chat other than TELEGRAM_CHAT_ID are ignored â€”
 * the bot token is semi-public (anyone can message the bot), the chat ID is
 * the access control. Cookie payloads are validated against LeetCode before
 * anything is stored, and are never logged or echoed back.
 *
 * Large exports: Telegram splits pasted text at ~4096 characters, which
 * corrupts JSON â€” so Cookie-Editor exports can also be sent as .txt/.json
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
  'LeetCode Daily Agent',
  '',
  '/renew - refresh an expired LeetCode session (cookies from your own browser)',
  '/status - show authentication status and the last run',
  '/cancel - cancel a renewal in progress',
  '/help - show this message',
].join('\n');

const RENEW_INSTRUCTIONS = [
  'LeetCode session renewal: Android only',
  '',
  'No computer is required.',
  '',
  '1. Open Lemur Browser on your Android phone.',
  '2. Open https://leetcode.com/ and sign in normally.',
  '3. Open the LeetCode Session Capture extension.',
  '4. Tap the capture button.',
  '5. Save or download leetcode-session.json.',
  '6. Send leetcode-session.json to this Telegram bot as a document.',
  '',
  'I will validate the session with LeetCode before replacing the stored session. If valid, I save it and start today\'s run automatically.',
  ].join('\n');

export function startTelegramBot(): () => void {
  if (!config.telegram.enabled || !config.telegram.commands) {
    logger.info('telegram command bot disabled (set TELEGRAM_BOT_TOKEN/CHAT_ID, TELEGRAM_COMMANDS=true)');
    return () => undefined;
  }

  let stopped = false;

  void (async () => {
    // A leftover webhook makes getUpdates fail with HTTP 409 â€” drop it once.
    await tgApi('deleteWebhook', { drop_pending_updates: true }).catch((err) =>
      logger.warn({ err: errText(err) }, 'Telegram deleteWebhook failed - continuing anyway'),
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
        logger.warn({ err: errText(err) }, 'Telegram polling error - retrying in 5 seconds');
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
        await reply('No renewal is currently in progress. When you are ready, send /renew and then the cookies.');
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
    await reply('That does not look like a cookie export. Send /renew for step-by-step instructions.');
    return;
  }

  await reply('Validating the new session with LeetCode...');
  const result = await applySessionRenewal(payload);

  if (!result.ok) {
    await reply(`Session renewal failed.\n\n${result.error}\n\nSend /renew to see the steps again.`);
    return;
  }

  // Session restored â€” immediately recover today's run if it failed/was skipped.
  const trigger = await triggerRun('session-renewal');
  const followUp = trigger.started
    ? "Today's challenge run is starting now. I will report the result here."
    : `Today's run was not started: ${trigger.message}`;
  await reply(
    `Session renewed. Signed in as ${result.username} (${result.cookieCount} cookies, ${result.format}).\n\n${followUp}`,
  );
}

async function statusText(): Promise<string> {
  const [sys, last] = await Promise.all([getAllSystemState(), latestRun()]);
  const lines = [
    'Agent status',
    '',
    `Auth: ${sys['authStatus'] ?? 'unknown'}${sys['authUsername'] ? ` (${sys['authUsername']})` : ''}`,
  ];
  if (last) {
    lines.push(
      `Last run: ${last.date} - ${last.title} - ${last.state}${last.submissionStatus ? ` (${last.submissionStatus})` : ''}`,
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
