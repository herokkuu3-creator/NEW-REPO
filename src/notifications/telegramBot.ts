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
import {
  CODEFORCES_MANUAL_REASON,
  cancelCodeforcesRun,
  formatCodeforcesRangeStatus,
  getCodeforcesRangeStatus,
  isCodeforcesRunInProgress,
  resolveCurrentEntry,
  runCodeforcesNow,
  type CodeforcesNetworkMode,
} from '../codeforces/worker';
import {
  isCodeChefRunInProgress,
  runCodeChefNow,
  formatCodeChefAccountMessage,
  cancelCodeChefRun,
  getCodeChefRangeStatus,
  formatCodeChefRangeStatus,
} from '../codechef/worker';
import { listCodeChefAccounts, getCodeChefProgress as getCodeChefAccountProgress } from '../codechef/storage';
import { deleteCodeforcesAccountById, deleteAllCodeforcesAccounts, getCodeforcesProgress, listCodeforcesAccounts } from '../codeforces/storage';
import { formatCodeforcesAccountMessage, summarizeCodeforcesReport } from '../codeforces/report';
import { loadRuntimeSourceIndex, SourceIndexEntry } from '../codeforces/sourceRepo';
import { submitPageUrl } from '../codeforces/handoff';
import {
  getAllConfiguredProxies,
  removeProxyByIndex,
  addCustomProxy,
  addCustomProxies,
  restoreAllProxies,
  testAllProxiesOneByOne,
  fetchRemoteSyncedProxies,
} from '../codeforces/proxyManager';
import { testProxyDetailed } from '../codeforces/proxyRotator';
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
  '<b>⚡ 𝗟𝗘𝗘𝗧𝗖𝗢𝗗𝗘 𝗗𝗔𝗜𝗟𝗬 𝗔𝗚𝗘𝗡𝗧 ⚡</b>',
  '<i>Autonomous Multi-Platform Coding Assistant</i>',
  '<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>',
  '',
  '<b>✨ 𝗟𝗘𝗘𝗧𝗖𝗢𝗗𝗘 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦</b>',
  '├ <code>/triggersubmission</code> — Submit today’s daily question',
  '├ <code>/claimcoins</code> — Collect contest coins &amp; rewards',
  '├ <code>/questionrangesubmission</code> — Range solver <i>(e.g. 200-400)</i>',
  '├ <code>/rangestatus</code> — Check active range job progress',
  '├ <code>/cancelrange</code> — Stop running range job',
  '└ <code>/accounts</code> — View LeetCode accounts &amp; session status',
  '',
  '<b>🏆 𝗖𝗢𝗗𝗘𝗙𝗢𝗥𝗖𝗘𝗦 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦</b>',
  '├ <code>/submitnextsolution</code> — Submit next problem for all accounts',
  '├ <code>/cfrange</code> <i>&lt;count&gt;</i> — Batch submit next N problems <i>(30s human pacing)</i>',
  '├ <code>/cfrangestatus</code> — Live batch progress &amp; ETA countdown',
  '├ <code>/cfcancelrange</code> — Cancel active batch submission',
  '├ <code>/nextsubcustomaccount</code> — Select specific account to submit',
  '├ <code>/cfnetwork</code> — Switch network mode (Proxy / Tailscale)',
  '├ <code>/cfmanualnext</code> — Get next source &amp; mobile submit link',
  '├ <code>/cfaccounts</code> — View Codeforces accounts &amp; verdicts',
  '└ <code>/cf_clear_cookies</code> — Delete Codeforces stored sessions',
  '',
  '<b>🌐 𝗣𝗥𝗢𝗫𝗬 &amp; 𝗡𝗘𝗧𝗪𝗢𝗥𝗞</b>',
  '├ <code>/testproxy</code> — Test each proxy one-by-one &amp; show live health',
  '├ <code>/setproxies</code> <i>&lt;urls&gt;</i> — Save &amp; verify multiple proxies in DB',
  '├ <code>/addproxy</code> <i>&lt;url&gt;</i> — Add proxy to active pool',
  '├ <code>/removeproxy</code> <i>&lt;number&gt;</i> — Blacklist &amp; remove dead proxy in DB',
  '├ <code>/restoreproxies</code> — Reset blacklist &amp; restore all proxies',
  '├ <code>/syncproxies</code> — Sync proxies from GitHub Actions runner',
  '└ <code>/cfnetwork</code> — Switch network mode (Proxy / Tailscale)',
  '',
  '<b>👨‍🍳 𝗖𝗢𝗗𝗘𝗖𝗛𝗘𝗙 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦</b>',
  '├ <code>/codechef</code> — Run daily CodeChef submission',
  '├ <code>/ccnextsubmit</code> — Force submit next solution in queue',
  '├ <code>/ccrange</code> <i>&lt;count&gt;</i> — Batch submit next N problems <i>(30s human pacing)</i>',
  '├ <code>/ccrangestatus</code> — Live batch progress &amp; ETA countdown',
  '├ <code>/cccancelrange</code> — Cancel active batch submission',
  '└ <code>/ccaccounts</code> — View CodeChef accounts &amp; queue progress',
  '',
  '<b>🍪 𝗦𝗘𝗦𝗦𝗜𝗢𝗡 𝗠𝗔𝗡𝗔𝗚𝗘𝗠𝗘𝗡𝗧</b>',
  '├ <code>/renew</code> — Session renewal guide &amp; instructions',
  '├ <code>/renew</code> <i>&lt;label&gt;</i> — Tag next uploaded JSON with label',
  '├ <code>/removesession</code> — Remove a single account session',
  '└ <code>/removeallsessions</code> — Purge all stored accounts',
  '',
  '<b>📊 𝗦𝗬𝗦𝗧𝗘𝗠 &amp; 𝗜𝗡𝗙𝗢</b>',
  '├ <code>/status</code> — System uptime &amp; last run summary',
  '├ <code>/cancel</code> — Abort ongoing prompt / renewal',
  '└ <code>/help</code> — Display this command menu',
  '',
  '<blockquote>💡 <b>Pro Tip:</b> Tap any command above to run it instantly! To add accounts, simply drop a browser cookie JSON file into this chat.</blockquote>',
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

export function extractTelegramCommand(text: string): { command: string; arg: string } {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return { command: '', arg: '' };
  }
  const match = trimmed.match(/^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s+([\s\S]*))?$/);
  if (!match) {
    const firstSpace = trimmed.search(/\s/);
    if (firstSpace === -1) {
      return { command: trimmed.split('@')[0]!.toLowerCase(), arg: '' };
    }
    return {
      command: trimmed.slice(0, firstSpace).split('@')[0]!.toLowerCase(),
      arg: trimmed.slice(firstSpace).trim(),
    };
  }
  return {
    command: `/${match[1]!.toLowerCase()}`,
    arg: (match[2] ?? '').trim(),
  };
}

export function isLikelyProxyPayload(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('[') || trimmed.startsWith('{')) {
    return false;
  }
  const lines = trimmed.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every((line) => {
    return (
      /^(?:https?|socks[45]h?):\/\/\S+/i.test(line) ||
      /^(?:[^:@\s]+:[^@\s]+@)?[a-zA-Z0-9_.-]+:\d+$/i.test(line) ||
      /^[a-zA-Z0-9_.-]+:\d+:[^:@\s]+:[^@\s]+$/i.test(line)
    );
  });
}

