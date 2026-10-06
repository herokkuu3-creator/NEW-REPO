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
import { loadCodeChefSourceIndex, fetchSourceCode, type CodeChefSourceEntry } from './sourceRepo';
import { loginToCodeChef } from './auth';
import { submitDirectlyViaCodeChefApi, submitToCodeChef, type CodeChefSubmitResult } from './api';
import { type CodeChefState } from './browser';

let runInProgress = false;
export function isCodeChefRunInProgress(): boolean { return runInProgress; }

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
  phase: 'checking' | 'logging-in' | 'session-ready' | 'loading-source' | 'opening-submit' | 'submitting' | 'judging' | 'completed' | 'failed' | 'skipped';
  label: string;
  username?: string | null;
  problemCode?: string | null;
  index: number;
  total: number;
  verdict?: string | null;
  submissionId?: string | null;
  error?: string | null;
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
  try {
    const report: CodeChefReport = { date: todayInTimezone(), outcomes: [] };
    await ensureCodeChefAccountsSeeded();
    const accounts = await listCodeChefAccounts(true);
    const queue = accounts.length ? await loadCodeChefSourceIndex() : [];
    const batchCount = Math.max(1, options.batchCount ?? 1);
    const forceAttempt = options.forceDailyAttempt ?? (reason === 'manual');

    for (const [accIndex, account] of accounts.entries()) {
      if (isLeetCodeBusy()) {
        const row: CodeChefOutcome = { label: account.label, performed: false, skipped: true, error: 'LeetCode is running; CodeChef was deferred to avoid competing for memory' };
        report.outcomes.push(row);
        await options.onProgress?.({ phase: 'skipped', label: account.label, username: account.username, index: accIndex + 1, total: accounts.length, error: row.error });
        continue;
      }

      await options.onProgress?.({ phase: 'checking', label: account.label, username: account.username, index: accIndex + 1, total: accounts.length });

      let currentProgress = await getCodeChefProgress(account.id);
      let index = nextCodeChefSource(queue, currentProgress);
      let entry = queue[index];

      if (!entry) {
        const row: CodeChefOutcome = { label: account.label, performed: false, skipped: true, error: 'Source queue exhausted' };
        report.outcomes.push(row);
        await options.onProgress?.({ phase: 'skipped', label: account.label, username: account.username, index: accIndex + 1, total: accounts.length, error: row.error });
        continue;
      }

      let claimed = await claimDailyAttempt(account.id, report.date, entry.problemCode!, forceAttempt);
      if (!claimed) {
        logger.info({ account: account.label, problem: entry.problemCode }, 'Today’s CodeChef attempt is already claimed');
        const row: CodeChefOutcome = { label: account.label, performed: false, skipped: true, problem: entry.problemCode, error: 'Today’s CodeChef attempt is already completed or awaiting confirmation' };
        report.outcomes.push(row);
        await options.onProgress?.({ phase: 'skipped', label: account.label, username: account.username, problemCode: entry.problemCode, index: accIndex + 1, total: accounts.length, error: row.error });
        continue;
      }

      let mayHaveSubmitted = false;
      const credentials = JSON.parse(account.storageState) as Partial<CodeChefState> & { username?: string; password?: string };
      let state: CodeChefState | undefined = credentials.cookies?.length ? { cookies: credentials.cookies, origins: [] } : undefined;

      const login = async (): Promise<void> => {
        await options.onProgress?.({ phase: 'logging-in', label: account.label, username: account.username, index: accIndex + 1, total: accounts.length });
        logger.info({ account: account.label }, 'Authenticating account on CodeChef...');
        const updated = await loginToCodeChef(credentials.username ?? account.username ?? account.label, credentials.password ?? '');
        state = { cookies: updated.cookies, origins: [] };
        await patchCodeChefAccount(account.id, { storageState: JSON.stringify({ username: credentials.username, password: credentials.password, ...updated }), checked: true });
        logger.info({ account: account.label }, 'CodeChef account session saved to DB');
        await options.onProgress?.({ phase: 'session-ready', label: account.label, username: account.username, index: accIndex + 1, total: accounts.length });
      };

      try {
        if (!state) await login();

        for (let step = 0; step < batchCount; step++) {
          if (step > 0) {
            currentProgress = await getCodeChefProgress(account.id);
            index = nextCodeChefSource(queue, currentProgress);
            entry = queue[index];
            if (!entry) break;
            claimed = await claimDailyAttempt(account.id, report.date, entry.problemCode!, true);
            mayHaveSubmitted = false;
          }
          if (!entry) break;

          const row: CodeChefOutcome = { label: account.label, performed: false, problem: entry.problemCode };
          logger.info({ account: account.label, problem: entry.problemCode, step: step + 1, batchCount, index, total: queue.length }, 'Starting CodeChef attempt');

          const progressIndex = accounts.length > 1 && batchCount === 1 ? accIndex + 1 : (accounts.length > 1 ? accIndex * batchCount + step + 1 : step + 1);
          const progressTotal = accounts.length > 1 && batchCount === 1 ? accounts.length : (accounts.length > 1 ? accounts.length * batchCount : batchCount);

          await options.onProgress?.({ phase: 'loading-source', label: account.label, username: account.username, problemCode: entry.problemCode, index: progressIndex, total: progressTotal });
          const code = await fetchSourceCode(entry);

          await options.onProgress?.({ phase: 'opening-submit', label: account.label, username: account.username, problemCode: entry.problemCode, index: progressIndex, total: progressTotal });
          await options.onProgress?.({ phase: 'submitting', label: account.label, username: account.username, problemCode: entry.problemCode, index: progressIndex, total: progressTotal });

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

          // 3. Fallback to browser submit flow if API submit could not proceed
          if (!posted || (!posted.performed && !posted.clicked && posted.kind === 'error')) {
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
              });
            } else {
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
              });
            }

            report.outcomes.push(row);
            await options.onAccountOutcome?.(row, progressIndex, progressTotal);

            if (step < batchCount - 1) {
              await new Promise((res) => setTimeout(res, 5000));
            }
          }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.warn({ accountId: account.id, error: errorMsg }, 'CodeChef account run failed');
        await patchCodeChefAccount(account.id, { lastError: errorMsg, checked: true }).catch(() => undefined);
        if (claimed && !mayHaveSubmitted) await releaseDailyAttempt(account.id, report.date).catch(() => undefined);
        report.outcomes.push({ label: account.label, performed: false, error: errorMsg, problem: entry?.problemCode });
        await options.onProgress?.({ phase: 'failed', label: account.label, username: account.username, index: accIndex + 1, total: accounts.length, error: errorMsg });
      }
    }

    if (reason === 'cron') {
      await sendTelegramMessage(formatCodeChefReport(report), { parseMode: 'HTML' }).catch(() => undefined);
    }
    logger.info({ reason, accounts: report.outcomes.length, performed: report.outcomes.filter((row) => row.performed).length }, 'CodeChef run finished');
    return report;
  } finally {
    runInProgress = false;
  }
}

export function codeChefSchedule(hour: number, minute: number): string {
  const total = (hour * 60 + minute + 10) % (24 * 60);
  return `${total % 60} ${Math.floor(total / 60)} * * *`;
}

export function startCodeChefScheduler(): () => void {
  const timezone = config.schedule.timezone;
  // Daily schedule at 08:45 and 09:15 as requested
  const morningTask = cron.schedule('45 8 * * *', () => {
    logger.info('Starting 08:45 CodeChef daily scheduled run...');
    void runCodeChefNow('cron', { forceDailyAttempt: true });
  }, { timezone });

  const postLeetCodeTask = cron.schedule('15 9 * * *', () => {
    logger.info('Starting 09:15 CodeChef daily scheduled run...');
    void runCodeChefNow('cron', { forceDailyAttempt: true });
  }, { timezone });

  logger.info({ timezone, schedules: ['45 8 * * *', '15 9 * * *'] }, 'CodeChef scheduler armed');
  return () => {
    morningTask.stop();
    postLeetCodeTask.stop();
  };
}
