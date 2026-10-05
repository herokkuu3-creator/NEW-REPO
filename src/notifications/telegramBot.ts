import { AccountStatus } from '@prisma/client';
import { config } from '../config';
import { logger } from '../logger';
import { sendTelegramMessage } from './telegram';
import { randomUUID } from 'node:crypto';
import {
  deleteSystemState,
  getAllSystemState,
  getSystemState,
  latestAcceptedRun,
  latestAcceptedRunForAccount,
  latestRun,
  setSystemState,
  SystemKeys,
} from '../database/models';
import { AccountRecord, deleteAccountById, deleteAllAccounts, listAccounts } from '../database/accounts';
import { describeIngest, ingestCookiePayload, Validator } from '../accounts/ingest';
import { ACCOUNT_LABEL_RE } from '../browser/sessionIdentity';
import { detectSessionSite, ingestCodeforcesSession, describeCodeforcesIngest } from '../codeforces/session';
import { CODEFORCES_MANUAL_REASON, isCodeforcesRunInProgress, resolveCurrentEntry, runCodeforcesNow, type CodeforcesNetworkMode } from '../codeforces/worker';
import { deleteCodeforcesAccountById, deleteAllCodeforcesAccounts, getCodeforcesProgress, listCodeforcesAccounts } from '../codeforces/storage';
import { formatCodeforcesAccountMessage, summarizeCodeforcesReport } from '../codeforces/report';
import { loadRuntimeSourceIndex, SourceIndexEntry } from '../codeforces/sourceRepo';
import { submitPageUrl } from '../codeforces/handoff';
import {
  isRunInProgress,
  runSubmissionNow,
  triggerRun,
  TRIGGER_SUBMISSION_REASON,
} from '../scheduler/dailyWorker';
import { formatAccountMessage, summarizeReport } from '../scheduler/report';
import { claimContestRewardForAccount, ContestRewardResult } from '../leetcode/contestReward';
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
  rangeQueueLength,
  startRangeJob,
  StartRangeResult,
} from '../scheduler/rangeSubmission';

