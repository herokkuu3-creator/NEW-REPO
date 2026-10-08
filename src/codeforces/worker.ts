import cron from 'node-cron';
import { CodeforcesAccountStatus } from '@prisma/client';
import { config } from '../config';
import { logger } from '../logger';
import { getSystemState, setSystemState, SystemKeys } from '../database/models';
import { isRunInProgress as isLeetCodeBusy, todayInTimezone } from '../scheduler/dailyWorker';
import { isCodeChefRunInProgress } from '../codechef/worker';
import {
  claimDailyAttempt,
  completeCurrentProblem,
  getCodeforcesProgress,
  listCodeforcesAccounts,
  parseStoredCodeforcesState,
  patchCodeforcesAccount,
  recordAttempt,
  releaseDailyAttempt,
} from './storage';
import { loadRuntimeSourceIndex, fetchSourceCode, SourceIndexEntry } from './sourceRepo';
import { isTerminalCodeforcesVerdict, shouldReleaseDailyAttempt } from './dailyGate';
import { fetchSolvedProblemKeys } from './api';
import { firstUnsolvedIndex, HANDOFF_VERDICT } from './handoff';
import type { HttpSubmitResult } from './httpSubmit';
import { captureBefore, pollForVerdict, postSubmitForm, type BrowserPostOutcome } from './submission';
import { isRemoteSubmitterConfigured, notifyProxyInUse, submitViaRemoteSubmitter } from './remoteSubmitter';
import { shouldRetryWithOriginal, stripCppComments } from './codeSanitizer';
import { runSubmissionAttempts, readBeforeDeadline, CODEFORCES_ATTEMPT_MS } from './attempts';
import { launchFirefoxWithStorageStateObject } from '../browser/playwright';
import { logMemory, memoryReading, MemoryWatch, releaseHeap } from '../memory';
import {
  buildCodeforcesReport,
  CodeforcesAccountOutcome,
  CodeforcesRunReport,
  formatCodeforcesReport,
} from './report';
import { sendTelegramMessage } from '../notifications/telegram';

const CODEFORCES_LAST_REPORT_KEY = 'codeforcesLastReport';
let runInProgress = false;

/** Codeforces can reject a duplicate without creating a new submission ID. */
export function isAlreadySubmittedCodeError(error: string | null | undefined): boolean {
  return /exactly the same code|same code before|already submitted/i.test(error ?? '');
}

/**
 * Minimum free container memory required before Firefox may start.
 *
 * Measured here: a warm headless Firefox is ~405MB PSS on a blank page and
 * ~520MB on a Codeforces page, on top of Node's ~140MB — more than a 512MB free
 * instance holds. So this is a MINIMUM-FREE floor, not a claim that Firefox
 * fits: the memory watchdog is what actually protects the container, by closing
 * the browser before the kernel OOM-kills the service. Demanding a full 520MB
 * free made the browser path impossible by construction.
 */
const BROWSER_MIN_FREE_MB = Number(process.env.CODEFORCES_BROWSER_MIN_FREE_MB ?? 300);

/** Free container memory in MB, or null when the container does not report it. */
export function availableMemoryMb(): number | null {
  const { usedMb, limitMb } = memoryReading();
  if (usedMb === null || limitMb === null) return null;
  return Math.max(0, limitMb - usedMb);
}

export function isCodeforcesRunInProgress(): boolean {
  return runInProgress;
}

export interface CodeforcesRangeJobInfo {
  totalRequested: number;
  completed: number;
  skipped: number;
  failed: number;
  currentStep: number;
  currentAccount: string | null;
  currentProblem: string | null;
  startedAt: number;
  state: 'running' | 'waiting' | 'cancelling' | 'idle';
  waitEndsAt?: number;
}

let activeCodeforcesRangeAbortController: AbortController | null = null;
let activeCodeforcesRangeJob: CodeforcesRangeJobInfo | null = null;

export const CODEFORCES_RANGE_GAP_MS = 30000; // 30-second fallback base pacing

/**
 * Returns a randomized pacing delay (in milliseconds) with jitter to mimic human behavior
 * and break rigid automation timing signatures.
 */
export function getCodeforcesPacingDelayMs(): number {
  const baseMs = Number(process.env.CODEFORCES_PACING_BASE_MS ?? 42000);
  const jitterMs = Number(process.env.CODEFORCES_PACING_JITTER_MS ?? 24000);
  const delta = (Math.random() - 0.5) * jitterMs;
  return Math.max(25000, Math.round(baseMs + delta));
}

export function cancelCodeforcesRun(): boolean {
  if (!runInProgress) return false;
  if (activeCodeforcesRangeJob) activeCodeforcesRangeJob.state = 'cancelling';
  if (activeCodeforcesRangeAbortController) {
    activeCodeforcesRangeAbortController.abort();
    return true;
  }
  return false;
}

export function getCodeforcesRangeStatus(): CodeforcesRangeJobInfo | null {
  return activeCodeforcesRangeJob ? { ...activeCodeforcesRangeJob } : null;
}

