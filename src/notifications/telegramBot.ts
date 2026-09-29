import { AccountStatus } from '@prisma/client';
import { config } from '../config';
import { logger } from '../logger';
import { sendTelegramMessage } from './telegram';
import { randomUUID } from 'node:crypto';
import {
  deleteSystemState,
  getAllSystemState,
  getSystemState,
  latestRun,
  setSystemState,
  SystemKeys,
} from '../database/models';
import { AccountRecord, deleteAccountById, deleteAllAccounts, listAccounts } from '../database/accounts';
import { describeIngest, ingestCookiePayload, Validator } from '../accounts/ingest';
import { ACCOUNT_LABEL_RE } from '../browser/sessionIdentity';
import { detectSessionSite, ingestCodeforcesSession, describeCodeforcesIngest } from '../codeforces/session';
import { isCodeforcesRunInProgress, runCodeforcesNow } from '../codeforces/worker';
import { formatCodeforcesAccountMessage, summarizeCodeforcesReport } from '../codeforces/report';
import { listCodeforcesAccounts } from '../codeforces/storage';
import {
  isRunInProgress,
  runSubmissionNow,
  triggerRun,
  TRIGGER_SUBMISSION_REASON,
} from '../scheduler/dailyWorker';
import { formatAccountMessage, summarizeReport } from '../scheduler/report';
import { humanLocal } from '../time';
import {
  cancelRangeJob,
  currentRangeJob,
  defaultRangeDeps,
  estimateAccountMs,
  formatDuration,
  formatRangeJobStatus,
  parseQuestionRange,
  QuestionRange,
  rangeSize,
  startRangeJob,
  StartRangeResult,
} from '../scheduler/rangeSubmission';

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

