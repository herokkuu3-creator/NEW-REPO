import { AccountStatus, CodeforcesAccountStatus } from '@prisma/client';
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
import {
  AccountRecord,
  deleteAccountById,
  deleteAllAccounts,
  getAccountById,
  listAccounts,
  listEnabledAccounts,
  saveAccount,
} from '../database/accounts';
import { saveEncryptedCredentials } from '../security/credentialStore';
import { loginToLeetCode } from '../leetcode/auth';
import { loginToCodeforces } from '../codeforces/auth';
import { verifyAndRefreshAllSessions } from '../security/sessionAutoRefresh';
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
import {
  deleteCodeforcesAccountById,
  deleteAllCodeforcesAccounts,
  getCodeforcesProgress,
  listCodeforcesAccounts,
  listAllUsernameProgress,
  saveCodeforcesAccount,
  saveUsernameProgress,
} from '../codeforces/storage';
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
  getPreferredProxy,
  setPreferredProxy,
  setPreferredProxyByIndex,
  clearPreferredProxy,
  extractProxyDetails,
  type ProxyCheckStatus,
} from '../codeforces/proxyManager';
import { testProxyDetailed, type ProxyTestResult } from '../codeforces/proxyRotator';
import {
  saveCapzyApiKeys,
  addCapzyApiKeys,
  getCapzyApiKeys,
  getActiveCapzyKeyIndex,
  setActiveCapzyKeyIndex,
  checkCapzyKeyBalance,
  maskApiKey,
  isLikelyCapzyKey,
  MIN_USABLE_CAPZY_BALANCE,
  type KeyBalanceResult,
} from '../codeforces/capzyKeyManager';
import { checkCPSolverHealth, getCPSolverUrl } from '../codeforces/captchaSolver';
import { appendSolutionApiKeys, replaceSolutionApiKeys, resetSolutionApiKeyPool, solutionKeyPoolStatus, testSolutionApiKey } from '../solutionPosts/keyPool';
import { runCombined, runManualQuestion, selectedAccountIds, setSelectedAccounts } from '../solutionPosts/scheduler';
import { resetFailedSolutionPostRetries } from '../solutionPosts/service';

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
  AccountRangeResult,
  calculateSafeRangeConcurrency,
  cancelRangeJob,
  countResults,
  currentRangeJob,
  defaultRangeDeps,
  estimateAccountMs,
  formatDuration,
  formatRangeJobStatus,
  parseQuestionRange,
  QuestionRange,
  RangeDeps,
  RangeProgressEvent,
  rangeSize,
  rangeQueueLength,
  startRangeJob,
  StartRangeOptions,
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

export type InlineButton = { text: string; callback_data: string };

export type PendingPromptType = 'leetcode' | 'codeforces' | 'codechef' | 'queue' | 'capzy' | 'addcapzy' | 'solutionkeys' | 'solutionquestion' | null;
let pendingPromptType: PendingPromptType = null;
let pendingRangePrompt = false;
let pendingQueuePrompt = false;
let pendingCapzyPrompt = false;
let pendingAddCapzyPrompt = false;
let pendingSolutionKeysPrompt = false;

export function getPendingPromptType(): PendingPromptType {
  return pendingPromptType;
}

export function setPendingPromptType(val: PendingPromptType): void {
  pendingPromptType = val;
  pendingRangePrompt = val === 'leetcode';
  pendingQueuePrompt = val === 'queue';
  pendingCapzyPrompt = val === 'capzy';
}

export function isPendingCapzyPrompt(): boolean {
  return pendingCapzyPrompt;
}

export function setPendingCapzyPrompt(val: boolean): void {
  pendingCapzyPrompt = val;
  if (val) {
    pendingPromptType = 'capzy';
    pendingRangePrompt = false;
    pendingQueuePrompt = false;
  } else if (pendingPromptType === 'capzy') {
    pendingPromptType = null;
  }
}

export function isPendingQueuePrompt(): boolean {
  return pendingQueuePrompt;
}

export function setPendingQueuePrompt(val: boolean): void {
  pendingQueuePrompt = val;
  if (val) {
    pendingPromptType = 'queue';
    pendingRangePrompt = false;
    pendingCapzyPrompt = false;
  } else if (pendingPromptType === 'queue') {
    pendingPromptType = null;
  }
}