export function formatCodeforcesRangeStatus(info: CodeforcesRangeJobInfo, now = Date.now()): string {
  const elapsedSec = Math.max(0, Math.floor((now - info.startedAt) / 1000));
  const elapsedMin = Math.floor(elapsedSec / 60);
  const elapsedRemSec = elapsedSec % 60;
  const elapsedStr = elapsedMin > 0 ? `${elapsedMin}m ${elapsedRemSec}s` : `${elapsedSec}s`;

  const doneCount = info.completed + info.skipped;
  const remaining = Math.max(0, info.totalRequested - doneCount);
  const pct = info.totalRequested > 0 ? Math.round((doneCount / info.totalRequested) * 100) : 0;

  let stateIcon = '🏃';
  let stateDesc = 'Running';
  if (info.state === 'waiting' && info.waitEndsAt) {
    const waitSec = Math.max(0, Math.ceil((info.waitEndsAt - now) / 1000));
    stateIcon = '⏳';
    stateDesc = `Pacing delay (${waitSec}s remaining before next submit)`;
  } else if (info.state === 'cancelling') {
    stateIcon = '🛑';
    stateDesc = 'Cancelling…';
  }

  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return [
    '<b>🏆 CODEFORCES RANGE STATUS</b>',
    '<code>━━━━━━━━━━━━━━━━━━━━</code>',
    `⚙️ <b>Status:</b> ${stateIcon} <i>${stateDesc}</i>`,
    `🎯 <b>Progress:</b> <b>${info.completed}</b> / ${info.totalRequested} questions (<b>${pct}%</b>)`,
    `✅ <b>Completed:</b> ${info.completed}`,
    `⏭️ <b>Skipped:</b> ${info.skipped}`,
    `❌ <b>Failed:</b> ${info.failed}`,
    `⏳ <b>Remaining:</b> ${remaining}`,
    info.currentAccount ? `👤 <b>Account:</b> <code>${escape(info.currentAccount)}</code>` : '',
    info.currentProblem ? `📝 <b>Current Problem:</b> <code>${escape(info.currentProblem)}</code>` : '',
    `⏱️ <b>Elapsed Time:</b> ${elapsedStr}`,
    '<code>━━━━━━━━━━━━━━━━━━━━</code>',
    '<i>Send /cfcancelrange to stop this batch job.</i>',
  ].filter(Boolean).join('\n');
}

export function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface CodeforcesProgressEvent {
  phase:
    | 'checking'
    | 'verified'
    | 'source'
    | 'network'
    | 'opening'
    | 'submitting'
    | 'verdict'
    | 'attempt'
    | 'retry'
    | 'queued'
    | 'running'
    | 'session-restored'
    | 'session-fresh'
    | 'verification'
    | 'verification-retry'
    | 'verification-blocked'
    | 'verification-cleared'
    | 'verification-not-required'
    | 'completed'
    | 'failed'
    | 'skipped'
    | 'waiting'
    | 'cancelled';
  label: string;
  username?: string | null;
  index: number;
  total: number;
  networkMode?: CodeforcesNetworkMode;
  attempt?: number;
  accIndex?: number;
  accTotal?: number;
  stepIndex?: number;
  stepTotal?: number;
  problem?: string | null;
  problemKey?: string | null;
  problemUrl?: string | null;
  verdict?: string | null;
  submissionId?: string | null;
  error?: string | null;
  waitSeconds?: number;
}

export interface CodeforcesRunOptions {
  onAccountOutcome?: (outcome: CodeforcesAccountOutcome, index: number, total: number) => Promise<void> | void;
  onAccountProgress?: (progress: CodeforcesProgressEvent) => Promise<void> | void;
  /** Manual triggers may reuse a day's single attempt after it failed. */
  forceDailyAttempt?: boolean;
  batchCount?: number;
  /** When present, run only these active Codeforces account IDs. */
  accountIds?: readonly string[];
  networkMode?: CodeforcesNetworkMode;
}

export type CodeforcesNetworkMode = 'proxy' | 'tailscale';

export interface CodeforcesTriggerResult {
  started: boolean;
  message: string;
}

export const CODEFORCES_MANUAL_REASON = 'codeforces-manual';

export async function triggerCodeforcesRun(reason: string): Promise<CodeforcesTriggerResult> {
  if (runInProgress) return { started: false, message: 'a Codeforces run is already in progress' };
  void executeCodeforcesRun(reason).catch((err) =>
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'unhandled Codeforces run error'),
  );
  return { started: true, message: `Codeforces run triggered (${reason})` };
}

export async function runCodeforcesNow(
  reason: string,
  options: CodeforcesRunOptions = {},
): Promise<CodeforcesRunReport | null> {
  if (runInProgress) return null;
  return executeCodeforcesRun(reason, options);
}