interface TgCallbackQuery {
  id: string;
  data?: string;
  message?: { message_id: number; chat: { id: number | string } };
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

const HELP_TEXT = [
  '🤖 LeetCode Daily Agent',
  '',
  '📎 Just send cookie .json files (one per account) — each file is added as an account named after its LeetCode username; a file for a user that already exists overrides that account.',
  '',
  '🍪 Sessions',
  '🔄 /renew - send a LeetCode or Codeforces session JSON; site is detected automatically',
  '🏷️ /renew <label> - store the NEXT file under this exact label',
  '👥 /accounts - list every account with its cookie status',
  '🗑️ /removesession - list every account with a Remove button (tap to delete that account\'s session)',
  '🧹 /removeallsessions - delete the sessions of ALL accounts (asks for confirmation)',
  '',
  '🚀 Submissions',
  '⚡ /triggersubmission - submit today\'s daily question again for ALL accounts (one reply per account)',
  '🏆 /submitnextsolution - submit the next Codeforces source solution for every Codeforces account',
  '📋 /cfaccounts - list Codeforces accounts, cursor and last verdict',
  '🎯 /questionrangesubmission 200-400 - submit every question in a range (pick one account or All)',
  '📍 /rangestatus - progress of the running range job',
  '🛑 /cancelrange - stop the running range job',
  '',
  'ℹ️ Info',
  '📊 /status - show authentication status and the last run',
  '❌ /cancel - cancel a renewal in progress',
  '❓ /help - show this message',
].join('\n');

const RENEW_INSTRUCTIONS = [
  '🔐 Session renewal',
  '',
  'Send a JSON export from your logged-in LeetCode or Codeforces browser session.',
  'The bot inspects the domains/origins and automatically stores it in the correct platform account store.',
  '',
  '🏠 LeetCode: your existing LeetCode renewal flow is unchanged.',
  '🏆 Codeforces: export cookies/storageState while logged in to codeforces.com and send the JSON file here.',
  '',
  '🏷️ /renew <label> optionally forces the account label for the next upload.',
  '❌ /cancel cancels a pending labeled renewal.',
].join('\n');

/**
 * Single-poller handover.
 *
 * Telegram allows ONE getUpdates long-poll per bot token; a second one gets
 * HTTP 409 "terminated by other getUpdates request". On every Render deploy
 * the NEW instance boots while the OLD one is still alive (zero-downtime
 * deploy), so both poll for a while and 409 each other.
 *
 * Fix: each instance claims the poller slot in the database on startup
 * (latest boot wins). Before every poll — and immediately after a 409 — an
 * instance checks it still owns the slot; the old instance sees it was
 * superseded and stops polling at once instead of fighting until it gets
 * SIGTERM. Shutdown also aborts the in-flight long-poll instead of letting
 * it hang for up to 25s. 409s during the short handover are expected and are
 * logged quietly; only a 409 that persists (a genuinely separate process
 * using the same bot token) is logged as a warning.
 */
export const POLLER_OWNER_KEY = 'telegramPollerOwner';
const HANDOVER_GRACE_MS = 60_000;

export function isConflictError(err: unknown): boolean {
  return /\b409\b|terminated by other getUpdates/i.test(errText(err));
}

export interface PollerDeps {
  instanceId?: string;
  getOwner?: () => Promise<string | null>;
  setOwner?: (id: string) => Promise<void>;
  /** Delay before retrying after a polling error (default 5s). */
  retryDelayMs?: number;
}

export function startTelegramBot(deps: PollerDeps = {}): () => void {
  if (!config.telegram.enabled || !config.telegram.commands) {
    logger.info('telegram command bot disabled (set TELEGRAM_BOT_TOKEN/CHAT_ID, TELEGRAM_COMMANDS=true)');
    return () => undefined;
  }

  let stopped = false;
  const abort = new AbortController();
  const instanceId = deps.instanceId ?? `${process.env.RENDER_INSTANCE_ID ?? 'local'}:${process.pid}:${randomUUID()}`;
  const getOwner = deps.getOwner ?? (() => getSystemState(POLLER_OWNER_KEY));
  const setOwner = deps.setOwner ?? ((id: string) => setSystemState(POLLER_OWNER_KEY, id));

  /** false only when the DB positively says another instance took over. */
  const stillOwner = async (): Promise<boolean> => {
    try {
      const owner = await getOwner();
      return owner === null || owner === instanceId;
    } catch {
      return true; // DB hiccup: keep polling rather than going silent
    }
  };

  void (async () => {
    await setOwner(instanceId).catch((err) =>
      logger.warn({ err: errText(err) }, 'could not claim the telegram poller slot - polling anyway'),
    );

    // A leftover webhook makes getUpdates fail with HTTP 409 â€” drop it once.
    await tgApi('deleteWebhook', { drop_pending_updates: true }).catch((err) =>
      logger.warn({ err: errText(err) }, 'Telegram deleteWebhook failed - continuing anyway'),
    );
    logger.info('telegram command bot polling started (/renew, /status, /help)');

    const startedAt = Date.now();
    let conflictSince: number | null = null;
    let offset = 0;
    while (!stopped) {
      if (!(await stillOwner())) {
        logger.info('a newer instance took over the telegram bot - this instance stops polling');
        break;
      }
      try {
        const updates = await tgApi<TgUpdate[]>(
          'getUpdates',
          { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message', 'callback_query'] },
          (POLL_TIMEOUT_S + 15) * 1000,
          abort.signal,
        );
        if (conflictSince !== null) {
          logger.info('telegram polling conflict resolved - this instance is now the only poller');
          conflictSince = null;
        }
        for (const update of updates) {
          offset = update.update_id + 1;
          if (update.message) {
            await handleMessage(update.message).catch((err) =>
              logger.warn({ err: errText(err) }, 'telegram message handling failed'),
            );
          }
          if (update.callback_query) {
            await handleCallbackQuery(update.callback_query).catch((err) =>
              logger.warn({ err: errText(err) }, 'telegram button handling failed'),
            );
          }
        }
      } catch (err) {
        if (stopped) break;
        if (isConflictError(err)) {
          if (!(await stillOwner())) {
            logger.info('a newer instance took over the telegram bot - this instance stops polling');
            break;
          }
          const now = Date.now();
          conflictSince ??= now;
          if (now - startedAt < HANDOVER_GRACE_MS) {
            // Expected right after a deploy while the old instance shuts down.
            logger.info('telegram poller handover in progress (previous instance still polling) - retrying in 5 seconds');
          } else {
            logger.warn(
              { conflictForS: Math.round((now - conflictSince) / 1000) },
              'Telegram 409: another process is polling with the SAME bot token (a second deployment, a local run, or another service) - only one may run',
            );
          }
        } else {
          logger.warn({ err: errText(err) }, 'Telegram polling error - retrying in 5 seconds');
        }
        await sleep(deps.retryDelayMs ?? 5_000);
      }
    }
  })();

  return () => {
    stopped = true;
    abort.abort(); // release the long-poll immediately on shutdown
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
          pendingRangePrompt = false;
          await reply(RENEW_INSTRUCTIONS);
          return;
        }
        if (!ACCOUNT_LABEL_RE.test(arg)) {
          await reply('Labels may contain letters, digits, dot, dash and underscore (max 32 characters). Try again, e.g. /renew main');
          return;
        }
        pendingRenewalLabel = arg;
        await reply(`🏷️ Renewing the "${arg}" account. Send its cookie export (text or file) in your next message. /cancel aborts.`);
        return;
      }
      case '/accounts':
        await reply(await accountsText());
        return;
      case '/status':
        await reply(await statusText());
        return;
      case '/submitnextsolution':
      case '/submit_next_solution':
        await handleCodeforcesSubmitNext();
        return;
      case '/cfaccounts':
      case '/cf_accounts':
        await reply(await codeforcesAccountsText());
        return;
      case '/triggersubmission':
      case '/trigger_submission':
        await handleTriggerSubmission();
        return;
      case '/removesession':
      case '/remove_session':
        await handleRemoveSession();
        return;
      case '/removeallsessions':
      case '/remove_all_sessions':
      case '/removeallsession':
        await handleRemoveAllSessions();
        return;
      case '/questionrangesubmission':
      case '/question_range_submission':
      case '/rangesubmission':
        pendingRangePrompt = false;
        await handleQuestionRangeCommand(text.split(/\s+/).slice(1).join(' '));
        return;
      case '/cancelrange':
      case '/cancel_range':
      case '/stoprange':
        pendingRangePrompt = false;
        await handleCancelRange();
        return;
      case '/rangestatus':
      case '/range_status':
        await handleRangeStatus();
        return;
      case '/cancel':
        pendingRenewalLabel = undefined;
        pendingRangePrompt = false;
        await reply(
          currentRangeJob()
            ? '❌ No renewal is in progress. To stop the question-range job, send /cancelrange.'
            : '❌ No renewal is in progress. When you are ready, send /renew (or /renew <label>) and then the cookies.',
        );
        return;
      default:
        await reply('🤔 Unknown command. Available: /renew, /renew <label>, /accounts, /cfaccounts, /status, /triggersubmission, /submitnextsolution, /questionrangesubmission, /rangestatus, /cancelrange, /removesession, /removeallsessions, /cancel, /help');
        return;
    }
  }

  // Reply to "/questionrangesubmission" without a range: the next "200-400" message.
  if (pendingRangePrompt && !msg.document && /^\s*#?\d/.test(text)) {
    pendingRangePrompt = false;
    await handleQuestionRangeCommand(text);
    return;
  }

  // Non-command message: a cookie payload (pasted text or an uploaded .json/.txt file).
  let payload = text;
  let fileName: string | undefined;
  if (msg.document) {
    fileName = msg.document.file_name;
    payload = await downloadDocument(msg.document);
  }
  if (!payload) {
    await reply('📎 Send a cookie .json file (or paste the cookies) to add an account. /accounts lists them.');
    return;
  }
  const result = await processCookieMessage(payload, {
    label: pendingRenewalLabel,
    fileName,
  });
  pendingRenewalLabel = undefined;
  await reply(result.text);
  if (result.stored && result.site === 'leetcode') scheduleBatchRun();
}

