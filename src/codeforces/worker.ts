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
import { loadRuntimeSourceIndex, fetchSourceCode, SourceIndexEntry } from './sourceRepo';
import { shouldReleaseDailyAttempt } from './dailyGate';
import { fetchSolvedProblemKeys } from './api';
import { firstUnsolvedIndex, HANDOFF_VERDICT } from './handoff';
import type { HttpSubmitResult } from './httpSubmit';
import { captureBefore, pollForVerdict, postSubmitForm, type BrowserPostOutcome } from './submission';
import { isRemoteSubmitterConfigured, submitViaRemoteSubmitter } from './remoteSubmitter';
import { shouldRetryWithOriginal, stripCppComments } from './codeSanitizer';
import { launchFirefoxWithStorageStateObject } from '../browser/playwright';
import { logMemory, memoryReading, MemoryWatch, releaseHeap } from '../memory';
import {
  buildCodeforcesReport,
  CodeforcesAccountOutcome,
  CodeforcesRunReport,
  formatCodeforcesReport,
} from './report';

const CODEFORCES_LAST_REPORT_KEY = 'codeforcesLastReport';
let runInProgress = false;

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
    const source = await loadRuntimeSourceIndex();
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
  source: Awaited<ReturnType<typeof loadRuntimeSourceIndex>>,
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
    const originalCode = await fetchSourceCode(entry);
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

      let attemptUsername = attempt.handle ?? handle;
      if (!attempt.ok && attempt.kind === 'blocked') {
        const viaBrowser = await submitViaBrowser(
          stored.state,
          label,
          attemptUsername,
          entry,
          submissionCode,
        );
        if (viaBrowser) {
          attempt = viaBrowser;
          attemptUsername = viaBrowser.handle ?? attemptUsername;
        }
      }
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
    } viaBrowser;
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
): Promise<(HttpSubmitResult & { handle?: string }) | null> {
  const user = handle ?? label;

  // All API work happens before any browser exists, local or remote.
  let before: Set<number>;
  try {
    before = await captureBefore(user, entry);
  } catch (err) {
    return {
      ok: false,
      kind: 'error',
      error: `could not snapshot Codeforces submissions before submitting: ${err instanceof Error ? err.message : String(err)}`,
      handle: user,
    };
  }

  const posted = isRemoteSubmitterConfigured()
    ? await submitViaRemoteSubmitter(state, label, user, entry, code)
    : await postViaLocalBrowser(state, label, entry, code);

  if (!posted) {
    return {
      ok: false,
      kind: 'error',
      error: 'no Codeforces browser transport is available (neither an isolated submitter URL nor a launchable local Firefox)',
      handle: user,
    };
  }

  if (!posted.ok) {
    return {
      ok: false,
      kind: posted.kind === 'submission-error' ? 'rejected' : (posted.kind ?? 'error'),
      error: `${posted.error ?? 'Codeforces rejected the submission form'} (${posted.transport})`,
      handle: user,
    } as HttpSubmitResult & { handle?: string };
  }

  const submission = await pollForVerdict(user, entry, before, posted.submittedAt).catch(() => null);
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
): Promise<LocalPostOutcome | null> {
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

  const session = await launchFirefoxWithStorageStateObject(state, label);
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
  return { ...posted, submittedAt, transport: 'Firefox transport' };
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
  // Staggered away from the LeetCode run by default (09:15 vs 09:00) so the two
  // never contend for the same 512MB container.
  const fallback = config.schedule;
  const requestedHour = Number(process.env.CODEFORCES_RUN_HOUR ?? fallback.hour);
  const requestedMinute = Number(process.env.CODEFORCES_RUN_MINUTE ?? fallback.minute);
  const hour = Number.isInteger(requestedHour) && requestedHour >= 0 && requestedHour <= 23
    ? requestedHour
    : fallback.hour;
  const minute = Number.isInteger(requestedMinute) && requestedMinute >= 0 && requestedMinute <= 59
    ? requestedMinute
    : fallback.minute;
  const timezone = fallback.timezone;
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