export async function executeCodeforcesRun(
  reason: string,
  options: CodeforcesRunOptions = {},
): Promise<CodeforcesRunReport> {
  if (runInProgress) {
    return buildCodeforcesReport({ date: todayInTimezone(), reason, startedAt: new Date().toISOString(), outcomes: [] });
  }
  runInProgress = true;
  activeCodeforcesRangeAbortController = new AbortController();
  const signal = activeCodeforcesRangeAbortController.signal;
  const startedAt = new Date().toISOString();
  const today = todayInTimezone();
  const baseForceDailyAttempt =
    options.forceDailyAttempt ?? reason === CODEFORCES_MANUAL_REASON;
  const batchCount = Math.max(1, options.batchCount ?? 1);

  try {
    const source = await loadRuntimeSourceIndex();
    const requestedAccountIds = options.accountIds ? new Set(options.accountIds) : null;
    const networkMode = options.networkMode ?? await configuredNetworkMode();
    const accounts = (await listCodeforcesAccounts(false)).filter(
      (account) => !requestedAccountIds || requestedAccountIds.has(account.id),
    );
    const outcomes: CodeforcesAccountOutcome[] = [];

    activeCodeforcesRangeJob = {
      totalRequested: accounts.length * batchCount,
      completed: 0,
      skipped: 0,
      failed: 0,
      currentStep: 0,
      currentAccount: null,
      currentProblem: null,
      startedAt: Date.now(),
      state: 'running',
    };

    if (accounts.length === 0) {
      const report = buildCodeforcesReport({ date: today, reason, startedAt, outcomes });
      await setSystemState(CODEFORCES_LAST_REPORT_KEY, JSON.stringify(report));
      return report;
    }

    if (reason === 'cron') {
      await sendTelegramMessage('🚀 <b>Starting daily submission for Codeforces…</b>', { parseMode: 'HTML' }).catch(() => undefined);
    }

    for (const [accIndex, account] of accounts.entries()) {
      if (signal.aborted) break;

      let consecutiveFailuresOnSameProblem = 0;
      let lastAttemptedProblemKey: string | null = null;
      let consecutiveCloudflareBlocks = 0;

      for (let step = 0; step < batchCount; step++) {
        if (signal.aborted) break;

        const progressIndex = accounts.length > 1 && batchCount === 1
          ? accIndex + 1
          : (accounts.length > 1 ? accIndex * batchCount + step + 1 : step + 1);
        const progressTotal = accounts.length > 1 && batchCount === 1
          ? accounts.length
          : (accounts.length > 1 ? accounts.length * batchCount : batchCount);

        if (activeCodeforcesRangeJob) {
          activeCodeforcesRangeJob.currentStep = progressIndex;
          activeCodeforcesRangeJob.currentAccount = account.label;
        }

        const stepForceAttempt = step > 0 ? true : baseForceDailyAttempt;

        await Promise.resolve(options.onAccountProgress?.({
          phase: 'checking',
          label: account.label,
          username: account.username,
          index: progressIndex,
          total: progressTotal,
          accIndex,
          accTotal: accounts.length,
          stepIndex: step + 1,
          stepTotal: batchCount,
        }));

        const outcome = await runForAccount(
          account,
          today,
          source,
          stepForceAttempt,
          networkMode,
          (phase, username, attempt) =>
            options.onAccountProgress?.({
              phase: phase as any,
              label: account.label,
              username,
              index: progressIndex,
              total: progressTotal,
              networkMode,
              attempt,
              accIndex,
              accTotal: accounts.length,
              stepIndex: step + 1,
              stepTotal: batchCount,
            }),
        );

        outcomes.push(outcome);

        if (activeCodeforcesRangeJob) {
          activeCodeforcesRangeJob.currentProblem = outcome.problem ?? null;
          if (outcome.kind === 'solved') {
            activeCodeforcesRangeJob.completed++;
          } else if (outcome.kind === 'skipped') {
            activeCodeforcesRangeJob.skipped++;
          } else {
            activeCodeforcesRangeJob.failed++;
          }
        }

        if (outcome.kind === 'solved') {
          consecutiveFailuresOnSameProblem = 0;
          consecutiveCloudflareBlocks = 0;
          lastAttemptedProblemKey = null;
        } else {
          const problemKey = outcome.problem ?? null;
          if (problemKey && problemKey === lastAttemptedProblemKey) {
            consecutiveFailuresOnSameProblem++;
          } else {
            consecutiveFailuresOnSameProblem = 1;
            lastAttemptedProblemKey = problemKey;
          }

          const isBlocked = /cloudflare|challenge|403|did not clear/i.test(outcome.error ?? '');
          if (isBlocked) {
            consecutiveCloudflareBlocks++;
            logger.warn({ account: account.label, consecutiveCloudflareBlocks }, 'Cloudflare verification challenge encountered on submit form');
            if (consecutiveCloudflareBlocks >= 3) {
              logger.error({ account: account.label }, 'Multiple consecutive Cloudflare blocks detected; stopping batch run to protect account');
              await options.onAccountProgress?.({
                phase: 'failed',
                label: account.label,
                username: account.username,
                problem: outcome.problem,
                error: 'Multiple consecutive Cloudflare blocks encountered. Paused batch to protect account trust score.',
                index: progressIndex,
                total: progressTotal,
                accIndex,
                accTotal: accounts.length,
                stepIndex: step + 1,
                stepTotal: batchCount,
              });
              break;
            }
          } else {
            consecutiveCloudflareBlocks = 0;
          }

          if (consecutiveFailuresOnSameProblem >= 2) {
            logger.warn({ account: account.label, problem: outcome.problem }, 'Problem failed twice consecutively; advancing queue to skip locked problem');
            const progress = await getCodeforcesProgress(account.id);
            const currentEntry = resolveCurrentEntry(source.queue, progress.nextKey, progress.lastCompletedKey);
            if (currentEntry) {
              const queueIndex = source.queue.findIndex((e) => e.key === currentEntry.key);
              if (queueIndex >= 0 && queueIndex + 1 < source.queue.length) {
                const nextEntry = source.queue[queueIndex + 1]!;
                await completeCurrentProblem(account.id, {
                  completedKey: currentEntry.key,
                  nextKey: nextEntry.key,
                  submissionId: null,
                  verdict: 'SKIPPED_AFTER_FAILURES',
                });
                logger.info({ skipped: currentEntry.key, next: nextEntry.key }, 'Advanced queue past failing problem');
              }
            }
            consecutiveFailuresOnSameProblem = 0;
          }
        }

        if (outcome.kind === 'solved') {
          await options.onAccountProgress?.({
            phase: 'completed',
            label: account.label,
            username: outcome.username,
            problem: outcome.problem,
            verdict: outcome.verdict ?? 'OK',
            submissionId: outcome.submissionId,
            index: progressIndex,
            total: progressTotal,
            accIndex,
            accTotal: accounts.length,
            stepIndex: step + 1,
            stepTotal: batchCount,
          });
        } else if (outcome.kind === 'skipped') {
          await options.onAccountProgress?.({
            phase: 'skipped',
            label: account.label,
            username: outcome.username,
            problem: outcome.problem,
            error: outcome.error ?? 'Skipped',
            index: progressIndex,
            total: progressTotal,
            accIndex,
            accTotal: accounts.length,
            stepIndex: step + 1,
            stepTotal: batchCount,
          });
        } else {
          await options.onAccountProgress?.({
            phase: 'failed',
            label: account.label,
            username: outcome.username,
            problem: outcome.problem,
            error: outcome.error ?? 'Failed',
            index: progressIndex,
            total: progressTotal,
            accIndex,
            accTotal: accounts.length,
            stepIndex: step + 1,
            stepTotal: batchCount,
          });
        }

        if (options.onAccountOutcome) {
          await Promise.resolve(options.onAccountOutcome(outcome, progressIndex, progressTotal)).catch((err) =>
            logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Codeforces outcome callback failed'),
          );
        }

        // If the queue was exhausted or account auth was completely invalid, break step loop for this account
        if (outcome.kind === 'skipped' && outcome.error?.includes('exhausted')) {
          break;
        }
        if (outcome.kind === 'failed' && outcome.error?.includes('storageState')) {
          break;
        }

        // Pacing delay between batch steps for this account
        if (step < batchCount - 1 && !signal.aborted) {
          const pacingGapMs = getCodeforcesPacingDelayMs();
          if (activeCodeforcesRangeJob) {
            activeCodeforcesRangeJob.state = 'waiting';
            activeCodeforcesRangeJob.waitEndsAt = Date.now() + pacingGapMs;
          }
          await options.onAccountProgress?.({
            phase: 'waiting',
            label: account.label,
            username: account.username,
            index: progressIndex,
            total: progressTotal,
            accIndex,
            accTotal: accounts.length,
            stepIndex: step + 1,
            stepTotal: batchCount,
            waitSeconds: Math.round(pacingGapMs / 1000),
          });
          await sleepWithAbort(pacingGapMs, signal);
          if (activeCodeforcesRangeJob) {
            activeCodeforcesRangeJob.state = 'running';
            activeCodeforcesRangeJob.waitEndsAt = undefined;
          }
          if (signal.aborted) {
            logger.info('Codeforces batch run aborted by user during pacing delay');
            break;
          }
        }
      }

      if (signal.aborted) {
        logger.info({ account: account.label }, 'Codeforces run aborted by user');
        await options.onAccountProgress?.({
          phase: 'cancelled',
          label: account.label,
          username: account.username,
          index: outcomes.length,
          total: accounts.length * batchCount,
          accIndex,
          accTotal: accounts.length,
        });
        break;
      }
    }

    const report = buildCodeforcesReport({ date: today, reason, startedAt, outcomes });
    await setSystemState(CODEFORCES_LAST_REPORT_KEY, JSON.stringify(report));
    if (reason === 'cron') {
      await sendTelegramMessage(formatCodeforcesReport(report)).catch(() => undefined);
    }
    logger.info({ summary: formatCodeforcesReport(report) }, 'Codeforces daily run finished');
    return report;
  } finally {
    runInProgress = false;
    activeCodeforcesRangeJob = null;
    activeCodeforcesRangeAbortController = null;
  }
}