export const HELP_TEXT = [
  '<b>⚡ 𝗟𝗘𝗘𝗧𝗖𝗢𝗗𝗘 𝗗𝗔𝗜𝗟𝗬 𝗔𝗚𝗘𝗡𝗧 ⚡</b>',
  '<i>Autonomous Multi-Platform Coding Assistant</i>',
  '<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>',
  '',
  '<b>📥 𝗤𝗨𝗘𝗨𝗘 𝗠𝗔𝗡𝗔𝗚𝗘𝗠𝗘𝗡𝗧</b>',
  '├ /startqueue — Queue next command (sequential execution)',
  '├ /queuestatus — View active process &amp; queued commands',
  '└ /clearqueue — Cancel &amp; purge pending queue',
  '',
  '<b>✨ 𝗟𝗘𝗘𝗧𝗖𝗢𝗗𝗘 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦</b>',
  '├ /triggersubmission — Submit today’s daily question',
  '├ /claimcoins — Collect contest coins &amp; rewards',
  '├ /questionrangesubmission — Range solver <i>(e.g. 200-400)</i>',
  '├ /rangestatus — Check active range job progress',
  '├ /cancelrange — Stop running range job',
  '└ /accounts — View LeetCode accounts &amp; session status',
  '',
  '<b>🏆 𝗖𝗢𝗗𝗘𝗙𝗢𝗥𝗖𝗘𝗦 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦</b>',
  '├ /submitnextsolution — Submit next problem for all accounts',
  '├ /cfrange — Batch submit next N problems <i>(account multi-selection · 30s pacing)</i>',
  '├ /cfrangestatus — Live batch progress &amp; ETA countdown',
  '├ /cfcancelrange — Cancel active batch submission',
  '├ /nextsubcustomaccount — Select specific account to submit 1 problem',
  '├ /cfnetwork — Switch network mode (Proxy / Tailscale)',
  '├ /cfmanualnext — Get next source &amp; mobile submit link',
  '├ /cfaccounts — View Codeforces accounts &amp; verdicts',
  '├ /cfprogress — View permanent submission progress by username in DB',
  '├ /cfsetprogress &lt;user&gt; &lt;problem&gt; — Set next problem for username',
  '└ /cf_clear_cookies — Delete Codeforces stored sessions',
  '',
  '<b>🌐 𝗣𝗥𝗢𝗫𝗬 &amp; 𝗡𝗘𝗧𝗪𝗢𝗥𝗞</b>',
  '├ /useproxy — Select &amp; switch active Codeforces proxy',
  '├ /testproxy — Test each proxy one-by-one &amp; show live health',
  '├ /setproxies — Save &amp; verify multiple proxies in DB',
  '├ /addproxy — Add proxy to active pool',
  '├ /removeproxy — Blacklist &amp; remove dead proxy in DB',
  '├ /restoreproxies — Reset blacklist &amp; restore all proxies',
  '├ /syncproxies — Sync proxies from GitHub Actions runner',
  '└ /cfnetwork — Switch network mode (Proxy / Tailscale)',
  '',
  '<b>🧩 𝗖𝗔𝗣𝗧𝗖𝗛𝗔 𝗦𝗢𝗟𝗩𝗘𝗥</b>',
  '├ /addcapsolver &lt;key&gt; — Append new Capzy/CapSolver API key(s) (preserves existing)',
  '├ /capsolver &lt;key&gt; — Replace Capzy/CapSolver API keys',
  '└ /capsolverstatus — Check current solver API keys &amp; balances',
  '',
  '<b>✨ 𝗔𝗜 𝗦𝗢𝗟𝗨𝗧𝗜𝗢𝗡 𝗔𝗥𝗧𝗜𝗖𝗟𝗘𝗦</b>',
  '├ /dailysolution — Choose cached accounts for 6 AM daily submit + article',
  '├ /manualsolution — Run the selected accounts for daily or one question number',
  '├ /addsolutionkeys &lt;key1,key2&gt; — Append CodeCraft API keys',
  '├ /setsolutionkeys &lt;key1,key2&gt; — Replace/reset CodeCraft API key pool',
  '├ /resetsolutionkeys — Reset active key to #1 &amp; clear retry limits',
  '├ /testsolkey [key] — Test CodeCraft API key &amp; inference diagnostics',
  '└ /solutionkeystatus — Show masked article-generation key pool',
  '',
  '<b>👨‍🍳 𝗖𝗢𝗗𝗘𝗖𝗛𝗘𝗙 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦</b>',
  '├ /codechef — Run daily CodeChef submission',
  '├ /ccnextsubmit — Force submit next solution in queue',
  '├ /ccrange — Batch submit next N problems <i>(30s human pacing)</i>',
  '├ /ccrangestatus — Live batch progress &amp; ETA countdown',
  '├ /cccancelrange — Cancel active batch submission',
  '└ /ccaccounts — View CodeChef accounts &amp; queue progress',
  '',
  '<b>🍪 𝗦𝗘𝗦𝗦𝗜𝗢𝗡 𝗠𝗔𝗡𝗔𝗚𝗘𝗠𝗘𝗡𝗧</b>',
  '├ /lclogin [label] — Interactive LeetCode login (auto-solves Turnstile)',
  '├ /cflogin [label] — Interactive Codeforces login (auto-solves Turnstile)',
  '├ /checksessions — Inspect all sessions &amp; auto-refresh expired accounts',
  '├ /renew — Session renewal guide &amp; instructions (supports label)',
  '├ /removesession — Remove a single account session',
  '└ /removeallsessions — Purge all stored accounts',
  '',
  '<b>📊 𝗦𝗬𝗦𝗧𝗘𝗠 &amp; 𝗜𝗡𝗙𝗢</b>',
  '├ /status — System uptime &amp; last run summary',
  '├ /cancel — Abort ongoing prompt / renewal',
  '└ /help — Display this command menu',
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
  const lowerText = text.toLowerCase();

  // Support plain text "start queue" / "queue start"
  if (lowerText === 'start queue' || lowerText === 'queue start') {
    pendingQueuePrompt = true;
    pendingPromptType = 'queue';
    pendingRangePrompt = false;
    await replyHtml(formatQueuePromptMessage());
    return;
  }
  if (lowerText.startsWith('start queue ') || lowerText.startsWith('queue start ')) {
    const directCmd = text.slice(12).trim();
    if (directCmd) {
      await handleQueueCommandInput(directCmd);
      return;
    }
  }

  // Handle active interactive login prompt (/lclogin or /cflogin)
  if (activeLoginPrompt) {
    if (text === '/cancel' || lowerText === 'cancel') {
      activeLoginPrompt = null;
      await reply('✖️ Login process cancelled.');
      return;
    }

    if (activeLoginPrompt.step === 'awaiting_identifier') {
      const identifier = text.trim();
      if (!identifier || identifier.startsWith('/')) {
        await reply('⚠️ Please send a valid username or email address (not a command), or /cancel to abort.');
        return;
      }
      activeLoginPrompt.identifier = identifier;
      if (!activeLoginPrompt.label) {
        activeLoginPrompt.label = identifier.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 32) || 'account';
      }
      activeLoginPrompt.step = 'awaiting_password';
      await replyHtml(
        `🔑 Identifier recorded: <code>${escapeHtml(identifier)}</code>\n` +
        `Now please enter your <b>password</b>:\n\n` +
        `<i>🔒 Your password message will be immediately deleted from Telegram chat history for privacy.</i>`,
      );
      return;
    }

    if (activeLoginPrompt.step === 'awaiting_password') {
      // Immediately delete the user's password message for privacy
      if (msg.message_id) {
        await tgApi('deleteMessage', {
          chat_id: msg.chat.id,
          message_id: msg.message_id,
        }).catch((err) => {
          logger.warn({ err: errText(err) }, 'Could not delete password message from Telegram chat');
        });
      }

      const { site, label, identifier } = activeLoginPrompt;
      const password = text;
      activeLoginPrompt = null;

      await handleExecuteLogin(site, label || identifier || 'account', identifier || '', password);
      return;
    }
  }

  // Handle active queue prompt
  if (pendingQueuePrompt) {
    if (text === '/cancel' || lowerText === 'cancel') {
      pendingQueuePrompt = false;
      pendingPromptType = null;
      await reply('✖️ Command queuing cancelled.');
      return;
    }
    const isInteractiveCommand = /^\/(?:cfrange|cf_range|cfbatch|cf_batch|ccrange|cc_range|ccbatch|cc_batch|questionrangesubmission|question_range_submission|rangesubmission)\b/.test(text.toLowerCase());
    if (!isInteractiveCommand) {
      const handled = await handleQueueCommandInput(text);
      if (handled) {
        pendingQueuePrompt = false;
        pendingPromptType = null;
      }
      return;
    }
  }

  // Handle active Capzy / CapSolver key prompt (replace)
  if (pendingCapzyPrompt) {
    if (text === '/cancel' || lowerText === 'cancel') {
      pendingCapzyPrompt = false;
      pendingPromptType = null;
      await reply('✖️ CapSolver key setup cancelled.');
      return;
    }
    await handleCapSolverCommand(text);
    return;
  }

  // Handle active Add Capzy / CapSolver key prompt (append)
  if (pendingAddCapzyPrompt) {
    if (text === '/cancel' || lowerText === 'cancel') {
      pendingAddCapzyPrompt = false;
      pendingPromptType = null;
      await reply('✖️ Add CapSolver key cancelled.');
      return;
    }
    await handleAddCapSolverCommand(text);
    return;
  }

  // API keys are append-only. The prompt remains available even after the pool already has keys.
  if (pendingSolutionKeysPrompt) {
    if (text === '/cancel' || lowerText === 'cancel') {
      pendingSolutionKeysPrompt = false;
      pendingPromptType = null;
      await reply('✖️ Article API-key setup cancelled.');
      return;
    }
    await deleteSensitiveTelegramMessage(msg);
    await handleAddSolutionApiKeys(text);
    return;
  }

  if (text.startsWith('/')) {
    const { command: cmd, arg: commandArg } = extractTelegramCommand(text);
    switch (cmd) {
      case '/start':
      case '/help':
        await replyHtml(HELP_TEXT);
        return;
      case '/addsolutionkeys':
      case '/addsolutionkey':
      case '/addarticlekeys':
      case '/addarticlekey':
      case '/solutionkeys':
      case '/solutionkey':
        await deleteSensitiveTelegramMessage(msg);
        await handleAddSolutionApiKeys(commandArg);
        return;
      case '/setsolutionkeys':
      case '/replacesolutionkeys':
      case '/resetsolutionkeys':
        await deleteSensitiveTelegramMessage(msg);
        await handleReplaceSolutionApiKeys(commandArg);
        return;
      case '/testsolkey':
      case '/testsolkeys':
      case '/testkey':
      case '/checksolkey':
        await deleteSensitiveTelegramMessage(msg);
        await handleTestSolutionApiKey(commandArg);
        return;
      case '/solutionkeystatus':
      case '/solutionkey_status':
      case '/articlekeystatus':
        await replyHtml(await formatSolutionKeyStatus());
        return;
      case '/lclogin':
      case '/lc_login':
      case '/leetcodelogin':
      case '/leetcode_login': {
        const label = commandArg ? commandArg.trim() : undefined;
        activeLoginPrompt = {
          site: 'leetcode',
          step: 'awaiting_identifier',
          label,
        };
        const labelNote = label ? ` for account <code>${escapeHtml(label)}</code>` : '';
        await replyHtml(
          `🔐 <b>LeetCode Interactive Login</b>${labelNote}\n\n` +
          `Please reply with your LeetCode <b>username or email address</b>:\n` +
          `<i>(Send /cancel anytime to abort)</i>`,
        );
        return;
      }
      case '/cflogin':
      case '/cf_login':
      case '/codeforceslogin':
      case '/codeforces_login': {
        const label = commandArg ? commandArg.trim() : undefined;
        activeLoginPrompt = {
          site: 'codeforces',
          step: 'awaiting_identifier',
          label,
        };
        const labelNote = label ? ` for account <code>${escapeHtml(label)}</code>` : '';
        await replyHtml(
          `🔐 <b>Codeforces Interactive Login</b>${labelNote}\n\n` +
          `Please reply with your Codeforces <b>handle or email address</b>:\n` +
          `<i>(Send /cancel anytime to abort)</i>`,
        );
        return;
      }
      case '/checksessions':
      case '/check_sessions':
      case '/sessioncheck':
      case '/session_check':
        await handleCheckSessionsCommand();
        return;
      case '/renew': {
        if (!commandArg) {
          pendingRenewalLabel = undefined;
          pendingRangePrompt = false;
          pendingPromptType = null;
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
          pendingPromptType = 'codechef';
          pendingRangePrompt = false;
          await handleCodeChefRangePrompt(defaultCodeChefUiDeps);
          return;
        }
        pendingPromptType = null;
        pendingRangePrompt = false;
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
      case '/codeforces':
      case '/cf':
      case '/cfnext':
      case '/cf_next':
      case '/cfsubmit':
      case '/cf_submit':
      case '/submitnextsolution':
      case '/submit_next_solution':
        await handleCodeforcesSubmitNext();
        return;
      case '/cfrange':
      case '/cf_range':
      case '/cfbatch':
      case '/cf_batch': {
        const tokens = commandArg.split(/\s+/).filter(Boolean);
        const rawCount = tokens[0];
        const parsedCount = parseInt(rawCount ?? '', 10);
        if (!rawCount || isNaN(parsedCount) || parsedCount <= 0) {
          pendingPromptType = 'codeforces';
          pendingRangePrompt = false;
          await handleCodeforcesRangePrompt(defaultCodeforcesSubmitUiDeps);
          return;
        }
        pendingPromptType = null;
        pendingRangePrompt = false;
        const count = Math.min(50, Math.max(1, parsedCount));
        const modifier = tokens[1]?.toLowerCase();
        if (modifier === 'all' || modifier === '--all') {
          await handleCodeforcesTrigger({ forceNext: true, count });
          return;
        }
        await handleCodeforcesRangePickerCommand(count);
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
      case '/useproxy':
      case '/selectproxy':
      case '/cfuseproxy':
      case '/cfselectproxy':
      case '/chooseproxy':
        await handleUseProxyCommand(commandArg);
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
      case '/addcapsolver':
      case '/addcapsolverkey':
      case '/addcapsolverkeys':
      case '/addcapzy':
      case '/addcapzykey':
      case '/addcapzykeys':
      case '/addsolver':
      case '/addsolverkey':
      case '/addsolverkeys':
        await handleAddCapSolverCommand(commandArg);
        return;
      case '/capsolver':
      case '/capsolverkey':
      case '/capsolverkeys':
      case '/capzy':
      case '/capzykey':
      case '/capzykeys':
      case '/solverkey':
      case '/solverkeys':
      case '/setsolver':
      case '/setcapsolver':
        await handleCapSolverCommand(commandArg);
        return;
      case '/capsolverstatus':
      case '/capzystatus':
      case '/solverstatus':
        await replyHtml(await formatCapzyStatusMessage());
        return;
      case '/cfaccounts':
      case '/cf_accounts':
        await replyHtml(await codeforcesAccountsText());
        return;
      case '/cfprogress':
      case '/cf_progress':
      case '/cfuserprogress':
      case '/cf_user_progress':
        await replyHtml(await codeforcesUserProgressText());
        return;
      case '/cfsetprogress':
      case '/cf_set_progress':
      case '/cfprogressset':
        await handleCfSetProgress(commandArg);
        return;
      case '/triggersubmission':
      case '/trigger_submission':
        await handleTriggerSubmission();
        return;
      case '/dailysolution':
      case '/daily_solution':
        await sendDailySolutionPicker();
        return;
      case '/manualsolution':
      case '/manual_solution':
        await handleManualSolutionCommand(commandArg);
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
        pendingPromptType = null;
        await handleQuestionRangeCommand(commandArg);
        return;
      case '/cancelrange':
      case '/cancel_range':
      case '/stoprange':
        pendingRangePrompt = false;
        pendingPromptType = null;
        await handleCancelRange();
        return;
      case '/rangestatus':
      case '/range_status':
        await handleRangeStatus();
        return;
      case '/startqueue':
      case '/start_queue':
      case '/queuestart':
      case '/queue_start': {
        if (commandArg && commandArg.toLowerCase() !== 'start') {
          await handleQueueCommandInput(commandArg);
          return;
        }
        pendingQueuePrompt = true;
        pendingPromptType = 'queue';
        pendingRangePrompt = false;
        await replyHtml(formatQueuePromptMessage());
        return;
      }
      case '/queue': {
        const lowerArg = commandArg.toLowerCase();
        if (!commandArg || lowerArg === 'start') {
          pendingQueuePrompt = true;
          pendingPromptType = 'queue';
          pendingRangePrompt = false;
          await replyHtml(formatQueuePromptMessage());
          return;
        }
        if (lowerArg === 'status' || lowerArg === 'show' || lowerArg === 'list') {
          await replyHtml(formatQueueStatusText());
          return;
        }
        if (lowerArg === 'clear' || lowerArg === 'cancel' || lowerArg === 'stop') {
          await reply(handleClearQueue());
          return;
        }
        await handleQueueCommandInput(commandArg);
        return;
      }
      case '/queuestatus':
      case '/queue_status':
      case '/showqueue':
      case '/show_queue':
      case '/queuelist':
      case '/queue_list':
        await replyHtml(formatQueueStatusText());
        return;
      case '/clearqueue':
      case '/clear_queue':
      case '/cancelqueue':
      case '/cancel_queue':
        await reply(handleClearQueue());
        return;
      case '/cancel':
        pendingRenewalLabel = undefined;
        pendingRangePrompt = false;
        pendingPromptType = null;
        if (activeLoginPrompt) {
          activeLoginPrompt = null;
          await reply('✖️ Login process cancelled.');
          return;
        }
        if (pendingCapzyPrompt) {
          pendingCapzyPrompt = false;
          await reply('✖️ CapSolver key setup cancelled.');
          return;
        }
        if (pendingQueuePrompt) {
          pendingQueuePrompt = false;
          await reply('✖️ Command queuing cancelled.');
          return;
        }
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
        await reply('🤔 Unknown command. Available: /lclogin, /cflogin, /checksessions, /renew, /renew <label>, /accounts, /cfaccounts, /status, /triggersubmission, /claimcoins, /submitnextsolution, /cfrange, /cfrangestatus, /cfcancelrange, /codechef, /ccrange, /ccrangestatus, /cccancelrange, /nextsubcustomaccount, /cfnetwork, /useproxy, /testproxy, /setproxies, /addproxy, /removeproxy, /restoreproxies, /syncproxies, /capsolver, /capsolverstatus, /cfmanualnext, /questionrangesubmission, /rangestatus, /cancelrange, /removesession, /removeallsessions, /startqueue, /queuestatus, /clearqueue, /cancel, /help');
        return;
    }
  }

  // Text replies to interactive prompts (when not a document and starts with a digit/hash):
  if (!msg.document && pendingPromptType === 'solutionquestion' && /^\s*#?\d{1,5}\s*$/.test(text)) {
    pendingPromptType = null;
    const key = String(msg.chat.id);
    const selected = [...(manualSolutionSelections.get(key) ?? new Set<string>())];
    manualSolutionSelections.delete(key);
    await startDailySolutionWorkflow(selected, Number(text.trim().replace(/^#/, '')));
    return;
  }
  if (!msg.document && /^\s*#?\d/.test(text)) {
    if (pendingPromptType === 'codeforces') {
      pendingPromptType = null;
      pendingRangePrompt = false;
      const count = parseInt(text.replace(/^[#\s]+/, ''), 10);
      if (!isNaN(count) && count > 0) {
        await handleCodeforcesRangePickerCommand(Math.min(50, count));
        return;
      }
    } else if (pendingPromptType === 'codechef') {
      pendingPromptType = null;
      pendingRangePrompt = false;
      const count = parseInt(text.replace(/^[#\s]+/, ''), 10);
      if (!isNaN(count) && count > 0) {
        await handleCodeChefTrigger({ forceNext: true, count: Math.min(50, count) });
        return;
      }
    } else if (pendingPromptType === 'leetcode' || pendingRangePrompt) {
      pendingPromptType = null;
      pendingRangePrompt = false;
      await handleQuestionRangeCommand(text);
      return;
    }
  }

  // Non-command message: check if it's pasted Capzy / CapSolver API key(s)
  if (!msg.document && isLikelyCapzyKey(text)) {
    await handleCapSolverCommand(text);
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
  runnerOrOptions?: typeof runCodeChefNow | { forceNext?: boolean; count?: number; accountIds?: readonly string[] },
  isBusyOrRunner?: (() => boolean) | typeof runCodeChefNow,
  sendOrIsBusy?: ((text: string) => Promise<void>) | (() => boolean),
): Promise<{ done: Promise<void> } | null> {
  let options: { forceNext?: boolean; count?: number; accountIds?: readonly string[] } = {};
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
    const runnerArgs: ['manual', Parameters<typeof runner>[1]?] =
      Object.keys(options).length > 0
        ? ['manual', {
            forceDailyAttempt: true,
            batchCount: options.count ?? 1,
            accountIds: options.accountIds,
          }]
        : ['manual'];
    const done = runner(...runnerArgs).then(async (report) => {
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
      accountIds: options.accountIds,
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

export interface CodeChefUiDeps {
  listAccounts: () => Promise<Awaited<ReturnType<typeof listCodeChefAccounts>>>;
  inProgress: () => boolean;
  send: (text: string, buttons?: InlineButton[][]) => Promise<void>;
  edit: (chatId: number | string, messageId: number, text: string, buttons?: InlineButton[][]) => Promise<void>;
  answer: (callbackId: string, text?: string) => Promise<void>;
}

export const defaultCodeChefUiDeps: CodeChefUiDeps = {
  listAccounts: () => listCodeChefAccounts(true),
  inProgress: isCodeChefRunInProgress,
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

export function buildCodeChefRangeCountPicker(): { text: string; buttons: InlineButton[][] } {
  const shouldQueue = isAnyWorkerBusy() || pendingQueuePrompt;
  const actionPrefix = shouldQueue ? 'ccrange:q:' : 'ccrange:run:';
  const labelSuffix = shouldQueue ? ' (Queue 📥)' : '';

  const text = [
    shouldQueue ? '<b>📥 Queue CodeChef Batch</b>' : '<b>🔢 CodeChef Batch Submission</b>',
    '<code>━━━━━━━━━━━━━━━━━━━━</code>',
    'How many questions do you want to submit?',
    'Select a batch size below, or reply with <code>/ccrange &lt;count&gt;</code>:',
  ].join('\n');
  const buttons: InlineButton[][] = [
    [
      { text: `5 Questions${labelSuffix}`, callback_data: `${actionPrefix}5` },
      { text: `10 Questions${labelSuffix}`, callback_data: `${actionPrefix}10` },
    ],
    [
      { text: `15 Questions${labelSuffix}`, callback_data: `${actionPrefix}15` },
      { text: `20 Questions${labelSuffix}`, callback_data: `${actionPrefix}20` },
    ],
    [
      { text: '✖️ Cancel', callback_data: 'ccrange:x' },
    ],
  ];
  return { text, buttons };
}

export async function handleCodeChefRangePrompt(
  deps: CodeChefUiDeps = defaultCodeChefUiDeps,
): Promise<void> {
  if (deps.inProgress()) {
    await deps.send('🚧 A CodeChef run is already in progress — wait for its report, then try again.');
    return;
  }
  const accounts = await deps.listAccounts();
  if (accounts.length === 0) {
    await deps.send('📭 No active CodeChef accounts configured.');
    return;
  }
  const picker = buildCodeChefRangeCountPicker();
  await deps.send(picker.text, picker.buttons);
}

export async function handleCodeChefRangeButton(
  chatId: number | string,
  messageId: number,
  callbackId: string,
  data: string,
  deps: CodeChefUiDeps = defaultCodeChefUiDeps,
  triggerFn: typeof handleCodeChefTrigger = handleCodeChefTrigger,
): Promise<void> {
  if (data === 'ccrange:x') {
    pendingPromptType = null;
    await deps.answer(callbackId, 'Cancelled');
    await deps.edit(chatId, messageId, '✖️ CodeChef batch submission cancelled.');
    return;
  }

  if (deps.inProgress()) {
    await deps.answer(callbackId, 'A CodeChef run is already in progress');
    await deps.edit(chatId, messageId, '🚧 A CodeChef run is already in progress — wait for its report, then try again.');
    return;
  }

  if (data.startsWith('ccrange:run:') || data.startsWith('ccrange:q:')) {
    pendingPromptType = null;
    const isQueue = data.startsWith('ccrange:q:');
    const rawCount = data.slice(isQueue ? 'ccrange:q:'.length : 'ccrange:run:'.length);
    const count = Math.min(50, Math.max(1, parseInt(rawCount, 10) || 5));
    const accounts = await deps.listAccounts();
    if (accounts.length === 0) {
      await deps.answer(callbackId, 'No active accounts');
      await deps.edit(chatId, messageId, '📭 No active CodeChef accounts configured.');
      return;
    }

    if (isQueue) {
      await deps.answer(callbackId, `Queuing batch (${count} Qs) 📥`);
      await deps.edit(chatId, messageId, `📥 <b>Queued CodeChef batch</b> (${count} questions)...`);
      const cmdStr = `/ccrange ${count}`;
      await handleQueueCommandInput(cmdStr, { notify: async (text, html) => { if (html) await replyHtml(text); else await reply(text); } });
      return;
    }

    await deps.answer(callbackId, `Starting batch (${count} Qs) 🚀`);
    await deps.edit(chatId, messageId, `🚀 Starting CodeChef batch (${count} questions) with 30s pacing…`);

    void triggerFn({
      forceNext: true,
      count,
    }).catch(async (err) => {
      logger.warn({ err: errText(err) }, 'CodeChef batch trigger failed');
    });
    return;
  }

  await deps.answer(callbackId, 'This button is no longer valid');
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

// ---------------------------------------------------------------------------
// Daily submit + article picker (/dailysolution, /manualsolution)
// ---------------------------------------------------------------------------

const dailySolutionSelections = new Map<string, Set<string>>();
// Manual choices intentionally live only for the current Telegram interaction.
// They never change the durable 06:00 schedule selection.
const manualSolutionSelections = new Map<string, Set<string>>();

export function buildDailySolutionPicker(accounts: AccountRecord[], selected: ReadonlySet<string>) {
  const allSelected = accounts.length > 0 && accounts.every(account => selected.has(account.id));
  const buttons: InlineButton[][] = accounts.map(account => [{
    text: `${selected.has(account.id) ? '✅' : '▫️'} ${accountName(account)}`.slice(0, 60),
    callback_data: `lcsol:a:${account.id}`,
  }]);
  buttons.push([{ text: `${allSelected ? '✅' : '👥'} All accounts (${accounts.length})`, callback_data: 'lcsol:all' }]);
  buttons.push([
    { text: `💾 Save daily selection (${selected.size})`, callback_data: 'lcsol:save' },
    { text: '🚀 Run daily now', callback_data: 'lcsol:daily' },
  ]);
  buttons.push([{ text: '✖️ Cancel', callback_data: 'lcsol:x' }]);
  return {
    text: ['📅 <b>Daily submission + solution article</b>', '',
      'Select the LeetCode accounts for the 06:00 IST daily workflow.',
      'The same saved selection is preloaded the next time you open this command.',
      'Each selected account submits the daily problem, generates two verified GIFs, and posts its article.',
      '', `Selected: <b>${selected.size}/${accounts.length}</b>`].join('\n'), buttons,
  };
}

async function sendDailySolutionPicker(): Promise<void> {
  const accounts = await listEnabledAccounts();
  if (!accounts.length) { await reply('📭 No active LeetCode accounts are configured.'); return; }
  const selected = new Set(await selectedAccountIds());
  dailySolutionSelections.set(String(config.telegram.chatId), selected);
  const picker = buildDailySolutionPicker(accounts, selected);
  await defaultCoinClaimUiDeps.send(picker.text, picker.buttons);
}

function solutionStageText(stage: string, error?: string): string {
  switch (stage) {
    case 'starting': return '⏳ Starting…';
    case 'resolving_daily': return '🔎 Finding today’s problem…';
    case 'submitting': return '📤 Submitting solution…';
    case 'accepted': return '✅ Solution accepted; preparing article…';
    case 'generating_article': return '✍️ Generating verified-GIF article…';
    case 'publishing_article': return '📮 Posting article to LeetCode…';
    case 'published': return '✅ Solution and article published';
    case 'article_ready': return '📝 Article generated and awaiting review';
    case 'skipped': return `⏭️ Skipped: ${error ?? 'already in progress'}`;
    case 'failed': {
      if (!error) return '❌ workflow failed';
      if (error === 'GENERATION_RETRY_LIMIT') return '❌ Retry limit reached (4 failed attempts). Use /resetsolutionkeys to reset.';
      if (error === 'AI_CONFIGURATION_REQUIRED') return '❌ No active AI keys. Use /setsolutionkeys to add a CodeCraft key.';
      if (error.startsWith('AI_ERROR:')) {
        const detail = error.slice('AI_ERROR:'.length).trim();
        return `❌ ${escapeHtml(detail.slice(0, 140))}`;
      }
      if (error === 'AI_MODELS_EXHAUSTED') {
        return '❌ AI models exhausted or billing verification required. Run /testsolkey to check.';
      }
      return `❌ ${escapeHtml(error.slice(0, 140))}`;
    }
    default: return '⏳ Queued…';
  }
}

function renderSolutionWorkflowProgress(
  title: string,
  accounts: AccountRecord[],
  states: ReadonlyMap<string, { stage: string; error?: string }>,
): string {
  const lines = [`🏆 <b>${title}</b>`, '<code>━━━━━━━━━━━━━━━━━━━━</code>', ''];
  accounts.forEach((account, index) => {
    const state = states.get(account.id);
    lines.push(`👤 <b>Account ${index + 1}/${accounts.length} · ${escapeHtml(accountName(account))}</b>`);
    lines.push(`└ ${solutionStageText(state?.stage ?? 'queued', state?.error)}`);
  });
  return lines.join('\n').slice(0, 3900);
}

async function startDailySolutionWorkflow(accountIds: string[], questionNumber?: number): Promise<void> {
  if (!accountIds.length) { await reply('⚠️ Select at least one account for this workflow.'); return; }
  const description = questionNumber ? `question #${questionNumber}` : 'today’s daily question';
  const accounts = (await listEnabledAccounts()).filter(account => accountIds.includes(account.id));
  if (accounts.length !== accountIds.length) { await reply('⚠️ One or more selected accounts are no longer available. Open the picker again.'); return; }
  const states = new Map<string, { stage: string; error?: string }>(accounts.map(account => [account.id, { stage: 'queued' }]));
  const title = questionNumber ? `QUESTION #${questionNumber} + SOLUTION ARTICLE` : 'DAILY SUBMISSION + SOLUTION ARTICLE';
  let rendered = renderSolutionWorkflowProgress(title, accounts, states);
  let messageId: number | undefined;
  try {
    const sent = await tgApi<{ message_id: number }>('sendMessage', {
      chat_id: config.telegram.chatId, text: rendered, parse_mode: 'HTML', disable_web_page_preview: true,
    });
    messageId = sent.message_id;
  } catch {
    await reply(`🚀 Starting ${description} for ${accountIds.length} selected account(s). Progress updates will be logged.`);
  }
  const update = async (event: { accountId: string; stage: string; error?: string }) => {
    states.set(event.accountId, { stage: event.stage, error: event.error });
    const next = renderSolutionWorkflowProgress(title, accounts, states);
    if (!messageId || next === rendered) return;
    rendered = next;
    try {
      await tgApi('editMessageText', { chat_id: config.telegram.chatId, message_id: messageId, text: next,
        parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: [] } });
    } catch (error) {
      // Progress delivery must never interrupt the submit/article transaction.
      logger.warn({ err: errText(error), stage: event.stage }, 'telegram solution workflow progress edit failed');
    }
  };
  void (async () => {
    const results = questionNumber ? await runManualQuestion(questionNumber, accountIds, new Date(), update) : await runCombined(accountIds, new Date(), update);
    const done = results.filter(result => result.status === 'PUBLISHED').length;
    const failed = results.filter(result => result.status === 'FAILED').length;
    const acceptedArticleFailed = results.filter(result => result.status === 'FAILED' && result.error === 'AI_MODELS_EXHAUSTED').length;
    await reply(`🏁 ${questionNumber ? `Question #${questionNumber}` : 'Daily workflow'} finished: ${done} published · ${failed} article/workflow failed.${acceptedArticleFailed ? ` ${acceptedArticleFailed} stopped at article generation; accepted code was retained.` : ''}`);
  })().catch(async error => {
    await reply(`⚠️ Daily solution workflow failed: ${errText(error)}`).catch(() => undefined);
  });
}

async function handleDailySolutionButton(chatId: number | string, messageId: number, callbackId: string, data: string): Promise<void> {
  const accounts = await listEnabledAccounts();
  const key = String(chatId);
  const selected = dailySolutionSelections.get(key) ?? new Set(await selectedAccountIds());
  if (data === 'lcsol:x') {
    dailySolutionSelections.delete(key); await defaultCoinClaimUiDeps.answer(callbackId, 'Cancelled');
    await defaultCoinClaimUiDeps.edit(chatId, messageId, '✖️ Daily solution selection cancelled. Saved accounts were not changed.'); return;
  }
  if (data === 'lcsol:all') {
    const all = accounts.length > 0 && accounts.every(account => selected.has(account.id));
    if (all) selected.clear(); else accounts.forEach(account => selected.add(account.id));
    dailySolutionSelections.set(key, selected); await defaultCoinClaimUiDeps.answer(callbackId, all ? 'Cleared all' : 'All accounts selected');
  } else if (data.startsWith('lcsol:a:')) {
    const id = data.slice('lcsol:a:'.length);
    if (!accounts.some(account => account.id === id)) { await defaultCoinClaimUiDeps.answer(callbackId, 'Account no longer available'); return; }
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    dailySolutionSelections.set(key, selected); await defaultCoinClaimUiDeps.answer(callbackId, selected.has(id) ? 'Selected' : 'Unselected');
  } else if (data === 'lcsol:save' || data === 'lcsol:daily') {
    if (!selected.size) { await defaultCoinClaimUiDeps.answer(callbackId, 'Select at least one account'); return; }
    await setSelectedAccounts([...selected]); dailySolutionSelections.delete(key);
    await defaultCoinClaimUiDeps.answer(callbackId, data === 'lcsol:daily' ? 'Starting daily workflow' : 'Saved');
    if (data === 'lcsol:daily') {
      await defaultCoinClaimUiDeps.edit(chatId, messageId, '🚀 Saved selection. The daily submit + verified-GIF article workflow is starting.');
      await startDailySolutionWorkflow([...selected]); return;
    }
  } else { await defaultCoinClaimUiDeps.answer(callbackId); return; }
  const picker = buildDailySolutionPicker(accounts, selected);
  await defaultCoinClaimUiDeps.edit(chatId, messageId, picker.text, picker.buttons);
}

async function handleManualSolutionCommand(argument: string): Promise<void> {
  const accounts = await listEnabledAccounts();
  if (!accounts.length) { await reply('📭 No active LeetCode accounts are configured.'); return; }
  const key = String(config.telegram.chatId);
  // A number supplied with the command is only a convenience; the user still
  // chooses the accounts for this one-time manual run.
  const raw = argument.trim();
  const question = /^#?\d{1,5}$/.test(raw) ? Number(raw.replace('#', '')) : undefined;
  manualSolutionSelections.set(key, new Set());
  const picker = buildManualSolutionPicker(accounts, new Set(), question);
  await defaultCoinClaimUiDeps.send(picker.text, picker.buttons);
}

export function buildManualSolutionPicker(accounts: AccountRecord[], selected: ReadonlySet<string>, questionNumber?: number) {
  const allSelected = accounts.length > 0 && accounts.every(account => selected.has(account.id));
  const buttons: InlineButton[][] = accounts.map(account => [{
    text: `${selected.has(account.id) ? '✅' : '▫️'} ${accountName(account)}`.slice(0, 60), callback_data: `lcsol:m:a:${account.id}`,
  }]);
  buttons.push([{ text: `${allSelected ? '✅' : '👥'} All accounts (${accounts.length})`, callback_data: 'lcsol:m:all' }]);
  buttons.push([
    { text: '📅 Run daily now', callback_data: 'lcsol:m:daily' },
    { text: questionNumber ? `🚀 Submit #${questionNumber}` : '🔢 Enter question number', callback_data: questionNumber ? `lcsol:m:n:${questionNumber}` : 'lcsol:m:question' },
  ]);
  buttons.push([{ text: '✖️ Cancel', callback_data: 'lcsol:m:x' }]);
  return { text: ['🛠️ <b>Manual submission + solution article</b>', '',
    'Choose accounts for this one-time run. These choices do not alter the 06:00 IST daily schedule.',
    'Then choose <b>Run daily now</b> or enter a LeetCode question number.', '',
    `Selected: <b>${selected.size}/${accounts.length}</b>`].join('\n'), buttons };
}

async function handleManualSolutionButton(chatId: number | string, messageId: number, callbackId: string, data: string): Promise<void> {
  const accounts = await listEnabledAccounts();
  const key = String(chatId);
  const selected = manualSolutionSelections.get(key) ?? new Set<string>();
  if (data === 'lcsol:m:x') {
    manualSolutionSelections.delete(key); pendingPromptType = null;
    await defaultCoinClaimUiDeps.answer(callbackId, 'Cancelled');
    await defaultCoinClaimUiDeps.edit(chatId, messageId, '✖️ Manual solution submission cancelled.');
    return;
  }
  if (data === 'lcsol:m:all') {
    const all = accounts.length > 0 && accounts.every(account => selected.has(account.id));
    if (all) selected.clear(); else accounts.forEach(account => selected.add(account.id));
    manualSolutionSelections.set(key, selected);
    await defaultCoinClaimUiDeps.answer(callbackId, all ? 'Cleared all' : 'All accounts selected');
  } else if (data.startsWith('lcsol:m:a:')) {
    const id = data.slice('lcsol:m:a:'.length);
    if (!accounts.some(account => account.id === id)) { await defaultCoinClaimUiDeps.answer(callbackId, 'Account no longer available'); return; }
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    manualSolutionSelections.set(key, selected);
    await defaultCoinClaimUiDeps.answer(callbackId, selected.has(id) ? 'Selected' : 'Unselected');
  } else if (data === 'lcsol:m:question') {
    if (!selected.size) { await defaultCoinClaimUiDeps.answer(callbackId, 'Select at least one account'); return; }
    manualSolutionSelections.set(key, selected); pendingPromptType = 'solutionquestion';
    await defaultCoinClaimUiDeps.answer(callbackId, 'Send a question number');
    await defaultCoinClaimUiDeps.edit(chatId, messageId, '🔢 Send one LeetCode question number, for example <code>3820</code>. Your manual account selection is retained.');
    return;
  } else if (data === 'lcsol:m:daily' || data.startsWith('lcsol:m:n:')) {
    if (!selected.size) { await defaultCoinClaimUiDeps.answer(callbackId, 'Select at least one account'); return; }
    const question = data.startsWith('lcsol:m:n:') ? Number(data.slice('lcsol:m:n:'.length)) : undefined;
    manualSolutionSelections.delete(key); pendingPromptType = null;
    await defaultCoinClaimUiDeps.answer(callbackId, 'Starting manual workflow');
    await defaultCoinClaimUiDeps.edit(chatId, messageId, `🚀 Starting the selected accounts for ${question ? `question #${question}` : 'today’s daily problem'}.`);
    await startDailySolutionWorkflow([...selected], question);
    return;
  } else { await defaultCoinClaimUiDeps.answer(callbackId); return; }
  const picker = buildManualSolutionPicker(accounts, selected);
  await defaultCoinClaimUiDeps.edit(chatId, messageId, picker.text, picker.buttons);
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
  runnerOrOptions?: typeof runCodeforcesNow | { forceNext?: boolean; count?: number; accountIds?: readonly string[] },
  isBusyOrRunner?: (() => boolean) | typeof runCodeforcesNow,
  sendOrIsBusy?: ((text: string) => Promise<void>) | (() => boolean),
  maybeSend?: (text: string) => Promise<void>,
): Promise<{ done: Promise<void> } | null> {
  let options: { forceNext?: boolean; count?: number; accountIds?: readonly string[] } = {};
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
    const done = runner(CODEFORCES_MANUAL_REASON, {
      forceDailyAttempt: true,
      batchCount: options.count ?? 1,
      accountIds: options.accountIds,
    }).then(async (report) => {
      if (!report) await send!('Another Codeforces run started; this command did not create a second run.');
    }).catch(async (err) => {
      await send!(`Codeforces could not start: ${err instanceof Error ? err.message : String(err)}`);
    });
    return { done };
  }

  const allAccounts = await listCodeforcesAccounts(false).catch(() => []);
  const configuredAccounts = options.accountIds && options.accountIds.length > 0
    ? allAccounts.filter((a) => options.accountIds!.includes(a.id))
    : allAccounts;
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
      accountIds: options.accountIds,
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
  send: (text: string, buttons?: InlineButton[][]) => Promise<any>;
  edit: (chatId: number | string, messageId: number, text: string, buttons?: InlineButton[][]) => Promise<void>;
  answer: (callbackId: string, text?: string) => Promise<void>;
}

export const defaultProxyUiDeps: ProxyUiDeps = {
  send: async (text, buttons) => {
    try {
      return await tgApi<{ message_id: number }>('sendMessage', {
        chat_id: config.telegram.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
      });
    } catch (err) {
      if (errText(err).includes("can't parse entities")) {
        const plain = text.replace(/<[^>]+>/g, '');
        return await tgApi<{ message_id: number }>('sendMessage', {
          chat_id: config.telegram.chatId,
          text: plain,
          disable_web_page_preview: true,
          ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
        });
      }
      throw err;
    }
  },
  edit: async (chatId, messageId, text, buttons) => {
    try {
      await tgApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: buttons ?? [] },
      });
    } catch (err) {
      if (errText(err).includes("can't parse entities")) {
        const plain = text.replace(/<[^>]+>/g, '');
        await tgApi('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: plain,
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: buttons ?? [] },
        });
        return;
      }
      throw err;
    }
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

  const sent = (await deps.send([
    '<b>🌐 CODEFORCES PROXY HEALTH CHECK</b>',
    '<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>',
    `🔎 Testing ${all.length} configured proxy(ies) (~150B trace check)...`,
    '<i>Please wait a few seconds...</i>',
  ].join('\n'))) as { message_id?: number } | void;

  let results: ProxyCheckStatus[];
  try {
    results = await testAllProxiesOneByOne();
  } catch (err) {
    logger.warn({ err: errText(err) }, 'testAllProxiesOneByOne failed in handleTestProxyCommand');
    results = all.map((p) => ({
      proxy: p,
      result: { ok: false, latencyMs: 0, error: 'Check failed' },
    }));
  }

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

  const messageId = sent && typeof sent === 'object' && 'message_id' in sent ? sent.message_id : undefined;
  if (messageId) {
    try {
      await deps.edit(config.telegram.chatId, messageId, lines.join('\n'), buttons);
      return;
    } catch {
      // Fall through to send
    }
  }

  await deps.send(lines.join('\n'), buttons);
}

export async function handleUseProxyCommand(arg?: string, deps: ProxyUiDeps = defaultProxyUiDeps): Promise<void> {
  const trimmed = (arg ?? '').trim();

  // Reset to auto pool rotation
  if (trimmed.toLowerCase() === 'auto' || trimmed.toLowerCase() === 'reset') {
    await clearPreferredProxy();
    await deps.send([
      '✅ <b>Reset to Automatic Proxy Rotation</b>',
      '<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>',
      'Preferred proxy cleared. Future Codeforces submissions will test proxies starting from the beginning of the pool and pick the first live proxy.',
    ].join('\n'));
    return;
  }

  // Direct selection by number or proxy identifier
  if (trimmed) {
    const index = Number.parseInt(trimmed.replace(/^#/, ''), 10);
    if (Number.isFinite(index) && index > 0) {
      const res = await setPreferredProxyByIndex(index);
      if (!res.ok || !res.proxy) {
        await deps.send(`❌ Proxy #${index} not found. Available proxies can be viewed with /useproxy or /testproxy.`);
        return;
      }

      const check: ProxyTestResult = await testProxyDetailed(res.proxy.url, 8).catch(() => ({ ok: false, latencyMs: 0, error: 'Check error' } as ProxyTestResult));
      const details = extractProxyDetails(res.proxy.url);
      const statusIcon = check.ok ? '🟢 <b>Live</b>' : '🔴 <b>Down/Unreachable</b>';
      const latencyText = check.ok
        ? ` (${check.latencyMs}ms${check.ip ? ` · IP: ${check.ip}` : ''})`
        : (check.error ? ` (${escapeHtml(check.error)})` : '');

      await deps.send([
        `✅ <b>Preferred Proxy Selected: #${index}</b>`,
        '<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>',
        `🌐 <b>Host:</b> <code>${escapeHtml(details.host)}</code>`,
        `👤 <b>User:</b> <code>${escapeHtml(details.username)}</code>`,
        `🔒 <b>Proxy:</b> <code>${escapeHtml(res.proxy.masked)}</code>`,
        `⚡ <b>Current Status:</b> ${statusIcon}${latencyText}`,
        '',
        '<i>This proxy will be tested and used first for Codeforces submissions. If it goes down, the system will automatically fall back to testing the pool from the beginning.</i>',
      ].join('\n'));
      return;
    }

    // Try selecting by URL, masked string, or hash
    const res = await setPreferredProxy(trimmed);
    if (res) {
      const check: ProxyTestResult = await testProxyDetailed(res.url, 8).catch(() => ({ ok: false, latencyMs: 0, error: 'Check error' } as ProxyTestResult));
      const details = extractProxyDetails(res.url);
      const statusIcon = check.ok ? '🟢 <b>Live</b>' : '🔴 <b>Down/Unreachable</b>';
      const latencyText = check.ok
        ? ` (${check.latencyMs}ms${check.ip ? ` · IP: ${check.ip}` : ''})`
        : (check.error ? ` (${escapeHtml(check.error)})` : '');

      await deps.send([
        `✅ <b>Preferred Proxy Selected: #${res.index}</b>`,
        '<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>',
        `🌐 <b>Host:</b> <code>${escapeHtml(details.host)}</code>`,
        `👤 <b>User:</b> <code>${escapeHtml(details.username)}</code>`,
        `🔒 <b>Proxy:</b> <code>${escapeHtml(res.masked)}</code>`,
        `⚡ <b>Current Status:</b> ${statusIcon}${latencyText}`,
        '',
        '<i>This proxy will be tested and used first for Codeforces submissions. If it goes down, the system will automatically fall back to testing the pool from the beginning.</i>',
      ].join('\n'));
      return;
    }

    await deps.send(`❌ Proxy "${escapeHtml(trimmed)}" not found. Send /useproxy to see all proxies or /useproxy &lt;number&gt; to select by number.`);
    return;
  }

  // Interactive selection: fetch all proxies, test health, display buttons
  const all = await getAllConfiguredProxies();
  if (all.length === 0) {
    await deps.send([
      '<b>🌐 Codeforces Proxies</b>',
      '<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>',
      '⚠️ <b>No proxies found in active pool.</b>',
      '',
      'Add proxies first with /addproxy &lt;url&gt; or /setproxies &lt;urls&gt;.',
    ].join('\n'));
    return;
  }

  const sent = (await deps.send([
    '<b>🌐 CODEFORCES PROXY SELECTION</b>',
    '<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>',
    `🔎 Testing ${all.length} configured proxy(ies) to check live status...`,
    '<i>Please wait a few seconds...</i>',
  ].join('\n'))) as { message_id?: number } | void;

  let results: ProxyCheckStatus[];
  try {
    results = await testAllProxiesOneByOne();
  } catch (err) {
    logger.warn({ err: errText(err) }, 'testAllProxiesOneByOne failed in handleUseProxyCommand');
    results = all.map((p) => ({
      proxy: p,
      result: { ok: false, latencyMs: 0, error: 'Check failed' },
    }));
  }
  const currentPreferred = await getPreferredProxy();

  const lines = [
    '<b>🌐 CODEFORCES PROXY SELECTION</b>',
    '<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>',
    'Select a proxy to prioritize for future Codeforces submissions:',
    '',
  ];

  const buttons: InlineButton[][] = [];

  for (const item of results) {
    const { proxy, result } = item;
    const details = extractProxyDetails(proxy.url);
    const isPref = currentPreferred ? (proxy.url === currentPreferred || proxy.hash === currentPreferred) : false;
    const prefTag = isPref ? ' <b>[CURRENT ACTIVE]</b>' : '';

    if (proxy.isRemoved) {
      lines.push(`🚫 [${proxy.index}/${all.length}] <code>${escapeHtml(proxy.masked)}</code> — <b>Blacklisted in DB</b>${prefTag}`);
    } else if (result.ok) {
      lines.push(`🟢 [${proxy.index}/${all.length}] <code>${escapeHtml(proxy.masked)}</code> — <b>Live</b> (${result.latencyMs}ms${result.ip ? ` · IP: ${result.ip}` : ''})${prefTag}`);
      lines.push(`   └ Host: <code>${escapeHtml(details.host)}</code> · User: <code>${escapeHtml(details.username)}</code>`);
      buttons.push([{
        text: `${isPref ? '⭐ ' : ''}🟢 Use #${proxy.index}: ${details.host}`,
        callback_data: `pxuse:${proxy.index}`,
      }]);
    } else {
      const errDetail = result.error ? ` (${escapeHtml(result.error)})` : ' (offline)';
      lines.push(`🔴 [${proxy.index}/${all.length}] <code>${escapeHtml(proxy.masked)}</code> — <b>Failed</b>${errDetail}${prefTag}`);
      lines.push(`   └ Host: <code>${escapeHtml(details.host)}</code> · User: <code>${escapeHtml(details.username)}</code>`);
      buttons.push([{
        text: `${isPref ? '⭐ ' : ''}🔴 Use #${proxy.index}: ${details.host}`,
        callback_data: `pxuse:${proxy.index}`,
      }]);
    }
  }

  lines.push('');
  if (currentPreferred) {
    const prefProxy = all.find((p) => p.url === currentPreferred || p.hash === currentPreferred);
    lines.push(`⭐ <b>Active Preferred:</b> #${prefProxy?.index ?? '?'} (<code>${escapeHtml(prefProxy?.masked ?? currentPreferred)}</code>)`);
  } else {
    lines.push('⚙️ <b>Active Mode:</b> Automatic pool rotation (picks first live proxy from start)');
  }
  lines.push('');
  lines.push('💡 <i>Tap a button below or send /useproxy &lt;number&gt; to set preferred proxy. Send /useproxy auto to reset to automatic rotation.</i>');

  buttons.push([
    { text: '🔄 Reset to Auto Fallback', callback_data: 'pxuse:auto' },
    { text: '✅ Done', callback_data: 'pxdone' },
  ]);

  const messageId = sent && typeof sent === 'object' && 'message_id' in sent ? sent.message_id : undefined;
  if (messageId) {
    try {
      await deps.edit(config.telegram.chatId, messageId, lines.join('\n'), buttons);
      return;
    } catch (err) {
      logger.warn({ err: errText(err) }, 'Failed to edit message in handleUseProxyCommand, falling back to send');
    }
  }

  await deps.send(lines.join('\n'), buttons).catch(async (err) => {
    logger.error({ err: errText(err) }, 'Failed to send proxy buttons in handleUseProxyCommand');
    const plainLines = lines.map((l) => l.replace(/<[^>]+>/g, ''));
    await deps.send(plainLines.join('\n'), buttons).catch(() => undefined);
  });
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
    '💡 <i>To re-enable all proxies, use /restoreproxies.</i>',
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
      '<i>Or send /syncproxies to sync from GitHub Secrets.</i>',
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
      await deps.send('⏳ GitHub Actions sync dispatched! Please wait ~20-30 seconds, then run /testproxy.');
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
  if (data.startsWith('pxuse:')) {
    const target = data.slice('pxuse:'.length).trim();
    if (target === 'auto' || target === 'reset') {
      await clearPreferredProxy();
      await deps.answer(callbackId, 'Reset to auto proxy rotation');
      await deps.edit(
        chatId,
        messageId,
        [
          '✅ <b>Reset to Automatic Proxy Rotation</b>',
          '<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>',
          'Preferred proxy cleared. Future Codeforces submissions will test proxies starting from the beginning of the pool and pick the first live proxy.',
        ].join('\n'),
      );
      return;
    }

    const index = Number.parseInt(target, 10);
    const res = await setPreferredProxyByIndex(index);
    if (!res.ok || !res.proxy) {
      await deps.answer(callbackId, res.error ?? `Proxy #${index} not found`);
      return;
    }

    const details = extractProxyDetails(res.proxy.url);
    await deps.answer(callbackId, `Preferred proxy #${index} selected!`);
    await deps.edit(
      chatId,
      messageId,
      [
        `✅ <b>Preferred Proxy Selected: #${index}</b>`,
        '<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>',
        `🌐 <b>Host:</b> <code>${escapeHtml(details.host)}</code>`,
        `👤 <b>User:</b> <code>${escapeHtml(details.username)}</code>`,
        `🔒 <b>Proxy:</b> <code>${escapeHtml(res.proxy.masked)}</code>`,
        '',
        '<i>This proxy will be tested and used first for future Codeforces submissions. If it goes down, the system will automatically fall back to testing the pool from the beginning.</i>',
      ].join('\n'),
    );
    return;
  }
}

export async function formatCapzyStatusMessage(): Promise<string> {
  const lines: string[] = [
    '🧩 <b>Cloudflare Turnstile Solver Configuration</b>',
    '<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>',
  ];

  // 1. Primary Solver: CPSolver (Local/Render)
  const cpUrl = getCPSolverUrl();
  if (cpUrl) {
    const health = await checkCPSolverHealth();
    if (health.ok) {
      lines.push('🟢 <b>Primary Solver: CPSolver (Local/Render)</b>');
      lines.push(`├ URL: <code>${escapeHtml(health.url)}</code>`);
      lines.push(`├ Status: <b>Online</b> (Uptime: ${health.uptimeSeconds ?? 0}s)`);
      lines.push(`├ Proxy Pool: <b>${health.totalProxies ?? 0} proxies</b> (Active: #${(health.activeIndex ?? 0) + 1})`);
      if (health.activeProxy) {
        lines.push(`└ Active Proxy: <code>${escapeHtml(health.activeProxy)}</code>`);
      }
    } else {
      lines.push('🔴 <b>Primary Solver: CPSolver (Local/Render)</b>');
      lines.push(`├ URL: <code>${escapeHtml(cpUrl)}</code>`);
      lines.push(`└ Status: <b>Offline/Unreachable</b> (<i>${escapeHtml(health.error ?? 'unknown')}</i>)`);
    }
  } else {
    lines.push('⚪ <b>Primary Solver: CPSolver (Local/Render)</b>');
    lines.push('└ <i>Not configured. Set CPSOLVER_URL in environment variables to enable.</i>');
  }

  lines.push('');
  lines.push('<b>🔄 Fallback Solver: CapSolver / Capzy (Commercial)</b>');

  const keys = await getCapzyApiKeys();
  if (keys.length === 0) {
    lines.push('⚠️ <i>No CapSolver/Capzy API keys configured in database.</i>');
    lines.push('To configure API key(s), run: <code>/capsolver &lt;key1, key2, ...&gt;</code>');
  } else {
    const balances: KeyBalanceResult[] = [];
    for (let i = 0; i < keys.length; i++) {
      balances.push(await checkCapzyKeyBalance(keys[i]!));
    }

    let activeIdx = await getActiveCapzyKeyIndex();
    // Auto-heal: If active key is out of bounds or current active key has insufficient balance,
    // automatically promote the first funded key in the pool.
    if (
      activeIdx >= keys.length ||
      !balances[activeIdx]?.ok ||
      (balances[activeIdx]?.balance ?? 0) < MIN_USABLE_CAPZY_BALANCE
    ) {
      const firstFunded = balances.findIndex((b) => b.ok && b.balance >= MIN_USABLE_CAPZY_BALANCE);
      if (firstFunded >= 0) {
        activeIdx = firstFunded;
        await setActiveCapzyKeyIndex(activeIdx);
      } else if (activeIdx >= keys.length) {
        activeIdx = 0;
        await setActiveCapzyKeyIndex(0);
      }
    }

    lines.push(`Total configured keys: <b>${keys.length}</b>`);
    lines.push(`Active key: <b>#${activeIdx + 1} (${escapeHtml(maskApiKey(keys[activeIdx] ?? ''))})</b>`);
    lines.push('');
    lines.push('<b>API Key Balances:</b>');

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const masked = maskApiKey(key);
      const isActive = i === activeIdx;
      const bal = balances[i]!;
      const isFunded = bal.ok && bal.balance >= MIN_USABLE_CAPZY_BALANCE;
      const tag = isActive
        ? ' <b>[ACTIVE]</b>'
        : (!isFunded ? ' <i>(exhausted/prior)</i>' : '');
      if (bal.ok && bal.balance > 0) {
        lines.push(`├ Key #${i + 1}: <code>${escapeHtml(masked)}</code> — ✅ $${bal.balance.toFixed(4)}${tag}`);
      } else {
        const errDesc = bal.error || (bal.balance <= 0 ? 'zero balance' : 'error');
        lines.push(`├ Key #${i + 1}: <code>${escapeHtml(masked)}</code> — ❌ ${escapeHtml(errDesc)}${tag}`);
      }
    }
  }

  lines.push('');
  lines.push('💡 <i>Commands: Use /addcapsolver &lt;key&gt; to add keys without removing older ones, or /capsolver &lt;key&gt; to replace all keys.</i>');
  lines.push('💡 <i>Execution flow: Submissions first attempt solving via CPSolver (up to 3 tries with residential proxy failover). If CPSolver fails, it automatically fails over to CapSolver/Capzy.</i>');
  return lines.join('\n');
}

export async function handleCapSolverCommand(commandArg?: string): Promise<void> {
  const arg = (commandArg ?? '').trim();
  if (arg) {
    pendingCapzyPrompt = false;
    pendingPromptType = null;
    await reply('⏳ Verifying and saving CapSolver/Capzy API keys...');
    const saveResult = await saveCapzyApiKeys(arg);
    if (!saveResult.ok || saveResult.keys.length === 0) {
      await replyHtml(`❌ <b>Failed to save API keys:</b> ${escapeHtml(saveResult.error ?? 'Invalid input')}`);
      return;
    }

    const activeIdx = await getActiveCapzyKeyIndex();
    const lines: string[] = [
      '🧩 <b>CapSolver / Capzy API Keys Saved</b>',
      '<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>',
      `Saved <b>${saveResult.keys.length}</b> key(s) to database.`,
      `Active key: <b>#${activeIdx + 1} (${escapeHtml(maskApiKey(saveResult.keys[activeIdx] ?? ''))})</b>`,
      '',
      '<b>Validation Results:</b>',
    ];

    for (let i = 0; i < saveResult.keys.length; i++) {
      const key = saveResult.keys[i]!;
      const masked = maskApiKey(key);
      const bal = saveResult.balances[i];
      const isActive = i === activeIdx;
      const tag = isActive ? ' <b>[ACTIVE]</b>' : '';
      if (bal && bal.ok && bal.balance > 0) {
        lines.push(`├ Key #${i + 1}: <code>${escapeHtml(masked)}</code> — ✅ $${bal.balance.toFixed(4)}${tag}`);
      } else {
        const errDesc = bal?.error || 'Zero balance / invalid';
        lines.push(`├ Key #${i + 1}: <code>${escapeHtml(masked)}</code> — ⚠️ ${escapeHtml(errDesc)}${tag}`);
      }
    }

    lines.push('');
    lines.push('🔄 <i>Automatic rotation is active: if a key runs out of funds or errors, solving immediately continues with the next key and persists the active state.</i>');
    await replyHtml(lines.join('\n'));
    return;
  }

  // If no argument provided: prompt user
  pendingCapzyPrompt = true;
  pendingAddCapzyPrompt = false;
  pendingPromptType = 'capzy';
  pendingRangePrompt = false;
  pendingQueuePrompt = false;

  const currentStatus = await formatCapzyStatusMessage();
  const promptMsg = [
    currentStatus,
    '',
    '<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>',
    '🔑 <b>Replace All CapSolver / Capzy Key(s)</b>',
    '',
    'Please send your API key(s) in your next message.',
    'You can enter a single key or comma-separated multiple keys:',
    '<code>capzy_xxx..., capzy_yyy...</code>',
    '',
    '💡 <i>Note: This will replace the entire key list. To ADD keys without removing existing ones, use /addcapsolver &lt;key&gt; instead.</i>',
    'Send /cancel to abort.',
  ].join('\n');

  await replyHtml(promptMsg);
}

export async function handleAddCapSolverCommand(commandArg?: string): Promise<void> {
  const arg = (commandArg ?? '').trim();
  if (arg) {
    pendingAddCapzyPrompt = false;
    pendingCapzyPrompt = false;
    pendingPromptType = null;
    await reply('⏳ Verifying and appending CapSolver/Capzy API key(s)...');
    const addResult = await addCapzyApiKeys(arg);
    if (!addResult.ok || addResult.totalKeys.length === 0) {
      await replyHtml(`❌ <b>Failed to add API key(s):</b> ${escapeHtml(addResult.error ?? 'Invalid input')}`);
      return;
    }

    const activeIdx = await getActiveCapzyKeyIndex();
    const lines: string[] = [
      '➕ <b>CapSolver / Capzy API Key(s) Added</b>',
      '<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>',
    ];

    if (addResult.addedKeys.length > 0) {
      lines.push(`Added <b>${addResult.addedKeys.length}</b> new key(s).`);
    }
    if (addResult.alreadyPresentKeys.length > 0) {
      lines.push(`ℹ️ <b>${addResult.alreadyPresentKeys.length}</b> key(s) already existed in pool.`);
    }
    lines.push(`Total active pool: <b>${addResult.totalKeys.length}</b> key(s).`);
    lines.push(`Active key: <b>#${activeIdx + 1} (${escapeHtml(maskApiKey(addResult.totalKeys[activeIdx] ?? ''))})</b>`);
    lines.push('');
    lines.push('<b>Current Key Pool &amp; Balances:</b>');

    const addedSet = new Set(addResult.addedKeys);

    for (let i = 0; i < addResult.totalKeys.length; i++) {
      const key = addResult.totalKeys[i]!;
      const masked = maskApiKey(key);
      const bal = addResult.balances[i];
      const isActive = i === activeIdx;
      const isNew = addedSet.has(key);
      let badges = '';
      if (isActive) badges += ' <b>[ACTIVE]</b>';
      if (isNew) badges += ' <i>[NEW]</i>';

      if (bal && bal.ok && bal.balance > 0) {
        lines.push(`├ Key #${i + 1}: <code>${escapeHtml(masked)}</code> — ✅ $${bal.balance.toFixed(4)}${badges}`);
      } else {
        const errDesc = bal?.error || 'Zero balance / invalid';
        lines.push(`├ Key #${i + 1}: <code>${escapeHtml(masked)}</code> — ⚠️ ${escapeHtml(errDesc)}${badges}`);
      }
    }

    lines.push('');
    lines.push('🔄 <i>Automatic rotation will cycle through all keys seamlessly during CF challenge solving. Older keys are safely preserved.</i>');
    await replyHtml(lines.join('\n'));
    return;
  }

  // If no argument provided: prompt user
  pendingAddCapzyPrompt = true;
  pendingCapzyPrompt = false;
  pendingPromptType = 'addcapzy';
  pendingRangePrompt = false;
  pendingQueuePrompt = false;

  const currentStatus = await formatCapzyStatusMessage();
  const promptMsg = [
    currentStatus,
    '',
    '<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>',
    '➕ <b>Add New CapSolver / Capzy API Key(s)</b>',
    '',
    'Existing keys will <b>NOT</b> be removed.',
    'Please send the new API key(s) in your next message (single key or comma-separated):',
    '<code>capzy_new1..., capzy_new2...</code>',
    '',
    'Send /cancel to abort.',
  ].join('\n');

  await replyHtml(promptMsg);
}

export async function formatSolutionKeyStatus(): Promise<string> {
  const status = await solutionKeyPoolStatus();
  const lines = [
    '✨ <b>Article-generation API key pool</b>',
    '<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>',
    `Stored keys: <b>${status.total}</b>`,
    `Source: <b>${escapeHtml(status.source)}</b>`,
    status.active ? `Active key: <b>#${status.active}</b>` : 'Active key: <b>none</b>',
    '',
  ];
  if (!status.keys.length) lines.push('No article-generation API keys are configured.');
  else for (const key of status.keys) lines.push(`├ Key #${key.position}: <code>${escapeHtml(key.masked)}</code>${key.active ? ' <b>[ACTIVE]</b>' : ''}`);
  lines.push('');
  lines.push('💡 <i>/addsolutionkeys accepts one key or comma-separated keys and appends them. Quota/credential exhaustion advances to the next saved key; short rate limits do not rotate the pool.</i>');
  return lines.join('\n');
}

export async function handleAddSolutionApiKeys(commandArg?: string): Promise<void> {
  const raw = (commandArg ?? '').trim();
  if (!raw) {
    pendingSolutionKeysPrompt = true;
    pendingPromptType = 'solutionkeys';
    pendingCapzyPrompt = false;
    pendingAddCapzyPrompt = false;
    pendingQueuePrompt = false;
    await replyHtml([
      await formatSolutionKeyStatus(), '', '<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>',
      '➕ <b>Add CodeCraft API key(s)</b>', '',
      'Send one key or a comma-separated list in your next message. Existing keys stay in order; new keys are appended after them.',
      'The bot attempts to delete your message after it stores the key. Send /cancel to abort.',
    ].join('\n'));
    return;
  }
  pendingSolutionKeysPrompt = false;
  pendingPromptType = null;
  try {
    const result = await appendSolutionApiKeys(raw);
    const status = await solutionKeyPoolStatus();
    await replyHtml([
      '✅ <b>Article API key(s) saved</b>',
      `<b>${result.added}</b> added; <b>${result.duplicates}</b> already present.`,
      `Pool size: <b>${status.total}</b>. ${status.active ? `Active: <b>#${status.active}</b>.` : 'No active key.'}`,
      '',
      'Keys are encrypted in the bot database and never shown in full. A quota/payment/invalid-key response advances to the next saved key for future article generation.',
    ].join('\n'));
  } catch (error) {
    await replyHtml(`❌ <b>Could not save article API keys:</b> ${escapeHtml(error instanceof Error ? error.message : 'invalid input')}`);
  }
}

/** Explicitly reactivates a replacement pool without reviving a key by surprise. */
export async function handleReplaceSolutionApiKeys(commandArg?: string): Promise<void> {
  const raw = (commandArg ?? '').trim();
  if (!raw) {
    try {
      const pool = await resetSolutionApiKeyPool();
      const cleared = await resetFailedSolutionPostRetries();
      await replyHtml([
        '🔄 <b>Article API key pool reset</b>',
        `Active key reset to <b>#1</b> (of ${pool.keys.length}).`,
        cleared > 0 ? `Cleared retry limit on <b>${cleared}</b> failed solution article(s).` : 'No locked solution articles.',
        'Run <code>/manualsolution</code> to test from Render, or <code>/testsolkey</code> to verify key status.',
      ].join('\n'));
      return;
    } catch {
      await replyHtml('⚠️ Usage: <code>/setsolutionkeys key1,key2</code>\nOr send <code>/resetsolutionkeys</code> to reset the existing pool to key #1.');
      return;
    }
  }
  try {
    const pool = await replaceSolutionApiKeys(raw);
    const cleared = await resetFailedSolutionPostRetries();
    await replyHtml([
      '✅ <b>Article API key pool replaced</b>',
      `Stored <b>${pool.keys.length}</b> key(s); active key: <b>#1</b>.`,
      cleared > 0 ? `Cleared retry limit on <b>${cleared}</b> failed solution article(s).` : '',
      'The supplied command message was deleted. Run <code>/manualsolution</code> to test from Render.',
    ].filter(Boolean).join('\n'));
  } catch (error) {
    await replyHtml(`❌ <b>Could not replace article API keys:</b> ${escapeHtml(error instanceof Error ? error.message : 'invalid input')}`);
  }
}

export async function handleTestSolutionApiKey(commandArg?: string): Promise<void> {
  const arg = (commandArg ?? '').trim();
  await replyHtml('🔎 <b>Testing CodeCraft API key…</b>\nChecking <code>/v1/models</code> and <code>/v1/chat/completions</code> from this server…');
  const result = await testSolutionApiKey(arg || undefined);
  const hostLabel = process.env.RENDER_EXTERNAL_URL ? 'Render Web Service' : (process.env.RENDER_INSTANCE_ID ? 'Render Container' : 'Local Host');
  const lines = [
    '🧪 <b>CodeCraft API Key Diagnostics</b>',
    '<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>',
    `🔑 <b>Key:</b> <code>${escapeHtml(result.keyMasked)}</code>`,
    `📍 <b>Execution host:</b> <code>${escapeHtml(hostLabel)}</code>`,
    '',
    `• <b>GET /v1/models:</b> ${result.modelsStatus === 200 ? '🟢 HTTP 200 OK' : `🔴 HTTP ${result.modelsStatus}`} (${result.modelsCount} models returned)`,
  ];
  if (result.chatStatus) {
    if (result.chatStatus === 200) {
      lines.push(`• <b>POST /v1/chat/completions:</b> 🟢 HTTP 200 OK (model: <code>${result.chatModel}</code>)`);
      lines.push('');
      lines.push('✅ <b>Inference is fully operational!</b> Articles can be generated.');
    } else {
      lines.push(`• <b>POST /v1/chat/completions:</b> 🔴 HTTP ${result.chatStatus} (model: <code>${result.chatModel}</code>)`);
      if (result.chatError) lines.push(`  └ <b>Error:</b> <code>${escapeHtml(result.chatError)}</code>`);
      if (result.chatCode) lines.push(`  └ <b>Code:</b> <code>${escapeHtml(result.chatCode)}</code>`);
      if (result.chatType) lines.push(`  └ <b>Type:</b> <code>${escapeHtml(result.chatType)}</code>`);
      lines.push('');
      if (result.chatStatus === 402) {
        lines.push('⚠️ <b>Cause:</b> CodeCraft rejected inference with <code>Billing verification failed</code>.');
        lines.push('The key is syntactically valid and recognized by CodeCraft, but the account has not completed billing verification or has insufficient funds.');
        lines.push('👉 Visit <a href="https://codecraftapi.com">codecraftapi.com</a> to verify billing or attach a payment method.');
      } else if (result.chatStatus === 401) {
        lines.push('⚠️ <b>Cause:</b> Invalid or revoked API key.');
      }
    }
  } else if (result.error) {
    lines.push(`• <b>Inference check skipped:</b> <code>${escapeHtml(result.error)}</code>`);
  }
  await replyHtml(lines.join('\n'));
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

export interface CodeforcesRangeSelectionState {
  count: number;
  selectedAccountIds: Set<string>;
}

export const cfRangeSelections = new Map<string, CodeforcesRangeSelectionState>();

/** Builds the multi-selection account picker for /cfrange <count>. */
export function buildCodeforcesRangePicker(
  count: number,
  accounts: Awaited<ReturnType<typeof listCodeforcesAccounts>>,
  selected: ReadonlySet<string>,
): { text: string; buttons: InlineButton[][] } {
  const allSelected = accounts.length > 0 && accounts.every((account) => selected.has(account.id));
  const buttons: InlineButton[][] = accounts.map((account) => [{
    text: `${selected.has(account.id) ? '✅' : '▫️'} ${cfAccountName(account)}`.slice(0, 60),
    callback_data: `cfrange:a:${account.id}`,
  }]);
  buttons.push([{
    text: `${allSelected ? '✅' : '👥'} Select All (${accounts.length})`,
    callback_data: 'cfrange:all',
  }]);
  const startLabel = selected.size > 0
    ? `🚀 Start Batch (${count} Qs · ${selected.size} acc)`
    : `🚀 Start Batch (${count} Qs)`;
  
  const shouldQueue = isAnyWorkerBusy() || pendingQueuePrompt;
  const finalBtnLabel = shouldQueue ? startLabel.replace('🚀 Start Batch', '📥 Enqueue Batch') : startLabel;
  const finalBtnAction = shouldQueue ? 'cfrange:q' : 'cfrange:run';

  buttons.push([
    { text: finalBtnLabel, callback_data: finalBtnAction },
    { text: '✖️ Cancel', callback_data: 'cfrange:x' },
  ]);

  const plural = count === 1 ? 'question' : 'questions';
  return {
    text: [
      `<b>🏆 CODEFORCES BATCH (${count} ${count === 1 ? 'QUESTION' : 'QUESTIONS'})</b>`,
      '<code>━━━━━━━━━━━━━━━━━━━━</code>',
      'Select the accounts to submit for this batch:',
      `<i>Each selected account will submit ${count} ${plural} with 30s pacing.</i>`,
    ].join('\n'),
    buttons,
  };
}

/** Handles the /cfrange command by opening an interactive multi-selection account picker. */
export async function handleCodeforcesRangePickerCommand(
  count: number,
  deps: CodeforcesSubmitUiDeps = defaultCodeforcesSubmitUiDeps,
  chatId: number | string = config.telegram.chatId,
): Promise<void> {
  const accounts = await deps.listAccounts();
  if (accounts.length === 0) {
    await deps.send('📭 No active Codeforces accounts configured — send a Codeforces session JSON through /renew first.');
    return;
  }
  const key = String(chatId);
  const selected = new Set<string>();
  if (accounts.length === 1 && accounts[0]) {
    selected.add(accounts[0].id);
  }
  cfRangeSelections.set(key, { count, selectedAccountIds: selected });
  const picker = buildCodeforcesRangePicker(count, accounts, selected);
  await deps.send(picker.text, picker.buttons);
}

export function buildCodeforcesRangeCountPicker(): { text: string; buttons: InlineButton[][] } {
  const text = [
    '<b>🔢 Codeforces Batch Submission</b>',
    '<code>━━━━━━━━━━━━━━━━━━━━</code>',
    'How many questions do you want to submit?',
    'Select a batch size below, or reply with <code>/cfrange &lt;count&gt;</code>:',
  ].join('\n');
  const buttons: InlineButton[][] = [
    [
      { text: '5 Questions', callback_data: 'cfrange:c:5' },
      { text: '10 Questions', callback_data: 'cfrange:c:10' },
    ],
    [
      { text: '15 Questions', callback_data: 'cfrange:c:15' },
      { text: '20 Questions', callback_data: 'cfrange:c:20' },
    ],
    [
      { text: '✖️ Cancel', callback_data: 'cfrange:x' },
    ],
  ];
  return { text, buttons };
}

export async function handleCodeforcesRangePrompt(
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
  const picker = buildCodeforcesRangeCountPicker();
  await deps.send(picker.text, picker.buttons);
}

/** Handles inline button taps for the /cfrange multi-selection picker. */
export async function handleCodeforcesRangeButton(
  chatId: number | string,
  messageId: number,
  callbackId: string,
  data: string,
  deps: CodeforcesSubmitUiDeps = defaultCodeforcesSubmitUiDeps,
  triggerFn: typeof handleCodeforcesTrigger = handleCodeforcesTrigger,
): Promise<void> {
  const key = String(chatId);
  if (data === 'cfrange:x') {
    cfRangeSelections.delete(key);
    pendingPromptType = null;
    await deps.answer(callbackId, 'Cancelled');
    await deps.edit(chatId, messageId, '✖️ Codeforces batch submission cancelled.');
    return;
  }

  if (data.startsWith('cfrange:c:')) {
    pendingPromptType = null;
    const rawCount = data.slice('cfrange:c:'.length);
    const count = Math.min(50, Math.max(1, parseInt(rawCount, 10) || 5));
    const accounts = await deps.listAccounts();
    if (accounts.length === 0) {
      cfRangeSelections.delete(key);
      await deps.answer(callbackId, 'No active accounts');
      await deps.edit(chatId, messageId, '📭 No active Codeforces accounts configured — send a Codeforces session JSON through /renew first.');
      return;
    }
    const selected = new Set<string>();
    if (accounts.length === 1 && accounts[0]) {
      selected.add(accounts[0].id);
    }
    cfRangeSelections.set(key, { count, selectedAccountIds: selected });
    await deps.answer(callbackId, `${count} questions selected`);
    const picker = buildCodeforcesRangePicker(count, accounts, selected);
    await deps.edit(chatId, messageId, picker.text, picker.buttons);
    return;
  }

  const state = cfRangeSelections.get(key);
  if (!state) {
    await deps.answer(callbackId, 'This batch picker expired');
    await deps.edit(chatId, messageId, '⌛ This batch picker expired. Send /cfrange again.');
    return;
  }

  const accounts = await deps.listAccounts();
  if (accounts.length === 0) {
    cfRangeSelections.delete(key);
    await deps.answer(callbackId, 'No active accounts');
    await deps.edit(chatId, messageId, '📭 No active Codeforces accounts configured.');
    return;
  }

  if (data === 'cfrange:all') {
    const allSelected = accounts.every((account) => state.selectedAccountIds.has(account.id));
    state.selectedAccountIds.clear();
    if (!allSelected) {
      accounts.forEach((account) => state.selectedAccountIds.add(account.id));
    }
    await deps.answer(callbackId, allSelected ? 'Cleared all' : 'All accounts selected');
    const picker = buildCodeforcesRangePicker(state.count, accounts, state.selectedAccountIds);
    await deps.edit(chatId, messageId, picker.text, picker.buttons);
    return;
  }

  if (data.startsWith('cfrange:a:')) {
    const id = data.slice('cfrange:a:'.length);
    if (!accounts.some((account) => account.id === id)) {
      await deps.answer(callbackId, 'Account no longer available');
      return;
    }
    if (state.selectedAccountIds.has(id)) {
      state.selectedAccountIds.delete(id);
    } else {
      state.selectedAccountIds.add(id);
    }
    await deps.answer(callbackId, state.selectedAccountIds.has(id) ? 'Selected' : 'Unselected');
    const picker = buildCodeforcesRangePicker(state.count, accounts, state.selectedAccountIds);
    await deps.edit(chatId, messageId, picker.text, picker.buttons);
    return;
  }

  if (data === 'cfrange:run' || data === 'cfrange:q') {
    const selectedAccounts = accounts.filter((account) => state.selectedAccountIds.has(account.id));
    if (selectedAccounts.length === 0) {
      await deps.answer(callbackId, 'Select at least one account');
      return;
    }

    const { count, selectedAccountIds } = state;
    cfRangeSelections.delete(key);

    const desc = selectedAccounts.length === 1
      ? cfAccountName(selectedAccounts[0]!)
      : `${selectedAccounts.length} accounts (${selectedAccounts.map((a) => cfAccountName(a)).join(', ')})`;

    if (data === 'cfrange:q') {
      await deps.answer(callbackId, 'Batch Queued 📥');
      await deps.edit(chatId, messageId, `📥 <b>Queued Codeforces batch</b> (${count} Qs) for ${desc}...`);
      const cmdStr = `/cfrange ${count} ${Array.from(selectedAccountIds).join(',')}`;
      await handleQueueCommandInput(cmdStr, { notify: async (text, html) => { if (html) await replyHtml(text); else await reply(text); } });
      return;
    }

    await deps.answer(callbackId, 'Batch starting 🚀');
    await deps.edit(
      chatId,
      messageId,
      `🚀 Starting Codeforces batch (${count} Qs) for ${desc}…`,
    );

    void triggerFn({
      forceNext: true,
      count,
      accountIds: Array.from(selectedAccountIds),
    }).catch(async (err) => {
      logger.warn({ err: errText(err) }, 'Codeforces batch trigger failed');
      await deps.send(`⚠️ Codeforces batch failed to start: ${errText(err)}`).catch(() => undefined);
    });
    return;
  }

  await deps.answer(callbackId);
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
  codechefUi: CodeChefUiDeps = defaultCodeChefUiDeps,
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

  if (data.startsWith('lcsol:')) {
    if (data.startsWith('lcsol:m:')) { await handleManualSolutionButton(chatId, messageId, q.id, data); return; }
    await handleDailySolutionButton(chatId, messageId, q.id, data);
    return;
  }

  if (data.startsWith('qr:')) {
    await handleRangeButton(chatId, messageId, q.id, data, deps, ui);
    return;
  }

  if (data.startsWith('cfsub:')) {
    await handleCodeforcesSubmitButton(chatId, messageId, q.id, data, codeforcesUi);
    return;
  }

  if (data.startsWith('cfrange:')) {
    await handleCodeforcesRangeButton(chatId, messageId, q.id, data, codeforcesUi);
    return;
  }

  if (data.startsWith('ccrange:')) {
    await handleCodeChefRangeButton(chatId, messageId, q.id, data, codechefUi);
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
    await deps.edit(chatId, messageId, `🧹 Removed all Codeforces sessions (${removed} account(s)).\n\n<b>Note:</b> Username submission progress is permanently preserved in the DB. When cookies are re-added, accounts continue from their next question.`);
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
      text = `✅ Removed Codeforces account ${cfAccountName(target)} (username submission progress preserved in DB)`;
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

const RANGE_GAP_MS = 30_000;

/** Wiring for the range UI — injectable for tests. */
export interface RangeUiDeps {
  start: (range: QuestionRange, target: string | 'all', options?: StartRangeOptions) => Promise<StartRangeResult>;
  current: typeof currentRangeJob;
  cancel: typeof cancelRangeJob;
  now: () => number;
  queueLength?: () => number;
}

export interface RangeAccountSectionState {
  accIndex: number;
  label: string;
  username?: string | null;
  completedItems: string[];
  activeLine?: string;
  accountStatus?: string;
}

export function renderRangeProgressSections(
  sections: ReadonlyMap<number, RangeAccountSectionState>,
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
      } else if (sec.accountStatus) {
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

export interface RangeTriggerDeps {
  listAccounts: () => Promise<AccountRecord[]>;
  getAccount: (id: string) => Promise<AccountRecord | null>;
  startJob: (range: QuestionRange, target: string | 'all', deps: RangeDeps, options?: StartRangeOptions) => Promise<StartRangeResult>;
  send?: (text: string) => Promise<void>;
  edit?: (chatId: number | string, messageId: number, text: string) => Promise<void>;
}

export const defaultRangeTriggerDeps: RangeTriggerDeps = {
  listAccounts: listEnabledAccounts,
  getAccount: getAccountById,
  startJob: startRangeJob,
};

export async function handleQuestionRangeTrigger(
  range: QuestionRange,
  target: string | 'all',
  triggerDeps: RangeTriggerDeps = defaultRangeTriggerDeps,
  chatId: number | string = config.telegram.chatId,
  options?: StartRangeOptions,
): Promise<StartRangeResult> {
  let configuredAccounts: AccountRecord[] = [];
  if (target === 'all') {
    configuredAccounts = await triggerDeps.listAccounts().catch(() => []);
    if (configuredAccounts.length === 0) return { started: false, reason: 'no-accounts' };
  } else {
    const acc = await triggerDeps.getAccount(target).catch(() => null);
    if (!acc) return { started: false, reason: 'account-not-found' };
    configuredAccounts = [acc];
  }

  const mode = options?.mode ?? (target === 'all' && configuredAccounts.length > 1 ? 'parallel' : 'sequential');
  const budget = calculateSafeRangeConcurrency(configuredAccounts.length, {
    mode,
    maxConcurrency: options?.maxConcurrency,
  });
  const concurrency = budget.concurrency;

  const initialTotalAccounts = Math.max(1, configuredAccounts.length);
  const accountSections = new Map<number, RangeAccountSectionState>();

  for (let i = 0; i < configuredAccounts.length; i++) {
    const acc = configuredAccounts[i];
    if (!acc) continue;
    accountSections.set(i, {
      accIndex: i,
      label: acc.label,
      username: acc.username,
      completedItems: [],
      activeLine: i < concurrency ? '🔎 Initializing session…' : '⏳ Queued…',
    });
  }

  const modeTag = configuredAccounts.length > 1
    ? (budget.mode === 'parallel' && concurrency > 1 ? ` · ⚡ Parallel (${concurrency}x)` : ' · 🐢 Sequential')
    : '';
  const title = `🎯 <b>LEETCODE QUESTION RANGE (#${range.from}–#${range.to})${modeTag}</b>`;
  const initialSubtitle = `🔎 Initializing range #${range.from}–#${range.to}…\n<i>⏳ 30s pacing between questions · /rangestatus · /cancelrange</i>`;
  const initialBlocks = configuredAccounts.length > 0
    ? renderRangeProgressSections(accountSections, initialTotalAccounts).join('\n\n')
    : initialSubtitle;

  let statusMessageId: number | null = null;
  if (triggerDeps.send) {
    statusMessageId = 1;
    await triggerDeps.send(`${title}\n<code>━━━━━━━━━━━━━━━━━━━━</code>\n${initialBlocks}`);
  } else {
    const statusMsg = await tgApi<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text: `${title}\n<code>━━━━━━━━━━━━━━━━━━━━</code>\n${initialBlocks}`,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }).catch((err) => {
      logger.warn({ err: errText(err) }, 'failed to send initial LeetCode range progress message');
      return null;
    });
    if (statusMsg) statusMessageId = statusMsg.message_id;
  }

  let totalAccounts = initialTotalAccounts;
  let lastEditTime = 0;
  let pendingEditTimer: NodeJS.Timeout | null = null;
  let pendingFooter: string | undefined = undefined;
  const EDIT_THROTTLE_MS = 1000;

  const performEdit = async (footer?: string): Promise<boolean> => {
    lastEditTime = Date.now();
    const blocks = renderRangeProgressSections(accountSections, totalAccounts);
    let body = blocks.join('\n\n');
    if (footer) body += footer;
    const fullText = `${title}\n<code>━━━━━━━━━━━━━━━━━━━━</code>\n${body}`;

    if (triggerDeps.edit && statusMessageId) {
      await triggerDeps.edit(chatId, statusMessageId, fullText).catch(() => undefined);
      return true;
    }

    if (!statusMessageId) return false;
    const updated = await tgApi('editMessageText', {
      chat_id: chatId,
      message_id: statusMessageId,
      text: fullText,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }).then(() => true).catch((err) => {
      if (/message is not modified/i.test(errText(err))) return true;
      logger.warn({ err: errText(err) }, 'could not update LeetCode range progress message');
      return false;
    });
    return updated;
  };

  const editProgress = async (extraFooter?: string): Promise<boolean> => {
    if (extraFooter) pendingFooter = extraFooter;
    if (triggerDeps.edit || extraFooter) {
      if (pendingEditTimer) {
        clearTimeout(pendingEditTimer);
        pendingEditTimer = null;
      }
      return performEdit(pendingFooter);
    }

    const elapsed = Date.now() - lastEditTime;
    if (elapsed >= EDIT_THROTTLE_MS) {
      if (pendingEditTimer) {
        clearTimeout(pendingEditTimer);
        pendingEditTimer = null;
      }
      return performEdit(pendingFooter);
    }

    if (!pendingEditTimer) {
      pendingEditTimer = setTimeout(() => {
        pendingEditTimer = null;
        void performEdit(pendingFooter);
      }, EDIT_THROTTLE_MS - elapsed);
    }
    return true;
  };

  const onProgress = async (event: RangeProgressEvent) => {
    if (event.accTotal && event.accTotal > totalAccounts) {
      totalAccounts = event.accTotal;
    }
    const accIdx = event.accIndex;
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

    const stepPrefix = event.stepTotal && event.stepTotal > 1 ? `[${event.stepIndex}/${event.stepTotal}] ` : '';
    const qName = event.questionTitle ? ` ${event.questionTitle}` : '';
    const qTag = `<code>#${event.questionNumber}${escapeHtml(qName)}</code>`;

    switch (event.phase) {
      case 'checking':
        sec.activeLine = `🔎 Checking session…`;
        break;
      case 'processing':
        sec.activeLine = `⏳ ${stepPrefix}${qTag} — Processing…`;
        break;
      case 'submitting':
        sec.activeLine = `🚀 ${stepPrefix}${qTag} — Submitting…`;
        break;
      case 'verdict':
        sec.activeLine = `⏳ ${stepPrefix}${qTag} — Waiting for verdict…`;
        break;
      case 'accepted': {
        const sub = event.submissionId ? ` · #${escapeHtml(event.submissionId)}` : '';
        sec.completedItems.push(`✅ ${stepPrefix}${qTag} — <b>Accepted</b>${sub}`);
        sec.activeLine = undefined;
        break;
      }
      case 'failed': {
        const verdict = escapeHtml(event.verdict ?? event.detail ?? 'Wrong Answer');
        const sub = event.submissionId ? ` · #${escapeHtml(event.submissionId)}` : '';
        sec.completedItems.push(`❌ ${stepPrefix}${qTag} — <b>${verdict}</b>${sub}`);
        sec.activeLine = undefined;
        break;
      }
      case 'premium': {
        sec.completedItems.push(`🔒 ${stepPrefix}${qTag} — <b>Premium Locked</b>`);
        sec.activeLine = undefined;
        break;
      }
      case 'error': {
        const fullDetail = event.detail ?? 'Error';
        const sub = event.submissionId ? ` · #${escapeHtml(event.submissionId)}` : '';
        if (sec.completedItems.length === 0 && (fullDetail.toLowerCase().includes('session') || fullDetail.toLowerCase().includes('cookie') || fullDetail.toLowerCase().includes('could not open'))) {
          sec.accountStatus = `⚠️ <b>${escapeHtml(fullDetail.slice(0, 100))}</b>`;
          sec.activeLine = undefined;
        } else {
          sec.completedItems.push(`⚠️ ${stepPrefix}${qTag} — <i>${escapeHtml(fullDetail.slice(0, 100))}</i>${sub}`);
          sec.activeLine = undefined;
        }
        break;
      }
      case 'waiting': {
        const nextStep = event.stepIndex + 1;
        const nextStepStr = event.stepTotal > 1 ? ` before question [${nextStep}/${event.stepTotal}]` : '';
        sec.activeLine = `⏳ Waiting ${event.waitSeconds ?? 30}s${nextStepStr} (human pacing)…`;
        break;
      }
      case 'blocked': {
        sec.activeLine = '🧱 LeetCode rate-limit / challenge blocked';
        sec.accountStatus = '🧱 Blocked by LeetCode';
        break;
      }
      case 'cancelled': {
        sec.activeLine = '🛑 Range cancelled by user';
        sec.accountStatus = '🛑 Cancelled';
        break;
      }
      case 'completed': {
        sec.activeLine = undefined;
        break;
      }
    }

    await editProgress();
  };

  const deps: RangeDeps = defaultRangeDeps(async () => undefined, onProgress);

  const res = await triggerDeps.startJob(range, target, deps, options ?? { mode });
  if (!res.started) {
    if ('queued' in res) {
      const sec = accountSections.get(0);
      if (sec) sec.activeLine = `🗂️ Waiting in queue (position ${res.position})…`;
      await editProgress();
      const wrappedDone = (async () => {
        try {
          const results = await res.done;
          for (const s of accountSections.values()) {
            s.activeLine = undefined;
          }
          const sum = { accepted: 0, failed: 0, error: 0, premium: 0 };
          for (const r of results) {
            const c = countResults(r.results);
            sum.accepted += c.accepted;
            sum.failed += c.failed;
            sum.error += c.error + (r.fatal ? 1 : 0);
            sum.premium += c.premium;
          }
          const summaryText = `\n\n🎯 <b>Finished:</b> ${sum.accepted} accepted · ${sum.failed} failed · ${sum.error} errors${sum.premium ? ` · 🔒 ${sum.premium} premium` : ''}`;
          await editProgress(summaryText);
          return results;
        } catch (err) {
          logger.warn({ err: errText(err) }, 'LeetCode range execution error');
          if (statusMessageId) {
            await tgApi('editMessageText', {
              chat_id: chatId,
              message_id: statusMessageId,
              text: `${title}\n<code>━━━━━━━━━━━━━━━━━━━━</code>\n⚠️ Error: ${escapeHtml(errText(err))}`,
              parse_mode: 'HTML',
              disable_web_page_preview: true,
            }).catch(() => undefined);
          }
          throw err;
        }
      })();
      return {
        ...res,
        done: wrappedDone,
      };
    }
    return res;
  }

  const wrappedDone = (async () => {
    try {
      const results = await res.done;
      for (const sec of accountSections.values()) {
        sec.activeLine = undefined;
      }
      const sum = { accepted: 0, failed: 0, error: 0, premium: 0 };
      for (const r of results) {
        const c = countResults(r.results);
        sum.accepted += c.accepted;
        sum.failed += c.failed;
        sum.error += c.error + (r.fatal ? 1 : 0);
        sum.premium += c.premium;
      }
      const summaryText = `\n\n🎯 <b>Finished:</b> ${sum.accepted} accepted · ${sum.failed} failed · ${sum.error} errors${sum.premium ? ` · 🔒 ${sum.premium} premium` : ''}`;
      await editProgress(summaryText);
      return results;
    } catch (err) {
      logger.warn({ err: errText(err) }, 'LeetCode range execution error');
      if (statusMessageId) {
        await tgApi('editMessageText', {
          chat_id: chatId,
          message_id: statusMessageId,
          text: `${title}\n<code>━━━━━━━━━━━━━━━━━━━━</code>\n⚠️ Error: ${escapeHtml(errText(err))}`,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }).catch(() => undefined);
      }
      throw err;
    }
  })();

  return {
    ...res,
    done: wrappedDone,
  };
}

const defaultRangeUiDeps: RangeUiDeps = {
  start: (range, target, options) => handleQuestionRangeTrigger(range, target, defaultRangeTriggerDeps, config.telegram.chatId, options),
  current: currentRangeJob,
  cancel: cancelRangeJob,
  now: () => Date.now(),
  queueLength: rangeQueueLength,
};

/** Account picker: one button per account, then "All accounts" (Parallel / Sequential) and Cancel. */
export function buildRangePicker(
  range: QuestionRange,
  accounts: AccountRecord[],
): { text: string; buttons: InlineButton[][] } {
  const size = rangeSize(range);
  const tag = `${range.from}-${range.to}`;
  
  const shouldQueue = isAnyWorkerBusy() || pendingQueuePrompt;
  const actionPrefix = shouldQueue ? 'qr:q:' : 'qr:';
  
  const text = [
    shouldQueue ? `📥 <b>Queue Question Range #${range.from}–#${range.to}</b> (${size} question${size === 1 ? '' : 's'})` : `🎯 Question range #${range.from}–#${range.to} (${size} question${size === 1 ? '' : 's'})`,
    '',
    '👇 Pick the account to run it on:',
    `⏳ Estimated ~${formatDuration(estimateAccountMs(range, RANGE_GAP_MS))} per account (30 s break between questions)`,
  ].join('\n');
  const buttons: InlineButton[][] = accounts.map((a) => [
    { text: `👤 ${accountName(a)}`.slice(0, 60), callback_data: `${actionPrefix}${tag}:${a.id}` },
  ]);
  if (accounts.length > 1) {
    buttons.push([
      { text: `⚡ All accounts (${accounts.length}, Parallel - Fast)`, callback_data: `${actionPrefix}${tag}:all:parallel` },
    ]);
  }
  buttons.push([{ text: `👥 All accounts (${accounts.length}, one by one)`, callback_data: `${actionPrefix}${tag}:all` }]);
  buttons.push([{ text: '✖️ Cancel', callback_data: 'qr:x' }]);
  return { text, buttons };
}

export function buildQuickRangeButtons(): InlineButton[][] {
  return [
    [
      { text: '1–25', callback_data: 'qr:r:1-25' },
      { text: '26–50', callback_data: 'qr:r:26-50' },
      { text: '51–100', callback_data: 'qr:r:51-100' },
    ],
    [
      { text: '101–200', callback_data: 'qr:r:101-200' },
      { text: '201–300', callback_data: 'qr:r:201-300' },
      { text: '301–400', callback_data: 'qr:r:301-400' },
    ],
    [
      { text: '✖️ Cancel', callback_data: 'qr:x' },
    ],
  ];
}

export async function handleQuestionRangeCommand(
  arg: string,
  deps: RemovalDeps = defaultRemovalDeps,
  ui: RangeUiDeps = defaultRangeUiDeps,
): Promise<void> {
  if (!arg.trim()) {
    const accounts = await deps.listAccounts();
    if (accounts.length === 0) {
      pendingRangePrompt = false;
      pendingPromptType = null;
      await deps.send('📭 No accounts configured — send cookie .json files first (/renew).');
      return;
    }
    pendingRangePrompt = true;
    pendingPromptType = 'leetcode';
    const buttons = buildQuickRangeButtons();
    const promptText = [
      '🎯 Which questions? Send the range, e.g. 200-400',
      'How many questions do you want to submit? Which range do you want to solve?',
      'Pick a quick range below to solve:',
      '(or in one go: /questionrangesubmission 200-400)',
    ].join('\n');
    await deps.send(promptText, buttons);
    return;
  }
  pendingRangePrompt = false;
  pendingPromptType = null;
  const tokens = arg.trim().split(/\s+/);
  const parsed = parseQuestionRange(tokens[0] || '');
  if (!parsed.ok) {
    await deps.send(`⚠️ ${parsed.error}\nExample: /questionrangesubmission 200-400`);
    return;
  }
  const accounts = await deps.listAccounts();
  if (accounts.length === 0) {
    await deps.send('📭 No accounts configured — send cookie .json files first (/renew).');
    return;
  }
  if (tokens.length >= 2 && tokens[1]) {
    let target = tokens[1];
    let mode: 'parallel' | 'sequential' = 'parallel';
    if (tokens.length >= 3 && tokens[2]) {
      const mStr = tokens[2].toLowerCase();
      if (mStr.startsWith('seq') || mStr === '1by1' || mStr === 'single') {
        mode = 'sequential';
      } else if (mStr.startsWith('par') || mStr === 'fast') {
        mode = 'parallel';
      }
    } else if (target === 'all:seq') {
      target = 'all';
      mode = 'sequential';
    } else if (target === 'all:parallel') {
      target = 'all';
      mode = 'parallel';
    } else if (target === 'all') {
      mode = 'parallel';
    } else {
      mode = 'sequential';
    }
    const result = await ui.start(parsed.range, target, { mode });
    if (!result.started) {
      if ('queued' in result) {
        await deps.send(`🗂️ Queued: questions #${parsed.range.from}–#${parsed.range.to} (Queue position: ${result.position})`);
      } else {
        await deps.send(
          result.reason === 'no-accounts'
            ? '📭 No accounts configured — send cookie .json files first.'
            : '🔍 That account does not exist — check /accounts.',
        );
      }
    }
    return;
  }
  const picker = buildRangePicker(parsed.range, accounts);
  if (ui.current()) {
    picker.text += '\n\n🗂️ A range process is already running. This request will be queued and started automatically after the current job completes or is cancelled.';
  }
  await deps.send(picker.text, picker.buttons);
}

export async function handleRangeButton(
  chatId: number | string,
  messageId: number,
  callbackId: string,
  data: string,
  deps: RemovalDeps,
  ui: RangeUiDeps = defaultRangeUiDeps,
): Promise<void> {
  if (data === 'qr:x') {
    pendingRangePrompt = false;
    pendingPromptType = null;
    await deps.answer(callbackId, 'Cancelled');
    await deps.edit(chatId, messageId, '✖️ Question-range submission cancelled — nothing was started.');
    return;
  }
  if (data.startsWith('qr:r:')) {
    const rangeStr = data.slice('qr:r:'.length);
    const parsedRange = parseQuestionRange(rangeStr);
    if (!parsedRange.ok) {
      await deps.answer(callbackId, 'Invalid range');
      return;
    }
    const accounts = await deps.listAccounts();
    if (accounts.length === 0) {
      pendingRangePrompt = false;
      pendingPromptType = null;
      await deps.answer(callbackId, 'No accounts configured');
      await deps.edit(chatId, messageId, '📭 No accounts configured — send cookie .json files first (/renew).');
      return;
    }
    pendingRangePrompt = false;
    pendingPromptType = null;
    const picker = buildRangePicker(parsedRange.range, accounts);
    if (ui.current()) {
      picker.text += '\n\n🗂️ A range process is already running. This request will be queued and started automatically after the current job completes or is cancelled.';
    }
    await deps.answer(callbackId, `Range #${parsedRange.range.from}–#${parsedRange.range.to}`);
    await deps.edit(chatId, messageId, picker.text, picker.buttons);
    return;
  }
  const m = /^qr:(?:q:)?(\d+)-(\d+):(.+)$/.exec(data);
  const parsed = m ? parseQuestionRange(`${m[1]}-${m[2]}`) : null;
  if (!m || !parsed || !parsed.ok) {
    await deps.answer(callbackId, 'This button is no longer valid');
    return;
  }
  
  if (data.startsWith('qr:q:')) {
    await deps.answer(callbackId, `Queuing range #${parsed.range.from}-${parsed.range.to} 📥`);
    await deps.edit(chatId, messageId, `📥 <b>Queued LeetCode Range</b> #${parsed.range.from}-${parsed.range.to}...`);
    const cmdStr = `/questionrangesubmission ${parsed.range.from}-${parsed.range.to} ${m[3]}`;
    await handleQueueCommandInput(cmdStr, { notify: async (text, html) => { if (html) await replyHtml(text); else await reply(text); } });
    return;
  }

  let target = m[3]!;
  let mode: 'parallel' | 'sequential' = 'parallel';
  if (target === 'all:parallel') {
    target = 'all';
    mode = 'parallel';
  } else if (target === 'all:seq') {
    target = 'all';
    mode = 'sequential';
  } else if (target === 'all') {
    mode = 'sequential';
  } else {
    mode = 'sequential';
  }

  const result = await ui.start(parsed.range, target, { mode });
  if (!result.started) {
    if ('queued' in result) {
      await deps.answer(callbackId, `Queued #${result.position} 🗂️`);
      await deps.edit(
        chatId,
        messageId,
        [
          `🗂️ Queued: questions #${parsed.range.from}–#${parsed.range.to} (${rangeSize(parsed.range)})`,
          `📍 Queue position: ${result.position}`,
          `👥 ${result.accounts.length === 1 ? `Account: ${result.accounts[0]?.label ?? 'unknown'}` : `Accounts: ${result.accounts.map((a) => a.label).join(', ')}`}`,
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
  const budget = calculateSafeRangeConcurrency(result.accounts.length, { mode });
  const isParallel = mode === 'parallel' && names.length > 1;
  const modeStr = isParallel
    ? ` · ⚡ Parallel (${budget.concurrency}x concurrent)`
    : (names.length > 1 ? ' · 🐢 Sequential (one by one)' : '');
  const estMs = isParallel && budget.concurrency > 1
    ? Math.ceil((estimateAccountMs(range, RANGE_GAP_MS) * names.length) / budget.concurrency)
    : estimateAccountMs(range, RANGE_GAP_MS) * names.length;

  await deps.answer(callbackId, 'Started 🚀');
  await deps.edit(
    chatId,
    messageId,
    [
      `🚀 Started: questions #${range.from}–#${range.to} (${rangeSize(range)})`,
      `👥 ${names.length === 1 ? `Account: ${names[0]}` : `Accounts: ${names.join(', ')}`}`,
      modeStr ? `⚙️ Mode:${modeStr}` : '',
      `⏳ ~${formatDuration(estMs)} in total — 30 s break between questions`,
      '',
      '📬 You get a summary after each account.',
      '📍 /rangestatus shows progress · 🛑 /cancelrange stops it',
    ].filter(Boolean).join('\n'),
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

// ---------------------------------------------------------------------------
// Command Queue (sequential FIFO execution)
// ---------------------------------------------------------------------------

export interface QueuedCommandItem {
  id: string;
  rawText: string;
  command: string;
  arg: string;
  queuedAt: number;
}

const commandQueue: QueuedCommandItem[] = [];
let queueWorkerActive = false;
let queueExecutionInProgress = false;

export const VALID_QUEUE_COMMANDS = new Set([
  // Codeforces
  '/cfrange', '/cf_range', '/cfbatch', '/cf_batch',
  '/submitnextsolution', '/submit_next_solution',
  '/cfmanualnext', '/cf_manual_next',
  '/nextsubcustomaccount', '/nextsubcustomaccout', '/next_sub_custom_account', '/cfsubmitcustom',
  '/cfrangestatus', '/cf_range_status', '/cfstatusrange', '/cf_status_range',
  '/cfcancelrange', '/cf_cancel_range', '/cfcancel', '/cf_cancel', '/cancelcfrange', '/cancel_cf_range',
  '/cfaccounts', '/cf_accounts',
  '/cfprogress', '/cf_progress', '/cfsetprogress', '/cf_set_progress',
  '/cfnetwork', '/cf_network', '/cftransport',
  // CodeChef
  '/ccrange', '/cc_range', '/ccbatch', '/cc_batch',
  '/ccnextsubmit', '/cc_next_submit', '/ccnext', '/cc_next', '/ccsubmit', '/cc_submit',
  '/codechef',
  '/ccrangestatus', '/cc_range_status', '/ccstatusrange', '/cc_status_range',
  '/cccancelrange', '/cc_cancel_range', '/cccancel', '/cc_cancel', '/cancelccrange', '/cancel_cc_range',
  '/ccaccounts', '/cc_accounts',
  // LeetCode
  '/questionrangesubmission', '/question_range_submission', '/rangesubmission',
  '/triggersubmission', '/trigger_submission',
  '/claimcoins', '/claim_coins', '/claimoffer', '/claimreward',
  '/rangestatus', '/range_status',
  '/cancelrange', '/cancel_range', '/stoprange',
  '/accounts',
  // Proxies
  '/useproxy', '/selectproxy', '/cfuseproxy', '/cfselectproxy', '/chooseproxy',
  '/testproxy', '/testproxies', '/cfproxy', '/cfproxies', '/proxytest', '/proxystatus',
  '/setproxies', '/setproxy', '/addproxies', '/addproxy', '/cfaddproxy', '/cfsetproxies',
  '/removeproxy', '/cfremoveproxy', '/rmproxy',
  '/restoreproxies', '/resetproxies', '/restoreproxy',
  '/syncproxies', '/syncproxy', '/cfsyncproxies',
  // System / Session
  '/status',
  '/removesession', '/remove_session',
  '/removeallsessions', '/remove_all_sessions', '/removeallsession',
  '/cf_clear_cookies', '/cfclearcookies',
  '/renew',
]);

export function getCommandQueue(): QueuedCommandItem[] {
  return [...commandQueue];
}

export function clearCommandQueue(): number {
  const count = commandQueue.length;
  commandQueue.length = 0;
  return count;
}

export function enqueueCommand(rawText: string): { position: number; item: QueuedCommandItem } {
  const { command, arg } = extractTelegramCommand(rawText);
  const item: QueuedCommandItem = {
    id: randomUUID(),
    rawText,
    command,
    arg,
    queuedAt: Date.now(),
  };
  commandQueue.push(item);
  return { position: commandQueue.length, item };
}

export function isAnyWorkerBusy(): boolean {
  return (
    isCodeforcesRunInProgress() ||
    isCodeChefRunInProgress() ||
    isRunInProgress() ||
    Boolean(currentRangeJob()) ||
    coinClaimInProgress
  );
}

export function describeActiveWorker(): string | null {
  if (isCodeforcesRunInProgress()) return '🏆 Codeforces batch/submission';
  if (isCodeChefRunInProgress()) return '👨‍🍳 CodeChef batch/submission';
  if (isRunInProgress()) return '⚡ LeetCode daily submission';
  if (currentRangeJob()) return '🎯 LeetCode question-range submission';
  if (coinClaimInProgress) return '🪙 LeetCode reward claim';
  return null;
}

export function isQueueTaskRunning(): boolean {
  return queueExecutionInProgress;
}

export function isQueueWorkerActive(): boolean {
  return queueWorkerActive;
}

export function resetQueueForTest(): void {
  commandQueue.length = 0;
  pendingQueuePrompt = false;
  queueWorkerActive = false;
  queueExecutionInProgress = false;
}

export function validateQueueCommand(input: string): { valid: boolean; normalized: string; error?: string } {
  let trimmed = input.trim();
  if (!trimmed) return { valid: false, normalized: '', error: 'Command cannot be empty' };

  if (trimmed.startsWith('/')) {
    trimmed = trimmed.replace(/^(\/[a-zA-Z0-9_]+)@[a-zA-Z0-9_]+/, '$1');
  } else {
    const firstWord = trimmed.split(/\s+/)[0]!.toLowerCase();
    if (VALID_QUEUE_COMMANDS.has(`/${firstWord}`)) {
      trimmed = `/${trimmed}`;
    }
  }

  const { command: cmd } = extractTelegramCommand(trimmed);
  if (!cmd) {
    return { valid: false, normalized: trimmed, error: 'Commands must start with /' };
  }

  const metaCommands = new Set([
    '/startqueue', '/start_queue', '/queuestart', '/queue_start',
    '/queue', '/queuestatus', '/queue_status', '/showqueue', '/show_queue', '/queuelist', '/queue_list',
    '/clearqueue', '/clear_queue', '/cancelqueue', '/cancel_queue',
    '/cancel', '/help', '/start',
  ]);
  if (metaCommands.has(cmd)) {
    return { valid: false, normalized: trimmed, error: 'Queue management commands cannot be queued' };
  }

  if (VALID_QUEUE_COMMANDS.has(cmd)) {
    return { valid: true, normalized: trimmed };
  }

  return { valid: false, normalized: trimmed, error: `Unknown command: ${cmd}` };
}

export function formatQueuePromptMessage(): string {
  return [
    '📥 <b>Command Queue</b>',
    '<code>━━━━━━━━━━━━━━━━━━━━</code>',
    'Please enter or tap the command you want to queue:',
    '',
    '<b>Common Examples:</b>',
    '• /cfrange 5 — Codeforces batch submit',
    '• /ccrange 5 — CodeChef batch submit',
    '• /questionrangesubmission 200-400 — LeetCode range submit',
    '• /submitnextsolution — Codeforces submit next',
    '• /codechef — CodeChef daily submit',
    '• /triggersubmission — LeetCode daily submit',
    '',
    '<i>Reply with any valid command, or send /cancel to abort.</i>',
  ].join('\n');
}

export function formatQueueStatusText(): string {
  const active = describeActiveWorker();
  const queue = getCommandQueue();
  const lines: string[] = [
    '📋 <b>COMMAND QUEUE STATUS</b>',
    '<code>━━━━━━━━━━━━━━━━━━━━</code>',
  ];
  if (active) {
    lines.push(`🔄 <b>Active Process:</b> ${active} in progress`);
  } else {
    lines.push('💤 <b>Active Process:</b> None (idle)');
  }
  lines.push('');
  if (queue.length === 0) {
    lines.push('📭 <b>Queue:</b> Empty');
    lines.push('');
    lines.push('💡 <i>Use /startqueue to queue a command to run after the active process.</i>');
  } else {
    lines.push(`📥 <b>Queued Commands (${queue.length}):</b>`);
    queue.forEach((item, idx) => {
      lines.push(`  ${idx + 1}. <code>${escapeHtml(item.rawText)}</code>`);
    });
    lines.push('');
    lines.push('💡 <i>Commands run sequentially in FIFO order. Use /clearqueue to cancel pending items.</i>');
  }
  return lines.join('\n');
}

export function handleClearQueue(): string {
  const count = clearCommandQueue();
  if (count === 0) {
    return '📭 Command queue was already empty.';
  }
  return `🗑️ Command queue cleared. Removed ${count} pending command${count === 1 ? '' : 's'}.`;
}

export async function handleQueueCommandInput(
  input: string,
  deps?: {
    notify?: (text: string, html?: boolean) => Promise<void>;
    startWorker?: () => void;
  },
): Promise<boolean> {
  const trimmed = input.trim();
  if (!trimmed) return false;

  const validation = validateQueueCommand(trimmed);
  const notifyFn = deps?.notify ?? ((text, html) => html ? replyHtml(text) : reply(text));

  if (!validation.valid) {
    await notifyFn(
      `⚠️ <b>Invalid Command:</b> <code>${escapeHtml(trimmed)}</code>\n` +
      `Please provide a valid bot command to queue.\n\n` +
      `<b>Examples:</b>\n` +
      `• <code>/cfrange 5</code>\n` +
      `• <code>/ccrange 5</code>\n` +
      `• <code>/questionrangesubmission 200-400</code>\n` +
      `• <code>/submitnextsolution</code>\n` +
      `• <code>/codechef</code>\n` +
      `• <code>/triggersubmission</code>\n\n` +
      `<i>Send /cancel to abort.</i>`,
      true,
    );
    return false;
  }

  const { position, item } = enqueueCommand(validation.normalized);
  const activeDesc = describeActiveWorker();

  let statusNote = '';
  if (activeDesc) {
    statusNote = `⏳ <b>${activeDesc}</b> is currently active.\nThis command will start automatically once ongoing tasks finish.`;
  } else if (position > 1) {
    statusNote = `⏳ Will execute sequentially after previous queued commands (#1..#${position - 1}) complete.`;
  } else {
    statusNote = `▶️ No process is currently running — starting execution now!`;
  }

  await notifyFn(
    `📥 <b>Command Queued (#${position} in queue)</b>\n` +
    `<code>━━━━━━━━━━━━━━━━━━━━</code>\n` +
    `<b>Command:</b> <code>${escapeHtml(item.rawText)}</code>\n\n` +
    `${statusNote}\n\n` +
    `💡 <i>To queue another command, send /startqueue again. Use /queuestatus to view queue.</i>`,
    true,
  );

  if (deps?.startWorker) {
    deps.startWorker();
  } else {
    ensureQueueWorkerRunning();
  }
  return true;
}

export function ensureQueueWorkerRunning(deps?: {
  isBusy?: () => boolean;
  execute?: (item: QueuedCommandItem) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  notify?: (text: string, html?: boolean) => Promise<void>;
}): void {
  if (queueWorkerActive) return;
  void runQueueWorker(deps).catch((err) => {
    logger.error({ err: errText(err) }, 'Fatal queue worker error');
    queueWorkerActive = false;
    queueExecutionInProgress = false;
  });
}

export async function runQueueWorker(deps?: {
  isBusy?: () => boolean;
  execute?: (item: QueuedCommandItem) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  notify?: (text: string, html?: boolean) => Promise<void>;
}): Promise<void> {
  if (queueWorkerActive) return;
  queueWorkerActive = true;
  const isBusyFn = deps?.isBusy ?? isAnyWorkerBusy;
  const executeFn = deps?.execute ?? ((item) => executeQueuedCommand(item));
  const sleepFn = deps?.sleep ?? sleep;
  const notifyFn = deps?.notify ?? ((text, html) => html ? replyHtml(text) : reply(text));

  let processedCount = 0;
  try {
    while (commandQueue.length > 0) {
      // 1. Wait until no background worker is busy
      while (isBusyFn()) {
        await sleepFn(2000);
      }

      // Check if queue was cleared while waiting
      if (commandQueue.length === 0) break;

      // Small delay between tasks
      await sleepFn(2000);
      if (isBusyFn()) continue;

      const nextItem = commandQueue.shift()!;
      queueExecutionInProgress = true;
      processedCount++;
      try {
        await notifyFn(
          `🚀 <b>Dispatching Queued Command:</b> <code>${escapeHtml(nextItem.rawText)}</code>\n` +
          `<i>(${commandQueue.length} item${commandQueue.length === 1 ? '' : 's'} remaining in queue)</i>`,
          true,
        );

        await executeFn(nextItem);

        // Give the triggered task a moment to register its busy state or complete
        await sleepFn(3000);

        // Wait while this task completes
        while (isBusyFn()) {
          await sleepFn(2000);
        }
      } catch (err) {
        logger.error({ err: errText(err), command: nextItem.rawText }, 'Error executing queued command');
        await notifyFn(
          `⚠️ Error executing queued command <code>${escapeHtml(nextItem.rawText)}</code>: ${escapeHtml(errText(err))}`,
          true,
        );
      } finally {
        queueExecutionInProgress = false;
      }
    }

    if (processedCount > 0) {
      await notifyFn('🏁 <b>Command Queue Completed!</b>\nAll queued tasks have finished.', true);
    }
  } finally {
    queueWorkerActive = false;
    queueExecutionInProgress = false;
  }
}

export async function executeQueuedCommand(item: QueuedCommandItem): Promise<void> {
  const { command: cmd, arg: commandArg } = extractTelegramCommand(item.rawText);

  switch (cmd) {
    case '/cfrange':
    case '/cf_range':
    case '/cfbatch':
    case '/cf_batch': {
      const tokens = commandArg.split(/\s+/).filter(Boolean);
      const parsedCount = parseInt(tokens[0] ?? '', 10);
      const count = !isNaN(parsedCount) && parsedCount > 0 ? Math.min(50, parsedCount) : 5;
      const accountIds = tokens[1] ? tokens[1].split(',') : undefined;
      const res = await handleCodeforcesTrigger({ forceNext: true, count, accountIds });
      if (res?.done) await res.done;
      return;
    }
    case '/ccrange':
    case '/cc_range':
    case '/ccbatch':
    case '/cc_batch': {
      const tokens = commandArg.split(/\s+/).filter(Boolean);
      const parsedCount = parseInt(tokens[0] ?? '', 10);
      const count = !isNaN(parsedCount) && parsedCount > 0 ? Math.min(50, parsedCount) : 5;
      const accountIds = tokens[1] ? tokens[1].split(',') : undefined;
      const res = await handleCodeChefTrigger({ forceNext: true, count, accountIds });
      if (res?.done) await res.done;
      return;
    }
    case '/questionrangesubmission':
    case '/question_range_submission':
    case '/rangesubmission': {
      const parts = commandArg.trim().split(/\s+/);
      const parsed = parseQuestionRange(parts[0] || '');
      const rawTarget = parts[1] || 'all';
      let accountId = rawTarget;
      let mode: 'parallel' | 'sequential' = 'parallel';
      if (parts[2]) {
        const mStr = parts[2].toLowerCase();
        if (mStr.startsWith('seq') || mStr === '1by1' || mStr === 'single') mode = 'sequential';
        else if (mStr.startsWith('par') || mStr === 'fast') mode = 'parallel';
      } else if (rawTarget === 'all:seq') {
        accountId = 'all';
        mode = 'sequential';
      } else if (rawTarget === 'all:parallel') {
        accountId = 'all';
        mode = 'parallel';
      }
      if (parsed.ok) {
        const res = await handleQuestionRangeTrigger(parsed.range, accountId, defaultRangeTriggerDeps, config.telegram.chatId, { mode });
        if (res.started || 'queued' in res) {
          await res.done;
        } else if (!res.started && 'reason' in res) {
          await reply(`⚠️ Could not start question range: ${res.reason}`);
        }
      } else {
        await replyHtml(`⚠️ Could not parse question range for queued command: ${escapeHtml(parsed.error)}`);
      }
      return;
    }
    case '/submitnextsolution':
    case '/submit_next_solution': {
      const res = await handleCodeforcesSubmitNext();
      if (res?.done) await res.done;
      return;
    }
    case '/ccnextsubmit':
    case '/cc_next_submit':
    case '/ccnext':
    case '/cc_next':
    case '/ccsubmit':
    case '/cc_submit': {
      const res = await handleCodeChefTrigger({ forceNext: true, count: 1 });
      if (res?.done) await res.done;
      return;
    }
    case '/codechef': {
      const res = await handleCodeChefTrigger({ forceNext: false });
      if (res?.done) await res.done;
      return;
    }
    case '/triggersubmission':
    case '/trigger_submission': {
      const res = await handleTriggerSubmission();
      if (res?.done) await res.done;
      return;
    }
    case '/claimcoins':
    case '/claim_coins':
    case '/claimoffer':
    case '/claimreward': {
      await handleCoinClaimCommand();
      return;
    }
    default: {
      await handleMessage({
        message_id: 0,
        chat: { id: config.telegram.chatId },
        text: item.rawText,
      });
      return;
    }
  }
}

/** Pending /renew <label> target — consumed by the next cookie payload. */
let pendingRenewalLabel: string | undefined;

export interface PendingLoginState {
  site: 'leetcode' | 'codeforces';
  step: 'awaiting_identifier' | 'awaiting_password';
  label?: string;
  identifier?: string;
}

let activeLoginPrompt: PendingLoginState | null = null;

export function getActiveLoginPrompt(): PendingLoginState | null {
  return activeLoginPrompt;
}

export function setActiveLoginPrompt(state: PendingLoginState | null): void {
  activeLoginPrompt = state;
}

async function handleExecuteLogin(
  site: 'leetcode' | 'codeforces',
  label: string,
  identifier: string,
  password: string,
  replyFunc: (text: string) => Promise<void> = replyHtml,
): Promise<void> {
  const siteName = site === 'leetcode' ? 'LeetCode' : 'Codeforces';
  await replyFunc(
    `🔄 <b>Logging in to ${siteName}...</b>\n` +
    `• Account label: <code>${escapeHtml(label)}</code>\n` +
    `• Identifier: <code>${escapeHtml(identifier)}</code>\n\n` +
    `<i>Solving Turnstile verification challenge with local CPSolver (with Capzy/CapSolver fallback)...</i>`,
  );

  try {
    if (site === 'leetcode') {
      const res = await loginToLeetCode(identifier, password, {
        onProgress: async (msg) => {
          await sendTelegramMessage(msg).catch(() => undefined);
        },
      });

      if (!res.ok || !res.storageState) {
        await replyFunc(
          `❌ <b>LeetCode Login Failed:</b>\n` +
          `<i>${escapeHtml(res.error || 'Authentication timed out or failed.')}</i>\n\n` +
          `Please check your username/password and try again with <code>/lclogin</code>.`,
        );
        return;
      }

      const username = res.username || identifier;
      await saveEncryptedCredentials('leetcode', label, {
        username,
        password,
        label,
      });

      await saveAccount(label, JSON.stringify(res.storageState), {
        username,
        status: AccountStatus.ACTIVE,
      });

      await replyFunc(
        `✅ <b>LeetCode Login Successful!</b>\n` +
        `• Authenticated as: <code>${escapeHtml(username)}</code>\n` +
        `• Account label: <code>${escapeHtml(label)}</code>\n` +
        `• Active session cookies saved to database.\n` +
        `• Credentials encrypted with AES-256-GCM and stored for automated daily re-login.`,
      );
    } else {
      const res = await loginToCodeforces(identifier, password, {
        onProgress: async (msg) => {
          await sendTelegramMessage(msg).catch(() => undefined);
        },
      });

      if (!res.ok || !res.storageState) {
        await replyFunc(
          `❌ <b>Codeforces Login Failed:</b>\n` +
          `<i>${escapeHtml(res.error || 'Authentication timed out or failed.')}</i>\n\n` +
          `Please check your handle/password and try again with <code>/cflogin</code>.`,
        );
        return;
      }

      const handle = res.handle || identifier;
      await saveEncryptedCredentials('codeforces', label, {
        username: handle,
        password,
        label,
      });

      await saveCodeforcesAccount(label, JSON.stringify(res.storageState), {
        username: handle,
        status: CodeforcesAccountStatus.ACTIVE,
      });

      await replyFunc(
        `✅ <b>Codeforces Login Successful!</b>\n` +
        `• Authenticated handle: <code>${escapeHtml(handle)}</code>\n` +
        `• Account label: <code>${escapeHtml(label)}</code>\n` +
        `• Active session cookies saved to database.\n` +
        `• Credentials encrypted with AES-256-GCM and stored for automated daily re-login.`,
      );
    }
  } catch (err) {
    logger.error({ site, label, err: errText(err) }, 'Error during interactive login execution');
    await replyFunc(`❌ <b>Login Error:</b> ${escapeHtml(errText(err))}`);
  }
}

async function handleCheckSessionsCommand(): Promise<void> {
  await replyHtml(
    '🔍 <b>Verifying Account Sessions...</b>\n' +
    'Checking all LeetCode & Codeforces accounts. If any session has expired and stored credentials exist, automatic re-login will run.',
  );
  try {
    const summary = await verifyAndRefreshAllSessions({ notifyTelegram: false });
    const lines: string[] = [
      '<b>📋 Session Verification Summary</b>',
      '<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>',
      `• Total LeetCode accounts: <b>${summary.totalLeetCode}</b>`,
      `• Total Codeforces accounts: <b>${summary.totalCodeforces}</b>`,
      `• ✅ Active & valid: <b>${summary.valid}</b>`,
      `• 🔄 Auto-refreshed: <b>${summary.refreshed}</b>`,
      `• ⚠️ Expired (no credentials): <b>${summary.expiredWithoutCreds}</b>`,
      `• ❌ Failed: <b>${summary.failed}</b>`,
      '',
    ];

    if (summary.outcomes.length > 0) {
      lines.push('<b>Account Status:</b>');
      for (const o of summary.outcomes) {
        const icon =
          o.status === 'valid'
            ? '✅'
            : o.status === 'refreshed'
            ? '🔄'
            : o.status === 'missing-credentials'
            ? '⚠️'
            : '❌';
        const siteTag = o.site === 'leetcode' ? 'LeetCode' : 'Codeforces';
        const userStr = o.username ? ` (${escapeHtml(o.username)})` : '';
        const statusNote =
          o.status === 'valid'
            ? 'Active'
            : o.status === 'refreshed'
            ? 'Auto-refreshed via credentials'
            : o.status === 'missing-credentials'
            ? 'Expired — no creds stored'
            : `Failed: ${escapeHtml((o.error || '').slice(0, 50))}`;
        lines.push(`${icon} [${siteTag}] <code>${escapeHtml(o.label)}</code>${userStr} — <i>${statusNote}</i>`);
      }
    }

    await replyHtml(lines.join('\n'));
  } catch (err) {
    await replyHtml(`❌ Session verification error: ${escapeHtml(errText(err))}`);
  }
}

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

async function codeforcesUserProgressText(): Promise<string> {
  const list = await listAllUsernameProgress();
  if (list.length === 0) {
    return '<b>🏆 CODEFORCES USER PROGRESS</b>\n<code>━━━━━━━━━━━━━━━━━━━━</code>\n<i>No username progress saved yet. Progress is saved automatically on each submission.</i>';
  }
  const lines = [
    '<b>🏆 CODEFORCES USER PROGRESS (PERMANENT)</b>',
    '<code>━━━━━━━━━━━━━━━━━━━━</code>',
    '<i>Tracks the last completed and next question for each username. Progress persists permanently in DB across cookie resets.</i>\n',
  ];
  for (const item of list) {
    lines.push(`👤 <b><code>${escapeHtml(item.username)}</code></b>`);
    if (item.nextKey) lines.push(`   ├ 🎯 Next: <code>${escapeHtml(item.nextKey)}</code>`);
    if (item.lastCompletedKey) lines.push(`   ├ ✅ Last Completed: <code>${escapeHtml(item.lastCompletedKey)}</code>`);
    if (item.lastVerdict) lines.push(`   ├ ⚖️ Verdict: <i>${escapeHtml(item.lastVerdict)}</i>`);
    if (item.lastSubmissionId) lines.push(`   ├ 🆔 Submission: #<code>${escapeHtml(item.lastSubmissionId)}</code>`);
    if (item.lastCompletedAt) lines.push(`   └ 🕒 Completed: <code>${escapeHtml(item.lastCompletedAt.slice(0, 19).replace('T', ' '))}</code>`);
    else lines.push(`   └ 🕒 Updated: <code>${escapeHtml(item.updatedAt.slice(0, 19).replace('T', ' '))}</code>`);
    lines.push('');
  }
  lines.push('<i>Use <code>/cfsetprogress &lt;username&gt; &lt;problemKey&gt;</code> to adjust progress manually.</i>');
  return lines.join('\n');
}

async function handleCfSetProgress(arg?: string): Promise<void> {
  const parts = (arg ?? '').trim().split(/\s+/);
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    await replyHtml('<b>Usage:</b> <code>/cfsetprogress &lt;username&gt; &lt;nextProblemKey&gt;</code>\n<i>Example: <code>/cfsetprogress pts003 628B</code></i>');
    return;
  }
  const [username, problemKey] = parts;
  await saveUsernameProgress(username!, { nextKey: problemKey! });
  const accounts = await listCodeforcesAccounts(true);
  const matched = accounts.find((a) => (a.username ?? '').toLowerCase() === username!.toLowerCase());
  if (matched) {
    const { prisma } = await import('../database/prisma');
    await prisma.codeforcesProgress.upsert({
      where: { accountId: matched.id },
      create: { accountId: matched.id, nextKey: problemKey! },
      update: { nextKey: problemKey! },
    });
  }
  await replyHtml(`✅ Set next problem for <b><code>${escapeHtml(username!)}</code></b> to <code>${escapeHtml(problemKey!)}</code>.\n<i>Permanent progress saved in DB${matched ? ` and synced to active account <code>${escapeHtml(matched.label)}</code>` : ''}.</i>`);
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

/** Best effort only: a bot needs Telegram delete permission in groups. Never include the key in a log if this fails. */
async function deleteSensitiveTelegramMessage(msg: TgMessage): Promise<void> {
  if (!msg.message_id) return;
  try {
    await tgApi('deleteMessage', { chat_id: msg.chat.id, message_id: msg.message_id });
  } catch {
    logger.warn('telegram: could not delete an article API-key message');
  }
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