export type CookieSite = 'leetcode' | 'codeforces';

export interface CookieMessageResult {
  /** true when the session was stored (added or overridden). */
  stored: boolean;
  /** Site selected from the supplied session metadata. */
  site?: CookieSite;
  text: string;
}

/**
 * Handles one session message/file. Codeforces is routed to its own account
 * store; the existing LeetCode ingestion path remains unchanged.
 */
export async function processCookieMessage(
  payload: string,
  opts: { label?: string; fileName?: string; validator?: Validator } = {},
): Promise<CookieMessageResult> {
  const detected = detectSessionSite(payload, opts.fileName);

  if (detected === 'codeforces') {
    const result = await ingestCodeforcesSession(payload, {
      label: opts.label,
      fileName: opts.fileName,
    }).catch((err: unknown) => ({
      ok: false as const,
      error: `Codeforces session check failed: ${err instanceof Error ? err.message : String(err)}`,
    }));
    if (!result.ok) {
      return {
        stored: false,
        site: 'codeforces',
        text: `${opts.fileName ? `${opts.fileName}: ` : ''}${describeCodeforcesIngest(result)}`,
      };
    }
    const total = (await listCodeforcesAccounts(true)).length;
    return {
      stored: true,
      site: 'codeforces',
      text: `${opts.fileName ? `${opts.fileName}\n` : ''}${describeCodeforcesIngest(result)}\n\n🏆 Codeforces accounts stored: ${total}. Use /cfaccounts to inspect progress.`,
    };
  }

  if (!looksLikeCookiePayload(payload)) {
    return {
      stored: false,
      text: '⚠️ That does not look like a supported session export. Send the original LeetCode or Codeforces .json file (or /help).',
    };
  }

  // Default/fallback path is deliberately the existing LeetCode ingestion.
  // This preserves all current LeetCode /renew behavior.
  const result = await ingestCookiePayload(payload, opts);
  if (!result.ok) {
    return { stored: false, site: 'leetcode', text: `${opts.fileName ? `${opts.fileName}: ` : ''}${describeIngest(result)}` };
  }
  const total = (await listAccounts()).length;
  return {
    stored: true,
    site: 'leetcode',
    text: `${opts.fileName ? `${opts.fileName}\n` : ''}${describeIngest(result)}\n\n📊 LeetCode accounts stored: ${total}. Send more files to add more — /accounts lists them.`,
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
          ? "📨 Uploads received. Running today's challenge for all accounts now — the report follows here."
          : `⚠️ Today's run was not started: ${trigger.message}`,
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
    await reply('🚧 A run is already in progress — wait for its report, then send /triggersubmission again.');
    return null;
  }
  await reply("🚀 Submitting today's daily question for all accounts — you'll get one message per account.");
  const done = (async () => {
    const report = await runner(TRIGGER_SUBMISSION_REASON, {
      onAccountOutcome: (outcome, index, total) => reply(formatAccountMessage(outcome, index, total)),
    });
    if (!report) {
      await reply('⏳ Not started: another run began at the same moment. Send /triggersubmission again after it finishes.');
    } else if (report.totals.accounts === 0) {
      await reply('📭 No accounts configured — send cookie files first (/renew).');
    } else {
      logger.info({ summary: summarizeReport(report) }, 'telegram /triggersubmission finished');
    }
  })().catch(async (err) => {
    logger.warn({ err: errText(err) }, '/triggersubmission failed');
    await reply(`⚠️ /triggersubmission failed: ${errText(err)}`).catch(() => undefined);
  });
  // Wrapped in an object: returning the promise itself from an async function
  // would make the caller wait for the whole run and block the poll loop.
  return { done };
}