async function runForAccount(
  account: Awaited<ReturnType<typeof listCodeforcesAccounts>>[number],
  today: string,
  source: Awaited<ReturnType<typeof loadRuntimeSourceIndex>>,
  forceDailyAttempt = false,
  networkMode: CodeforcesNetworkMode = 'proxy',
  onProgress?: (phase: 'verified' | 'source' | 'network' | 'opening' | 'submitting' | 'verdict' | 'attempt' | 'retry' | 'queued' | 'running', username: string | null, attempt?: number) => Promise<void> | void,
): Promise<CodeforcesAccountOutcome> {
  const label = account.label;
  const stored = parseStoredCodeforcesState(account.storageState);
  if (!stored.ok) {
    await patchCodeforcesAccount(account.id, { status: CodeforcesAccountStatus.UNKNOWN, lastError: stored.error, checked: true });
    return { label, username: account.username, kind: 'failed', error: stored.error };
  }

  let progress = await getCodeforcesProgress(account.id);
  const resolved = resolveCurrentEntry(source.queue, progress.nextKey, progress.lastCompletedKey);
  let current = resolved;
  let note: string | undefined;
  if (resolved && account.username) {
    const solved = await fetchSolvedProblemKeys(account.username).catch(() => null);
    if (solved) {
      const start = source.queue.indexOf(resolved);
      const index = firstUnsolvedIndex(source.queue, start, solved);
      if (index > start) {
        const passed = source.queue[index - 1]!;
        current = source.queue[index] ?? null;
        await completeCurrentProblem(account.id, {
          completedKey: passed.key,
          nextKey: current?.key ?? null,
          submissionId: null,
          verdict: 'OK',
        });
        const handedOff = progress.lastVerdict === HANDOFF_VERDICT && progress.lastAttemptKey === resolved.key;
        note = handedOff
          ? `✅ ${problemLabel(resolved)} was accepted on Codeforces — moved on`
          : `⏩ skipped ${index - start} problem(s) already solved on Codeforces`;
        progress = await getCodeforcesProgress(account.id);
      }
    }
  }
  if (!current) {
    return {
      label,
      username: account.username,
      kind: 'skipped',
      error: 'source repository queue is exhausted — no uncompleted Codeforces solution remains',
    };
  }

  const entry = current;
  const handle = account.username ?? label;
  let username = handle;
  // This is deliberately tracked separately from `performed`: an attempt
  // which reached the proxied browser may be safe to retry in principle,
  // but repeatedly reopening it every five minutes is very expensive.
  let browserAttempted = false;
  await Promise.resolve(onProgress?.('verified', username));
  try {
    const originalCode = await fetchSourceCode(entry);
    await Promise.resolve(onProgress?.('source', username));
    const strippedCode =
      entry.language === 'cpp' ? stripCppComments(originalCode) : originalCode;
    const useCommentStrippedFirst =
      entry.language === 'cpp' &&
      strippedCode.trim().length > 0 &&
      strippedCode !== originalCode;

    const retryToday = shouldReleaseDailyAttempt({
      manual: forceDailyAttempt,
      lastAttemptDate: progress.lastAttemptDate ?? null,
      lastVerdict: progress.lastVerdict ?? null,
      today,
    });
    if (retryToday) await releaseDailyAttempt(account.id, today);
    const claimed = await claimDailyAttempt(account.id, today, entry.key);
    if (!claimed) {
      const latest = await getCodeforcesProgress(account.id);
      return {
        label,
        username: handle,
        kind: 'skipped',
        problem: problemLabel(entry),
        problemUrl: entry.problemUrl ?? null,
        verdict: latest.lastVerdict,
        submissionId: latest.lastSubmissionId,
        note,
        error: `already solved/attempted ${today}; the next run submits the following problem`,
      };
    }

    const submitOnce = async (submissionCode: string): Promise<HttpSubmitResult & { handle?: string }> => {
      await Promise.resolve(onProgress?.('network', username));
      await Promise.resolve(onProgress?.('opening', username));
      await Promise.resolve(onProgress?.('submitting', username));
      // The header-only POST is answered 302 -> "/" by Codeforces' own router,
      // so it remains an opt-in diagnostic; the browser path is the real
      // transport for the free-tier submission service.
      const httpFirst = process.env.CODEFORCES_HTTP_FIRST?.trim().toLowerCase() === 'true';
      let attempt: HttpSubmitResult & { handle?: string };
      if (httpFirst) {
        const { submitViaHttp } = await import('./httpSubmit');
        attempt = await submitViaHttp(stored.state, account.username, entry, submissionCode);
      } else {
        attempt = {
          ok: false,
          kind: 'blocked',
          error: 'browser transport selected for the free-tier submission path',
          handle,
        };
      }

      let attemptUsername = attempt.handle ?? username;
      if (!attempt.ok && attempt.kind === 'blocked') {
        logger.warn({ label, problem: problemLabel(entry), error: attempt.error }, 'Codeforces HTTP submission blocked; falling back to browser transport');
        browserAttempted = true;
        const viaBrowser = await runSubmissionAttempts((deadline, attemptNumber) => submitViaBrowser(
          stored.state,
          label,
          attemptUsername,
          entry,
          submissionCode,
          networkMode,
          deadline,
          (phase) => onProgress?.(phase, attemptUsername, attemptNumber),
        ), (phase, attemptNumber) => onProgress?.(phase, attemptUsername, attemptNumber));
        if (viaBrowser) {
          attempt = viaBrowser;
          attemptUsername = viaBrowser.handle ?? attemptUsername;
        }
      } else if (!attempt.ok) {
        logger.warn({ label, problem: problemLabel(entry), kind: attempt.kind, error: attempt.error }, 'Codeforces HTTP submission failed (not blocked, no browser fallback)');
      }
      username = attemptUsername;
      return { ...attempt, handle: attemptUsername };
    };

    let submissionCode = useCommentStrippedFirst ? strippedCode : originalCode;
    if (useCommentStrippedFirst) {
      logger.info(
        { label, problem: problemLabel(entry), removedComments: true },
        'Codeforces: submitting comment-stripped source first',
      );
    } else {
      logger.info(
        { label, problem: problemLabel(entry), removedComments: false },
        'Codeforces: submitting source without comment retry',
      );
    }

    let result = await submitOnce(submissionCode);
    await Promise.resolve(onProgress?.('verdict', username));

    if (
      useCommentStrippedFirst &&
      !result.ok &&
      shouldRetryWithOriginal(result.verdict)
    ) {
      logger.warn(
        {
          label,
          problem: problemLabel(entry),
          firstVerdict: result.verdict,
          firstSubmissionId: result.submissionId ?? null,
        },
        'Codeforces: comment-stripped submission failed at compile/runtime; retrying exact original source',
      );

      // The first attempt already consumed today's reservation. Release it,
      // then immediately reserve the same day again for the exact original
      // source. This is intentionally limited to compiler/runtime failures.
      await releaseDailyAttempt(account.id, today);
      const reclaimed = await claimDailyAttempt(account.id, today, entry.key);
      if (reclaimed) {
        submissionCode = originalCode;
        result = await submitOnce(originalCode);
        await Promise.resolve(onProgress?.('verdict', username));
        logger.info(
          {
            label,
            problem: problemLabel(entry),
            retryVerdict: result.verdict ?? (result.ok ? 'OK' : null),
            retrySubmissionId: result.submissionId ?? null,
          },
          'Codeforces: original-source retry finished',
        );
      } else {
        logger.error(
          { label, problem: problemLabel(entry) },
          'Codeforces: could not reclaim today attempt for original-source retry',
        );
      }
    }

    if (result.ok) {
      const index = source.queue.findIndex((e) => e.key === entry.key);
      const nextKey = source.queue[index + 1]?.key ?? null;
      await recordAttempt(account.id, { submissionId: result.submissionId, verdict: result.verdict });
      await completeCurrentProblem(account.id, {
        completedKey: entry.key,
        nextKey,
        submissionId: result.submissionId,
        verdict: result.verdict,
      });
      await patchCodeforcesAccount(account.id, {
        status: CodeforcesAccountStatus.ACTIVE,
        username,
        lastError: null,
        checked: true,
        lastSubmissionDate: today,
        lastSubmissionId: result.submissionId,
        lastVerdict: result.verdict,
      });
      return {
        label,
        username,
        kind: 'solved',
        performed: true,
        browserAttempted,
        note,
        problem: problemLabel(entry),
        problemUrl: entry.problemUrl ?? null,
        submissionId: result.submissionId,
        verdict: result.verdict,
      };
    }

    const verdictCode = result.verdict ?? result.kind.toUpperCase().replace(/-/g, '_');
    await recordAttempt(account.id, { submissionId: result.submissionId ?? null, verdict: verdictCode });
    const duplicateSubmission = isAlreadySubmittedCodeError(result.error);
    const finalVerdict = Boolean(result.submissionId && isTerminalCodeforcesVerdict(result.verdict));
    if (finalVerdict || duplicateSubmission) {
      const index = source.queue.findIndex((e) => e.key === entry.key);
      await completeCurrentProblem(account.id, {
        completedKey: entry.key,
        nextKey: source.queue[index + 1]?.key ?? null,
        submissionId: result.submissionId ?? null,
        verdict: duplicateSubmission ? 'DUPLICATE_CODE' : verdictCode,
      });
    }
    await patchCodeforcesAccount(account.id, {
      status:
        result.kind === 'signed-out'
          ? CodeforcesAccountStatus.REJECTED
          : result.kind === 'blocked'
            ? CodeforcesAccountStatus.UNKNOWN
            : CodeforcesAccountStatus.ACTIVE,
      username,
      lastError: result.error,
      checked: true,
      lastSubmissionDate: today,
      lastSubmissionId: result.submissionId ?? null,
      lastVerdict: verdictCode,
    });
    return {
      label,
      username,
      kind: result.kind === 'signed-out' ? 'rejected' : 'failed',
      performed: finalVerdict || duplicateSubmission,
      browserAttempted,
      note: duplicateSubmission
        ? `${note ? `${note} ` : ''}Codeforces already had this exact source; marked it performed and advanced to the next solution.`
        : note,
      problem: problemLabel(entry),
      problemUrl: entry.problemUrl ?? null,
      submissionId: result.submissionId ?? null,
      verdict: result.verdict ?? null,
      error: result.error,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await patchCodeforcesAccount(account.id, {
      status: CodeforcesAccountStatus.UNKNOWN,
      lastError: msg,
      checked: true,
      lastSubmissionDate: today,
      lastVerdict: 'SUBMISSION_ERROR',
    }).catch(() => undefined);
    return {
      label,
      username: handle,
      kind: 'failed',
      note,
      problem: problemLabel(entry),
      problemUrl: entry.problemUrl ?? null,
      browserAttempted,
      error: msg,
    };
  }
}

/**
 * Posts the submit form and reads the verdict from the public API — fully
 * unattended.
 *
 * The POST itself happens in a browser, because Codeforces' form carries a
 * Cloudflare Turnstile field that only a real page can fill, and its POSTs are
 * answered 302 -> "/" for every other client. WHERE that browser runs depends on
 * configuration: when a second free web service is configured
 * (`CODEFORCES_SUBMITTER_URL`), the POST is handed to it, because a headless
 * Firefox costs ~390MB the instant it launches and this container also runs
 * Telehram, Prisma and the LeetCode scheduler inside 512MB. Without that
 * configuration the browser runs locally, watched by the memory guard.
 *
 * The verdict poll is always browserless, so it does not matter which side did
 * the POST.
 */
async function submitViaBrowser(
  state: Parameters<typeof launchFirefoxWithStorageStateObject>[0],
  label: string,
  handle: string | null,
  entry: SourceIndexEntry,
  code: string,
  networkMode: CodeforcesNetworkMode = 'proxy',
  deadline = Date.now() + CODEFORCES_ATTEMPT_MS,
  onProgress?: (phase: 'queued' | 'running' | 'verdict') => Promise<void> | void,
): Promise<HttpSubmitResult & { handle?: string; safeToRetry?: boolean }> {
  const user = handle ?? label;

  // All API work happens before any browser exists, local or remote.
  let before: Set<number>;
  try {
    before = await readBeforeDeadline(captureBefore(user, entry), deadline);
  } catch (err) {
    return {
      ok: false,
      kind: 'error',
      error: `could not snapshot Codeforces submissions before submitting: ${err instanceof Error ? err.message : String(err)}`,
      handle: user,
      safeToRetry: true,
    };
  }

  const posted = isRemoteSubmitterConfigured()
    ? await submitViaRemoteSubmitter(state, label, user, entry, code, networkMode, { deadline, onProgress })
    : await postViaLocalBrowser(state, label, entry, code, deadline, networkMode);

  if (!posted) {
    return {
      ok: false,
      kind: 'error',
      error: 'no Codeforces browser transport is available (neither an isolated submitter URL nor a launchable local Firefox)',
      handle: user,
      safeToRetry: true,
    };
  }

  if (!posted.ok) {
    // A broker restart, 502 or response loss can happen after the single
    // Codeforces POST. Reconcile against the pre-submit snapshot before saying
    // the job failed. Never fire another POST from this path.
    if (posted.clicked || /outcome is uncertain|not JSON|call failed/i.test(posted.error ?? '')) {
      await onProgress?.('verdict');
      const discovered = Date.now() < deadline ? await readBeforeDeadline(
        pollForVerdict(user, entry, before, posted.submittedAt, { windowMs: Math.min(180_000, deadline - Date.now()) }), deadline,
      ).catch(() => null) : null;
      if (discovered) {
        const verdict = discovered.verdict ?? 'TESTING';
        return verdict === 'OK'
          ? { ok: true, submissionId: String(discovered.id), verdict, handle: user }
          : { ok: false, kind: verdict === 'TESTING' ? 'judge-timeout' : 'rejected', error: `Codeforces verdict: ${verdict}`, submissionId: String(discovered.id), verdict, handle: user } as HttpSubmitResult & { handle?: string };
      }
    }
    return {
      ok: false,
      kind: posted.kind === 'submission-error' ? 'rejected' : (posted.kind ?? 'error'),
      error: `${posted.error ?? 'Codeforces rejected the submission form'} (${posted.transport})`,
      handle: user,
      safeToRetry: 'safeToRetry' in posted ? posted.safeToRetry === true : false,
    } as HttpSubmitResult & { handle?: string; safeToRetry?: boolean };
  }

  await onProgress?.('verdict');
  const submission = Date.now() < deadline ? await readBeforeDeadline(
    pollForVerdict(user, entry, before, posted.submittedAt, { windowMs: Math.min(180_000, deadline - Date.now()) }), deadline,
  ).catch(() => null) : null;
  if (!submission) {
    return {
      ok: false,
      kind: 'judge-timeout',
      error: `the ${posted.transport} posted the form (HTTP ${posted.status ?? '?'} → ${posted.finalUrl}) but no new submission appeared in the API`,
      handle: user,
    } as HttpSubmitResult & { handle?: string };
  }
  const verdict = submission.verdict ?? 'TESTING';
  if (verdict === 'OK') return { ok: true, submissionId: String(submission.id), verdict, handle: user };
  return {
    ok: false,
    kind: verdict === 'TESTING' ? 'judge-timeout' : 'rejected',
    error: `Codeforces verdict: ${verdict}`,
    submissionId: String(submission.id),
    verdict,
    handle: user,
  } as HttpSubmitResult & { handle?: string };
}

async function configuredNetworkMode(): Promise<CodeforcesNetworkMode> {
  const value = await getSystemState(SystemKeys.codeforcesNetworkMode);
  return value === 'tailscale' ? 'tailscale' : 'proxy';
}

/**
 * A posted (or failed-to-post) result from either transport. The local fallback
 * can additionally fail with a transport-level `error`, which the shared tail
 * below reports as-is rather than mislabelling it as a Codeforces rejection.
 */
type LocalPostOutcome = Omit<BrowserPostOutcome, 'kind'> & {
  kind?: BrowserPostOutcome['kind'] | 'error';
  submittedAt: number;
  transport: string;
};

/**
 * Local fallback: runs the POST in a Firefox inside THIS container, under the
 * memory watchdog. Only reachable when no isolated submitter is configured —
 * on a 512MB instance the browser is very likely to be closed at the ceiling,
 * which is exactly why the isolated submitter exists.
 */
async function postViaLocalBrowser(
  state: Parameters<typeof launchFirefoxWithStorageStateObject>[0],
  label: string,
  entry: SourceIndexEntry,
  code: string,
  deadline = Date.now() + CODEFORCES_ATTEMPT_MS,
  networkMode: CodeforcesNetworkMode = 'proxy',
): Promise<LocalPostOutcome | null> {
  const activeProxy = networkMode !== 'tailscale'
    ? await notifyProxyInUse(networkMode).catch(() => null)
    : null;
  releaseHeap();
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  const available = availableMemoryMb();
  logMemory('codeforces browser preflight', { availableMb: available, minimumFreeMb: BROWSER_MIN_FREE_MB });
  if (available !== null && available < BROWSER_MIN_FREE_MB) {
    return {
      ok: false,
      kind: 'blocked',
      error:
        `not starting Firefox locally: only ${available}MB is free after cleanup; the floor is ${BROWSER_MIN_FREE_MB}MB. ` +
        'Set CODEFORCES_SUBMITTER_URL to run the browser in its own free service instead.',
      status: null,
      finalUrl: '',
      turnstile: false,
      clicked: false,
      interactive: false,
      submittedAt: Math.floor(Date.now() / 1000),
      transport: 'Firefox transport',
    };
  }

  const session = await launchFirefoxWithStorageStateObject(state, label, activeProxy?.url);
  if (!session) {
    return {
      ok: false,
      kind: 'error',
      error: 'Firefox could not be launched from the stored Codeforces session',
      status: null,
      finalUrl: '',
      turnstile: false,
      clicked: false,
      interactive: false,
      submittedAt: Math.floor(Date.now() / 1000),
      transport: 'Firefox transport',
    };
  }
  logMemory('codeforces firefox launched');
  const attemptTimer = setTimeout(() => { void session.close().catch(() => undefined); }, Math.max(1, deadline - Date.now()));

  let pressured = false;
  let posted: BrowserPostOutcome;
  let submittedAt: number;
  const watch = new MemoryWatch(() => {
    pressured = true;
    logger.error(
      { ...memoryReading(), phase: 'codeforces browser' },
      'memory ceiling reached - closing the Codeforces browser before the kernel kills the whole service',
    );
    void session.close().catch(() => undefined);
  });
  watch.start();

  try {
    submittedAt = Math.floor(Date.now() / 1000);
    posted = await postSubmitForm(session, entry, code);
    logMemory('codeforces submit posted', {
      status: posted.status,
      finalUrl: posted.finalUrl,
      clicked: posted.clicked,
      turnstile: posted.turnstile,
      interactive: posted.interactive,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const { peakMb, tripped } = watch.stop();
    logMemory('codeforces browser step finished', { peakMb, tripped, pressured });
    return {
      ok: false,
      kind: pressured ? 'blocked' : 'error',
      error: pressured
        ? `the local browser step was stopped at the instance's memory ceiling: ${message}`
        : `Firefox transport failed: ${message}`,
      status: null,
      finalUrl: '',
      turnstile: false,
      clicked: false,
      interactive: false,
      submittedAt: Math.floor(Date.now() / 1000),
      transport: 'Firefox transport',
    };
  } finally {
    clearTimeout(attemptTimer);
    const closing = session.close().catch(() => undefined);
    const bail = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 15_000);
      timer.unref?.();
    });
    await Promise.race([closing, bail]);
    releaseHeap();
  }

  const { peakMb, tripped } = watch.stop();
  logMemory('codeforces browser step finished', { peakMb, tripped, pressured });
  if (pressured && !posted.ok) {
    posted.kind = 'blocked';
    posted.error = `the local browser step was stopped at the instance's memory ceiling: ${posted.error}`;
  }
  return { ...posted, submittedAt, transport: 'Firefox transport' };
}

