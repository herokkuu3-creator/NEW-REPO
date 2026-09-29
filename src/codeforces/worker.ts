import cron from 'node-cron';
import { CodeforcesAccountStatus } from '@prisma/client';
import { config } from '../config';
import { logger } from '../logger';
import { setSystemState } from '../database/models';
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
import { firstUnsolvedIndex, HANDOFF_VERDICT } from './handoff';
import { submitViaHttp, HttpSubmitResult } from './httpSubmit';
import { captureBefore, pollForVerdict, postSubmitForm } from './submission';
import { launchFirefoxWithStorageStateObject } from '../browser/playwright';
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
  const handle = account.username ?? label;
  try {
    const code = await fetchSourceCode(entry);
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

    // HTTP first — no browser, no extra memory. A POST the edge refuses (which
    // is every POST from here) falls through to a real Firefox.
    let result = await submitViaHttp(stored.state, account.username, entry, code);
    let username = result.handle ?? handle;
    if (!result.ok && result.kind === 'blocked') {
      const viaBrowser = await submitViaBrowser(stored.state, label, username, entry, code);
      if (viaBrowser) {
        result = viaBrowser;
        username = viaBrowser.handle ?? username;
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
        note,
        problem: problemLabel(entry),
        problemUrl: entry.problemUrl ?? null,
        submissionId: result.submissionId,
        verdict: result.verdict,
      };
    }

    const verdictCode = result.verdict ?? result.kind.toUpperCase().replace(/-/g, '_');
    await recordAttempt(account.id, { submissionId: result.submissionId ?? null, verdict: verdictCode });
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
      note,
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
      error: msg,
    };
  }
}

/**
 * Replays the submit in a headless Firefox and reads the verdict from the public
 * API — still fully unattended.
 *
 * Cloudflare redirects every POST to codeforces.com to "/" unless the client
 * passed its challenge, so header and field shaping can never get the HTTP
 * transport through. Firefox passes that challenge, and it also runs the page's
 * own JavaScript, which is what fills `_tta` (Codeforces.signForms), ftaa/bfaa
 * and the form action in a human's browser. Returns null when no browser could
 * be started, leaving the caller to report the HTTP failure unchanged.
 */
async function submitViaBrowser(
  state: Parameters<typeof launchFirefoxWithStorageStateObject>[0],
  label: string,
  handle: string | null,
  entry: SourceIndexEntry,
  code: string,
): Promise<(HttpSubmitResult & { handle?: string }) | null> {
  const user = handle ?? label;
  const session = await launchFirefoxWithStorageStateObject(state, label);
  if (!session) return null;

  let before: Set<number>;
  let posted: Awaited<ReturnType<typeof postSubmitForm>>;
  let submittedAt: number;
  try {
    before = await captureBefore(user, entry);
    submittedAt = Math.floor(Date.now() / 1000);
    posted = await postSubmitForm(session, entry, code);
    logger.info(
      {
        status: posted.status,
        finalUrl: posted.finalUrl,
        turnstile: posted.turnstile,
        rssMb: Math.round(process.memoryUsage().rss / 1_048_576),
      },
      'Codeforces submit posted from Firefox',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, kind: 'error', error: `Firefox transport failed: ${message}`, handle: user };
  } finally {
    // Free the browser before polling: on the 512MB instance, polling with the
    // browser still open was what killed the service mid-submission.
    await session.close().catch(() => undefined);
  }

  if (!posted.ok) {
    return {
      ok: false,
      kind: posted.kind === 'submission-error' ? 'rejected' : (posted.kind ?? 'error'),
      error: `${posted.error} (Firefox transport)`,
      handle: user,
    } as HttpSubmitResult & { handle?: string };
  }

  const submission = await pollForVerdict(user, entry, before, submittedAt).catch(() => null);
  if (!submission) {
    return {
      ok: false,
      kind: 'judge-timeout',
      error: `the Firefox transport posted the form (HTTP ${posted.status ?? '?'} → ${posted.finalUrl}) but no new submission appeared in the API`,
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