/** /submitnextsolution — run the next queued Codeforces source solution once per account. */
export async function handleCodeforcesSubmitNext(
  runner: typeof runCodeforcesNow = runCodeforcesNow,
  inProgress: () => boolean = isCodeforcesRunInProgress,
): Promise<{ done: Promise<void> } | null> {
  if (inProgress()) {
    await reply('🚧 A Codeforces run is already in progress — wait for its report, then send /submitnextsolution again.');
    return null;
  }
  await reply('🏆 Submitting the next Codeforces source solution for all Codeforces accounts.');
  const done = (async () => {
    const report = await runner('telegram', {
      onAccountOutcome: (outcome, index, total) =>
        reply(formatCodeforcesAccountMessage(outcome, index, total)),
    });
    if (!report) {
      await reply('⏳ Not started: another Codeforces run began at the same moment. Try again after it finishes.');
    } else if (report.totals.accounts === 0) {
      await reply('📭 No Codeforces accounts configured — send a Codeforces session JSON through /renew first.');
    } else {
      logger.info({ summary: summarizeCodeforcesReport(report) }, 'telegram /submitnextsolution finished');
    }
  })().catch(async (err) => {
    logger.warn({ err: errText(err) }, '/submitnextsolution failed');
    await reply(`⚠️ /submitnextsolution failed: ${errText(err)}`).catch(() => undefined);
  });
  return { done };
}