async function handleMessage(msg: TgMessage): Promise<void> {
  // Access control: one allowed chat only.
  if (String(msg.chat.id) !== config.telegram.chatId) {
    logger.warn('telegram: ignored a message from an unknown chat');
    return;
  }

  const text = (msg.text ?? '').trim();
  if (text.startsWith('/')) {
    const { command: cmd, arg: commandArg } = extractTelegramCommand(text);
    switch (cmd) {
      case '/start':
      case '/help':
        await replyHtml(HELP_TEXT);
        return;
      case '/renew': {
        if (!commandArg) {
          pendingRenewalLabel = undefined;
          pendingRangePrompt = false;
          await reply(RENEW_INSTRUCTIONS);
          return;
        }
        if (!ACCOUNT_LABEL_RE.test(commandArg)) {
          await reply('Labels may contain letters, digits, dot, dash and underscore (max 32 characters). Try again, e.g. /renew main');
          return;
        }
        pendingRenewalLabel = commandArg;
        await reply(`🏷️ Renewing the "${commandArg}" account. Send its cookie export (text or file) in your next message. /cancel aborts.`);
        return;
      }
      case '/accounts':
        await replyHtml(await accountsText());
        return;
      case '/status':
        await replyHtml(await statusText());
        return;
      case '/codechef':
        await handleCodeChefTrigger({ forceNext: false });
        return;
      case '/ccnextsubmit':
      case '/cc_next_submit':
      case '/ccnext':
      case '/cc_next':
      case '/ccsubmit':
      case '/cc_submit':
        await handleCodeChefTrigger({ forceNext: true });
        return;
      case '/ccrange':
      case '/cc_range':
      case '/ccbatch':
      case '/cc_batch': {
        const parsedCount = Number.parseInt(commandArg, 10);
        if (!Number.isFinite(parsedCount) || parsedCount <= 0) {
          await replyHtml(
            [
              '<b>🔢 CodeChef Batch Submission</b>',
              '<code>━━━━━━━━━━━━━━━━━━━━</code>',
              'Please specify how many questions to submit:',
              '👉 <code>/ccrange 5</code> (submit next 5 questions)',
              '👉 <code>/ccrange 10</code> (submit next 10 questions)',
            ].join('\n'),
          );
          return;
        }
        const count = Math.min(50, Math.max(1, parsedCount));
        await handleCodeChefTrigger({ forceNext: true, count });
        return;
      }
      case '/ccaccounts':
      case '/cc_accounts':
        await replyHtml(await codechefAccountsText());
        return;
      case '/ccrangestatus':
      case '/cc_range_status':
      case '/ccstatusrange':
      case '/cc_status_range':
        await handleCodeChefRangeStatus();
        return;
      case '/cccancelrange':
      case '/cc_cancel_range':
      case '/cccancel':
      case '/cc_cancel':
      case '/cancelccrange':
      case '/cancel_cc_range':
        await handleCancelCodeChefRange();
        return;
      case '/submitnextsolution':
      case '/submit_next_solution':
        await handleCodeforcesSubmitNext();
        return;
      case '/cfrange':
      case '/cf_range':
      case '/cfbatch':
      case '/cf_batch': {
        const parsedCount = parseInt(commandArg, 10);
        if (!commandArg || isNaN(parsedCount) || parsedCount <= 0) {
          await replyHtml(
            [
              '<b>🔢 Codeforces Batch Submission</b>',
              '<code>━━━━━━━━━━━━━━━━━━━━</code>',
              'Please specify how many questions to submit:',
              '👉 <code>/cfrange 5</code> (submit next 5 questions)',
              '👉 <code>/cfrange 10</code> (submit next 10 questions)',
            ].join('\n'),
          );
          return;
        }
        const count = Math.min(50, Math.max(1, parsedCount));
        await handleCodeforcesTrigger({ forceNext: true, count });
        return;
      }
      case '/cfrangestatus':
      case '/cf_range_status':
      case '/cfstatusrange':
      case '/cf_status_range':
        await handleCodeforcesRangeStatus();
        return;
      case '/cfcancelrange':
      case '/cf_cancel_range':
      case '/cfcancel':
      case '/cf_cancel':
      case '/cancelcfrange':
      case '/cancel_cf_range':
        await handleCancelCodeforcesRange();
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
      case '/testproxy':
      case '/testproxies':
      case '/cfproxy':
      case '/cfproxies':
      case '/proxytest':
      case '/proxystatus':
        await handleTestProxyCommand();
        return;
      case '/removeproxy':
      case '/cfremoveproxy':
      case '/rmproxy': {
        await handleRemoveProxyCommand(commandArg);
        return;
      }
      case '/setproxies':
      case '/setproxy':
      case '/addproxies':
      case '/addproxy':
      case '/cfaddproxy':
      case '/cfsetproxies': {
        await handleAddProxyCommand(commandArg);
        return;
      }
      case '/syncproxies':
      case '/syncproxy':
      case '/cfsyncproxies':
        await handleSyncProxiesCommand();
        return;
      case '/restoreproxies':
      case '/resetproxies':
      case '/restoreproxy':
        await handleRestoreProxiesCommand();
        return;
      case '/cfaccounts':
      case '/cf_accounts':
        await replyHtml(await codeforcesAccountsText());
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
        await handleQuestionRangeCommand(commandArg);
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
        if (getCodeforcesRangeStatus() && getCodeforcesRangeStatus()?.state !== 'idle') {
          await handleCancelCodeforcesRange();
          return;
        }
        if (getCodeChefRangeStatus() && getCodeChefRangeStatus()?.state !== 'idle') {
          await handleCancelCodeChefRange();
          return;
        }
        await reply(
          currentRangeJob()
            ? '❌ No renewal is in progress. To stop the question-range job, send /cancelrange.'
            : '❌ No renewal is in progress. When you are ready, send /renew (or /renew <label>) and then the cookies.',
        );
        return;
      default:
        await reply('🤔 Unknown command. Available: /renew, /renew <label>, /accounts, /cfaccounts, /status, /triggersubmission, /claimcoins, /submitnextsolution, /cfrange, /cfrangestatus, /cfcancelrange, /codechef, /ccrange, /ccrangestatus, /cccancelrange, /nextsubcustomaccount, /cfnetwork, /testproxy, /setproxies, /addproxy, /removeproxy, /restoreproxies, /syncproxies, /cfmanualnext, /questionrangesubmission, /rangestatus, /cancelrange, /removesession, /removeallsessions, /cancel, /help');
        return;
    }
  }

  // Reply to "/questionrangesubmission" without a range: the next "200-400" message.
  if (pendingRangePrompt && !msg.document && /^\s*#?\d/.test(text)) {
    pendingRangePrompt = false;
    await handleQuestionRangeCommand(text);
    return;
  }

  // Non-command message: check if it's pasted proxy list first
  if (!msg.document && isLikelyProxyPayload(text)) {
    await handleAddProxyCommand(text);
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
export interface CodeChefAccountSectionState {
  accIndex: number;
  label: string;
  username?: string | null;
  completedItems: string[];
  activeLine?: string;
  accountStatus?: string;
}

export function renderCodeChefProgressSections(
  sections: ReadonlyMap<number, CodeChefAccountSectionState>,
  totalAccounts: number,
): string[] {
  const sorted = [...sections.values()].sort((a, b) => a.accIndex - b.accIndex);
  if (sorted.length === 0) {
    return ['<i>Waiting for progress updates…</i>'];
  }

  const effectiveTotal = Math.max(totalAccounts, sorted.length);
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const buildBlocks = (pruneThreshold?: number): string[] => {
    return sorted.map((sec) => {
      const accNum = sec.accIndex + 1;
      const name = escape(sec.username ?? sec.label);
      const header = `👤 <b>Account ${accNum}/${effectiveTotal} · <code>${name}</code></b>`;

      let completed = sec.completedItems;
      let prunedNotice: string | null = null;
      if (pruneThreshold && completed.length > pruneThreshold) {
        const skippedCount = completed.length - pruneThreshold;
        prunedNotice = `<i>… ${skippedCount} earlier completed question(s)</i>`;
        completed = completed.slice(completed.length - pruneThreshold);
      }

      const items: string[] = [];
      if (prunedNotice) items.push(prunedNotice);
      items.push(...completed);

      if (sec.activeLine) {
        items.push(sec.activeLine);
      } else if (sec.accountStatus && items.length === 0) {
        items.push(sec.accountStatus);
      }

      if (items.length === 0) {
        items.push('⏳ Queued…');
      }

      const treeLines = items.map((item, idx) => {
        const isLast = idx === items.length - 1;
        const connector = isLast ? '└ ' : '├ ';
        return `${connector}${item}`;
      });

      return [header, ...treeLines].join('\n');
    });
  };

  let blocks = buildBlocks();
  if (blocks.join('\n\n').length > 3400) {
    blocks = buildBlocks(6);
  }
  if (blocks.join('\n\n').length > 3400) {
    blocks = buildBlocks(3);
  }

  return blocks;
}

export function renderCodeChefProgressLines(progress: ReadonlyMap<number, string>): string[] {
  const rows = [...progress.entries()].sort(([a], [b]) => a - b);
  const selected: string[] = [];
  let size = 0;
  for (const [, text] of rows.reverse()) {
    const row = text.length <= 1800 ? text : `Result recorded; see /accounts for details.`;
    if (size + row.length > 3400) break;
    selected.unshift(row);
    size += row.length + 1;
  }
  return selected;
}

export async function handleCodeChefTrigger(
  runnerOrOptions?: typeof runCodeChefNow | { forceNext?: boolean; count?: number },
  isBusyOrRunner?: (() => boolean) | typeof runCodeChefNow,
  sendOrIsBusy?: ((text: string) => Promise<void>) | (() => boolean),
): Promise<{ done: Promise<void> } | null> {
  let options: { forceNext?: boolean; count?: number } = {};
  let runner: typeof runCodeChefNow = runCodeChefNow;
  let isBusy: () => boolean = isCodeChefRunInProgress;
  let send: ((text: string) => Promise<void>) | undefined;

  if (typeof runnerOrOptions === 'function') {
    runner = runnerOrOptions;
    if (typeof isBusyOrRunner === 'function') isBusy = isBusyOrRunner as () => boolean;
    if (typeof sendOrIsBusy === 'function') send = sendOrIsBusy as (text: string) => Promise<void>;
  } else if (typeof runnerOrOptions === 'object' && runnerOrOptions !== null) {
    options = runnerOrOptions;
    if (typeof isBusyOrRunner === 'function') runner = isBusyOrRunner as typeof runCodeChefNow;
    if (typeof sendOrIsBusy === 'function') isBusy = sendOrIsBusy as () => boolean;
  }

  if (isBusy()) {
    if (send) await send('A CodeChef run is already active. Please wait for its result.');
    else await reply('🚧 A CodeChef run is already in progress — wait for its report, then try again.');
    return null;
  }

  if (send) {
    await send('👨‍🍳 CodeChef: checking configured accounts and submitting the next pending source.');
    const done = runner('manual').then(async (report) => {
      if (!report) await send!('Another CodeChef run started; this command did not create a second run.');
    }).catch(async (err) => {
      await send!(`CodeChef could not start: ${err instanceof Error ? err.message : String(err)}`);
    });
    return { done };
  }

  const configuredAccounts = await listCodeChefAccounts(true).catch(() => []);
  const initialTotalAccounts = Math.max(1, configuredAccounts.length);
  const accountSections = new Map<number, CodeChefAccountSectionState>();

  for (let i = 0; i < configuredAccounts.length; i++) {
    const acc = configuredAccounts[i];
    if (!acc) continue;
    accountSections.set(i, {
      accIndex: i,
      label: acc.label,
      username: acc.username,
      completedItems: [],
      activeLine: i === 0 ? '🔎 Initializing session…' : '⏳ Queued…',
    });
  }

  const title = options.count && options.count > 1
    ? `<b>👨‍🍳 CODECHEF BATCH (${options.count} Questions)</b>`
    : options.forceNext
      ? `<b>👨‍🍳 CODECHEF NEXT SUBMISSION</b>`
      : `<b>👨‍🍳 CODECHEF SUBMISSION</b>`;

  const initialSubtitle = options.count && options.count > 1
    ? `🔎 Initializing batch (${options.count} questions)…\n<i>⏳ 30s pacing between questions · /ccrangestatus · /cccancelrange</i>`
    : `🔎 Initializing CodeChef…`;

  const initialBlocks = configuredAccounts.length > 0
    ? renderCodeChefProgressSections(accountSections, initialTotalAccounts).join('\n\n')
    : initialSubtitle;

  const statusMessage = await tgApi<{ message_id: number }>('sendMessage', {
    chat_id: config.telegram.chatId,
    text: `${title}\n<code>━━━━━━━━━━━━━━━━━━━━</code>\n${initialBlocks}`,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });

  const html = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let totalAccounts = initialTotalAccounts;

  const editProgress = async (extraFooter?: string): Promise<boolean> => {
    const blocks = renderCodeChefProgressSections(accountSections, totalAccounts);
    let body = blocks.join('\n\n');
    if (extraFooter) body += extraFooter;

    const fullText = `${title}\n<code>━━━━━━━━━━━━━━━━━━━━</code>\n${body}`;

    const updated = await tgApi('editMessageText', {
      chat_id: config.telegram.chatId,
      message_id: statusMessage.message_id,
      text: fullText,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }).then(() => true).catch((err) => {
      if (/message is not modified/i.test(errText(err))) return true;
      logger.warn({ err: errText(err) }, 'could not update CodeChef progress message');
      return false;
    });
    return updated;
  };

  const done = (async () => {
    const report = await runner('manual', {
      forceDailyAttempt: options.forceNext ?? false,
      batchCount: options.count ?? 1,
      onProgress: async (event) => {
        if (event.accTotal && event.accTotal > totalAccounts) {
          totalAccounts = event.accTotal;
        }
        const accIdx = event.accIndex ?? Math.max(0, event.index - 1);
        let sec = accountSections.get(accIdx);
        if (!sec) {
          sec = {
            accIndex: accIdx,
            label: event.label,
            username: event.username,
            completedItems: [],
          };
          accountSections.set(accIdx, sec);
        }
        if (event.username && !sec.username) {
          sec.username = event.username;
        }

        const stepPrefix = event.stepTotal && event.stepTotal > 1 ? `[${event.stepIndex ?? 1}/${event.stepTotal}] ` : '';
        const probTag = event.problemCode ? `<code>${html(event.problemCode)}</code>` : '';

        switch (event.phase) {
          case 'checking':
            sec.activeLine = '🔎 Checking session…';
            break;
          case 'logging-in':
            sec.activeLine = '🔑 Logging in to CodeChef…';
            break;
          case 'session-ready':
            sec.activeLine = '🍪 Session verified';
            break;
          case 'loading-source':
            sec.activeLine = `📦 ${stepPrefix}Source loaded${probTag ? ` · ${probTag}` : ''}`;
            break;
          case 'opening-submit':
            sec.activeLine = `🖥️ ${stepPrefix}Opening submit page${probTag ? ` · ${probTag}` : ''}`;
            break;
          case 'submitting':
            sec.activeLine = `🚀 ${stepPrefix}Submitting signed form${probTag ? ` · ${probTag}` : ''}`;
            break;
          case 'judging':
            sec.activeLine = `⏳ ${stepPrefix}Waiting for CodeChef verdict${probTag ? ` · ${probTag}` : ''}`;
            break;
          case 'completed': {
            const verdict = html(event.verdict ?? 'Accepted');
            const sub = event.submissionId
              ? ` · <a href="https://www.codechef.com/viewsolution/${html(event.submissionId)}">#${html(event.submissionId)}</a>`
              : '';
            const line = `✅ ${stepPrefix}${probTag ? `${probTag} — ` : ''}<b>${verdict}</b>${sub}`;
            sec.completedItems.push(line);
            sec.activeLine = undefined;
            break;
          }
          case 'failed': {
            const err = html(event.error ?? 'Failed');
            const line = `❌ ${stepPrefix}${probTag ? `${probTag} — ` : ''}<i>${err}</i>`;
            sec.completedItems.push(line);
            sec.activeLine = undefined;
            break;
          }
          case 'skipped': {
            const err = html(event.error ?? 'Skipped');
            const line = `⏭️ ${stepPrefix}${probTag ? `${probTag} — ` : ''}<i>${err}</i>`;
            sec.completedItems.push(line);
            sec.activeLine = undefined;
            break;
          }
          case 'waiting': {
            const nextStep = (event.stepIndex ?? 1) + 1;
            const nextStepStr = event.stepTotal && event.stepTotal > 1 ? ` before question [${nextStep}/${event.stepTotal}]` : '';
            sec.activeLine = `⏳ Waiting ${event.waitSeconds ?? 30}s${nextStepStr} (human pacing)…`;
            break;
          }
          case 'cancelled':
            sec.activeLine = '🛑 Batch cancelled by user';
            sec.accountStatus = '🛑 Cancelled';
            break;
          default:
            sec.activeLine = `⚙️ ${event.phase}${probTag ? ` · ${probTag}` : ''}`;
            break;
        }

        await editProgress();
      },
      onAccountOutcome: async () => {
        await editProgress();
      },
    });

    if (!report) {
      await tgApi('editMessageText', {
        chat_id: config.telegram.chatId,
        message_id: statusMessage.message_id,
        text: `${title}\n<code>━━━━━━━━━━━━━━━━━━━━</code>\n⏳ Not started: another run began concurrently.`,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }).catch(() => undefined);
    } else if (report.outcomes.length === 0) {
      await tgApi('editMessageText', {
        chat_id: config.telegram.chatId,
        message_id: statusMessage.message_id,
        text: `${title}\n<code>━━━━━━━━━━━━━━━━━━━━</code>\n📭 No active CodeChef accounts configured. Add CODECHEF_1 in Render.`,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }).catch(() => undefined);
    } else {
      for (const sec of accountSections.values()) {
        sec.activeLine = undefined;
      }
      const solved = report.outcomes.filter(o => o.verdict === 'Accepted' || (o.performed && !o.error)).length;
      const failed = report.outcomes.filter(o => !o.skipped && (o.error || (o.verdict && o.verdict !== 'Accepted'))).length;
      const skipped = report.outcomes.filter(o => o.skipped).length;
      const summaryText = `\n\n🏆 <b>Finished:</b> ${solved} solved · ${failed} failed · ${skipped} skipped`;
      await editProgress(summaryText);
      logger.info({ summary: report.outcomes.length, solved, failed, skipped }, 'telegram /codechef run finished');
    }
  })().catch(async (err) => {
    logger.warn({ err: errText(err) }, 'CodeChef telegram run failed');
    await tgApi('editMessageText', {
      chat_id: config.telegram.chatId,
      message_id: statusMessage.message_id,
      text: `${title}\n<code>━━━━━━━━━━━━━━━━━━━━</code>\n⚠️ Error: ${html(errText(err))}`,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }).catch(() => undefined);
  });

  return { done };
}

export async function handleCancelCodeChefRange(): Promise<void> {
  const cancelled = cancelCodeChefRun();
  if (cancelled) {
    await reply('🛑 Cancelling CodeChef batch submission… Stopping immediately.');
  } else {
    await reply('🤷 No CodeChef batch submission is currently running.');
  }
}

export async function handleCodeChefRangeStatus(): Promise<void> {
  const status = getCodeChefRangeStatus();
  if (!status || status.state === 'idle') {
    await replyHtml('💤 No CodeChef batch job is currently running.\nStart one with <code>/ccrange 10</code>.');
    return;
  }
  await replyHtml(formatCodeChefRangeStatus(status));
}

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
export function renderCodeforcesProgressLines(progress: ReadonlyMap<number, string>): string[] {
  const rows = [...progress.entries()].sort(([a], [b]) => a - b);
  const selected: string[] = [];
  let size = 0;
  // Keep the currently running/last account visible. Fit complete HTML rows,
  // never cut through a tag/entity when respecting Telegram's message limit.
  for (const [index, text] of rows.reverse()) {
    const row = text.length <= 1800 ? text : `Account ${index}: result recorded; see /accounts for details.`;
    if (size + row.length > 3400) break;
    selected.unshift(row);
    size += row.length + 1;
  }
  if (selected.length < rows.length) selected.unshift(`<i>${rows.length - selected.length} earlier account result(s) recorded · /accounts</i>`);
  return selected;
}

export interface CodeforcesAccountSectionState {
  accIndex: number;
  label: string;
  username?: string | null;
  completedItems: string[];
  activeLine?: string;
  accountStatus?: string;
}

export function renderCodeforcesProgressSections(
  sections: ReadonlyMap<number, CodeforcesAccountSectionState>,
  totalAccounts: number,
): string[] {
  const sorted = [...sections.values()].sort((a, b) => a.accIndex - b.accIndex);
  if (sorted.length === 0) {
    return ['<i>Waiting for progress updates…</i>'];
  }

  const effectiveTotal = Math.max(totalAccounts, sorted.length);
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const buildBlocks = (pruneThreshold?: number): string[] => {
    return sorted.map((sec) => {
      const accNum = sec.accIndex + 1;
      const name = escape(sec.username ?? sec.label);
      const header = `👤 <b>Account ${accNum}/${effectiveTotal} · <code>${name}</code></b>`;

      let completed = sec.completedItems;
      let prunedNotice: string | null = null;
      if (pruneThreshold && completed.length > pruneThreshold) {
        const skippedCount = completed.length - pruneThreshold;
        prunedNotice = `<i>… ${skippedCount} earlier completed question(s)</i>`;
        completed = completed.slice(completed.length - pruneThreshold);
      }

      const items: string[] = [];
      if (prunedNotice) items.push(prunedNotice);
      items.push(...completed);

      if (sec.activeLine) {
        items.push(sec.activeLine);
      } else if (sec.accountStatus && items.length === 0) {
        items.push(sec.accountStatus);
      }

      if (items.length === 0) {
        items.push('⏳ Queued…');
      }

      const treeLines = items.map((item, idx) => {
        const isLast = idx === items.length - 1;
        const connector = isLast ? '└ ' : '├ ';
        return `${connector}${item}`;
      });

      return [header, ...treeLines].join('\n');
    });
  };

  let blocks = buildBlocks();
  if (blocks.join('\n\n').length > 3400) {
    blocks = buildBlocks(6);
  }
  if (blocks.join('\n\n').length > 3400) {
    blocks = buildBlocks(3);
  }

  return blocks;
}

export async function handleCancelCodeforcesRange(): Promise<void> {
  const cancelled = cancelCodeforcesRun();
  if (cancelled) {
    await reply('🛑 Cancelling Codeforces batch submission… Stopping immediately.');
  } else {
    await reply('🤷 No Codeforces batch submission is currently running.');
  }
}

export async function handleCodeforcesRangeStatus(): Promise<void> {
  const status = getCodeforcesRangeStatus();
  if (!status || status.state === 'idle') {
    await replyHtml('💤 No Codeforces batch job is currently running.\nStart one with <code>/cfrange 10</code>.');
    return;
  }
  await replyHtml(formatCodeforcesRangeStatus(status));
}

export async function handleCodeforcesTrigger(
  runnerOrOptions?: typeof runCodeforcesNow | { forceNext?: boolean; count?: number },
  isBusyOrRunner?: (() => boolean) | typeof runCodeforcesNow,
  sendOrIsBusy?: ((text: string) => Promise<void>) | (() => boolean),
  maybeSend?: (text: string) => Promise<void>,
): Promise<{ done: Promise<void> } | null> {
  let options: { forceNext?: boolean; count?: number } = {};
  let runner: typeof runCodeforcesNow = runCodeforcesNow;
  let isBusy: () => boolean = isCodeforcesRunInProgress;
  let send: ((text: string) => Promise<void>) | undefined;

  if (typeof runnerOrOptions === 'function') {
    runner = runnerOrOptions;
    if (typeof isBusyOrRunner === 'function') isBusy = isBusyOrRunner as () => boolean;
    if (typeof sendOrIsBusy === 'function') send = sendOrIsBusy as (text: string) => Promise<void>;
  } else if (typeof runnerOrOptions === 'object' && runnerOrOptions !== null) {
    options = runnerOrOptions;
    if (typeof isBusyOrRunner === 'function') runner = isBusyOrRunner as typeof runCodeforcesNow;
    if (typeof sendOrIsBusy === 'function') isBusy = sendOrIsBusy as () => boolean;
    if (typeof maybeSend === 'function') send = maybeSend;
  }

  if (isBusy()) {
    if (send) await send('A Codeforces run is already active. Please wait for its result.');
    else await reply('🚧 A Codeforces run is already in progress — wait for its report, then try again.');
    return null;
  }

  if (send) {
    await send('🏆 Codeforces: checking configured accounts and submitting the next pending source.');
    const done = runner(CODEFORCES_MANUAL_REASON, { forceDailyAttempt: true, batchCount: options.count ?? 1 }).then(async (report) => {
      if (!report) await send!('Another Codeforces run started; this command did not create a second run.');
    }).catch(async (err) => {
      await send!(`Codeforces could not start: ${err instanceof Error ? err.message : String(err)}`);
    });
    return { done };
  }

  const configuredAccounts = await listCodeforcesAccounts(true).catch(() => []);
  const initialTotalAccounts = Math.max(1, configuredAccounts.length);
  const accountSections = new Map<number, CodeforcesAccountSectionState>();

  for (let i = 0; i < configuredAccounts.length; i++) {
    const acc = configuredAccounts[i];
    if (!acc) continue;
    accountSections.set(i, {
      accIndex: i,
      label: acc.label,
      username: acc.username,
      completedItems: [],
      activeLine: i === 0 ? '🔎 Initializing session…' : '⏳ Queued…',
    });
  }

  const title = options.count && options.count > 1
    ? `<b>🏆 CODEFORCES BATCH (${options.count} Questions)</b>`
    : `<b>🏆 CODEFORCES SUBMISSION</b>`;

  const initialSubtitle = options.count && options.count > 1
    ? `🔎 Initializing batch (${options.count} questions)…\n<i>⏳ 30s pacing between questions · /cfrangestatus · /cfcancelrange</i>`
    : `🔎 Initializing Codeforces…`;

  const initialBlocks = configuredAccounts.length > 0
    ? renderCodeforcesProgressSections(accountSections, initialTotalAccounts).join('\n\n')
    : initialSubtitle;

  const statusMessage = await tgApi<{ message_id: number }>('sendMessage', {
    chat_id: config.telegram.chatId,
    text: `${title}\n<code>━━━━━━━━━━━━━━━━━━━━</code>\n${initialBlocks}`,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });

  const html = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let totalAccounts = initialTotalAccounts;

  const editProgress = async (extraFooter?: string): Promise<boolean> => {
    const blocks = renderCodeforcesProgressSections(accountSections, totalAccounts);
    let body = blocks.join('\n\n');
    if (extraFooter) body += extraFooter;

    const fullText = `${title}\n<code>━━━━━━━━━━━━━━━━━━━━</code>\n${body}`;

    const updated = await tgApi('editMessageText', {
      chat_id: config.telegram.chatId,
      message_id: statusMessage.message_id,
      text: fullText,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }).then(() => true).catch((err) => {
      if (/message is not modified/i.test(errText(err))) return true;
      logger.warn({ err: errText(err) }, 'could not update Codeforces progress message');
      return false;
    });
    return updated;
  };

  const done = (async () => {
    const report = await runner(CODEFORCES_MANUAL_REASON, {
      forceDailyAttempt: options.forceNext ?? true,
      batchCount: options.count ?? 1,
      onAccountProgress: async (event) => {
        if (event.accTotal && event.accTotal > totalAccounts) {
          totalAccounts = event.accTotal;
        }
        const accIdx = event.accIndex ?? Math.max(0, event.index - 1);
        let sec = accountSections.get(accIdx);
        if (!sec) {
          sec = {
            accIndex: accIdx,
            label: event.label,
            username: event.username,
            completedItems: [],
          };
          accountSections.set(accIdx, sec);
        }
        if (event.username && !sec.username) {
          sec.username = event.username;
        }

        const stepPrefix = event.stepTotal && event.stepTotal > 1 ? `[${event.stepIndex ?? 1}/${event.stepTotal}] ` : '';
        const probTag = event.problem ? `<code>${html(event.problem)}</code>` : '';
        const route = event.networkMode === 'tailscale' ? '📱 Phone Tailscale' : '🏠 Residential Proxy';

        switch (event.phase) {
          case 'checking':
            sec.activeLine = `🔎 ${stepPrefix}Checking session…`;
            break;
          case 'verified':
            sec.activeLine = `✅ ${stepPrefix}Session verified`;
            break;
          case 'source':
            sec.activeLine = `📦 ${stepPrefix}Source loaded${probTag ? ` · ${probTag}` : ''}`;
            break;
          case 'network':
            sec.activeLine = `🌐 ${stepPrefix}Route: ${route}`;
            break;
          case 'opening':
            sec.activeLine = `🖥️ ${stepPrefix}Opening submit page${probTag ? ` · ${probTag}` : ''}`;
            break;
          case 'submitting':
            sec.activeLine = `🚀 ${stepPrefix}Submitting signed form${probTag ? ` · ${probTag}` : ''}`;
            break;
          case 'verdict':
            sec.activeLine = `⏳ ${stepPrefix}Waiting for Codeforces verdict${probTag ? ` · ${probTag}` : ''}`;
            break;
          case 'attempt':
            sec.activeLine = `⏱️ ${stepPrefix}Attempt ${event.attempt ?? 1}/3`;
            break;
          case 'retry':
            sec.activeLine = `🔄 ${stepPrefix}Retrying source · attempt ${event.attempt ?? 1}/3`;
            break;
          case 'queued':
            sec.activeLine = `🕓 ${stepPrefix}Waiting for cloud browser · attempt ${event.attempt ?? 1}/3`;
            break;
          case 'running':
            sec.activeLine = `🖥️ ${stepPrefix}Cloud browser running · attempt ${event.attempt ?? 1}/3`;
            break;
          case 'session-restored':
            sec.activeLine = `💾 ${stepPrefix}Session restored`;
            break;
          case 'session-fresh':
            sec.activeLine = `🍪 ${stepPrefix}Fresh session cookies`;
            break;
          case 'verification':
            sec.activeLine = `🔐 ${stepPrefix}Checking verification`;
            break;
          case 'verification-retry':
            sec.activeLine = `⏳ ${stepPrefix}Verification retrying`;
            break;
          case 'verification-blocked':
            sec.activeLine = `⚠️ ${stepPrefix}Verification blocked`;
            break;
          case 'verification-cleared':
            sec.activeLine = `✅ ${stepPrefix}Verification cleared`;
            break;
          case 'verification-not-required':
            sec.activeLine = `✅ ${stepPrefix}No verification required`;
            break;
          case 'completed': {
            const verdict = html(event.verdict ?? 'OK');
            const sub = event.submissionId ? ` · #${html(event.submissionId)}` : '';
            const line = `✅ ${stepPrefix}${probTag ? `${probTag} — ` : ''}<b>${verdict}</b>${sub}`;
            sec.completedItems.push(line);
            sec.activeLine = undefined;
            break;
          }
          case 'failed': {
            const err = html(event.error ? event.error.slice(0, 300) : 'Failed');
            const line = `❌ ${stepPrefix}${probTag ? `${probTag} — ` : ''}<i>${err}</i>`;
            sec.completedItems.push(line);
            sec.activeLine = undefined;
            break;
          }
          case 'skipped': {
            const err = html(event.error ? event.error.slice(0, 300) : 'Skipped');
            const line = `⏭️ ${stepPrefix}${probTag ? `${probTag} — ` : ''}<i>${err}</i>`;
            sec.completedItems.push(line);
            sec.activeLine = undefined;
            break;
          }
          case 'waiting': {
            const nextStep = (event.stepIndex ?? 1) + 1;
            const nextStepStr = event.stepTotal && event.stepTotal > 1 ? ` before question [${nextStep}/${event.stepTotal}]` : '';
            sec.activeLine = `⏳ Waiting ${event.waitSeconds ?? 30}s${nextStepStr} (human pacing)…`;
            break;
          }
          case 'cancelled':
            sec.activeLine = '🛑 Batch cancelled by user';
            sec.accountStatus = '🛑 Cancelled';
            break;
          default:
            sec.activeLine = `⚙️ ${event.phase}${probTag ? ` · ${probTag}` : ''}`;
            break;
        }

        await editProgress();
      },
      onAccountOutcome: async () => {
        await editProgress();
      },
    });

    if (!report) {
      await tgApi('editMessageText', {
        chat_id: config.telegram.chatId,
        message_id: statusMessage.message_id,
        text: `${title}\n<code>━━━━━━━━━━━━━━━━━━━━</code>\n⏳ Not started: another run began concurrently.`,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }).catch(() => undefined);
    } else if (report.totals.accounts === 0) {
      await tgApi('editMessageText', {
        chat_id: config.telegram.chatId,
        message_id: statusMessage.message_id,
        text: `${title}\n<code>━━━━━━━━━━━━━━━━━━━━</code>\n📭 No active Codeforces accounts configured. Send /renew with a Codeforces session JSON.`,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }).catch(() => undefined);
    } else {
      for (const sec of accountSections.values()) {
        sec.activeLine = undefined;
      }
      const solved = report.totals.solved;
      const failed = report.totals.failed;
      const skipped = report.totals.skipped;
      const summaryText = `\n\n🏆 <b>Finished:</b> ${solved} solved · ${failed} failed · ${skipped} skipped`;
      await editProgress(summaryText);
      logger.info({ summary: report.accounts.length, solved, failed, skipped }, 'telegram /codeforces run finished');
    }
  })().catch(async (err) => {
    logger.warn({ err: errText(err) }, 'Codeforces telegram run failed');
    await tgApi('editMessageText', {
      chat_id: config.telegram.chatId,
      message_id: statusMessage.message_id,
      text: `${title}\n<code>━━━━━━━━━━━━━━━━━━━━</code>\n⚠️ Error: ${html(errText(err))}`,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }).catch(() => undefined);
  });

  return { done };
}

export async function handleCodeforcesSubmitNext(
  runner: typeof runCodeforcesNow = runCodeforcesNow,
  inProgress: () => boolean = isCodeforcesRunInProgress,
): Promise<{ done: Promise<void> } | null> {
  return handleCodeforcesTrigger({ forceNext: true, count: 1 }, runner, inProgress);
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
      '🌐 Codeforces submission network',
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
    await deps.edit(chatId, messageId, '🔍 That network choice is no longer valid. Send /cfnetwork again.');
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

export interface ProxyUiDeps {
  send: (text: string, buttons?: InlineButton[][]) => Promise<void>;
  edit: (chatId: number | string, messageId: number, text: string, buttons?: InlineButton[][]) => Promise<void>;
  answer: (callbackId: string, text?: string) => Promise<void>;
}

export const defaultProxyUiDeps: ProxyUiDeps = {
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

export async function handleTestProxyCommand(deps: ProxyUiDeps = defaultProxyUiDeps): Promise<void> {
  const all = await getAllConfiguredProxies();
  if (all.length === 0) {
    await deps.send([
      '<b>🌐 Configured Proxies</b>',
      '<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>',
      '⚠️ <b>No proxies found in active pool.</b>',
      '',
      '<b>How to connect your proxies:</b>',
      '1️⃣ <b>Directly in chat (Recommended & Instant):</b>',
      '   Send: <code>/setproxies &lt;paste proxies here&gt;</code>',
      '   <i>Accepts comma or newline separated proxy URLs.</i>',
      '',
      '2️⃣ <b>In Render Dashboard:</b>',
      '   Add <code>CODEFORCES_RESIDENTIAL_PROXY</code> to Environment Variables in Render.',
      '',
      '3️⃣ <b>From GitHub Actions Secrets:</b>',
      '   Send: <code>/syncproxies</code> to trigger sync from GitHub Actions.',
    ].join('\n'));
    return;
  }

  await deps.send([
    '<b>🌐 CODEFORCES PROXY HEALTH CHECK</b>',
    '<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>',
    `🔎 Testing ${all.length} configured proxy(ies) one-by-one (~150B trace check)...`,
    '<i>Please wait...</i>',
  ].join('\n'));

  const results = await testAllProxiesOneByOne();

  let workingCount = 0;
  let failedCount = 0;
  let removedCount = 0;

  const lines = [
    '<b>🌐 CODEFORCES PROXY HEALTH CHECK</b>',
    '<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>',
  ];

  const buttons: InlineButton[][] = [];

  for (const item of results) {
    const { proxy, result } = item;
    if (proxy.isRemoved) {
      removedCount++;
      lines.push(`🚫 [${proxy.index}/${all.length}] <code>${escapeHtml(proxy.masked)}</code> — <b>Blacklisted in DB</b>`);
    } else if (result.ok) {
      workingCount++;
      lines.push(`✅ [${proxy.index}/${all.length}] <code>${escapeHtml(proxy.masked)}</code> — <b>Working</b> (${result.latencyMs}ms${result.ip ? ` · IP: ${result.ip}` : ''})`);
    } else {
      failedCount++;
      const errDetail = result.error ? ` (${escapeHtml(result.error)})` : ' (offline/quota exceeded)';
      lines.push(`❌ [${proxy.index}/${all.length}] <code>${escapeHtml(proxy.masked)}</code> — <b>Failed</b>${errDetail}`);
      buttons.push([{ text: `❌ Blacklist #${proxy.index} in DB`, callback_data: `pxrm:${proxy.index}` }]);
    }
  }

  lines.push('');
  lines.push(`📊 <b>Status:</b> ${workingCount} working · ${failedCount} failed · ${removedCount} blacklisted`);
  if (failedCount > 0) {
    lines.push('💡 <i>Tap a button below or send <code>/removeproxy &lt;number&gt;</code> to blacklist a dead proxy in DB.</i>');
  }
  buttons.push([
    { text: '🔄 Retest All', callback_data: 'pxretest' },
    { text: '✅ Done', callback_data: 'pxdone' },
  ]);

  await deps.send(lines.join('\n'), buttons);
}

export async function handleRemoveProxyCommand(arg?: string, deps: ProxyUiDeps = defaultProxyUiDeps): Promise<void> {
  const index = Number.parseInt((arg ?? '').trim(), 10);
  if (!Number.isFinite(index) || index <= 0) {
    const all = await getAllConfiguredProxies();
    if (all.length === 0) {
      await deps.send('⚠️ No proxies configured.');
      return;
    }
    const lines = [
      '<b>🗑️ Remove / Blacklist Proxy</b>',
      '<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>',
      'Select a proxy to blacklist in the DB (it will NOT be used even if in GitHub Secrets):',
      '',
    ];
    const buttons: InlineButton[][] = [];
    for (const p of all) {
      const tag = p.isRemoved ? '🚫 Blacklisted' : 'Active';
      lines.push(`${p.index}. <code>${escapeHtml(p.masked)}</code> — ${tag}`);
      if (!p.isRemoved) {
        buttons.push([{ text: `❌ Remove #${p.index}`, callback_data: `pxrm:${p.index}` }]);
      }
    }
    lines.push('');
    lines.push('👉 <i>Or send: <code>/removeproxy &lt;number&gt;</code> (e.g. <code>/removeproxy 2</code>)</i>');
    buttons.push([{ text: '✅ Done', callback_data: 'pxdone' }]);
    await deps.send(lines.join('\n'), buttons);
    return;
  }

  const res = await removeProxyByIndex(index);
  if (!res.ok || !res.proxy) {
    await deps.send(`⚠️ ${res.error ?? `Proxy #${index} not found.`}`);
    return;
  }

  await deps.send([
    `🗑️ <b>Proxy #${index} Removed &amp; Blacklisted</b>`,
    '<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>',
    `🌐 <code>${escapeHtml(res.proxy.masked)}</code>`,
    '',
    '✅ <b>Saved to database blacklist.</b>',
    'This proxy will <b>NOT</b> be used for any future submissions, even if it remains in GitHub Action secrets.',
    '',
    '💡 <i>To re-enable all proxies, use <code>/restoreproxies</code>.</i>',
  ].join('\n'));
}

export async function handleAddProxyCommand(arg?: string, deps: ProxyUiDeps = defaultProxyUiDeps): Promise<void> {
  const text = (arg ?? '').trim();
  if (!text) {
    await deps.send([
      '<b>➕ Set / Add Proxies</b>',
      '<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>',
      'Please specify one or more proxy URLs (comma, space, or newline separated):',
      '👉 <code>/setproxies http://user:pass@host1:port, http://user:pass@host2:port</code>',
      '',
      '<i>Or send <code>/syncproxies</code> to sync from GitHub Secrets.</i>',
    ].join('\n'));
    return;
  }

  const res = await addCustomProxies(text);
  if (!res.ok || res.total === 0) {
    await deps.send(`❌ Failed to parse proxies: ${res.error ?? 'Invalid proxy format'}`);
    return;
  }

  const statusMsg = res.added.length > 0
    ? `✅ <b>Added ${res.added.length} proxy(ies) to database pool!</b> (Total pool: ${res.total})`
    : `ℹ️ <b>${res.total} proxy(ies) active in database pool!</b>`;

  await deps.send([
    statusMsg,
    '🔎 Running health checks on all proxies now...',
  ].join('\n'));

  await handleTestProxyCommand(deps);
}

export async function handleSyncProxiesCommand(deps: ProxyUiDeps = defaultProxyUiDeps): Promise<void> {
  const runnerRepo = (process.env.CODEFORCES_RUNNER_REPOSITORY ?? '').trim();
  const dispatchToken = (process.env.GITHUB_DISPATCH_TOKEN ?? '').trim();

  await deps.send('🔄 Checking for proxies synced from GitHub Actions runner...');
  const remote = await fetchRemoteSyncedProxies();
  if (remote.length > 0) {
    await deps.send(`✅ Found ${remote.length} proxy(ies) synced from GitHub Actions!`);
    await handleTestProxyCommand(deps);
    return;
  }

  if (runnerRepo && dispatchToken) {
    try {
      await deps.send('🚀 Triggering GitHub Actions workflow to sync secrets...');
      const { dispatchAction } = await import('../codeforces/actionBroker');
      const testJobId = randomUUID();
      await dispatchAction(runnerRepo, dispatchToken, testJobId);
      await deps.send('⏳ GitHub Actions sync dispatched! Please wait ~20-30 seconds, then run <code>/testproxy</code>.');
      return;
    } catch {
      // fallback below
    }
  }

  await deps.send([
    '💡 <b>GitHub Secrets Info:</b>',
    'GitHub repository secrets are private to GitHub Actions runners.',
    '',
    '👉 <b>Instant Fix:</b> Paste your proxies here using:',
    '<code>/setproxies &lt;paste your proxies here&gt;</code>',
    '',
    'They will be saved in PostgreSQL and verified immediately!',
  ].join('\n'));
}

export async function handleRestoreProxiesCommand(deps: ProxyUiDeps = defaultProxyUiDeps): Promise<void> {
  const count = await restoreAllProxies();
  await deps.send([
    '<b>♻️ Proxy Blacklist Cleared</b>',
    '<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>',
    `Restored ${count} previously blacklisted proxy(ies).`,
    'All configured proxies in GitHub Secrets and database will now be considered and tested.',
  ].join('\n'));
}

export async function handleProxyButton(
  chatId: number | string,
  messageId: number,
  callbackId: string,
  data: string,
  deps: ProxyUiDeps = defaultProxyUiDeps,
): Promise<void> {
  if (data === 'pxdone') {
    await deps.answer(callbackId, 'Done');
    await deps.edit(chatId, messageId, '✅ Done.');
    return;
  }
  if (data === 'pxretest') {
    await deps.answer(callbackId, 'Retesting proxies...');
    await handleTestProxyCommand(deps);
    return;
  }
  if (data.startsWith('pxrm:')) {
    const index = Number.parseInt(data.slice(5), 10);
    const res = await removeProxyByIndex(index);
    if (!res.ok || !res.proxy) {
      await deps.answer(callbackId, res.error ?? 'Proxy not found');
      return;
    }
    await deps.answer(callbackId, `Proxy #${index} blacklisted in DB`);
    await deps.edit(
      chatId,
      messageId,
      `🗑️ <b>Proxy #${index} (<code>${escapeHtml(res.proxy.masked)}</code>) removed &amp; blacklisted in DB.</b>\nIt will NOT be used for submissions even if in GitHub Secrets.`,
    );
    return;
  }
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
      '🏆 Submit the next Codeforces source solution',
      '',
      '👇 Pick an account, or choose All accounts:',
      'Only the selected account(s) will receive a submission.',
    ].join('\n'),
    buttons,
  };
}

/** /nextsubcustomaccount — show the active Codeforces account picker. */
export async function handleCodeforcesCustomSubmit(
  deps: CodeforcesSubmitUiDeps = defaultCodeforcesSubmitUiDeps,
): Promise<void> {
  if (deps.inProgress()) {
    await deps.send('🚧 A Codeforces run is already in progress — wait for its report, then try again.');
    return;
  }
  const accounts = await deps.listAccounts();
  if (accounts.length === 0) {
    await deps.send('📭 No active Codeforces accounts configured — send a Codeforces session JSON through /renew first.');
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
    await deps.send('⏳ Not started: another Codeforces run began at the same moment. Try again after it finishes.');
  } else if (report.totals.accounts === 0) {
    await deps.send('📭 The selected Codeforces account is no longer active. Send /nextsubcustomaccount again.');
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
    await deps.edit(chatId, messageId, '✖️ Codeforces submission cancelled — nothing was submitted.');
    return;
  }
  if (deps.inProgress()) {
    await deps.answer(callbackId, 'A Codeforces run is in progress');
    await deps.edit(chatId, messageId, '🚧 A Codeforces run is already in progress — wait for its report, then try again.');
    return;
  }
  const accounts = await deps.listAccounts();
  const selected = data === 'cfsub:all' ? accounts : accounts.filter((account) => data === `cfsub:${account.id}`);
  if (selected.length === 0) {
    await deps.answer(callbackId, 'This button is no longer valid');
    await deps.edit(chatId, messageId, '🔍 That Codeforces account is no longer active. Send /nextsubcustomaccount again.');
    return;
  }
  const description = selected.length === 1 ? cfAccountName(selected[0]!) : `all ${selected.length} Codeforces accounts`;
  await deps.answer(callbackId, 'Started 🚀');
  await deps.edit(
    chatId,
    messageId,
    `🚀 Submitting the next Codeforces source solution for ${description}.\n\n📬 You will receive the verdict here.`,
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

/** /cfmanualnext — send a mobile-ready source/submit handoff without posting anything. */
export async function handleCodeforcesManualNext(
  deps: CodeforcesManualUiDeps = defaultCodeforcesManualUiDeps,
): Promise<void> {
  const accounts = await deps.listAccounts();
  if (accounts.length === 0) {
    await deps.send('📭 No active Codeforces accounts configured. Add one with /renew first.');
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
    await deps.edit(chatId, messageId, '🔍 That Codeforces account is no longer active. Send /cfmanualnext again.');
    return;
  }
  const entry = await deps.nextEntry(account.id);
  if (!entry || entry.contestId === undefined || !entry.problemIndex) {
    await deps.answer(callbackId, 'No source available');
    await deps.edit(chatId, messageId, '📭 No next Codeforces source is available for this account.');
    return;
  }
  await deps.answer(callbackId, 'Ready 📱');
  await deps.edit(
    chatId,
    messageId,
    [
      `📱 Manual Codeforces submission for ${cfAccountName(account)}`,
      `Problem: ${entry.contestId}${entry.problemIndex}${entry.problemName ? ` — ${entry.problemName}` : ''}`,
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
// Session removal (/removesession, /removeallsessions) — inline buttons
// ---------------------------------------------------------------------------

type InlineButton = { text: string; callback_data: string };

// ---------------------------------------------------------------------------
// LeetCode contest reward (/claimcoins) — multi-account inline picker
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
    text: `${selected.has(account.id) ? '✅' : '▫️'} ${accountName(account)}`.slice(0, 60),
    callback_data: `lccoin:a:${account.id}`,
  }]);
  buttons.push([{
    text: `${allSelected ? '✅' : '👥'} ALL (${accounts.length})`,
    callback_data: 'lccoin:all',
  }]);
  buttons.push([
    { text: `🎁 Claim selected (${selected.size})`, callback_data: 'lccoin:run' },
    { text: '✖️ Cancel', callback_data: 'lccoin:x' },
  ]);
  return {
    text: [
      '<b>🎁 LEETCODE CONTEST REWARD</b>',
      '<code>━━━━━━━━━━━━━━━━━━━━</code>',
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
    await deps.send('🚧 A LeetCode process is already running. Try /claimcoins again after it finishes.');
    return;
  }
  const accounts = await deps.listAccounts();
  if (accounts.length === 0) {
    await deps.send('📭 No active LeetCode accounts configured. Add one with /renew first.');
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
    await deps.edit(chatId, messageId, '🚧 A LeetCode process is already running. Send /claimcoins again after it finishes.');
    return;
  }
  const accounts = await deps.listAccounts();
  const selection = coinClaimSelections.get(key);
  if (!selection) {
    await deps.answer(callbackId, 'This picker expired');
    await deps.edit(chatId, messageId, '⌛ This account picker expired. Send /claimcoins again.');
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
  await deps.answer(callbackId, 'Reward check started 🎁');
  await deps.edit(
    chatId,
    messageId,
    `<b>🎁 LEETCODE CONTEST REWARD</b>\n<code>━━━━━━━━━━━━━━━━━━━━</code>\n🔎 Checking 0/${selectedAccounts.length} accounts…`,
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
            '<b>🎁 LEETCODE CONTEST REWARD</b>',
            '<code>━━━━━━━━━━━━━━━━━━━━</code>',
            ...lines,
            `🔎 Checking ${i + 1}/${selectedAccounts.length} · ${coinHtml(accountName(account))}…`,
          ].join('\n'),
        );
        const result = await deps.claim(account);
        if (result.claimed) lines.push(`✅ ${coinHtml(accountName(account))} — Coins offered collected`);
        else if (result.error) lines.push(`❌ ${coinHtml(accountName(account))} — ${coinHtml(result.error.slice(0, 180))}`);
        else lines.push(`▫️ ${coinHtml(accountName(account))} — No coin offer available`);
      }
      await deps.edit(
        chatId,
        messageId,
        ['<b>🎁 LEETCODE CONTEST REWARD</b>', '<code>━━━━━━━━━━━━━━━━━━━━</code>', ...lines].join('\n'),
      );
    } catch (err) {
      await deps.edit(chatId, messageId, `⚠️ Reward check stopped: ${errText(err)}`).catch(() => undefined);
    } finally {
      coinClaimInProgress = false;
    }
  })();
}

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
    await tgApi('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text, show_alert: true } : {}) });
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

function cfAccountName(a: { label: string; username?: string | null }): string {
  return a.username && a.username !== a.label ? `${a.label} (${a.username})` : a.label;
}

export function buildCfRemoveSessionView(accounts: any[]): { text: string; buttons: InlineButton[][] } {
  if (accounts.length === 0) {
    return { text: '📭 No Codeforces sessions stored - nothing to remove.', buttons: [] };
  }
  const lines = [`🗂️ Codeforces Sessions stored: ${accounts.length}`, '👇 Tap an account to remove its session:', ''];
  accounts.forEach((a, i) => lines.push(`${i + 1}. ${cfAccountName(a)} - ${a.status}`));
  const buttons = accounts.map((a) => [{ text: `🗑️ Remove ${cfAccountName(a)}`.slice(0, 60), callback_data: `cfrm:${a.id}` }]);
  buttons.push([{ text: `🔥 Remove All`, callback_data: 'cfrmall:yes' }]);
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

  if (data.startsWith('px')) {
    await handleProxyButton(chatId, messageId, q.id, data);
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

  if (data === 'cfrm:done') {
    await deps.answer(q.id);
    await deps.edit(chatId, messageId, '✅ Done.');
    return;
  }

  if (data === 'cfrmall:yes') {
    if (isCodeforcesRunInProgress()) {
      await deps.answer(q.id, 'A Codeforces run is in progress - try again later');
      await deps.edit(chatId, messageId, '🚧 A Codeforces run is in progress right now - wait for its report, then try again.');
      return;
    }
    const removed = await deleteAllCodeforcesAccounts();
    logger.info({ removed }, 'all Codeforces account sessions removed via Telegram');
    await deps.answer(q.id, `Removed ${removed}`);
    await deps.edit(chatId, messageId, `🧹 Removed all Codeforces sessions (${removed} account(s)). Send Codeforces cookie .json files to add accounts again.`);
    return;
  }

  if (data.startsWith('cfrm:')) {
    const id = data.slice(5);
    const before = await listCodeforcesAccounts();
    const target = before.find((a) => a.id === id);
    if (isCodeforcesRunInProgress()) {
      await deps.answer(q.id, 'A Codeforces run is in progress - try again later');
      await deps.send('🚧 A Codeforces run is in progress right now - wait for its report, then try again.');
      return;
    }
    let text: string;
    if (!target || !(await deleteCodeforcesAccountById(id))) {
      text = '🤷 That Codeforces account was already removed.';
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

/** Wiring for the range UI — injectable for tests. */
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
  if (ui.current()) {
    picker.text += '\n\n🗂️ A range process is already running. This request will be queued and started automatically after the current job completes or is cancelled.';
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
    if ('queued' in result) {
      await deps.answer(callbackId, `Queued #${result.position} 🗂️`);
      await deps.edit(
        chatId,
        messageId,
        [
          `🗂️ Queued: questions #${parsed.range.from}–#${parsed.range.to} (${rangeSize(parsed.range)})`,
          `📍 Queue position: ${result.position}`,
          `👥 ${result.accounts.length === 1 ? `Account: ${result.accounts[0]?.label ?? 'unknown'}` : `Accounts (one by one): ${result.accounts.map((a) => a.label).join(', ')}`}`,
          '',
          '⏳ It will start automatically after the current range job completes or is cancelled.',
          '📍 /rangestatus shows the active job and queue.',
        ].join('\n'),
      );
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
  const queued = ui.queueLength?.() ?? rangeQueueLength();
  await reply(
    job
      ? formatRangeJobStatus(job, ui.now(), queued)
      : queued > 0
        ? `🗂️ ${queued} range job(s) waiting in the queue. A waiting job starts automatically when the active job finishes or is cancelled.`
        : '💤 No question-range process is running. Start one with /questionrangesubmission 200-400',
  );
}

/** Pending /renew <label> target — consumed by the next cookie payload. */
let pendingRenewalLabel: string | undefined;

async function accountsText(): Promise<string> {
  const [accounts, codeforces, codechefs] = await Promise.all([
    listAccounts(),
    listCodeforcesAccounts(true),
    listCodeChefAccounts(true),
  ]);
  const lines = [
    '<b>✦ ACCOUNT HUB</b>  <i>live snapshot</i>',
    '<code>━━━━━━━━━━━━━━━━━━━━</code>',
    '',
    `<b>🟩 LEETCODE</b>  <code>${accounts.length} connected</code>`,
  ];
  if (accounts.length === 0) {
    lines.push('📭 No LeetCode accounts configured. Send /renew with a cookie export.');
  }
  for (const a of accounts) {
    const who = a.username ? ` (${escapeHtml(a.username)})` : '';
    const accepted = await latestAcceptedRunForAccount(a.id);
    const acceptedText = accepted ? `AC ${humanLocal(accepted.updatedAt)}` : 'no accepted run';
    const checkedText = a.lastCheckedAt ? ` · checked ${humanLocal(a.lastCheckedAt)}` : '';
    lines.push(`${accountStatusIcon(a.status)} <b>${escapeHtml(a.label)}</b>${who}  <i>${escapeHtml(acceptedText)}${escapeHtml(checkedText)}</i>`);
    if (a.lastError) lines.push(`   └ ⚠️ <i>${escapeHtml(a.lastError.slice(0, 120))}</i>`);
  }
  lines.push('', '<code>━━━━━━━━━━━━━━━━━━━━</code>', '', `<b>🏆 CODEFORCES</b>  <code>${codeforces.length} connected</code>`);
  if (codeforces.length === 0) lines.push('📭 No Codeforces accounts configured.');
  for (const account of codeforces) {
    const progress = await getCodeforcesProgress(account.id);
    const who = account.username ? ` (${escapeHtml(account.username)})` : '';
    const verdict = progress.lastVerdict ? ` · <i>${escapeHtml(progress.lastVerdict)}</i>` : '';
    lines.push(`${accountStatusIcon(account.status)} <b>${escapeHtml(account.label)}</b>${who}${verdict}`);
    lines.push(`   └ next <code>${escapeHtml(progress.nextKey ?? 'first queued source')}</code>${progress.lastSubmissionId ? ` · #<code>${escapeHtml(progress.lastSubmissionId)}</code>` : ''}`);
    if (account.lastError) lines.push(`   └ ⚠️ <i>${escapeHtml(account.lastError.slice(0, 140))}</i>`);
  }
  lines.push('', '<code>━━━━━━━━━━━━━━━━━━━━</code>', '', `<b>👨‍🍳 CODECHEF</b>  <code>${codechefs.length} connected</code>`);
  if (codechefs.length === 0) lines.push('📭 No CodeChef accounts configured. Add CODECHEF_1 in Render.');
  for (const account of codechefs) {
    const progress = await getCodeChefAccountProgress(account.id);
    const who = account.username ? ` (${escapeHtml(account.username)})` : '';
    const verdict = progress.lastVerdict ? ` · <i>${escapeHtml(progress.lastVerdict)}</i>` : '';
    lines.push(`${accountStatusIcon(account.status)} <b>${escapeHtml(account.label)}</b>${who}${verdict}`);
    lines.push(`   └ next <code>${escapeHtml(progress.nextKey ?? 'first queued source')}</code>${progress.lastSubmissionId ? ` · #<code>${escapeHtml(progress.lastSubmissionId)}</code>` : ''}`);
    if (account.lastError) lines.push(`   └ ⚠️ <i>${escapeHtml(account.lastError.slice(0, 140))}</i>`);
  }
  return lines.join('\n');
}

async function codechefAccountsText(): Promise<string> {
  const accounts = await listCodeChefAccounts(true);
  if (accounts.length === 0) return '📭 No CodeChef accounts configured. Add CODECHEF_1=username::password in Render.';
  const lines = [
    `<b>👨‍🍳 CODECHEF</b>  <code>${accounts.length} connected</code>`,
    '<i>queue · cursor · last verdict</i>',
    '<code>━━━━━━━━━━━━━━━━━━━━</code>',
    '',
  ];
  for (const account of accounts) {
    const progress = await getCodeChefAccountProgress(account.id);
    const who = account.username ? ` (${escapeHtml(account.username)})` : '';
    const verdict = progress.lastVerdict ? ` · <i>${escapeHtml(progress.lastVerdict)}</i>` : '';
    lines.push(`${accountStatusIcon(account.status)} <b>${escapeHtml(account.label)}</b>${who}${verdict}`);
    lines.push(`   └ next <code>${escapeHtml(progress.nextKey ?? 'first queued source')}</code>${progress.lastSubmissionId ? ` · #<code>${escapeHtml(progress.lastSubmissionId)}</code>` : ''}`);
    if (account.lastError) lines.push(`   └ ⚠️ <i>${escapeHtml(account.lastError.slice(0, 140))}</i>`);
  }
  return lines.join('\n');
}

async function codeforcesAccountsText(): Promise<string> {
  const accounts = await listCodeforcesAccounts(true);
  if (accounts.length === 0) return '📭 No Codeforces accounts configured. Send /renew with a Codeforces session JSON.';
  const lines = [`<b>🏆 CODEFORCES</b>  <code>${accounts.length} connected</code>`, '<i>queue · verdict · transport health</i>', '<code>━━━━━━━━━━━━━━━━━━━━</code>', ''];
  for (const account of accounts) {
    const progress = await (await import('../codeforces/storage')).getCodeforcesProgress(account.id);
    lines.push(`${accountStatusIcon(account.status)} <b>${escapeHtml(account.label)}</b>${account.username ? ` (${escapeHtml(account.username)})` : ''}${progress.lastVerdict ? ` · <i>${escapeHtml(progress.lastVerdict)}</i>` : ''}`);
    lines.push(`   └ next <code>${escapeHtml(progress.nextKey ?? 'first queued source')}</code>${progress.lastSubmissionId ? ` · #<code>${escapeHtml(progress.lastSubmissionId)}</code>` : ''}`);
    if (account.lastError) lines.push(`   └ ⚠️ <i>${escapeHtml(account.lastError.slice(0, 140))}</i>`);
  }
  return lines.join('\n');
}

async function statusText(): Promise<string> {
  const [sys, last, lastAccepted, accounts, codeforces, codechefs] = await Promise.all([
    getAllSystemState(),
    latestRun(),
    latestAcceptedRun(),
    listAccounts(),
    listCodeforcesAccounts(true),
    listCodeChefAccounts(true),
  ]);
  const active = accounts.filter((a) => a.status === AccountStatus.ACTIVE).length;
  const expired = accounts.filter((a) => a.status === AccountStatus.EXPIRED).length;
  const rejected = accounts.filter((a) => a.status === AccountStatus.REJECTED).length;
  const lines = [
    '<b>◈ AGENT PULSE</b>  <i>platform health</i>',
    '<code>━━━━━━━━━━━━━━━━━━━━</code>',
    '',
    `<b>🟩 LEETCODE</b>  <code>${accounts.length} total</code>`,
    `👥 <b>${active}</b> active · <i>${expired} expired · ${rejected} rejected</i>`,
    `🔐 <i>${escapeHtml(String(sys['authStatus'] ?? 'unknown'))}</i>${sys['authUsername'] ? ` · ${escapeHtml(String(sys['authUsername']))}` : ''}`,
  ];
  if (lastAccepted) {
    lines.push(
      `✅ <b>${escapeHtml(lastAccepted.title)}</b>${lastAccepted.submissionStatus ? ` · <i>${escapeHtml(lastAccepted.submissionStatus)}</i>` : ''} · ${escapeHtml(humanLocal(lastAccepted.updatedAt))}`,
    );
  } else {
    lines.push('✅ Last accepted: <i>none recorded</i>');
  }
  if (last && last.state !== 'SUCCESS' && last.error) lines.push(`❗ Latest run error: <i>${escapeHtml(last.error.slice(0, 300))}</i>`);
  lines.push('', '<code>━━━━━━━━━━━━━━━━━━━━</code>', '', `<b>🏆 CODEFORCES</b>  <code>${codeforces.length} total</code>`);
  if (codeforces.length === 0) {
    lines.push('📭 No Codeforces accounts configured.');
  } else {
    for (const account of codeforces) {
      const progress = await getCodeforcesProgress(account.id);
      const who = account.username ? ` (${escapeHtml(account.username)})` : '';
      const verdict = progress.lastVerdict ? ` — <i>${escapeHtml(progress.lastVerdict)}</i>` : '';
      lines.push(`${accountStatusIcon(account.status)} <b>${escapeHtml(account.label)}</b>${who}${verdict}`);
      lines.push(`   └ next <code>${escapeHtml(progress.nextKey ?? 'queued')}</code>`);
    }
  }
  lines.push('', '<code>━━━━━━━━━━━━━━━━━━━━</code>', '', `<b>👨‍🍳 CODECHEF</b>  <code>${codechefs.length} total</code>`);
  if (codechefs.length === 0) {
    lines.push('📭 No CodeChef accounts configured.');
  } else {
    for (const account of codechefs) {
      const progress = await getCodeChefAccountProgress(account.id);
      const who = account.username ? ` (${escapeHtml(account.username)})` : '';
      const verdict = progress.lastVerdict ? ` — <i>${escapeHtml(progress.lastVerdict)}</i>` : '';
      lines.push(`${accountStatusIcon(account.status)} <b>${escapeHtml(account.label)}</b>${who}${verdict}`);
      lines.push(`   └ next <code>${escapeHtml(progress.nextKey ?? 'queued')}</code>`);
    }
  }
  return lines.join('\n');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function accountStatusIcon(status: string): string {
  switch (status.toUpperCase()) {
    case 'ACTIVE': return '🟢';
    case 'EXPIRED': return '🟠';
    case 'REJECTED': return '🔴';
    case 'DISABLED': return '⚫';
    default: return '⚪';
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
