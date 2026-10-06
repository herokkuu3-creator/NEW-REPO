import cron from 'node-cron';
import { CodeChefAccountStatus } from '@prisma/client';
import { logger } from '../logger';
import { config } from '../config';
import { isRunInProgress as isLeetCodeBusy } from '../scheduler/dailyWorker';
import { sendTelegramMessage } from '../notifications/telegram';
import {
  listCodeChefAccounts,
  ensureCodeChefAccountsSeeded,
  patchCodeChefAccount,
  getCodeChefProgress,
  completeCurrentProblem,
  claimDailyAttempt,
  releaseDailyAttempt,
  recordAttempt,
} from './storage';
import {
  loadCodeChefSourceIndex,
  fetchSourceCode,
  isCodeChefProblemListed,
  RETIRED_OR_INVALID_CODECHEF_PROBLEMS,
  type CodeChefSourceEntry,
} from './sourceRepo';
import { loginToCodeChef } from './auth';
import { submitDirectlyViaCodeChefApi, submitToCodeChef, type CodeChefSubmitResult } from './api';
import { type CodeChefState } from './browser';

let runInProgress = false;
export function isCodeChefRunInProgress(): boolean { return runInProgress; }

export interface CodeChefRangeJobInfo {
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

let activeRangeAbortController: AbortController | null = null;
let activeRangeJob: CodeChefRangeJobInfo | null = null;

export const CODECHEF_RANGE_GAP_MS = 30000; // 30-second pacing between batch questions to mimic human behavior

export function cancelCodeChefRun(): boolean {
  if (!runInProgress) return false;
  if (activeRangeJob) activeRangeJob.state = 'cancelling';
  if (activeRangeAbortController) {
    activeRangeAbortController.abort();
    return true;
  }
  return false;
}

export function getCodeChefRangeStatus(): CodeChefRangeJobInfo | null {
  return activeRangeJob ? { ...activeRangeJob } : null;
}

export function formatCodeChefRangeStatus(info: CodeChefRangeJobInfo, now = Date.now()): string {
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
    '<b>👨‍🍳 CODECHEF RANGE STATUS</b>',
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
    '<i>Send <code>/cccancelrange</code> to stop this batch job.</i>',
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

export function isTerminalCodeChefVerdict(verdict: string | null | undefined): boolean {
  if (!verdict) return false;
  const v = verdict.toLowerCase();
  return /accepted|wrong answer|time limit|runtime|compilation|partially|internal error/i.test(v);
}

export interface CodeChefOutcome {
  label: string;
  problem?: string;
  verdict?: string;
  submissionId?: string;
  error?: string;
  performed: boolean;
  skipped?: boolean;
}

export interface CodeChefReport {
  date: string;
  outcomes: CodeChefOutcome[];
}

export interface CodeChefProgressEvent {
  phase: 'checking' | 'logging-in' | 'session-ready' | 'loading-source' | 'opening-submit' | 'submitting' | 'judging' | 'completed' | 'failed' | 'skipped' | 'waiting' | 'cancelled';
  label: string;
  username?: string | null;
  problemCode?: string | null;
  index: number;
  total: number;
  accIndex?: number;
  accTotal?: number;
  stepIndex?: number;
  stepTotal?: number;
  verdict?: string | null;
  submissionId?: string | null;
  error?: string | null;
  waitSeconds?: number;
}

export interface CodeChefRunOptions {
  forceDailyAttempt?: boolean;
  batchCount?: number;
  onProgress?: (event: CodeChefProgressEvent) => Promise<void> | void;
  onAccountOutcome?: (outcome: CodeChefOutcome, index: number, total: number) => Promise<void> | void;
}

function todayInTimezone(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: config.schedule.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function nextCodeChefSource(queue: CodeChefSourceEntry[], progress: { nextKey: string | null; lastCompletedKey: string | null }): number {
  if (progress.nextKey) {
    const index = queue.findIndex(entry => entry.problemCode === progress.nextKey);
    if (index < 0) throw new Error('The next CodeChef problem is missing from the source queue. Rebuild the index before submitting.');
    return index;
  }
  if (!progress.lastCompletedKey) return 0;
  const index = queue.findIndex(entry => entry.problemCode === progress.lastCompletedKey);
  if (index < 0) throw new Error('The previous CodeChef problem is missing from the source queue. Progress was preserved.');
  return index + 1;
}

/**
 * Resiliently resolves the next problem index. If nextKey or lastCompletedKey
 * was retired, removed, or missing from the queue, falls back to the next
 * alphabetical problem in line instead of throwing an error.
 */
export function findNextCodeChefSourceIndex(
  queue: CodeChefSourceEntry[],
  progress: { nextKey: string | null; lastCompletedKey: string | null },
): number {
  if (queue.length === 0) return 0;
  try {
    const idx = nextCodeChefSource(queue, progress);
    return idx < queue.length ? idx : 0;
  } catch {
    const refKey = progress.nextKey ?? progress.lastCompletedKey;
    if (refKey) {
      const idx = queue.findIndex(e => (e.problemCode ?? '').localeCompare(refKey) > 0);
      if (idx >= 0) return idx;
    }
    return 0;
  }
}

/**
 * Validates candidate problems against CodeChef before attempting submit.
 * If a problem is unlisted, retired, or invalid on CodeChef, it automatically
 * advances the database cursor and skips past it until a valid problem is found.
 */
export async function advanceToNextValidProblem(
  accountId: string,
  accountLabel: string,
  accountUsername: string | null | undefined,
  queue: CodeChefSourceEntry[],
  startIndex: number,
  onProgress?: (event: CodeChefProgressEvent) => Promise<void> | void,
  progressIndex = 1,
  progressTotal = 1,
  signal?: AbortSignal,
  accIndex?: number,
  accTotal?: number,
  stepIndex?: number,
  stepTotal?: number,
): Promise<{ entry: CodeChefSourceEntry; index: number } | null> {
  let currIdx = startIndex;
  let skips = 0;

  while (currIdx < queue.length && skips < 50) {
    if (signal?.aborted) return null;
    const candidate = queue[currIdx];
    if (!candidate || !candidate.problemCode) break;

    const check = await isCodeChefProblemListed(candidate.problemCode);
    if (check.valid) {
      return { entry: candidate, index: currIdx };
    }

    logger.warn({ account: accountLabel, problem: candidate.problemCode, reason: check.reason }, 'CodeChef problem is unlisted or URL is invalid; auto-skipping...');
    skips++;
    if (activeRangeJob) activeRangeJob.skipped++;
    const nextCandidate = queue[currIdx + 1];
    await completeCurrentProblem(accountId, {
      completedKey: candidate.problemCode,
      nextKey: nextCandidate?.problemCode ?? null,
      submissionId: null,
      verdict: 'SKIPPED_RETIRED',
    });
    await patchCodeChefAccount(accountId, {
      lastError: `Problem ${candidate.problemCode} not listed on CodeChef (${check.reason})`,
      checked: true,
    });
    await onProgress?.({
      phase: 'skipped',
      label: accountLabel,
      username: accountUsername,
      problemCode: candidate.problemCode,
      index: progressIndex,
      total: progressTotal,
      accIndex,
      accTotal,
      stepIndex,
      stepTotal,
      error: `Skipped unlisted problem ${candidate.problemCode}: ${check.reason}`,
    });

    currIdx++;
  }

  const remaining = currIdx < queue.length ? queue[currIdx] : undefined;
  return remaining?.problemCode ? { entry: remaining, index: currIdx } : null;
}

export function formatCodeChefAccountMessage(outcome: CodeChefOutcome, index: number, total: number): string {
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const emoji = outcome.skipped
    ? '⏭️'
    : outcome.verdict === 'Accepted'
      ? '✅'
      : outcome.verdict === 'Time Limit Exceeded'
        ? '⏱️'
        : outcome.verdict === 'Runtime Error'
          ? '💥'
          : outcome.verdict === 'Compilation Error'
            ? '⚠️'
            : outcome.performed
              ? '❌'
              : '⚠️';
  const prefix = total > 1 ? `<b>[${index}/${total}]</b> ` : '';
  const problem = outcome.problem ? ` · <code>${escape(outcome.problem)}</code>` : '';
  const result = outcome.error ? escape(outcome.error) : outcome.verdict ?? 'No result';
  const sub = outcome.submissionId ? ` · <a href="https://www.codechef.com/viewsolution/${escape(outcome.submissionId)}">#${escape(outcome.submissionId)}</a>` : '';
  return `${emoji} ${prefix}<b>${escape(outcome.label)}</b>${problem} — <i>${result}</i>${sub}`;
}

export function formatCodeChefReport(report: CodeChefReport): string {
  const lines = report.outcomes.map((row, i) => formatCodeChefAccountMessage(row, i + 1, report.outcomes.length));
  return [
    `<b>👨‍🍳 CODECHEF SUBMISSION</b>`,
    `<i>${report.date}</i>`,
    `<code>━━━━━━━━━━━━━━━━━━━━</code>`,
    '',
    ...(lines.length ? lines : ['No active CodeChef accounts configured. Add CODECHEF_1=username::password in Render.']),
  ].join('\n');
}

export async function runCodeChefNow(
  reason: 'manual' | 'cron' = 'manual',
  options: CodeChefRunOptions = {},
): Promise<CodeChefReport | null> {
  if (runInProgress) return null;
  runInProgress = true;
  activeRangeAbortController = new AbortController();
  const signal = activeRangeAbortController.signal;
  try {
    const report: CodeChefReport = { date: todayInTimezone(), outcomes: [] };
    await ensureCodeChefAccountsSeeded();
    const accounts = await listCodeChefAccounts(true);
    const queue = accounts.length ? await loadCodeChefSourceIndex() : [];
    const batchCount = Math.max(1, options.batchCount ?? 1);
    const forceAttempt = options.forceDailyAttempt ?? (reason === 'manual');

    activeRangeJob = {
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

    for (const [accIndex, account] of accounts.entries()) {
      if (signal.aborted) break;

      if (isLeetCodeBusy()) {
        const row: CodeChefOutcome = { label: account.label, performed: false, skipped: true, error: 'LeetCode is running; CodeChef was deferred to avoid competing for memory' };
        report.outcomes.push(row);
        await options.onProgress?.({ phase: 'skipped', label: account.label, username: account.username, index: accIndex + 1, total: accounts.length, error: row.error });
        continue;
      }

      await options.onProgress?.({
        phase: 'checking',
        label: account.label,
        username: account.username,
        index: accIndex + 1,
        total: accounts.length,
        accIndex,
        accTotal: accounts.length,
      });

      let currentProgress = await getCodeChefProgress(account.id);
      let validCandidate = await advanceToNextValidProblem(
        account.id,
        account.label,
        account.username,
        queue,
        findNextCodeChefSourceIndex(queue, currentProgress),
        options.onProgress,
        accIndex + 1,
        accounts.length,
        signal,
        accIndex,
        accounts.length,
        1,
        batchCount,
      );

      if (signal.aborted) break;

      if (!validCandidate) {
        const row: CodeChefOutcome = { label: account.label, performed: false, skipped: true, error: 'Source queue exhausted or no valid problems remain' };
        report.outcomes.push(row);
        await options.onProgress?.({
          phase: 'skipped',
          label: account.label,
          username: account.username,
          index: accIndex + 1,
          total: accounts.length,
          accIndex,
          accTotal: accounts.length,
          error: row.error,
        });
        continue;
      }

      let index = validCandidate.index;
      let entry = validCandidate.entry;

      let claimed = await claimDailyAttempt(account.id, report.date, entry.problemCode!, forceAttempt);
      if (!claimed) {
        logger.info({ account: account.label, problem: entry.problemCode }, 'Today’s CodeChef attempt is already claimed');
        const row: CodeChefOutcome = { label: account.label, performed: false, skipped: true, problem: entry.problemCode, error: 'Today’s CodeChef attempt is already completed or awaiting confirmation' };
        report.outcomes.push(row);
        await options.onProgress?.({
          phase: 'skipped',
          label: account.label,
          username: account.username,
          problemCode: entry.problemCode,
          index: accIndex + 1,
          total: accounts.length,
          accIndex,
          accTotal: accounts.length,
          error: row.error,
        });
        continue;
      }

      let mayHaveSubmitted = false;
      const credentials = JSON.parse(account.storageState) as Partial<CodeChefState> & { username?: string; password?: string };
      let state: CodeChefState | undefined = credentials.cookies?.length ? { cookies: credentials.cookies, origins: [] } : undefined;

      const login = async (): Promise<void> => {
        await options.onProgress?.({
          phase: 'logging-in',
          label: account.label,
          username: account.username,
          index: accIndex + 1,
          total: accounts.length,
          accIndex,
          accTotal: accounts.length,
        });
        logger.info({ account: account.label }, 'Authenticating account on CodeChef...');
        const updated = await loginToCodeChef(credentials.username ?? account.username ?? account.label, credentials.password ?? '');
        state = { cookies: updated.cookies, origins: [] };
        await patchCodeChefAccount(account.id, { storageState: JSON.stringify({ username: credentials.username, password: credentials.password, ...updated }), checked: true });
        logger.info({ account: account.label }, 'CodeChef account session saved to DB');
        await options.onProgress?.({
          phase: 'session-ready',
          label: account.label,
          username: account.username,
          index: accIndex + 1,
          total: accounts.length,
          accIndex,
          accTotal: accounts.length,
        });
      };

      try {
        if (!state) await login();

        let retiredSkips = 0;
        for (let step = 0; step < batchCount; step++) {
          if (signal.aborted) break;

          const progressIndex = accounts.length > 1 && batchCount === 1 ? accIndex + 1 : (accounts.length > 1 ? accIndex * batchCount + step + 1 : step + 1);
          const progressTotal = accounts.length > 1 && batchCount === 1 ? accounts.length : (accounts.length > 1 ? accounts.length * batchCount : batchCount);

          currentProgress = await getCodeChefProgress(account.id);
          const candidate = await advanceToNextValidProblem(
            account.id,
            account.label,
            account.username,
            queue,
            findNextCodeChefSourceIndex(queue, currentProgress),
            options.onProgress,
            progressIndex,
            progressTotal,
            signal,
            accIndex,
            accounts.length,
            step + 1,
            batchCount,
          );
          if (signal.aborted || !candidate) break;

          index = candidate.index;
          entry = candidate.entry;

          if (activeRangeJob) {
            activeRangeJob.currentStep = progressIndex;
            activeRangeJob.currentAccount = account.label;
            activeRangeJob.currentProblem = entry.problemCode ?? null;
          }

          if (step > 0 || retiredSkips > 0) {
            claimed = await claimDailyAttempt(account.id, report.date, entry.problemCode!, true);
            mayHaveSubmitted = false;
          }

          const row: CodeChefOutcome = { label: account.label, performed: false, problem: entry.problemCode };
          logger.info({ account: account.label, problem: entry.problemCode, step: step + 1, batchCount, index, total: queue.length }, 'Starting CodeChef attempt');

          await options.onProgress?.({
            phase: 'loading-source',
            label: account.label,
            username: account.username,
            problemCode: entry.problemCode,
            index: progressIndex,
            total: progressTotal,
            accIndex,
            accTotal: accounts.length,
            stepIndex: step + 1,
            stepTotal: batchCount,
          });
          const code = await fetchSourceCode(entry);

          await options.onProgress?.({
            phase: 'opening-submit',
            label: account.label,
            username: account.username,
            problemCode: entry.problemCode,
            index: progressIndex,
            total: progressTotal,
            accIndex,
            accTotal: accounts.length,
            stepIndex: step + 1,
            stepTotal: batchCount,
          });
          await options.onProgress?.({
            phase: 'submitting',
            label: account.label,
            username: account.username,
            problemCode: entry.problemCode,
            index: progressIndex,
            total: progressTotal,
            accIndex,
            accTotal: accounts.length,
            stepIndex: step + 1,
            stepTotal: batchCount,
          });

          mayHaveSubmitted = true;
          // 1. Direct API submit (0MB browser RAM, takes 2-3s, completely avoids Render OOM)
          let posted: CodeChefSubmitResult | null = null;
          if (state) {
            posted = await submitDirectlyViaCodeChefApi(state, entry.problemUrl!, code, entry.language, 90000);
          }

          // 2. If signed-out, re-login and retry
          if (posted?.kind === 'signed-out' && !posted.clicked) {
            logger.warn({ account: account.label }, 'CodeChef session expired before submit click; re-authenticating...');
            await login();
            posted = await submitDirectlyViaCodeChefApi(state, entry.problemUrl!, code, entry.language, 90000);
          }

          const isProblemInvalid = posted?.problemInvalid || /does not belong to the contest|no such problem|does not exist in Practice/i.test(posted?.error ?? '');
          if (isProblemInvalid) {
            logger.warn({ account: account.label, problem: entry.problemCode }, 'CodeChef problem is retired or contest-restricted; advancing cursor past it...');
            RETIRED_OR_INVALID_CODECHEF_PROBLEMS.add(entry.problemCode!);
            if (activeRangeJob) activeRangeJob.skipped++;
            await completeCurrentProblem(account.id, {
              completedKey: entry.problemCode!,
              nextKey: queue[index + 1]?.problemCode ?? null,
              submissionId: null,
              verdict: 'SKIPPED_RETIRED',
            });
            await patchCodeChefAccount(account.id, {
              lastError: `Problem ${entry.problemCode} retired or contest-restricted on CodeChef`,
              checked: true,
            });
            await options.onProgress?.({
              phase: 'skipped',
              label: account.label,
              username: account.username,
              problemCode: entry.problemCode,
              index: progressIndex,
              total: progressTotal,
              accIndex,
              accTotal: accounts.length,
              stepIndex: step + 1,
              stepTotal: batchCount,
              error: `Retired problem ${entry.problemCode} skipped`,
            });
            retiredSkips++;
            if (retiredSkips <= 50) {
              step--;
            }
            continue;
          }

          // 3. Fallback to browser submit flow ONLY if explicitly allowed and API had a generic error
          if (!posted || (!posted.performed && !posted.clicked && posted.kind === 'error' && process.env.CODECHEF_ALLOW_BROWSER_FALLBACK === 'true')) {
            logger.info({ account: account.label }, 'Falling back to browser submit flow for CodeChef...');
            posted = await submitToCodeChef(state, entry.problemUrl!, code, entry.language, account.username ?? credentials.username);
          }

          mayHaveSubmitted = posted.clicked === true;

          row.submissionId = posted.submissionId;
          row.verdict = posted.verdict;
          row.error = posted.error;
          row.performed = posted.performed === true && !!posted.submissionId;

            const isCompleted = row.performed || (posted.submissionId && isTerminalCodeChefVerdict(posted.verdict)) || isTerminalCodeChefVerdict(posted.verdict);
            if (isCompleted) {
              if (activeRangeJob) activeRangeJob.completed++;
              await completeCurrentProblem(account.id, {
                completedKey: entry.problemCode!,
                nextKey: queue[index + 1]?.problemCode ?? null,
                submissionId: posted.submissionId ?? null,
                verdict: posted.verdict ?? null,
              });
              await patchCodeChefAccount(account.id, {
                status: CodeChefAccountStatus.ACTIVE,
                lastSubmissionDate: report.date,
                lastSubmissionId: posted.submissionId ?? null,
                lastVerdict: posted.verdict ?? null,
                lastError: null,
                checked: true,
              });
              await options.onProgress?.({
                phase: 'completed',
                label: account.label,
                username: account.username,
                problemCode: entry.problemCode,
                verdict: posted.verdict,
                submissionId: posted.submissionId,
                index: progressIndex,
                total: progressTotal,
                accIndex,
                accTotal: accounts.length,
                stepIndex: step + 1,
                stepTotal: batchCount,
              });
            } else {
              if (activeRangeJob) activeRangeJob.failed++;
              await recordAttempt(account.id, { submissionId: posted.submissionId ?? null, verdict: posted.verdict ?? null });
              await patchCodeChefAccount(account.id, { lastError: posted.error ?? 'No confirmed CodeChef result', checked: true });
              if (!mayHaveSubmitted) await releaseDailyAttempt(account.id, report.date);
              await options.onProgress?.({
                phase: 'failed',
                label: account.label,
                username: account.username,
                problemCode: entry.problemCode,
                error: posted.error,
                index: progressIndex,
                total: progressTotal,
                accIndex,
                accTotal: accounts.length,
                stepIndex: step + 1,
                stepTotal: batchCount,
              });
            }

            report.outcomes.push(row);
            await options.onAccountOutcome?.(row, progressIndex, progressTotal);

            if (step < batchCount - 1 && !signal.aborted) {
              if (activeRangeJob) {
                activeRangeJob.state = 'waiting';
                activeRangeJob.waitEndsAt = Date.now() + CODECHEF_RANGE_GAP_MS;
              }
              await options.onProgress?.({
                phase: 'waiting',
                label: account.label,
                username: account.username,
                problemCode: entry.problemCode,
                index: progressIndex,
                total: progressTotal,
                accIndex,
                accTotal: accounts.length,
                stepIndex: step + 1,
                stepTotal: batchCount,
                waitSeconds: Math.round(CODECHEF_RANGE_GAP_MS / 1000),
              });
              await sleepWithAbort(CODECHEF_RANGE_GAP_MS, signal);
              if (activeRangeJob) {
                activeRangeJob.state = 'running';
                activeRangeJob.waitEndsAt = undefined;
              }
              if (signal.aborted) {
                logger.info('CodeChef batch run aborted by user during pacing delay');
                break;
              }
            }
          }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.warn({ accountId: account.id, error: errorMsg }, 'CodeChef account run failed');
        await patchCodeChefAccount(account.id, { lastError: errorMsg, checked: true }).catch(() => undefined);
        if (claimed && !mayHaveSubmitted) await releaseDailyAttempt(account.id, report.date).catch(() => undefined);
        report.outcomes.push({ label: account.label, performed: false, error: errorMsg, problem: entry?.problemCode });
        await options.onProgress?.({
          phase: 'failed',
          label: account.label,
          username: account.username,
          index: accIndex + 1,
          total: accounts.length,
          accIndex,
          accTotal: accounts.length,
          error: errorMsg,
        });
      }

      if (signal.aborted) {
        logger.info({ account: account.label }, 'CodeChef run aborted by user');
        const row: CodeChefOutcome = { label: account.label, performed: false, skipped: true, error: 'Cancelled by user' };
        report.outcomes.push(row);
        await options.onProgress?.({
          phase: 'cancelled',
          label: account.label,
          username: account.username,
          index: accIndex + 1,
          total: accounts.length,
          accIndex,
          accTotal: accounts.length,
          error: 'CodeChef batch cancelled by user',
        });
        break;
      }

      if (accIndex < accounts.length - 1 && !signal.aborted) {
        await sleepWithAbort(4000, signal);
      }
    }

    if (reason === 'cron' && !signal.aborted) {
      await sendTelegramMessage(formatCodeChefReport(report), { parseMode: 'HTML' }).catch(() => undefined);
    }
    logger.info({ reason, accounts: report.outcomes.length, performed: report.outcomes.filter((row) => row.performed).length }, 'CodeChef run finished');
    return report;
  } finally {
    runInProgress = false;
    activeRangeJob = null;
    activeRangeAbortController = null;
  }
}

export function codeChefSchedule(hour: number, minute: number): string {
  const total = (hour * 60 + minute + 10) % (24 * 60);
  return `${total % 60} ${Math.floor(total / 60)} * * *`;
}

export function isAfterCodeChefSchedule(
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

async function runAutomaticCodeChefDaily(
  isRetry: boolean,
  hour: number,
  minute: number,
  timezone: string,
): Promise<void> {
  if (runInProgress) return;
  if (isLeetCodeBusy()) {
    logger.info('LeetCode is currently running; deferring CodeChef execution to protect memory');
    return;
  }
  if (isRetry && !isAfterCodeChefSchedule(new Date(), hour, minute, timezone)) return;

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const currentHour = Number(parts.find((part) => part.type === 'hour')?.value ?? -1);
  const currentMinute = Number(parts.find((part) => part.type === 'minute')?.value ?? -1);
  const currentTotal = currentHour * 60 + currentMinute;
  const scheduledTotal = hour * 60 + minute;

  // Between 8:15 and 8:50 AM (must finish well before LeetCode at 09:00 AM)
  if (isRetry && currentTotal > scheduledTotal + 35) return;

  const today = todayInTimezone();
  const accounts = await listCodeChefAccounts(true).catch(() => []);
  const pending = accounts.filter((a) => a.lastSubmissionDate !== today);
  if (pending.length === 0) return;

  logger.info(
    { date: today, retry: isRetry, accounts: pending.length, scheduled: `${hour}:${String(minute).padStart(2, '0')}` },
    'automatic CodeChef daily run starting',
  );

  await runCodeChefNow('cron', { forceDailyAttempt: false });
}

export function startCodeChefScheduler(): () => void {
  const timezone = config.schedule.timezone;
  const requestedHour = Number(process.env.CODECHEF_RUN_HOUR ?? 8);
  const requestedMinute = Number(process.env.CODECHEF_RUN_MINUTE ?? 15);
  const hour = Number.isInteger(requestedHour) && requestedHour >= 0 && requestedHour <= 23
    ? requestedHour
    : 8;
  const minute = Number.isInteger(requestedMinute) && requestedMinute >= 0 && requestedMinute <= 59
    ? requestedMinute
    : 15;

  const expression = `${minute} ${hour} * * *`;
  const task = cron.schedule(
    expression,
    () => {
      logger.info({ hour, minute }, 'Starting CodeChef daily scheduled run...');
      void runAutomaticCodeChefDaily(false, hour, minute, timezone);
    },
    { timezone },
  );

  const retryTask = cron.schedule(
    '*/5 * * * *',
    () => {
      void runAutomaticCodeChefDaily(true, hour, minute, timezone);
    },
    { timezone },
  );

  logger.info({ timezone, expression, retryExpression: '*/5 * * * *' }, 'CodeChef scheduler armed');
  return () => {
    task.stop();
    retryTask.stop();
  };
}