// ---------------------------------------------------------------------------
// Session removal (/removesession, /removeallsessions) — inline buttons
// ---------------------------------------------------------------------------

type InlineButton = { text: string; callback_data: string };

/** Everything session removal touches — injectable for tests. */
export interface RemovalDeps {
  listAccounts: () => Promise<AccountRecord[]>;
  deleteAccountById: (id: string) => Promise<boolean>;
  deleteAllAccounts: () => Promise<number>;
  /** Drops the legacy single-session copy, so it can't re-seed a "default" account. */
  clearLegacySession: () => Promise<void>;
  isRunInProgress: () => boolean;
  send: (text: string, buttons?: InlineButton[][]) => Promise<void>;
  edit: (chatId: number | string, messageId: number, text: string, buttons?: InlineButton[][]) => Promise<void>;
  answer: (callbackId: string, text?: string) => Promise<void>;
}

const RUN_BUSY_TEXT = '🚧 A run is in progress right now - wait for its report, then try again (removing an account mid-run would break it).';

const defaultRemovalDeps: RemovalDeps = {
  listAccounts,
  deleteAccountById,
  deleteAllAccounts,
  clearLegacySession: () => deleteSystemState(SystemKeys.storageState),
  isRunInProgress,
  send: async (text, buttons) => {
    await tgApi('sendMessage', {
      chat_id: config.telegram.chatId,
      text,
      disable_web_page_preview: true,
      ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
    });
  },
  edit: async (chatId, messageId, text, buttons) => {
    await tgApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: buttons ?? [] },
    });
  },
  answer: async (callbackId, text) => {
    await tgApi('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text } : {}) });
  },
};

function accountName(a: AccountRecord): string {
  return a.username && a.username !== a.label ? `${a.label} (${a.username})` : a.label;
}

/** The session list + one "Remove" button per account. */
export function buildRemoveSessionView(accounts: AccountRecord[]): { text: string; buttons: InlineButton[][] } {
  if (accounts.length === 0) {
    return { text: '📭 No sessions stored - nothing to remove.', buttons: [] };
  }
  const lines = [`🗂️ Sessions stored: ${accounts.length}`, '👇 Tap an account to remove its session:', ''];
  accounts.forEach((a, i) => lines.push(`${i + 1}. ${accountName(a)} - ${a.status}`));
  const buttons = accounts.map((a) => [{ text: `🗑️ Remove ${accountName(a)}`.slice(0, 60), callback_data: `rm:${a.id}` }]);
  buttons.push([{ text: '✅ Done', callback_data: 'rm:done' }]);
  return { text: lines.join('\n'), buttons };
}

export async function handleRemoveSession(deps: RemovalDeps = defaultRemovalDeps): Promise<void> {
  const view = buildRemoveSessionView(await deps.listAccounts());
  await deps.send(view.text, view.buttons.length ? view.buttons : undefined);
}

export async function handleRemoveAllSessions(deps: RemovalDeps = defaultRemovalDeps): Promise<void> {
  const accounts = await deps.listAccounts();
  if (accounts.length === 0) {
    await deps.send('No sessions stored - nothing to remove.');
    return;
  }
  await deps.send(
    [
      `⚠️ Remove ALL ${accounts.length} session(s)? This deletes every account's cookies and run history and cannot be undone:`,
      '',
      ...accounts.map((a) => `▪️ ${accountName(a)}`),
    ].join('\n'),
    [[
      { text: `🔥 Yes, remove all ${accounts.length}`, callback_data: 'rmall:yes' },
      { text: 'Cancel', callback_data: 'rmall:no' },
    ]],
  );
}