/**
 * Telegram command bot Ã¢â‚¬â€ the interactive half of session renewal.
 *
 * Long polling (getUpdates), so it needs NO public webhook setup and works
 * on Render's free web service as-is. Commands:
 *
 *   /renew   Ã¢â‚¬â€ step-by-step instructions, then paste/upload the cookies
 *   /status  Ã¢â‚¬â€ auth state + last run
 *   /help    Ã¢â‚¬â€ command list
 *   /cancel  Ã¢â‚¬â€ abort a renewal in progress
 *
 * Security: messages from ANY chat other than TELEGRAM_CHAT_ID are ignored Ã¢â‚¬â€
 * the bot token is semi-public (anyone can message the bot), the chat ID is
 * the access control. Cookie payloads are parsed and stored immediately; live
 * LeetCode validation is deferred to the daily run. Cookie values are never
 * logged or echoed back.
 *
 * Large exports: Telegram splits pasted text at ~4096 characters, which
 * corrupts JSON Ã¢â‚¬â€ so Cookie-Editor exports can also be sent as .txt/.json
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
  'ðŸ¤– LeetCode Daily Agent',
  '',
  'ðŸ“Ž Just send cookie .json files (one per account) â€” each file is added as an account named after its LeetCode username; a file for a user that already exists overrides that account.',
  '',
  'ðŸª Sessions',
  'ðŸ”„ /renew - send a LeetCode or Codeforces session JSON; site is detected automatically',
  'ðŸ·ï¸ /renew <label> - store the NEXT file under this exact label',
  '👥 /accounts - list every account with its cookie status',
  'ðŸ—‘ï¸ /removesession - list every account with a Remove button (tap to delete that account\'s session)',
  'ðŸ§¹ /removeallsessions - delete the sessions of ALL accounts (asks for confirmation)',
  '',
  '🚀 Submissions',
  'âš¡ /triggersubmission - submit today\'s daily question again for ALL accounts (one reply per account)',
  'ðŸŽ /claimcoins - check and collect the contest-page coin offer for selected LeetCode accounts',
  'ðŸ† /submitnextsolution - submit the next Codeforces source solution for every Codeforces account',
  'ðŸŽ¯ /nextsubcustomaccount - choose one Codeforces account, or all, for the next source solution',
  'ðŸŒ /cfnetwork - choose residential proxy or phone Tailscale for Codeforces',
  '📱 /cfmanualnext - send the next source and submit link for a phone-browser fallback',
  'ðŸ“‹ /cfaccounts - list Codeforces accounts, cursor and last verdict',
  'ðŸ—‘ï¸ /cf_clear_cookies, /codechef - list every Codeforces account with a Remove button, plus a Remove All option',
  '👨‍🍳 /codechef - trigger CodeChef submissions for all configured accounts',
  'ðŸŽ¯ /questionrangesubmission 200-400 - submit every question in a range (pick one account or All)',
  'ðŸ“ /rangestatus - progress of the running range job',
  'ðŸ›‘ /cancelrange - stop the running range job',
  '',
  'â„¹ï¸ Info',
  'ðŸ“Š /status - show authentication status and the last run',
  'âŒ /cancel - cancel a renewal in progress',
  'â“ /help - show this message',
].join('\n');

const RENEW_INSTRUCTIONS = [
  'ðŸ” Session renewal',
  '',
  'Send a JSON export from your logged-in LeetCode or Codeforces browser session.',
  'The bot inspects the domains/origins and automatically stores it in the correct platform account store.',
  '',
  '🏠 LeetCode: your existing LeetCode renewal flow is unchanged.',
  'ðŸ† Codeforces: export cookies/storageState while logged in to codeforces.com and send the JSON file here.',
  '',
  'ðŸ·ï¸ /renew <label> optionally forces the account label for the next upload.',
  'âŒ /cancel cancels a pending labeled renewal.',
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
 * (latest boot wins). Before every poll â€” and immediately after a 409 â€” an
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

    // A leftover webhook makes getUpdates fail with HTTP 409 Ã¢â‚¬â€ drop it once.
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
        await reply(`ðŸ·ï¸ Renewing the "${arg}" account. Send its cookie export (text or file) in your next message. /cancel aborts.`);
        return;
      }
      case '/accounts':
        await replyHtml(await accountsText());
        return;
      case '/status':
        await replyHtml(await statusText());
        return;
      case '/codechef':
        await reply('🚀 CodeChef runs are triggered by the internal cron scheduler automatically. Support for manual triggers via Telegram is coming soon! Ensure CODECHEF_1, CODECHEF_2 environment variables are configured.');
        return;
      case '/submitnextsolution':
      case '/submit_next_solution':
        await handleCodeforcesSubmitNext();
        return;
      case '/nextsubcustomaccount':
      case '/nextsubcustomaccout':
      case '/next_sub_custom_account':
      case '/cfsubmitcustom':
        await handleCodeforcesCustomSubmit();
        return;
      case '/cfmanualnext':
      case '/cf_manual_next':
        await handleCodeforcesManualNext();
        return;
      case '/cfnetwork':
      case '/cf_network':
      case '/cftransport':
        await handleCodeforcesNetworkCommand();
        return;
      case '/cfaccounts':
      case '/cf_accounts':
        await reply(await codeforcesAccountsText());
        return;
      case '/triggersubmission':
      case '/trigger_submission':
        await handleTriggerSubmission();
        return;
      case '/claimcoins':
      case '/claim_coins':
      case '/claimoffer':
      case '/claimreward':
        await handleCoinClaimCommand();
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
      case '/cf_clear_cookies':
      case '/cfclearcookies':
        await handleCfRemoveSession();
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
            ? 'âŒ No renewal is in progress. To stop the question-range job, send /cancelrange.'
            : 'âŒ No renewal is in progress. When you are ready, send /renew (or /renew <label>) and then the cookies.',
        );
        return;
      default:
        await reply('ðŸ¤” Unknown command. Available: /renew, /renew <label>, /accounts, /cfaccounts, /status, /triggersubmission, /claimcoins, /submitnextsolution, /nextsubcustomaccount, /cfnetwork, /cfmanualnext, /questionrangesubmission, /rangestatus, /cancelrange, /removesession, /removeallsessions, /cancel, /help');
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
    await reply('ðŸ“Ž Send a cookie .json file (or paste the cookies) to add an account. /accounts lists them.');
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
      text: `${opts.fileName ? `${opts.fileName}\n` : ''}${describeCodeforcesIngest(result)}\n\nðŸ† Codeforces accounts stored: ${total}. Use /cfaccounts to inspect progress.`,
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
    text: `${opts.fileName ? `${opts.fileName}\n` : ''}${describeIngest(result)}\n\nðŸ“Š LeetCode accounts stored: ${total}. Send more files to add more â€” /accounts lists them.`,
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
          ? "ðŸ“¨ Uploads received. Running today's challenge for all accounts now â€” the report follows here."
          : `⚠️ Today's run was not started: ${trigger.message}`,
      );
    })().catch((err) => logger.warn({ err: errText(err) }, 'batch run trigger failed'));
  }, BATCH_RUN_DELAY_MS);
}

/**
 * /triggersubmission â€” re-submits today's daily question for every account.
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
    await reply('ðŸš§ A run is already in progress â€” wait for its report, then send /triggersubmission again.');
    return null;
  }
  await reply("🚀 Submitting today's daily question for all accounts â€” you'll get one message per account.");
  const done = (async () => {
    const report = await runner(TRIGGER_SUBMISSION_REASON, {
      onAccountOutcome: (outcome, index, total) => reply(formatAccountMessage(outcome, index, total)),
    });
    if (!report) {
      await reply('â³ Not started: another run began at the same moment. Send /triggersubmission again after it finishes.');
    } else if (report.totals.accounts === 0) {
      await reply('ðŸ“­ No accounts configured â€” send cookie files first (/renew).');
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

/** /submitnextsolution â€” run the next queued Codeforces source solution once per account. */
export async function handleCodeforcesSubmitNext(
  runner: typeof runCodeforcesNow = runCodeforcesNow,
  inProgress: () => boolean = isCodeforcesRunInProgress,
): Promise<{ done: Promise<void> } | null> {
  if (inProgress()) {
    await reply('ðŸš§ A Codeforces run is already in progress â€” wait for its report, then send /submitnextsolution again.');
    return null;
  }
  const statusMessage = await tgApi<{ message_id: number }>('sendMessage', {
    chat_id: config.telegram.chatId,
    text: '<b>ðŸ† CODEFORCES SUBMISSION</b>\n<code>â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”</code>\nðŸ”Ž Checking all accountsâ€¦',
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
  const progressLines = new Map<number, string>();
  const html = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const editProgress = async (): Promise<void> => {
    const lines = [...progressLines.entries()].sort(([a], [b]) => a - b).map(([, line]) => line);
    await tgApi('editMessageText', {
      chat_id: config.telegram.chatId,
      message_id: statusMessage.message_id,
      text: ['<b>ðŸ† CODEFORCES SUBMISSION</b>', '<code>â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”</code>', ...lines].join('\n'),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }).catch((err) => logger.warn({ err: errText(err) }, 'could not update Codeforces progress message'));
  };
  const done = (async () => {
    const report = await runner(CODEFORCES_MANUAL_REASON, {
      forceDailyAttempt: true,
      onAccountProgress: async ({ phase, label, username, index, total, networkMode }) => {
        const account = html(username ?? label);
        const route = networkMode === 'tailscale' ? '📱 PHONE TAILSCALE' : '🏠 RESIDENTIAL PROXY';
        const phaseText = {
          'verification-required': `📱 <b>${account}</b> · waiting for you to verify · open the private browser link sent below`,
          checking: `ðŸ”Ž <b>Account ${index}/${total}</b> Â· checking <code>${account}</code>â€¦`,
          verified: `✅ <b>Account ${index}/${total}</b> Â· verified <code>${account}</code>`,
          source: `ðŸ“¦ <b>Account ${index}/${total}</b> Â· source loaded for <code>${account}</code>`,
          network: `ðŸŒ <b>Account ${index}/${total}</b> Â· route: <b>${route}</b>`,
          opening: `ðŸ–¥ï¸ <b>Account ${index}/${total}</b> Â· opening Codeforces submit page`,
          submitting: `🚀 <b>Account ${index}/${total}</b> Â· submitting signed form`,
          verdict: `â³ <b>Account ${index}/${total}</b> Â· waiting for Codeforces verdict`,
          'session-restored': `ðŸ’¾ <b>${account}</b> Â· saved browser session restored`,
          'session-fresh': `ðŸª <b>${account}</b> Â· starting from uploaded session cookies`,
          verification: `ðŸ” <b>${account}</b> Â· checking verification Â· waiting for the page to complete normally`,
          'verification-retry': `â³ <b>${account}</b> Â· verification has not cleared Â· one retry before submitting`,
          'verification-blocked': `⚠️ <b>${account}</b> Â· verification did not clear automatically Â· attention required`,
          'verification-cleared': `✅ <b>${account}</b> Â· verification completed Â· preparing submission`,
          'verification-not-required': `✅ <b>${account}</b> Â· no form verification required`,
        }[phase];
        progressLines.set(
          index,
          phaseText,
        );
        await editProgress();
      },
      onAccountOutcome: (outcome, index, total) => {
        progressLines.set(index, html(formatCodeforcesAccountMessage(outcome, index, total)));
        return editProgress();
      },
    });
    if (!report) {
      progressLines.set(0, 'â³ Not started: another Codeforces run began at the same moment. Try again after it finishes.');
      await editProgress();
    } else if (report.totals.accounts === 0) {
      progressLines.set(0, 'ðŸ“­ No Codeforces accounts configured â€” send a Codeforces session JSON through /renew first.');
      await editProgress();
    } else {
      logger.info({ summary: summarizeCodeforcesReport(report) }, 'telegram /submitnextsolution finished');
    }
  })().catch(async (err) => {
    logger.warn({ err: errText(err) }, '/submitnextsolution failed');
      progressLines.set(0, `⚠️ <b>/submitnextsolution failed:</b> ${html(errText(err))}`);
    await editProgress().catch(() => undefined);
  });
  return { done };
}

export interface CodeforcesSubmitUiDeps {
  listAccounts: () => Promise<Awaited<ReturnType<typeof listCodeforcesAccounts>>>;
  runner: typeof runCodeforcesNow;
  inProgress: () => boolean;
  send: (text: string, buttons?: InlineButton[][]) => Promise<void>;
  edit: (chatId: number | string, messageId: number, text: string, buttons?: InlineButton[][]) => Promise<void>;
  answer: (callbackId: string, text?: string) => Promise<void>;
}

const defaultCodeforcesSubmitUiDeps: CodeforcesSubmitUiDeps = {
  listAccounts: () => listCodeforcesAccounts(false),
  runner: runCodeforcesNow,
  inProgress: isCodeforcesRunInProgress,
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
    await tgApi('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text, show_alert: true } : {}) });
  },
};

export interface CodeforcesNetworkUiDeps {
  getMode: () => Promise<CodeforcesNetworkMode | null>;
  setMode: (mode: CodeforcesNetworkMode) => Promise<void>;
  send: (text: string, buttons?: InlineButton[][]) => Promise<void>;
  edit: (chatId: number | string, messageId: number, text: string, buttons?: InlineButton[][]) => Promise<void>;
  answer: (callbackId: string, text?: string) => Promise<void>;
}

const defaultCodeforcesNetworkUiDeps: CodeforcesNetworkUiDeps = {
  getMode: async () => {
    const value = await getSystemState(SystemKeys.codeforcesNetworkMode);
    return value === 'tailscale' || value === 'proxy' ? value : null;
  },
  setMode: (mode) => setSystemState(SystemKeys.codeforcesNetworkMode, mode),
  send: defaultCodeforcesSubmitUiDeps.send,
  edit: defaultCodeforcesSubmitUiDeps.edit,
  answer: defaultCodeforcesSubmitUiDeps.answer,
};

export function buildCodeforcesNetworkPicker(mode: CodeforcesNetworkMode | null): { text: string; buttons: InlineButton[][] } {
  const selected = mode ?? 'proxy';
  return {
    text: [
      'ðŸŒ Codeforces submission network',
      '',
      `Current route: ${selected === 'proxy' ? '🏠 Residential proxy' : '📱 Phone Tailscale'}`,
      'Choose the route used by automatic and Telegram-triggered submissions:',
      selected === 'tailscale'
        ? 'Tailscale is strict: if the phone is offline, the job reports an error instead of silently using the proxy.'
        : 'Proxy is strict: this run will not connect to Tailscale.',
    ].join('\n'),
    buttons: [
      [{ text: `${selected === 'proxy' ? '✅ ' : ''}🏠 Residential proxy`, callback_data: 'cfnet:proxy' }],
      [{ text: `${selected === 'tailscale' ? '✅ ' : ''}📱 Phone Tailscale`, callback_data: 'cfnet:tailscale' }],
      [{ text: '✖️ Cancel', callback_data: 'cfnet:x' }],
    ],
  };
}

export async function handleCodeforcesNetworkCommand(
  deps: CodeforcesNetworkUiDeps = defaultCodeforcesNetworkUiDeps,
): Promise<void> {
  const picker = buildCodeforcesNetworkPicker(await deps.getMode());
  await deps.send(picker.text, picker.buttons);
}

async function handleCodeforcesNetworkButton(
  chatId: number | string,
  messageId: number,
  callbackId: string,
  data: string,
  deps: CodeforcesNetworkUiDeps,
): Promise<void> {
  if (data === 'cfnet:x') {
    await deps.answer(callbackId, 'Cancelled');
    await deps.edit(chatId, messageId, '✖️ Network selection cancelled.');
    return;
  }
  const mode = data === 'cfnet:tailscale' ? 'tailscale' : data === 'cfnet:proxy' ? 'proxy' : null;
  if (!mode) {
    await deps.answer(callbackId, 'This button is no longer valid');
    await deps.edit(chatId, messageId, 'ðŸ” That network choice is no longer valid. Send /cfnetwork again.');
    return;
  }
  await deps.setMode(mode);
  await deps.answer(callbackId, mode === 'proxy' ? 'Residential proxy selected' : 'Phone Tailscale selected');
  await deps.edit(
    chatId,
    messageId,
    mode === 'proxy'
      ? '✅ Codeforces route set to residential proxy. Tailscale will not be used.'
      : '✅ Codeforces route set to phone Tailscale. The job will fail clearly if the phone exit node is offline.',
  );
}

/** One account per button, followed by the explicit all-accounts choice. */
export function buildCodeforcesSubmitPicker(
  accounts: Awaited<ReturnType<typeof listCodeforcesAccounts>>,
): { text: string; buttons: InlineButton[][] } {
  const buttons = accounts.map((account) => [
    { text: `👤 ${cfAccountName(account)}`.slice(0, 60), callback_data: `cfsub:${account.id}` },
  ]);
  buttons.push([{ text: `👥 All accounts (${accounts.length}, one by one)`, callback_data: 'cfsub:all' }]);
  buttons.push([{ text: '✖️ Cancel', callback_data: 'cfsub:x' }]);
  return {
    text: [
      'ðŸ† Submit the next Codeforces source solution',
      '',
      'ðŸ‘‡ Pick an account, or choose All accounts:',
      'Only the selected account(s) will receive a submission.',
    ].join('\n'),
    buttons,
  };
}

/** /nextsubcustomaccount â€” show the active Codeforces account picker. */
export async function handleCodeforcesCustomSubmit(
  deps: CodeforcesSubmitUiDeps = defaultCodeforcesSubmitUiDeps,
): Promise<void> {
  if (deps.inProgress()) {
    await deps.send('ðŸš§ A Codeforces run is already in progress â€” wait for its report, then try again.');
    return;
  }
  const accounts = await deps.listAccounts();
  if (accounts.length === 0) {
    await deps.send('ðŸ“­ No active Codeforces accounts configured â€” send a Codeforces session JSON through /renew first.');
    return;
  }
  const picker = buildCodeforcesSubmitPicker(accounts);
  await deps.send(picker.text, picker.buttons);
}

async function startSelectedCodeforcesRun(
  accountIds: readonly string[] | undefined,
  description: string,
  deps: CodeforcesSubmitUiDeps,
): Promise<void> {
  const report = await deps.runner(CODEFORCES_MANUAL_REASON, {
    forceDailyAttempt: true,
    ...(accountIds ? { accountIds } : {}),
    onAccountOutcome: (outcome, index, total) => deps.send(formatCodeforcesAccountMessage(outcome, index, total)),
  });
  if (!report) {
    await deps.send('â³ Not started: another Codeforces run began at the same moment. Try again after it finishes.');
  } else if (report.totals.accounts === 0) {
    await deps.send('ðŸ“­ The selected Codeforces account is no longer active. Send /nextsubcustomaccount again.');
  } else {
    logger.info({ description, summary: summarizeCodeforcesReport(report) }, 'telegram custom Codeforces submission finished');
  }
}

async function handleCodeforcesSubmitButton(
  chatId: number | string,
  messageId: number,
  callbackId: string,
  data: string,
  deps: CodeforcesSubmitUiDeps,
): Promise<void> {
  if (data === 'cfsub:x') {
    await deps.answer(callbackId, 'Cancelled');
    await deps.edit(chatId, messageId, '✖️ Codeforces submission cancelled â€” nothing was submitted.');
    return;
  }
  if (deps.inProgress()) {
    await deps.answer(callbackId, 'A Codeforces run is in progress');
    await deps.edit(chatId, messageId, 'ðŸš§ A Codeforces run is already in progress â€” wait for its report, then try again.');
    return;
  }
  const accounts = await deps.listAccounts();
  const selected = data === 'cfsub:all' ? accounts : accounts.filter((account) => data === `cfsub:${account.id}`);
  if (selected.length === 0) {
    await deps.answer(callbackId, 'This button is no longer valid');
    await deps.edit(chatId, messageId, 'ðŸ” That Codeforces account is no longer active. Send /nextsubcustomaccount again.');
    return;
  }
  const description = selected.length === 1 ? cfAccountName(selected[0]!) : `all ${selected.length} Codeforces accounts`;
  await deps.answer(callbackId, 'Started 🚀');
  await deps.edit(
    chatId,
    messageId,
    `🚀 Submitting the next Codeforces source solution for ${description}.\n\nðŸ“¬ You will receive the verdict here.`,
  );
  void startSelectedCodeforcesRun(data === 'cfsub:all' ? undefined : [selected[0]!.id], description, deps).catch(async (err) => {
    logger.warn({ err: errText(err) }, 'custom Codeforces submission failed');
    await deps.send(`⚠️ Codeforces submission failed: ${errText(err)}`).catch(() => undefined);
  });
}

export interface CodeforcesManualUiDeps {
  listAccounts: () => Promise<Awaited<ReturnType<typeof listCodeforcesAccounts>>>;
  nextEntry: (accountId: string) => Promise<SourceIndexEntry | null>;
  send: (text: string, buttons?: InlineButton[][]) => Promise<void>;
  edit: (chatId: number | string, messageId: number, text: string, buttons?: InlineButton[][]) => Promise<void>;
  answer: (callbackId: string, text?: string) => Promise<void>;
}

async function nextManualEntry(accountId: string): Promise<SourceIndexEntry | null> {
  const [source, progress] = await Promise.all([loadRuntimeSourceIndex(), getCodeforcesProgress(accountId)]);
  return resolveCurrentEntry(source.queue, progress.nextKey, progress.lastCompletedKey);
}

const defaultCodeforcesManualUiDeps: CodeforcesManualUiDeps = {
  listAccounts: () => listCodeforcesAccounts(false),
  nextEntry: nextManualEntry,
  send: defaultCodeforcesSubmitUiDeps.send,
  edit: defaultCodeforcesSubmitUiDeps.edit,
  answer: defaultCodeforcesSubmitUiDeps.answer,
};

function buildCodeforcesManualPicker(accounts: Awaited<ReturnType<typeof listCodeforcesAccounts>>): { text: string; buttons: InlineButton[][] } {
  return {
    text: '📱 Phone fallback\n\nPick the Codeforces account signed in on your phone. The bot will send its next source link and the matching Codeforces submit page. No cloud browser or proxy is used.',
    buttons: [
      ...accounts.map((account) => [{ text: `👤 ${cfAccountName(account)}`.slice(0, 60), callback_data: `cfmanual:${account.id}` }]),
      [{ text: '✖️ Cancel', callback_data: 'cfmanual:x' }],
    ],
  };
}

/** /cfmanualnext â€” send a mobile-ready source/submit handoff without posting anything. */
export async function handleCodeforcesManualNext(
  deps: CodeforcesManualUiDeps = defaultCodeforcesManualUiDeps,
): Promise<void> {
  const accounts = await deps.listAccounts();
  if (accounts.length === 0) {
    await deps.send('ðŸ“­ No active Codeforces accounts configured. Add one with /renew first.');
    return;
  }
  const picker = buildCodeforcesManualPicker(accounts);
  await deps.send(picker.text, picker.buttons);
}

async function handleCodeforcesManualButton(
  chatId: number | string,
  messageId: number,
  callbackId: string,
  data: string,
  deps: CodeforcesManualUiDeps,
): Promise<void> {
  if (data === 'cfmanual:x') {
    await deps.answer(callbackId, 'Cancelled');
    await deps.edit(chatId, messageId, '✖️ Phone fallback cancelled.');
    return;
  }
  const account = (await deps.listAccounts()).find((item) => data === `cfmanual:${item.id}`);
  if (!account) {
    await deps.answer(callbackId, 'This button is no longer valid');
    await deps.edit(chatId, messageId, 'ðŸ” That Codeforces account is no longer active. Send /cfmanualnext again.');
    return;
  }
  const entry = await deps.nextEntry(account.id);
  if (!entry || entry.contestId === undefined || !entry.problemIndex) {
    await deps.answer(callbackId, 'No source available');
    await deps.edit(chatId, messageId, 'ðŸ“­ No next Codeforces source is available for this account.');
    return;
  }
  await deps.answer(callbackId, 'Ready 📱');
  await deps.edit(
    chatId,
    messageId,
    [
      `📱 Manual Codeforces submission for ${cfAccountName(account)}`,
      `Problem: ${entry.contestId}${entry.problemIndex}${entry.problemName ? ` â€” ${entry.problemName}` : ''}`,
      `Language: ${entry.language === 'python' ? 'Python 3' : 'GNU C++'}`,
      '',
      `1. Open source: ${entry.rawUrl}`,
      `2. Open submit page: ${submitPageUrl(entry)}`,
      '3. Paste the source and submit in the same Codeforces account on your phone.',
      '',
      'After an Accepted verdict, the next automatic or manual run detects it and moves to the following problem.',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Session removal (/removesession, /removeallsessions) â€” inline buttons
// ---------------------------------------------------------------------------

type InlineButton = { text: string; callback_data: string };

// ---------------------------------------------------------------------------
// LeetCode contest reward (/claimcoins) â€” multi-account inline picker
// ---------------------------------------------------------------------------

export interface CoinClaimUiDeps {
  listAccounts: () => Promise<AccountRecord[]>;
  claim: (account: AccountRecord) => Promise<ContestRewardResult>;
  busy: () => boolean;
  send: (text: string, buttons?: InlineButton[][]) => Promise<void>;
  edit: (chatId: number | string, messageId: number, text: string, buttons?: InlineButton[][]) => Promise<void>;
  answer: (callbackId: string, text?: string) => Promise<void>;
}

const coinClaimSelections = new Map<string, Set<string>>();
let coinClaimInProgress = false;

function coinHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const defaultCoinClaimUiDeps: CoinClaimUiDeps = {
  listAccounts: async () => (await listAccounts()).filter((account) => account.status !== AccountStatus.DISABLED),
  claim: claimContestRewardForAccount,
  busy: () => isRunInProgress() || Boolean(currentRangeJob()) || coinClaimInProgress,
  send: async (text, buttons) => {
    await tgApi('sendMessage', {
      chat_id: config.telegram.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
    });
  },
  edit: async (chatId, messageId, text, buttons) => {
    await tgApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: buttons ?? [] },
    });
  },
  answer: async (callbackId, text) => {
    await tgApi('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text, show_alert: true } : {}) });
  },
};

export function buildCoinClaimPicker(
  accounts: AccountRecord[],
  selected: ReadonlySet<string>,
): { text: string; buttons: InlineButton[][] } {
  const allSelected = accounts.length > 0 && accounts.every((account) => selected.has(account.id));
  const buttons = accounts.map((account) => [{
    text: `${selected.has(account.id) ? '✅' : 'â–«ï¸'} ${accountName(account)}`.slice(0, 60),
    callback_data: `lccoin:a:${account.id}`,
  }]);
  buttons.push([{
    text: `${allSelected ? '✅' : '👥'} ALL (${accounts.length})`,
    callback_data: 'lccoin:all',
  }]);
  buttons.push([
    { text: `ðŸŽ Claim selected (${selected.size})`, callback_data: 'lccoin:run' },
    { text: '✖️ Cancel', callback_data: 'lccoin:x' },
  ]);
  return {
    text: [
      '<b>ðŸŽ LEETCODE CONTEST REWARD</b>',
      '<code>â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”</code>',
      'Select one or more accounts, or choose ALL.',
      'The check only opens the contest reward area; daily submissions are not changed.',
    ].join('\n'),
    buttons,
  };
}

export async function handleCoinClaimCommand(
  deps: CoinClaimUiDeps = defaultCoinClaimUiDeps,
): Promise<void> {
  if (deps.busy()) {
    await deps.send('ðŸš§ A LeetCode process is already running. Try /claimcoins again after it finishes.');
    return;
  }
  const accounts = await deps.listAccounts();
  if (accounts.length === 0) {
    await deps.send('ðŸ“­ No active LeetCode accounts configured. Add one with /renew first.');
    return;
  }
  coinClaimSelections.set(config.telegram.chatId, new Set());
  const picker = buildCoinClaimPicker(accounts, new Set());
  await deps.send(picker.text, picker.buttons);
}

async function handleCoinClaimButton(
  chatId: number | string,
  messageId: number,
  callbackId: string,
  data: string,
  deps: CoinClaimUiDeps,
): Promise<void> {
  const key = String(chatId);
  if (data === 'lccoin:x') {
    coinClaimSelections.delete(key);
    await deps.answer(callbackId, 'Cancelled');
    await deps.edit(chatId, messageId, '✖️ Contest reward check cancelled.');
    return;
  }
  if (deps.busy()) {
    await deps.answer(callbackId, 'A LeetCode process is already running');
    await deps.edit(chatId, messageId, 'ðŸš§ A LeetCode process is already running. Send /claimcoins again after it finishes.');
    return;
  }
  const accounts = await deps.listAccounts();
  const selection = coinClaimSelections.get(key);
  if (!selection) {
    await deps.answer(callbackId, 'This picker expired');
    await deps.edit(chatId, messageId, 'âŒ› This account picker expired. Send /claimcoins again.');
    return;
  }

  if (data === 'lccoin:all') {
    const allSelected = accounts.every((account) => selection.has(account.id));
    selection.clear();
    if (!allSelected) accounts.forEach((account) => selection.add(account.id));
    await deps.answer(callbackId, allSelected ? 'Cleared' : 'All accounts selected');
    const picker = buildCoinClaimPicker(accounts, selection);
    await deps.edit(chatId, messageId, picker.text, picker.buttons);
    return;
  }

  if (data.startsWith('lccoin:a:')) {
    const id = data.slice('lccoin:a:'.length);
    if (!accounts.some((account) => account.id === id)) {
      await deps.answer(callbackId, 'Account no longer available');
      return;
    }
    if (selection.has(id)) selection.delete(id);
    else selection.add(id);
    await deps.answer(callbackId, selection.has(id) ? 'Selected' : 'Unselected');
    const picker = buildCoinClaimPicker(accounts, selection);
    await deps.edit(chatId, messageId, picker.text, picker.buttons);
    return;
  }

  if (data !== 'lccoin:run') {
    await deps.answer(callbackId);
    return;
  }
  const selectedAccounts = accounts.filter((account) => selection.has(account.id));
  if (selectedAccounts.length === 0) {
    await deps.answer(callbackId, 'Select at least one account');
    return;
  }

  coinClaimSelections.delete(key);
  coinClaimInProgress = true;
  await deps.answer(callbackId, 'Reward check started ðŸŽ');
  await deps.edit(
    chatId,
    messageId,
    `<b>ðŸŽ LEETCODE CONTEST REWARD</b>\n<code>â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”</code>\nðŸ”Ž Checking 0/${selectedAccounts.length} accountsâ€¦`,
  );
  void (async () => {
    const lines: string[] = [];
    try {
      for (let i = 0; i < selectedAccounts.length; i += 1) {
        const account = selectedAccounts[i]!;
        await deps.edit(
          chatId,
          messageId,
          [
            '<b>ðŸŽ LEETCODE CONTEST REWARD</b>',
            '<code>â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”</code>',
            ...lines,
            `ðŸ”Ž Checking ${i + 1}/${selectedAccounts.length} Â· ${coinHtml(accountName(account))}â€¦`,
          ].join('\n'),
        );
        const result = await deps.claim(account);
        if (result.claimed) lines.push(`✅ ${coinHtml(accountName(account))} â€” Coins offered collected`);
        else if (result.error) lines.push(`âŒ ${coinHtml(accountName(account))} â€” ${coinHtml(result.error.slice(0, 180))}`);
        else lines.push(`â–«ï¸ ${coinHtml(accountName(account))} â€” No coin offer available`);
      }
      await deps.edit(
        chatId,
        messageId,
        ['<b>ðŸŽ LEETCODE CONTEST REWARD</b>', '<code>â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”</code>', ...lines].join('\n'),
      );
    } catch (err) {
      await deps.edit(chatId, messageId, `⚠️ Reward check stopped: ${errText(err)}`).catch(() => undefined);
    } finally {
      coinClaimInProgress = false;
    }
  })();
}

/** Everything session removal touches â€” injectable for tests. */
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

const RUN_BUSY_TEXT = 'ðŸš§ A run is in progress right now - wait for its report, then try again (removing an account mid-run would break it).';

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
    await tgApi('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text, show_alert: true } : {}) });
  },
};

function accountName(a: AccountRecord): string {
  return a.username && a.username !== a.label ? `${a.label} (${a.username})` : a.label;
}

/** The session list + one "Remove" button per account. */
export function buildRemoveSessionView(accounts: AccountRecord[]): { text: string; buttons: InlineButton[][] } {
  if (accounts.length === 0) {
    return { text: 'ðŸ“­ No sessions stored - nothing to remove.', buttons: [] };
  }
  const lines = [`ðŸ—‚ï¸ Sessions stored: ${accounts.length}`, 'ðŸ‘‡ Tap an account to remove its session:', ''];
  accounts.forEach((a, i) => lines.push(`${i + 1}. ${accountName(a)} - ${a.status}`));
  const buttons = accounts.map((a) => [{ text: `ðŸ—‘ï¸ Remove ${accountName(a)}`.slice(0, 60), callback_data: `rm:${a.id}` }]);
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
      ...accounts.map((a) => `â–ªï¸ ${accountName(a)}`),
    ].join('\n'),
    [[
      { text: `ðŸ”¥ Yes, remove all ${accounts.length}`, callback_data: 'rmall:yes' },
      { text: 'Cancel', callback_data: 'rmall:no' },
    ]],
  );
}

