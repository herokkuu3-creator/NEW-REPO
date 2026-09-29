import cron from 'node-cron';
import { CodeforcesAccountStatus } from '@prisma/client';
import { config } from '../config';
import { logger } from '../logger';
import { setSystemState } from '../database/models';
import { launchWithStorageStateObject } from '../browser/playwright';
import { todayInTimezone } from '../scheduler/dailyWorker';
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
import { loadSourceIndex, fetchSourceCode, SourceIndexEntry } from './sourceRepo';
import { shouldReleaseDailyAttempt } from './dailyGate';
import { fetchSolvedProblemKeys } from './api';
import { firstUnsolvedIndex, HANDOFF_VERDICT, sendHandoff } from './handoff';

/** After Cloudflare blocks the server once, skip the doomed browser attempt for a while. */
const BLOCK_BACKOFF_MS = 6 * 60 * 60 * 1000;
let blockedUntil = 0;
import { inspectCodeforcesSessionPage } from './session';
import { submitAndVerify } from './submission';
import {
  buildCodeforcesReport,
  CodeforcesAccountOutcome,
  CodeforcesRunReport,
  formatCodeforcesReport,
} from './report';

const CODEFORCES_LAST_REPORT_KEY = 'codeforcesLastReport';
let runInProgress = false;

export function isCodeforcesRunInProgress(): boolean {
  return runInProgress;
}

export interface CodeforcesRunOptions {
  onAccountOutcome?: (outcome: CodeforcesAccountOutcome, index: number, total: number) => Promise<void> | void;
  /** Manual triggers may reuse a day's single attempt after it failed. */
  forceDailyAttempt?: boolean;
}

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
  const startedAt = new Date().toISOString();
  const today = todayInTimezone();
  const forceDailyAttempt =
    options.forceDailyAttempt ?? reason === CODEFORCES_MANUAL_REASON;

  try {
    const source = await loadSourceIndex();
    const accounts = await listCodeforcesAccounts(false);
    const outcomes: CodeforcesAccountOutcome[] = [];

    if (accounts.length === 0) {
      const report = buildCodeforcesReport({ date: today, reason, startedAt, outcomes });
      await setSystemState(CODEFORCES_LAST_REPORT_KEY, JSON.stringify(report));
      return report;
    }

    for (const account of accounts) {
      const outcome = await runForAccount(account, today, source, forceDailyAttempt);
      outcomes.push(outcome);
      if (options.onAccountOutcome) {
        await Promise.resolve(options.onAccountOutcome(outcome, outcomes.length, accounts.length)).catch((err) =>
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Codeforces outcome callback failed'),
        );
      }
    }

    const report = buildCodeforcesReport({ date: today, reason, startedAt, outcomes });
    await setSystemState(CODEFORCES_LAST_REPORT_KEY, JSON.stringify(report));
    logger.info({ summary: formatCodeforcesReport(report) }, 'Codeforces daily run finished');
    return report;
  } finally {
    runInProgress = false;
  }
}