export function resolveCurrentEntry(queue: SourceIndexEntry[], nextKey: string | null, lastCompletedKey: string | null): SourceIndexEntry | null {
  if (nextKey) {
    const exact = queue.find((entry) => entry.key === nextKey);
    if (exact) return exact;
  }
  if (lastCompletedKey) {
    const completedIndex = queue.findIndex((entry) => entry.key === lastCompletedKey);
    if (completedIndex >= 0) return queue[completedIndex + 1] ?? null;
  }
  return queue[0] ?? null;
}

function problemLabel(entry: SourceIndexEntry): string {
  return `${entry.contestId ?? '?'}${entry.problemIndex ?? ''}${entry.problemName ? ` — ${entry.problemName}` : ''}`;
}

interface CodeforcesDailyState {
  date: string;
  retryCount: number;
  completedAccountIds: string[];
  /** Accounts that already opened the expensive proxy browser today. */
  browserAttemptedAccountIds: string[];
}

const CODEFORCES_DAILY_RETRY_LIMIT = 10;

async function readCodeforcesDailyState(date: string): Promise<CodeforcesDailyState> {
  try {
    const raw = await getSystemState(SystemKeys.codeforcesDailyState);
    const parsed = raw ? JSON.parse(raw) as Partial<CodeforcesDailyState> : null;
    if (parsed?.date === date) {
      return {
        date,
        retryCount: Number.isInteger(parsed.retryCount) && Number(parsed.retryCount) >= 0 ? Number(parsed.retryCount) : 0,
        completedAccountIds: Array.isArray(parsed.completedAccountIds)
          ? parsed.completedAccountIds.filter((id): id is string => typeof id === 'string')
          : [],
        browserAttemptedAccountIds: Array.isArray(parsed.browserAttemptedAccountIds)
          ? parsed.browserAttemptedAccountIds.filter((id): id is string => typeof id === 'string')
          : [],
      };
    }
  } catch {
    // Reset malformed state; account progress remains durable in its own table.
  }
  return { date, retryCount: 0, completedAccountIds: [], browserAttemptedAccountIds: [] };
}