function cfAccountName(a: { label: string; username?: string | null }): string {
  return a.username && a.username !== a.label ? `${a.label} (${a.username})` : a.label;
}

export function buildCfRemoveSessionView(accounts: any[]): { text: string; buttons: InlineButton[][] } {
  if (accounts.length === 0) {
    return { text: 'ðŸ“­ No Codeforces sessions stored - nothing to remove.', buttons: [] };
  }
  const lines = [`ðŸ—‚ï¸ Codeforces Sessions stored: ${accounts.length}`, 'ðŸ‘‡ Tap an account to remove its session:', ''];
  accounts.forEach((a, i) => lines.push(`${i + 1}. ${cfAccountName(a)} - ${a.status}`));
  const buttons = accounts.map((a) => [{ text: `ðŸ—‘ï¸ Remove ${cfAccountName(a)}`.slice(0, 60), callback_data: `cfrm:${a.id}` }]);
  buttons.push([{ text: `ðŸ”¥ Remove All`, callback_data: 'cfrmall:yes' }]);
  buttons.push([{ text: '✅ Done', callback_data: 'cfrm:done' }]);
  return { text: lines.join('\n'), buttons };
}

export async function handleCfRemoveSession(deps: RemovalDeps = defaultRemovalDeps): Promise<void> {
  const accounts = await listCodeforcesAccounts();
  const view = buildCfRemoveSessionView(accounts);
  await deps.send(view.text, view.buttons.length ? view.buttons : undefined);
}