async function runForAccount(
  account: Awaited<ReturnType<typeof listCodeforcesAccounts>>[number],
  today: string,
  source: Awaited<ReturnType<typeof loadSourceIndex>>,
  forceDailyAttempt = false,
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
  const handoff = async (reason: string, handle: string): Promise<CodeforcesAccountOutcome> => {
    const code = await fetchSourceCode(entry);
    const sent = await sendHandoff(entry, handle, code);
    await claimDailyAttempt(account.id, today, entry.key).catch(() => false);
    await recordAttempt(account.id, { submissionId: null, verdict: sent ? HANDOFF_VERDICT : 'BLOCKED' });
    await patchCodeforcesAccount(account.id, {
      status: CodeforcesAccountStatus.ACTIVE,
      lastError: reason,
      checked: true,
      lastSubmissionDate: today,
      lastVerdict: sent ? HANDOFF_VERDICT : 'BLOCKED',
    });
    logger.info({ label, problem: problemLabel(entry), sent, reason }, 'Codeforces solution handed off to the user');
    return {
      label,
      username: handle,
      kind: sent ? 'pending' : 'failed',
      problem: problemLabel(entry),
      problemUrl: entry.problemUrl ?? null,
      note,
      error: sent ? null : `${reason}; sending the solution file over Telegram also failed`,
    };
  };

  if (Date.now() < blockedUntil) {
    return handoff('Cloudflare blocked the server recently', account.username ?? label);
  }

  const session = await launchWithStorageStateObject(stored.state, `codeforces:${label}`);
  if (!session) {
    await patchCodeforcesAccount(account.id, { status: CodeforcesAccountStatus.UNKNOWN, lastError: 'browser launch failed', checked: true });
    return { label, username: account.username, kind: 'failed', problem: problemLabel(current), error: 'browser launch failed' };
  }

  try {
    await session.page.goto('https://codeforces.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await session.page.waitForTimeout(500);
    const check = await inspectCodeforcesSessionPage(session.page);
    if (!check.ok && check.reason === 'blocked') {
      blockedUntil = Date.now() + BLOCK_BACKOFF_MS;
      return await handoff(check.error, account.username ?? label);
    }
    if (!check.ok) {
      const status = check.reason === 'signed-out' ? CodeforcesAccountStatus.REJECTED : CodeforcesAccountStatus.UNKNOWN;
      await patchCodeforcesAccount(account.id, {
        status,
        username: account.username,
        lastError: check.error,
        checked: true,
      });
      return {
        label,
        username: account.username,
        kind: check.reason === 'signed-out' ? 'rejected' : 'failed',
        problem: problemLabel(current),
        error: check.error,
      };
    }

    const username = check.username;
    await patchCodeforcesAccount(account.id, {
      username,
      status: CodeforcesAccountStatus.ACTIVE,
      lastError: null,
      checked: true,
    });

    const code = await fetchSourceCode(current);
    const retryToday = shouldReleaseDailyAttempt({
      manual: forceDailyAttempt,
      lastAttemptDate: progress.lastAttemptDate ?? null,
      lastVerdict: progress.lastVerdict ?? null,
      today,
    });
    if (retryToday) {
      await releaseDailyAttempt(account.id, today);
    }
    const claimed = await claimDailyAttempt(account.id, today, current.key);
    if (!claimed) {
      const latest = await getCodeforcesProgress(account.id);
      return {
        label,
        username,
        kind: 'skipped',
        problem: problemLabel(current),
        problemUrl: current.problemUrl ?? null,
        verdict: latest.lastVerdict,
        submissionId: latest.lastSubmissionId,
        error: `already attempted ${today}; one Codeforces attempt per account per day is enforced`,
      };
    }

    const result = await submitAndVerify(session, username, current, code);
    if (!result.ok && result.kind === 'blocked') {
      blockedUntil = Date.now() + BLOCK_BACKOFF_MS;
      return await handoff(result.error, username);
    }
    if (result.ok) {
      const index = source.queue.findIndex((entry) => entry.key === current.key);
      const nextKey = source.queue[index + 1]?.key ?? null;
      await recordAttempt(account.id, { submissionId: result.submissionId, verdict: result.verdict });
      await completeCurrentProblem(account.id, {
        completedKey: current.key,
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
        note,
        problem: problemLabel(current),
        problemUrl: current.problemUrl ?? null,
        submissionId: result.submissionId,
        verdict: result.verdict,
      };
    }

    await recordAttempt(account.id, {
      submissionId: result.submissionId ?? null,
      verdict: result.verdict ?? (result.kind === 'blocked' ? 'BLOCKED' : 'SUBMISSION_ERROR'),
    });
    await patchCodeforcesAccount(account.id, {
      status: result.kind === 'blocked' ? CodeforcesAccountStatus.UNKNOWN : CodeforcesAccountStatus.ACTIVE,
      username,
      lastError: result.error,
      checked: true,
      lastSubmissionDate: today,
      lastSubmissionId: result.submissionId ?? null,
      lastVerdict: result.verdict ?? result.kind.toUpperCase(),
    });

    return {
      label,
      username,
      kind: 'failed',
      problem: problemLabel(current),
      problemUrl: current.problemUrl ?? null,
      submissionId: result.submissionId ?? null,
      verdict: result.verdict ?? null,
      error: result.error,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await patchCodeforcesAccount(account.id, {
      status: CodeforcesAccountStatus.UNKNOWN,
      username: account.username,
      lastError: msg,
      checked: true,
      lastSubmissionDate: today,
      lastVerdict: 'SUBMISSION_ERROR',
    }).catch(() => undefined);
    return {
      label,
      username: account.username,
      kind: 'failed',
      problem: problemLabel(current),
      problemUrl: current.problemUrl ?? null,
      verdict: 'SUBMISSION_ERROR',
      error: msg,
    };
  } finally {
    await session.close().catch(() => undefined);
  }
}

function resolveCurrentEntry(queue: SourceIndexEntry[], nextKey: string | null, lastCompletedKey: string | null): SourceIndexEntry | null {
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

export function startCodeforcesScheduler(): () => void {
  const { hour, minute, timezone } = config.schedule;
  const expression = `${minute} ${hour} * * *`;
  const task = cron.schedule(
    expression,
    () => {
      void triggerCodeforcesRun('cron');
    },
    { timezone },
  );
  logger.info({ expression, timezone }, 'Codeforces scheduler armed');
  // Deliberately no RUN_ON_BOOT hook: existing LeetCode boot behavior stays unchanged,
  // and Codeforces submissions happen on the configured daily cron or manual command.
  return () => task.stop();
}
