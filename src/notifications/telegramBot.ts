import { AccountStatus } from '@prisma/client';
import { config } from '../config';
import { logger } from '../logger';
import { sendTelegramMessage } from './telegram';
import { getAllSystemState, latestRun } from '../database/models';
import { listAccounts } from '../database/accounts';
import { describeIngest, ingestCookiePayload, Validator } from '../accounts/ingest';
import { ACCOUNT_LABEL_RE } from '../browser/sessionIdentity';
import {
  isRunInProgress,
  runSubmissionNow,
  triggerRun,
  TRIGGER_SUBMISSION_REASON,
} from '../scheduler/dailyWorker';
import { formatAccountMessage, summarizeReport } from '../scheduler/report';

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
 * the access control. Cookie payloads are parsed and stored immediately; live
 * LeetCode validation is deferred to the daily run. Cookie values are never
 * logged or echoed back.
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
  'Just send cookie .json files (one per account) — each file is added as an account named after its LeetCode username; a file for a user that already exists overrides that account.',
  '',
  '/renew - how to capture the cookie file on Android',
  '/renew <label> - store the NEXT file under this exact label',
  '/accounts - list every account with its cookie status',
  '/triggersubmission - submit today\'s daily question again for ALL accounts (one reply per account)',
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
  '6. Send the .json file to this Telegram bot as a document.',
  '',
  'Multiple accounts: send one .json file per account, one after another. Each file is stored immediately (a new user = new account, a known user = cookies overridden), then checked with LeetCode. Once the uploads stop, today\'s run starts for all accounts.',
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
      case '/renew': {
        const arg = text.split(/[\s@]+/).slice(1).join(' ').trim();
        if (!arg) {
          pendingRenewalLabel = undefined;
          await reply(RENEW_INSTRUCTIONS);
          return;
        }
        if (!ACCOUNT_LABEL_RE.test(arg)) {
          await reply('Labels may contain letters, digits, dot, dash and underscore (max 32 characters). Try again, e.g. /renew main');
          return;
        }
        pendingRenewalLabel = arg;
        await reply(`Renewing the "${arg}" account. Send its cookie export (text or file) in your next message. /cancel aborts.`);
        return;
      }
      case '/accounts':
        await reply(await accountsText());
        return;
      case '/status':
        await reply(await statusText());
        return;
      case '/triggersubmission':
      case '/trigger_submission':
        await handleTriggerSubmission();
        return;
      case '/cancel':
        pendingRenewalLabel = undefined;
        await reply('No renewal is in progress. When you are ready, send /renew (or /renew <label>) and then the cookies.');
        return;
      default:
        await reply('Unknown command. Available: /renew, /renew <label>, /accounts, /status, /triggersubmission, /cancel, /help');
        return;
    }
  }

  // Non-command message: a cookie payload (pasted text or an uploaded .json/.txt file).
  let payload = text;
  let fileName: string | undefined;
  if (msg.document) {
    fileName = msg.document.file_name;
    payload = await downloadDocument(msg.document);
  }
  if (!payload) {
    await reply('Send a cookie .json file (or paste the cookies) to add an account. /accounts lists them.');
    return;
  }
  const result = await processCookieMessage(payload, {
    label: pendingRenewalLabel,
    fileName,
  });
  pendingRenewalLabel = undefined;
  await reply(result.text);
  if (result.stored) scheduleBatchRun();
}

export interface CookieMessageResult {
  /** true when the cookies were stored (added or overridden). */
  stored: boolean;
  text: string;
}

/**
 * Handles one cookie message (file or text) — exported for tests. Every
 * message is ingested independently, so sending several files in a row adds
 * one account per LeetCode user, and a file for an already-known user
 * overrides that account's cookies.
 */
export async function processCookieMessage(
  payload: string,
  opts: { label?: string; fileName?: string; validator?: Validator } = {},
): Promise<CookieMessageResult> {
  if (!looksLikeCookiePayload(payload)) {
    return {
      stored: false,
      text: 'That does not look like a cookie export. Send the .json file from the capture extension (or /help).',
    };
  }
  const result = await ingestCookiePayload(payload, opts);
  if (!result.ok) {
    return { stored: false, text: `${opts.fileName ? `${opts.fileName}: ` : ''}${describeIngest(result)}` };
  }
  const total = (await listAccounts()).length;
  return {
    stored: true,
    text: `${opts.fileName ? `${opts.fileName}\n` : ''}${describeIngest(result)}\n\nAccounts stored: ${total}. Send more files to add more — /accounts lists them.`,
  };
}