/** Handles a tap on one of the inline buttons above. */
export async function handleCallbackQuery(
  q: TgCallbackQuery,
  deps: RemovalDeps = defaultRemovalDeps,
  ui: RangeUiDeps = defaultRangeUiDeps,
  codeforcesUi: CodeforcesSubmitUiDeps = defaultCodeforcesSubmitUiDeps,
  codeforcesManualUi: CodeforcesManualUiDeps = defaultCodeforcesManualUiDeps,
  codeforcesNetworkUi: CodeforcesNetworkUiDeps = defaultCodeforcesNetworkUiDeps,
  coinClaimUi: CoinClaimUiDeps = defaultCoinClaimUiDeps,
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

  if (data.startsWith('cfsub:')) {
    await handleCodeforcesSubmitButton(chatId, messageId, q.id, data, codeforcesUi);
    return;
  }

  if (data.startsWith('cfmanual:')) {
    await handleCodeforcesManualButton(chatId, messageId, q.id, data, codeforcesManualUi);
    return;
  }

  if (data.startsWith('cfnet:')) {
    await handleCodeforcesNetworkButton(chatId, messageId, q.id, data, codeforcesNetworkUi);
    return;
  }

  if (data.startsWith('lccoin:')) {
    await handleCoinClaimButton(chatId, messageId, q.id, data, coinClaimUi);
    return;
  }

  if (data === 'rm:done' || data === 'rmall:no') {
    await deps.answer(q.id, data === 'rmall:no' ? 'Cancelled' : undefined);
    await deps.edit(chatId, messageId, data === 'rmall:no' ? 'âŒ Cancelled - no sessions were removed.' : '✅ Done.');
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
      `ðŸ§¹ Removed all sessions (${removed} account(s)). Send cookie .json files to add accounts again.`,
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
      text = 'ðŸ¤· That account was already removed.';
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

  if (data === 'cfrm:done') {
    await deps.answer(q.id);
    await deps.edit(chatId, messageId, '✅ Done.');
    return;
  }

  if (data === 'cfrmall:yes') {
    if (isCodeforcesRunInProgress()) {
      await deps.answer(q.id, 'A Codeforces run is in progress - try again later');
      await deps.edit(chatId, messageId, 'ðŸš§ A Codeforces run is in progress right now - wait for its report, then try again.');
      return;
    }
    const removed = await deleteAllCodeforcesAccounts();
    logger.info({ removed }, 'all Codeforces account sessions removed via Telegram');
    await deps.answer(q.id, `Removed ${removed}`);
    await deps.edit(chatId, messageId, `ðŸ§¹ Removed all Codeforces sessions (${removed} account(s)). Send Codeforces cookie .json files to add accounts again.`);
    return;
  }

  if (data.startsWith('cfrm:')) {
    const id = data.slice(5);
    const before = await listCodeforcesAccounts();
    const target = before.find((a) => a.id === id);
    if (isCodeforcesRunInProgress()) {
      await deps.answer(q.id, 'A Codeforces run is in progress - try again later');
      await deps.send('ðŸš§ A Codeforces run is in progress right now - wait for its report, then try again.');
      return;
    }
    let text: string;
    if (!target || !(await deleteCodeforcesAccountById(id))) {
      text = 'ðŸ¤· That Codeforces account was already removed.';
    } else {
      logger.info({ label: target.label }, 'Codeforces account session removed via Telegram');
      text = `✅ Removed Codeforces account ${cfAccountName(target)}`;
    }
    const remaining = await listCodeforcesAccounts();
    await deps.answer(q.id, text);
    const view = buildCfRemoveSessionView(remaining);
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

/** Wiring for the range UI â€” injectable for tests. */
export interface RangeUiDeps {
  start: (range: QuestionRange, target: string | 'all') => Promise<StartRangeResult>;
  current: typeof currentRangeJob;
  cancel: typeof cancelRangeJob;
  now: () => number;
  queueLength?: () => number;
}

const defaultRangeUiDeps: RangeUiDeps = {
  start: (range, target) => startRangeJob(range, target, defaultRangeDeps(reply)),
  current: currentRangeJob,
  cancel: cancelRangeJob,
  now: () => Date.now(),
  queueLength: rangeQueueLength,
};

/** Account picker: one button per account, then "All accounts" and Cancel. */
export function buildRangePicker(
  range: QuestionRange,
  accounts: AccountRecord[],
): { text: string; buttons: InlineButton[][] } {
  const size = rangeSize(range);
  const tag = `${range.from}-${range.to}`;
  const text = [
    `ðŸŽ¯ Question range #${range.from}â€“#${range.to} (${size} question${size === 1 ? '' : 's'})`,
    '',
    'ðŸ‘‡ Pick the account to run it on:',
    `â³ Estimated ~${formatDuration(estimateAccountMs(range, RANGE_GAP_MS))} per account (30 s break between questions)`,
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
  if (!arg.trim()) {
    pendingRangePrompt = true;
    await deps.send('ðŸŽ¯ Which questions? Send the range, e.g. 200-400\n(or in one go: /questionrangesubmission 200-400)');
    return;
  }
  const parsed = parseQuestionRange(arg);
  if (!parsed.ok) {
    await deps.send(`⚠️ ${parsed.error}\nExample: /questionrangesubmission 200-400`);
    return;
  }
  const accounts = await deps.listAccounts();
  if (accounts.length === 0) {
    await deps.send('ðŸ“­ No accounts configured â€” send cookie .json files first (/renew).');
    return;
  }
  const picker = buildRangePicker(parsed.range, accounts);
  if (ui.current()) {
    picker.text += '\n\nðŸ—‚ï¸ A range process is already running. This request will be queued and started automatically after the current job completes or is cancelled.';
  }
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
    await deps.edit(chatId, messageId, '✖️ Question-range submission cancelled â€” nothing was started.');
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
    if ('queued' in result) {
      await deps.answer(callbackId, `Queued #${result.position} ðŸ—‚ï¸`);
      await deps.edit(
        chatId,
        messageId,
        [
          `ðŸ—‚ï¸ Queued: questions #${parsed.range.from}â€“#${parsed.range.to} (${rangeSize(parsed.range)})`,
          `ðŸ“ Queue position: ${result.position}`,
          `👥 ${result.accounts.length === 1 ? `Account: ${result.accounts[0]?.label ?? 'unknown'}` : `Accounts (one by one): ${result.accounts.map((a) => a.label).join(', ')}`}`,
          '',
          'â³ It will start automatically after the current range job completes or is cancelled.',
          'ðŸ“ /rangestatus shows the active job and queue.',
        ].join('\n'),
      );
    } else {
      await deps.answer(callbackId, 'Account not found');
      await deps.edit(
        chatId,
        messageId,
        result.reason === 'no-accounts'
          ? 'ðŸ“­ No accounts configured â€” send cookie .json files first.'
          : 'ðŸ” That account no longer exists â€” send /questionrangesubmission again.',
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
      `🚀 Started: questions #${range.from}â€“#${range.to} (${rangeSize(range)})`,
      `👥 ${names.length === 1 ? `Account: ${names[0]}` : `Accounts (one by one): ${names.join(', ')}`}`,
      `â³ ~${formatDuration(estimateAccountMs(range, RANGE_GAP_MS) * names.length)} in total â€” 30 s break between questions`,
      '',
      'ðŸ“¬ You get a summary after each account.',
      'ðŸ“ /rangestatus shows progress Â· ðŸ›‘ /cancelrange stops it',
    ].join('\n'),
  );
}

export async function handleCancelRange(ui: RangeUiDeps = defaultRangeUiDeps): Promise<void> {
  const job = ui.current();
  if (!job || !ui.cancel()) {
    await reply('ðŸ¤· No question-range process is running.');
    return;
  }
  await reply(
    `ðŸ›‘ Cancelling the question-range job (#${job.range.from}â€“#${job.range.to})â€¦\nIt stops right after the current question â€” the summary for ${job.currentLabel ?? 'the current account'} follows.`,
  );
}

export async function handleRangeStatus(ui: RangeUiDeps = defaultRangeUiDeps): Promise<void> {
  const job = ui.current();
  const queued = ui.queueLength?.() ?? rangeQueueLength();
  await reply(
    job
      ? formatRangeJobStatus(job, ui.now(), queued)
      : queued > 0
        ? `ðŸ—‚ï¸ ${queued} range job(s) waiting in the queue. A waiting job starts automatically when the active job finishes or is cancelled.`
        : 'ðŸ’¤ No question-range process is running. Start one with /questionrangesubmission 200-400',
  );
}

/** Pending /renew <label> target â€” consumed by the next cookie payload. */
let pendingRenewalLabel: string | undefined;

async function accountsText(): Promise<string> {
  const [accounts, codeforces] = await Promise.all([listAccounts(), listCodeforcesAccounts(true)]);
  const lines = [
    '<b>âœ¦ ACCOUNT HUB</b>  <i>live snapshot</i>',
    '<code>â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”</code>',
    '',
    `<b>ðŸŸ© LEETCODE</b>  <code>${accounts.length} connected</code>`,
  ];
  if (accounts.length === 0) {
    lines.push('ðŸ“­ No LeetCode accounts configured. Send /renew with a cookie export.');
  }
  for (const a of accounts) {
    const who = a.username ? ` (${escapeHtml(a.username)})` : '';
    const accepted = await latestAcceptedRunForAccount(a.id);
    const acceptedText = accepted ? `AC ${humanLocal(accepted.updatedAt)}` : 'no accepted run';
    const checkedText = a.lastCheckedAt ? ` Â· checked ${humanLocal(a.lastCheckedAt)}` : '';
    lines.push(`${accountStatusIcon(a.status)} <b>${escapeHtml(a.label)}</b>${who}  <i>${escapeHtml(acceptedText)}${escapeHtml(checkedText)}</i>`);
    if (a.lastError) lines.push(`   â”” ⚠️ <i>${escapeHtml(a.lastError.slice(0, 120))}</i>`);
  }
  lines.push('', '<code>â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”</code>', '', `<b>ðŸ† CODEFORCES</b>  <code>${codeforces.length} connected</code>`);
  if (codeforces.length === 0) lines.push('ðŸ“­ No Codeforces accounts configured.');
  for (const account of codeforces) {
    const progress = await getCodeforcesProgress(account.id);
    const who = account.username ? ` (${escapeHtml(account.username)})` : '';
    const verdict = progress.lastVerdict ? ` Â· <i>${escapeHtml(progress.lastVerdict)}</i>` : '';
    lines.push(`${accountStatusIcon(account.status)} <b>${escapeHtml(account.label)}</b>${who}${verdict}`);
    lines.push(`   â”” next <code>${escapeHtml(progress.nextKey ?? 'first queued source')}</code>${progress.lastSubmissionId ? ` Â· #<code>${escapeHtml(progress.lastSubmissionId)}</code>` : ''}`);
    if (account.lastError) lines.push(`   â”” ⚠️ <i>${escapeHtml(account.lastError.slice(0, 140))}</i>`);
  }
  return lines.join('\n');
}

async function codeforcesAccountsText(): Promise<string> {
  const accounts = await listCodeforcesAccounts(true);
  if (accounts.length === 0) return 'ðŸ“­ No Codeforces accounts configured. Send /renew with a Codeforces session JSON.';
  const lines = [`<b>ðŸ† CODEFORCES</b>  <code>${accounts.length} connected</code>`, '<i>queue Â· verdict Â· transport health</i>', '<code>â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”</code>', ''];
  for (const account of accounts) {
    const progress = await (await import('../codeforces/storage')).getCodeforcesProgress(account.id);
    lines.push(`${accountStatusIcon(account.status)} <b>${escapeHtml(account.label)}</b>${account.username ? ` (${escapeHtml(account.username)})` : ''}${progress.lastVerdict ? ` Â· <i>${escapeHtml(progress.lastVerdict)}</i>` : ''}`);
    lines.push(`   â”” next <code>${escapeHtml(progress.nextKey ?? 'first queued source')}</code>${progress.lastSubmissionId ? ` Â· #<code>${escapeHtml(progress.lastSubmissionId)}</code>` : ''}`);
    if (account.lastError) lines.push(`   â”” ⚠️ <i>${escapeHtml(account.lastError.slice(0, 140))}</i>`);
  }
  return lines.join('\n');
}

async function statusText(): Promise<string> {
  const [sys, last, lastAccepted, accounts, codeforces] = await Promise.all([
    getAllSystemState(),
    latestRun(),
    latestAcceptedRun(),
    listAccounts(),
    listCodeforcesAccounts(true),
  ]);
  const active = accounts.filter((a) => a.status === AccountStatus.ACTIVE).length;
  const expired = accounts.filter((a) => a.status === AccountStatus.EXPIRED).length;
  const rejected = accounts.filter((a) => a.status === AccountStatus.REJECTED).length;
  const lines = [
    '<b>â—ˆ AGENT PULSE</b>  <i>platform health</i>',
    '<code>â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”</code>',
    '',
    `<b>ðŸŸ© LEETCODE</b>  <code>${accounts.length} total</code>`,
    `👥 <b>${active}</b> active Â· <i>${expired} expired Â· ${rejected} rejected</i>`,
    `ðŸ” <i>${escapeHtml(String(sys['authStatus'] ?? 'unknown'))}</i>${sys['authUsername'] ? ` Â· ${escapeHtml(String(sys['authUsername']))}` : ''}`,
  ];
  if (lastAccepted) {
    lines.push(
      `✅ <b>${escapeHtml(lastAccepted.title)}</b>${lastAccepted.submissionStatus ? ` Â· <i>${escapeHtml(lastAccepted.submissionStatus)}</i>` : ''} Â· ${escapeHtml(humanLocal(lastAccepted.updatedAt))}`,
    );
  } else {
    lines.push('✅ Last accepted: <i>none recorded</i>');
  }
  if (last && last.state !== 'SUCCESS' && last.error) lines.push(`â— Latest run error: <i>${escapeHtml(last.error.slice(0, 300))}</i>`);
  lines.push('', '<code>â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”</code>', '', `<b>ðŸ† CODEFORCES</b>  <code>${codeforces.length} total</code>`);
  if (codeforces.length === 0) {
    lines.push('ðŸ“­ No Codeforces accounts configured.');
  } else {
    for (const account of codeforces) {
      const progress = await getCodeforcesProgress(account.id);
      const who = account.username ? ` (${escapeHtml(account.username)})` : '';
      const verdict = progress.lastVerdict ? ` â€” <i>${escapeHtml(progress.lastVerdict)}</i>` : '';
      lines.push(`${accountStatusIcon(account.status)} <b>${escapeHtml(account.label)}</b>${who}${verdict}`);
      lines.push(`   â”” next <code>${escapeHtml(progress.nextKey ?? 'queued')}</code>`);
    }
  }
  return lines.join('\n');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function accountStatusIcon(status: string): string {
  switch (status.toUpperCase()) {
    case 'ACTIVE': return 'ðŸŸ¢';
    case 'EXPIRED': return 'ðŸŸ ';
    case 'REJECTED': return 'ðŸ”´';
    case 'DISABLED': return 'âš«';
    default: return 'âšª';
  }
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

async function replyHtml(text: string): Promise<void> {
  await sendTelegramMessage(text, { parseMode: 'HTML', disableWebPagePreview: true });
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