async function writeCodeforcesDailyState(state: CodeforcesDailyState): Promise<void> {
  await setSystemState(SystemKeys.codeforcesDailyState, JSON.stringify(state));
}

export function isAfterCodeforcesSchedule(
  now: Date,
  hour: number,
  minute: number,
  timezone: string,
): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const currentHour = Number(parts.find((part) => part.type === 'hour')?.value ?? -1);
  const currentMinute = Number(parts.find((part) => part.type === 'minute')?.value ?? -1);
  return currentHour * 60 + currentMinute > hour * 60 + minute;
}

async function runAutomaticCodeforcesDaily(isRetry: boolean, hour: number, minute: number, timezone: string): Promise<void> {
  if (runInProgress) return;
  if (isLeetCodeBusy() || isCodeChefRunInProgress()) {
    logger.info('LeetCode or CodeChef is currently running; deferring Codeforces execution to protect memory');
    return;
  }
  if (isRetry && !isAfterCodeforcesSchedule(new Date(), hour, minute, timezone)) return;

  const date = todayInTimezone();
  const state = await readCodeforcesDailyState(date);
  if (isRetry && state.retryCount >= CODEFORCES_DAILY_RETRY_LIMIT) return;

  const accounts = await listCodeforcesAccounts(false);
  const completed = new Set(state.completedAccountIds);
  const browserAttempted = new Set(state.browserAttemptedAccountIds);
  // A normal daily submission gets one browser delivery. The browser path
  // itself still has its bounded three-attempt recovery; subsequent cron ticks
  // only retry failures that occurred before any proxy browser was opened.
  const pending = accounts.filter((account) => !completed.has(account.id) && !browserAttempted.has(account.id));
  if (pending.length === 0) return;

  if (isRetry) state.retryCount += 1;
  await writeCodeforcesDailyState(state);
  logger.info(
    { date, retry: isRetry, retryAttempt: state.retryCount, retryLimit: CODEFORCES_DAILY_RETRY_LIMIT, accounts: pending.length, browserAttempted: browserAttempted.size },
    'automatic Codeforces daily run starting',
  );

  await runCodeforcesNow('cron', {
    forceDailyAttempt: true,
    accountIds: pending.map((account) => account.id),
    onAccountOutcome: async (outcome, index) => {
      const account = pending[index - 1];
      if (!account) return;
      const terminalWithoutSource = outcome.kind === 'skipped' && /queue is exhausted/i.test(outcome.error ?? '');
      if (outcome.performed || terminalWithoutSource) {
        completed.add(account.id);
        state.completedAccountIds = [...completed];
        await writeCodeforcesDailyState(state);
      } else if (outcome.browserAttempted) {
        browserAttempted.add(account.id);
        state.browserAttemptedAccountIds = [...browserAttempted];
        await writeCodeforcesDailyState(state);
      }
    },
  });
}