/** Handles a tap on one of the inline buttons above (rm:* and qr:*). */
export async function handleCallbackQuery(
  q: TgCallbackQuery,
  deps: RemovalDeps = defaultRemovalDeps,
  ui: RangeUiDeps = defaultRangeUiDeps,
): Promise<void> {
  const chatId = q.message?.chat.id;
  const messageId = q.message?.message_id;
  // Same access control as commands: only the configured chat.
  if (chatId === undefined || String(chatId) !== config.telegram.chatId || messageId === undefined) {
    logger.warn('telegram: ignored a button tap from an unknown chat');
    await deps.answer(q.id).catch(() => undefined);
    return;
  }
  const data = q.data ?? '';

  if (data.startsWith('qr:')) {
    await handleRangeButton(chatId, messageId, q.id, data, deps, ui);
    return;
  }

  if (data === 'rm:done' || data === 'rmall:no') {
    await deps.answer(q.id, data === 'rmall:no' ? 'Cancelled' : undefined);
    await deps.edit(chatId, messageId, data === 'rmall:no' ? '❌ Cancelled - no sessions were removed.' : '✅ Done.');
    return;
  }

  if (data === 'rmall:yes') {
    if (deps.isRunInProgress()) {
      await deps.answer(q.id, 'A run is in progress - try again after it finishes');
      await deps.edit(chatId, messageId, RUN_BUSY_TEXT);
      return;
    }
    const removed = await deps.deleteAllAccounts();
    await deps.clearLegacySession().catch(() => undefined);
    logger.info({ removed }, 'all account sessions removed via Telegram');
    await deps.answer(q.id, `Removed ${removed}`);
    await deps.edit(
      chatId,
      messageId,
      `🧹 Removed all sessions (${removed} account(s)). Send cookie .json files to add accounts again.`,
    );
    return;
  }

  if (data.startsWith('rm:')) {
    const id = data.slice(3);
    const before = await deps.listAccounts();
    const target = before.find((a) => a.id === id);
    if (deps.isRunInProgress()) {
      await deps.answer(q.id, 'A run is in progress - try again after it finishes');
      await deps.send(RUN_BUSY_TEXT);
      return;
    }
    let text: string;
    if (!target || !(await deps.deleteAccountById(id))) {
      text = '🤷 That account was already removed.';
    } else {
      logger.info({ label: target.label }, 'account session removed via Telegram');
      text = `✅ Removed ${accountName(target)}`;
    }
    const remaining = await deps.listAccounts();
    if (remaining.length === 0) await deps.clearLegacySession().catch(() => undefined);
    await deps.answer(q.id, text);
    // Refresh the same message so the list and buttons stay accurate.
    const view = buildRemoveSessionView(remaining);
    await deps.edit(chatId, messageId, `${text}\n\n${view.text}`, view.buttons);
    return;
  }

  await deps.answer(q.id);
}

// ---------------------------------------------------------------------------
// Question-range submission (/questionrangesubmission 200-400)
// ---------------------------------------------------------------------------

/** true after "/questionrangesubmission" with no range: the next "200-400" message is the range. */
let pendingRangePrompt = false;

const RANGE_GAP_MS = 30_000;

/** Wiring for the range UI — injectable for tests. */
export interface RangeUiDeps {
  start: (range: QuestionRange, target: string | 'all') => Promise<StartRangeResult>;
  current: typeof currentRangeJob;
  cancel: typeof cancelRangeJob;
  now: () => number;
}

const defaultRangeUiDeps: RangeUiDeps = {
  start: (range, target) => startRangeJob(range, target, defaultRangeDeps(reply)),
  current: currentRangeJob,
  cancel: cancelRangeJob,
  now: () => Date.now(),
};