/**
 * Several files usually arrive back-to-back: wait until the uploads go quiet,
 * then run the daily challenge ONCE for all accounts (instead of one run per
 * file, which the in-progress guard would mostly reject anyway).
 */
const BATCH_RUN_DELAY_MS = 30_000;
let batchRunTimer: NodeJS.Timeout | undefined;

function scheduleBatchRun(): void {
  if (batchRunTimer) clearTimeout(batchRunTimer);
  batchRunTimer = setTimeout(() => {
    batchRunTimer = undefined;
    void (async () => {
      const trigger = await triggerRun('session-renewal');
      await reply(
        trigger.started
          ? "Uploads received. Running today's challenge for all accounts now — the report follows here."
          : `Today's run was not started: ${trigger.message}`,
      );
    })().catch((err) => logger.warn({ err: errText(err) }, 'batch run trigger failed'));
  }, BATCH_RUN_DELAY_MS);
}

/**
 * /triggersubmission — re-submits today's daily question for every account.
 * Replies once when starting, then ONE message per account as soon as that
 * account finishes; the usual aggregated report follows at the end.
 *
 * The run is started in the background so the bot keeps answering other
 * commands (/status etc.) while the submissions are in progress.
 */
export async function handleTriggerSubmission(
  runner: typeof runSubmissionNow = runSubmissionNow,
  inProgress: () => boolean = isRunInProgress,
): Promise<{ done: Promise<void> } | null> {
  if (inProgress()) {
    await reply('A run is already in progress — wait for its report, then send /triggersubmission again.');
    return null;
  }
  await reply("Submitting today's daily question for all accounts — you'll get one message per account.");
  const done = (async () => {
    const report = await runner(TRIGGER_SUBMISSION_REASON, {
      onAccountOutcome: (outcome, index, total) => reply(formatAccountMessage(outcome, index, total)),
    });
    if (!report) {
      await reply('Not started: another run began at the same moment. Send /triggersubmission again after it finishes.');
    } else if (report.totals.accounts === 0) {
      await reply('No accounts configured — send cookie files first (/renew).');
    } else {
      logger.info({ summary: summarizeReport(report) }, 'telegram /triggersubmission finished');
    }
  })().catch(async (err) => {
    logger.warn({ err: errText(err) }, '/triggersubmission failed');
    await reply(`/triggersubmission failed: ${errText(err)}`).catch(() => undefined);
  });
  // Wrapped in an object: returning the promise itself from an async function
  // would make the caller wait for the whole run and block the poll loop.
  return { done };
}

/** Pending /renew <label> target — consumed by the next cookie payload. */
let pendingRenewalLabel: string | undefined;

async function accountsText(): Promise<string> {
  const accounts = await listAccounts();
  if (accounts.length === 0) {
    return 'No accounts configured yet. Send /renew (or /renew <label>) with your cookies, or use POST /admin/accounts.';
  }
  const lines = [`Accounts: ${accounts.length}`, ''];
  for (const a of accounts) {
    const who = a.username ? ` (${a.username})` : '';
    const when = a.lastRunAt
      ? `, last run ${a.lastRunAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`
      : '';
    lines.push(`- ${a.label}${who}: ${a.status}${when}`);
    if (a.lastError) lines.push(`  error: ${a.lastError.slice(0, 150)}`);
  }
  return lines.join('\n');
}

async function statusText(): Promise<string> {
  const [sys, last, accounts] = await Promise.all([getAllSystemState(), latestRun(), listAccounts()]);
  const active = accounts.filter((a) => a.status === AccountStatus.ACTIVE).length;
  const expired = accounts.filter((a) => a.status === AccountStatus.EXPIRED).length;
  const rejected = accounts.filter((a) => a.status === AccountStatus.REJECTED).length;
  const lines = [
    'Agent status',
    '',
    `Accounts: ${accounts.length}${accounts.length ? ` (${active} active, ${expired} expired, ${rejected} rejected)` : ''}`,
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
