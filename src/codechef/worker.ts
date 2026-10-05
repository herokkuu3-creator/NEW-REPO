import cron from 'node-cron';
import { CodeChefAccountStatus } from '@prisma/client';
import { logger } from '../logger';
import { config } from '../config';
import { isRunInProgress as isLeetCodeBusy } from '../scheduler/dailyWorker';
import { sendTelegramMessage } from '../notifications/telegram';
import { listCodeChefAccounts, ensureCodeChefAccountsSeeded, patchCodeChefAccount,
  getCodeChefProgress, completeCurrentProblem, claimDailyAttempt, releaseDailyAttempt, recordAttempt } from './storage';
import { loadCodeChefSourceIndex, fetchSourceCode, type CodeChefSourceEntry } from './sourceRepo';
import { loginOnCodeChefPage } from './auth';
import { submitOnCodeChefPage } from './api';
import { withCodeChefPage, type CodeChefState } from './browser';

let runInProgress = false;
export function isCodeChefRunInProgress(): boolean { return runInProgress; }

export interface CodeChefOutcome { label: string; problem?: string; verdict?: string; submissionId?: string; error?: string; performed: boolean; skipped?: boolean }
export interface CodeChefReport { date: string; outcomes: CodeChefOutcome[] }

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

export function formatCodeChefReport(report: CodeChefReport): string {
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = report.outcomes.map(row => `${row.skipped ? '⏭️' : row.verdict === 'Accepted' ? '✅' : '❌'} <b>${escape(row.label)}</b>${row.problem ? ` · ${escape(row.problem)}` : ''} — ${escape(row.error ?? row.verdict ?? 'No result')}${row.submissionId ? ` · #${escape(row.submissionId)}` : ''}`);
  return [`<b>👨‍🍳 CODECHEF SUBMISSION</b>`, `<i>${report.date}</i>`, '', ...(lines.length ? lines : ['No active CodeChef accounts configured. Add CODECHEF_1=username::password in Render.'])].join('\n');
}

export async function runCodeChefNow(reason: 'manual' | 'cron' = 'manual'): Promise<CodeChefReport | null> {
  if (runInProgress) return null;
  runInProgress = true;
  try {
    const report: CodeChefReport = { date: todayInTimezone(), outcomes: [] };
    await ensureCodeChefAccountsSeeded();
    const accounts = await listCodeChefAccounts(true);
    const queue = accounts.length ? await loadCodeChefSourceIndex() : [];
    for (const account of accounts) {
      let claimed = false;
      let mayHaveSubmitted = false;
      const row: CodeChefOutcome = { label: account.label, performed: false };
      try {
        if (isLeetCodeBusy()) { row.skipped = true; row.error = 'LeetCode is running; CodeChef was deferred to avoid competing for memory'; continue; }
        const progress = await getCodeChefProgress(account.id);
        const index = nextCodeChefSource(queue, progress);
        const entry = queue[index];
        if (!entry) { row.skipped = true; row.error = 'Source queue exhausted'; continue; }
        row.problem = entry.problemCode;
        claimed = await claimDailyAttempt(account.id, report.date, entry.problemCode!);
        if (!claimed) { row.skipped = true; row.error = 'Today’s CodeChef attempt is already completed or awaiting confirmation'; continue; }
        const credentials = JSON.parse(account.storageState) as Partial<CodeChefState> & { username?: string; password?: string };
        const state: CodeChefState | undefined = credentials.cookies?.length ? { cookies: credentials.cookies, origins: credentials.origins ?? [] } : undefined;
        const code = await fetchSourceCode(entry);
        const result = await withCodeChefPage(state, async page => {
          const login = async () => {
            const updated = await loginOnCodeChefPage(page, credentials.username ?? account.username ?? account.label, credentials.password ?? '');
            await patchCodeChefAccount(account.id, { storageState: JSON.stringify({ username: credentials.username, password: credentials.password, ...updated }), checked: true });
          };
          if (!state) await login();
          mayHaveSubmitted = true;
          let posted = await submitOnCodeChefPage(page, entry.problemUrl!, code, entry.language);
          mayHaveSubmitted = posted.clicked === true;
          // A signed-out redirect before any click is safe to reauthenticate.
          if (posted.kind === 'signed-out' && !posted.clicked) {
            await login();
            mayHaveSubmitted = true;
            posted = await submitOnCodeChefPage(page, entry.problemUrl!, code, entry.language);
            mayHaveSubmitted = posted.clicked === true;
          }
          return posted;
        });
        row.submissionId = result.submissionId;
        row.verdict = result.verdict;
        row.error = result.error;
        row.performed = result.performed === true && !!result.submissionId;
        if (row.performed) {
          await completeCurrentProblem(account.id, { completedKey: entry.problemCode!, nextKey: queue[index + 1]?.problemCode ?? null,
            submissionId: result.submissionId!, verdict: result.verdict ?? null });
          await patchCodeChefAccount(account.id, { status: CodeChefAccountStatus.ACTIVE, lastSubmissionDate: report.date,
            lastSubmissionId: result.submissionId, lastVerdict: result.verdict, lastError: null, checked: true });
        } else {
          await recordAttempt(account.id, { submissionId: result.submissionId ?? null, verdict: result.verdict ?? null });
          await patchCodeChefAccount(account.id, { lastError: result.error ?? 'No confirmed CodeChef result', checked: true });
          if (!mayHaveSubmitted) await releaseDailyAttempt(account.id, report.date);
        }
      } catch (err) {
        row.error = err instanceof Error ? err.message : String(err);
        logger.warn({ accountId: account.id, error: row.error }, 'CodeChef account run failed');
        await patchCodeChefAccount(account.id, { lastError: row.error, checked: true }).catch(() => undefined);
        if (claimed && !mayHaveSubmitted) await releaseDailyAttempt(account.id, report.date).catch(() => undefined);
      } finally { report.outcomes.push(row); }
    }
    await sendTelegramMessage(formatCodeChefReport(report), { parseMode: 'HTML' });
    logger.info({ reason, accounts: report.outcomes.length, performed: report.outcomes.filter(row => row.performed).length }, 'CodeChef run finished');
    return report;
  } finally { runInProgress = false; }
}

export function codeChefSchedule(hour: number, minute: number): string {
  const total = (hour * 60 + minute + 10) % (24 * 60);
  return `${total % 60} ${Math.floor(total / 60)} * * *`;
}

export function startCodeChefScheduler(): () => void {
  const expression = codeChefSchedule(config.schedule.hour, config.schedule.minute);
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const run = async (attempt = 0): Promise<void> => {
    if (stopped) return;
    try {
      const report = await runCodeChefNow('cron');
      const deferred = report?.outcomes.some(row => /^LeetCode is running|^Not enough free memory/.test(row.error ?? ''));
      if (!stopped && (report === null || deferred) && attempt < 10) {
        retryTimer = setTimeout(() => { void run(attempt + 1); }, 5 * 60000);
        retryTimer.unref?.();
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ error }, 'CodeChef scheduled run failed');
      await sendTelegramMessage(`CodeChef daily run could not start: ${error}`);
    }
  };
  const task = cron.schedule(expression, () => {
    if (retryTimer) clearTimeout(retryTimer);
    void run();
  }, { timezone: config.schedule.timezone });
  logger.info({ expression, timezone: config.schedule.timezone }, 'CodeChef scheduler armed');
  return () => { stopped = true; if (retryTimer) clearTimeout(retryTimer); task.stop(); };
}