export function startCodeforcesScheduler(): () => void {
  // Staggered away from the LeetCode run by default (09:15 vs 09:00) so the two
  // never contend for the same 512MB container.
  const fallback = config.schedule;
  const requestedHour = Number(process.env.CODEFORCES_RUN_HOUR ?? 9);
  const requestedMinute = Number(process.env.CODEFORCES_RUN_MINUTE ?? 30);
  const hour = Number.isInteger(requestedHour) && requestedHour >= 0 && requestedHour <= 23
    ? requestedHour
    : 9;
  const minute = Number.isInteger(requestedMinute) && requestedMinute >= 0 && requestedMinute <= 59
    ? requestedMinute
    : 30;
  const timezone = fallback.timezone;
  const expression = `${minute} ${hour} * * *`;
  const task = cron.schedule(
    expression,
    () => {
      void runAutomaticCodeforcesDaily(false, hour, minute, timezone);
    },
    { timezone },
  );
  const retryTask = cron.schedule(
    '*/5 * * * *',
    () => {
      void runAutomaticCodeforcesDaily(true, hour, minute, timezone);
    },
    { timezone },
  );
  logger.info({ expression, retryExpression: '*/5 * * * *', retryLimit: CODEFORCES_DAILY_RETRY_LIMIT, timezone }, 'Codeforces scheduler armed');
  // Deliberately no RUN_ON_BOOT hook: existing LeetCode boot behavior stays unchanged,
  // and Codeforces submissions happen on the configured daily cron or manual command.
  return () => {
    task.stop();
    retryTask.stop();
  };
}