/** Account picker: one button per account, then "All accounts" and Cancel. */
export function buildRangePicker(
  range: QuestionRange,
  accounts: AccountRecord[],
): { text: string; buttons: InlineButton[][] } {
  const size = rangeSize(range);
  const tag = `${range.from}-${range.to}`;
  const text = [
    `🎯 Question range #${range.from}–#${range.to} (${size} question${size === 1 ? '' : 's'})`,
    '',
    '👇 Pick the account to run it on:',
    `⏳ Estimated ~${formatDuration(estimateAccountMs(range, RANGE_GAP_MS))} per account (30 s break between questions)`,
  ].join('\n');
  const buttons: InlineButton[][] = accounts.map((a) => [
    { text: `👤 ${accountName(a)}`.slice(0, 60), callback_data: `qr:${tag}:${a.id}` },
  ]);
  buttons.push([{ text: `👥 All accounts (${accounts.length}, one by one)`, callback_data: `qr:${tag}:all` }]);
  buttons.push([{ text: '✖️ Cancel', callback_data: 'qr:x' }]);
  return { text, buttons };
}

export async function handleQuestionRangeCommand(
  arg: string,
  deps: RemovalDeps = defaultRemovalDeps,
  ui: RangeUiDeps = defaultRangeUiDeps,
): Promise<void> {
  const running = ui.current();
  if (running) {
    await deps.send(`🚧 A question-range process is already in progress.\n\n${formatRangeJobStatus(running, ui.now())}`);
    return;
  }
  if (!arg.trim()) {
    pendingRangePrompt = true;
    await deps.send('🎯 Which questions? Send the range, e.g. 200-400\n(or in one go: /questionrangesubmission 200-400)');
    return;
  }
  const parsed = parseQuestionRange(arg);
  if (!parsed.ok) {
    await deps.send(`⚠️ ${parsed.error}\nExample: /questionrangesubmission 200-400`);
    return;
  }
  const accounts = await deps.listAccounts();
  if (accounts.length === 0) {
    await deps.send('📭 No accounts configured — send cookie .json files first (/renew).');
    return;
  }
  const picker = buildRangePicker(parsed.range, accounts);
  await deps.send(picker.text, picker.buttons);
}

async function handleRangeButton(
  chatId: number | string,
  messageId: number,
  callbackId: string,
  data: string,
  deps: RemovalDeps,
  ui: RangeUiDeps = defaultRangeUiDeps,
): Promise<void> {
  if (data === 'qr:x') {
    await deps.answer(callbackId, 'Cancelled');
    await deps.edit(chatId, messageId, '✖️ Question-range submission cancelled — nothing was started.');
    return;
  }
  const m = /^qr:(\d+)-(\d+):(.+)$/.exec(data);
  const parsed = m ? parseQuestionRange(`${m[1]}-${m[2]}`) : null;
  if (!m || !parsed || !parsed.ok) {
    await deps.answer(callbackId, 'This button is no longer valid');
    return;
  }
  const result = await ui.start(parsed.range, m[3]!);
  if (!result.started) {
    if (result.reason === 'busy') {
      await deps.answer(callbackId, 'A range process is already running');
      await deps.send(`🚧 A question-range process is already in progress.\n\n${formatRangeJobStatus(result.job, ui.now())}`);
    } else {
      await deps.answer(callbackId, 'Account not found');
      await deps.edit(
        chatId,
        messageId,
        result.reason === 'no-accounts'
          ? '📭 No accounts configured — send cookie .json files first.'
          : '🔍 That account no longer exists — send /questionrangesubmission again.',
      );
    }
    return;
  }
  const { range } = parsed;
  const names = result.accounts.map((a) => accountName(a));
  await deps.answer(callbackId, 'Started 🚀');
  await deps.edit(
    chatId,
    messageId,
    [
      `🚀 Started: questions #${range.from}–#${range.to} (${rangeSize(range)})`,
      `👥 ${names.length === 1 ? `Account: ${names[0]}` : `Accounts (one by one): ${names.join(', ')}`}`,
      `⏳ ~${formatDuration(estimateAccountMs(range, RANGE_GAP_MS) * names.length)} in total — 30 s break between questions`,
      '',
      '📬 You get a summary after each account.',
      '📍 /rangestatus shows progress · 🛑 /cancelrange stops it',
    ].join('\n'),
  );
}

export async function handleCancelRange(ui: RangeUiDeps = defaultRangeUiDeps): Promise<void> {
  const job = ui.current();
  if (!job || !ui.cancel()) {
    await reply('🤷 No question-range process is running.');
    return;
  }
  await reply(
    `🛑 Cancelling the question-range job (#${job.range.from}–#${job.range.to})…\nIt stops right after the current question — the summary for ${job.currentLabel ?? 'the current account'} follows.`,
  );
}

export async function handleRangeStatus(ui: RangeUiDeps = defaultRangeUiDeps): Promise<void> {
  const job = ui.current();
  await reply(job ? formatRangeJobStatus(job, ui.now()) : '💤 No question-range process is running. Start one with /questionrangesubmission 200-400');
}

/** Pending /renew <label> target — consumed by the next cookie payload. */
let pendingRenewalLabel: string | undefined;

async function accountsText(): Promise<string> {
  const accounts = await listAccounts();
  if (accounts.length === 0) {
    return '📭 No accounts configured yet. Send /renew (or /renew <label>) with your cookies, or use POST /admin/accounts.';
  }
  const lines = [`👥 Accounts: ${accounts.length}`, ''];
  for (const a of accounts) {
    const who = a.username ? ` (${a.username})` : '';
    const when = a.lastRunAt
      ? `, last run ${humanLocal(a.lastRunAt)}`
      : '';
    lines.push(`▪️ ${a.label}${who}: ${a.status}${when}`);
    if (a.lastError) lines.push(`  ⚠️ error: ${a.lastError.slice(0, 150)}`);
  }
  return lines.join('\n');
}

async function codeforcesAccountsText(): Promise<string> {
  const accounts = await listCodeforcesAccounts(true);
  if (accounts.length === 0) return '📭 No Codeforces accounts configured. Send /renew with a Codeforces session JSON.';
  const lines = [`🏆 Codeforces accounts: ${accounts.length}`, ''];
  for (const account of accounts) {
    const progress = await (await import('../codeforces/storage')).getCodeforcesProgress(account.id);
    lines.push(`▪️ ${account.label}${account.username ? ` (${account.username})` : ''}: ${account.status}`);
    lines.push(`  📍 Next: ${progress.nextKey ?? 'first queued source'}`);
    if (progress.lastCompletedKey) lines.push(`  ✅ Last accepted: ${progress.lastCompletedKey}`);
    if (progress.lastAttemptDate) lines.push(`  🗓️ Last attempt: ${progress.lastAttemptDate}${progress.lastVerdict ? ` — ${progress.lastVerdict}` : ''}`);
    if (progress.lastSubmissionId) lines.push(`  🆔 Submission: ${progress.lastSubmissionId}`);
    if (account.lastError) lines.push(`  ⚠️ ${account.lastError.slice(0, 180)}`);
  }
  return lines.join('\n');
}

async function statusText(): Promise<string> {
  const [sys, last, accounts] = await Promise.all([getAllSystemState(), latestRun(), listAccounts()]);
  const active = accounts.filter((a) => a.status === AccountStatus.ACTIVE).length;
  const expired = accounts.filter((a) => a.status === AccountStatus.EXPIRED).length;
  const rejected = accounts.filter((a) => a.status === AccountStatus.REJECTED).length;
  const lines = [
    '📊 Agent status',
    '',
    `👥 Accounts: ${accounts.length}${accounts.length ? ` (${active} active, ${expired} expired, ${rejected} rejected)` : ''}`,
    `🔐 Auth: ${sys['authStatus'] ?? 'unknown'}${sys['authUsername'] ? ` (${sys['authUsername']})` : ''}`,
  ];
  if (last) {
    lines.push(
      `🕹️ Last run: ${last.date} - ${last.title} - ${last.state}${last.submissionStatus ? ` (${last.submissionStatus})` : ''}`,
    );
  } else {
    lines.push('🕹️ Last run: none yet');
  }
  if (sys['lastError']) lines.push(`❗ Last error: ${sys['lastError'].slice(0, 300)}`);
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
  cancel?: AbortSignal,
): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: cancel ? AbortSignal.any([timeout, cancel]) : timeout,
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
