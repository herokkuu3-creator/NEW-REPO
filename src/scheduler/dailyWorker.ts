import cron from 'node-cron';
import { config } from '../config';
import { logger } from '../logger';
import {
  DailyRunRecord,
  RunState,
  createRun,
  findRunByDate,
  finalizeRun,
  setSystemState,
  SystemKeys,
  updateRun,
} from '../database/models';
import { establishAuthenticatedSession } from '../browser/auth';
import { detectVerificationPage } from '../browser/cloudflareDetector';
import { captureDiagnostics, pruneDiagnostics } from '../browser/diagnostics';
import { BrowserSession } from '../browser/playwright';
import {
  DailyProblemNotFoundError,
  fetchDailyChallenge,
  fetchQuestionData,
} from '../leetcode/dailyChallenge';
import { parseProblem, ProblemParseError } from '../leetcode/parser';
import { createLLMProvider } from '../ai/provider';
import { solveProblem } from '../ai/solver';
import { fetchWalkcccSolution, signatureMatchesStarter, WalkcccError } from '../solutions/walkccc';
import { ensureLanguage, openProblemPage, setEditorCode } from '../leetcode/editor';
import { submitCurrentEditor } from '../leetcode/submission';
import { notifyRunFinished } from '../notifications/notifier';

/**
 * The daily pipeline. Every invocation ends in EXACTLY ONE terminal state,
 * persisted to PostgreSQL. Duplicate submissions are structurally
 * impossible: the unique `date` row is created before any submission work.
 */

let runInProgress = false;

export function isRunInProgress(): boolean {
  return runInProgress;
}

/** Today's date in the configured timezone — the dedupe key. */
export function todayInTimezone(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.schedule.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export interface RunTriggerResult {
  started: boolean;
  message: string;
}

export async function triggerRun(reason: string): Promise<RunTriggerResult> {
  if (runInProgress) {
    return { started: false, message: 'a run is already in progress' };
  }
  // Fire and forget — the HTTP caller / cron should not block on the full run.
  void executeDailyRun(reason).catch((err) =>
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'unhandled run error'),
  );
  return { started: true, message: `run triggered (${reason})` };
}

export async function executeDailyRun(reason: string): Promise<RunState> {
  if (runInProgress) {
    logger.warn({ reason }, 'run skipped — already in progress');
    return RunState.PENDING;
  }
  runInProgress = true;

  let session: BrowserSession | null = null;
  let run: DailyRunRecord | null = null;

  try {
    pruneDiagnostics();
    const today = todayInTimezone();
    logger.info({ today, reason, timezone: config.schedule.timezone }, 'daily run starting');

    // --- 0) Duplicate guard -------------------------------------------------
    const existing = await findRunByDate(today);
    if (existing && (existing.state === RunState.SUCCESS || existing.state === RunState.PENDING)) {
      logger.info({ today, state: existing.state }, 'today already handled — skipping');
      return existing.state;
    }

    // --- 1) Authenticate -----------------------------------------------------
    const auth = await establishAuthenticatedSession();
    if (!auth.ok) {
      run = await upsertPlaceholderRun(today);
      await finalize(run, auth.reason, { error: humanMessage(auth.reason) });
      return auth.reason;
    }
    session = auth.session;
    const page = session.page;

    // --- 2) Locate today's daily challenge ----------------------------------
    let daily;
    try {
      daily = await fetchDailyChallenge(page);
    } catch (err) {
      if (err instanceof DailyProblemNotFoundError) {
        run = await upsertPlaceholderRun(today);
        await finalize(run, RunState.DAILY_PROBLEM_NOT_FOUND, {
          error: 'LeetCode returned no active daily challenge',
        });
        return RunState.DAILY_PROBLEM_NOT_FOUND;
      }
      throw err;
    }

    // Re-check duplication against the actual slug (belt and suspenders).
    const existingAfterFetch = await findRunByDate(today);
    if (existingAfterFetch?.state === RunState.SUCCESS) {
      logger.info({ today }, 'already completed — skipping');
      return RunState.SUCCESS;
    }

    run =
      existingAfterFetch ??
      (await createRun({
        date: today,
        problemSlug: daily.slug,
        title: daily.title,
        difficulty: daily.difficulty,
        language: config.llm.language,
      }));
    run = await updateRun(run.id, {
      problemSlug: daily.slug,
      title: daily.title,
      difficulty: daily.difficulty,
      language: config.llm.language,
      attempts: { increment: 1 },
    });

    if (await guardCloudflare(session, run)) return RunState.CLOUDFLARE_VERIFICATION_REQUIRED;

    // --- 3) Fetch + parse the problem ---------------------------------------
    let problem;
    try {
      const raw = await fetchQuestionData(page, daily.slug);
      problem = parseProblem(raw, config.llm.language);
    } catch (err) {
      if (err instanceof ProblemParseError) {
        await finalize(run, RunState.PROBLEM_PARSE_FAILED, { error: err.message });
        return RunState.PROBLEM_PARSE_FAILED;
      }
      throw err;
    }

    // --- 4) Obtain the solution (walkccc fetch by default; LLM on opt-in) ---
    let solutionCode: string;
    if (config.solution.source === 'walkccc') {
      try {
        const sol = await fetchWalkcccSolution(problem.frontendId);
        // Guard: walkccc's method name must match LeetCode's C++ starter, or
        // the submission is a guaranteed compile error.
        if (!signatureMatchesStarter(sol.code, problem)) {
          await finalize(run, RunState.SOLUTION_VALIDATION_FAILED, {
            solution: sol.code,
            error:
              'walkccc solution signature does not match the LeetCode C++ starter for this problem — flagged for review instead of submitting broken code',
          });
          return RunState.SOLUTION_VALIDATION_FAILED;
        }
        solutionCode = sol.code;
        logger.info({ sourceUrl: sol.sourceUrl }, 'solution obtained from walkccc');
      } catch (err) {
        if (err instanceof WalkcccError) {
          await finalize(run, RunState.SOLUTION_VALIDATION_FAILED, { error: err.message });
          return RunState.SOLUTION_VALIDATION_FAILED;
        }
        throw err;
      }
    } else {
      const llm = createLLMProvider();
      const solved = await solveProblem(
        llm,
        problem,
        config.llm.language,
        config.llm.maxSolutionRetries,
      );
      if (!solved.ok) {
        const state =
          solved.reason === 'LLM_ERROR' ? RunState.LLM_ERROR : RunState.SOLUTION_VALIDATION_FAILED;
        await finalize(run, state, {
          error: solved.reason === 'LLM_ERROR' ? solved.error : solved.lastReport,
          solution: solved.reason === 'SOLUTION_VALIDATION_FAILED' ? solved.lastCode : undefined,
        });
        return state;
      }
      solutionCode = solved.code;
    }

    run = await updateRun(run.id, { solution: solutionCode });

    // --- 5) Open problem page, verify slug + language, fill editor ----------
    await openProblemPage(page, daily.slug);
    if (await guardCloudflare(session, run)) return RunState.CLOUDFLARE_VERIFICATION_REQUIRED;

    const languageOk = await ensureLanguage(page, config.llm.language);
    if (!languageOk) {
      logger.warn({ language: config.llm.language }, 'could not confirm language selection');
    }
    await setEditorCode(page, solutionCode);

    // --- 6) Submit (only when AUTO_SUBMIT=true) ------------------------------
    if (!config.submission.autoSubmit) {
      logger.info('AUTO_SUBMIT=false — editor filled, not submitting');
      await finalize(run, RunState.SUCCESS, {
        submissionStatus: 'EDITOR_FILLED (AUTO_SUBMIT=false)',
      });
      return RunState.SUCCESS;
    }

    let result;
    try {
      result = await submitCurrentEditor(page, problem.frontendId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await captureDiagnostics(page, 'submission-error', session.browserLogs);
      await finalize(run, RunState.SUBMISSION_ERROR, { error: msg });
      return RunState.SUBMISSION_ERROR;
    }

    if (result.classification === 'ACCEPTED') {
      await finalize(run, RunState.SUCCESS, {
        submissionId: result.submissionId,
        submissionStatus: result.statusDisplay,
        runtime: result.runtime,
        memory: result.memory,
      });
      return RunState.SUCCESS;
    }

    // Judge ran but rejected — record exactly what happened for the operator.
    await captureDiagnostics(page, `rejected-${result.classification.toLowerCase()}`, session.browserLogs);
    await finalize(run, RunState.SUBMISSION_REJECTED, {
      submissionId: result.submissionId,
      submissionStatus: result.statusDisplay,
      runtime: result.runtime,
      memory: result.memory,
      error: `judge verdict: ${result.rawStatusMsg}`,
    });
    return RunState.SUBMISSION_REJECTED;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'daily run failed with unexpected error');
    if (session) {
      await captureDiagnostics(session.page, 'unexpected-error', session.browserLogs);
    }
    if (run) {
      await finalize(run, RunState.SUBMISSION_ERROR, { error: `unexpected: ${msg}` });
    } else {
      await setSystemState(SystemKeys.lastError, msg);
    }
    return RunState.SUBMISSION_ERROR;
  } finally {
    if (session) await session.close().catch(() => undefined);
    runInProgress = false;
  }
}

/**
 * Cloudflare guard: detection only. On any verification page, capture a
 * diagnostics bundle and finalize the run as CLOUDFLARE_VERIFICATION_REQUIRED.
 * Returns true when the run must stop.
 */
async function guardCloudflare(session: BrowserSession, run: DailyRunRecord): Promise<boolean> {
  const kind = await detectVerificationPage(session.page);
  if (!kind) return false;
  const bundle = await captureDiagnostics(session.page, `cloudflare-${kind}`, session.browserLogs);
  await finalize(run, RunState.CLOUDFLARE_VERIFICATION_REQUIRED, {
    error: `Cloudflare verification page detected (${kind}). Manual verification required.`,
  }, bundle?.screenshotPath);
  return true;
}

/** Placeholder row for runs that fail before a problem is identified. */
async function upsertPlaceholderRun(date: string): Promise<DailyRunRecord> {
  const existing = await findRunByDate(date);
  if (existing) return existing;
  return createRun({
    date,
    problemSlug: '(unknown)',
    title: '(not fetched)',
    difficulty: '-',
    language: config.llm.language,
  });
}

async function finalize(
  run: DailyRunRecord,
  state: RunState,
  extra: Parameters<typeof finalizeRun>[2],
  screenshotPath?: string | null,
): Promise<void> {
  const updated = await finalizeRun(run.id, state, extra);
  await setSystemState(SystemKeys.lastRunSummary, JSON.stringify({
    date: updated.date,
    slug: updated.problemSlug,
    state: updated.state,
    at: updated.updatedAt.toISOString(),
  }));
  if (state !== RunState.SUCCESS && updated.error) {
    await setSystemState(SystemKeys.lastError, updated.error);
  }
  await notifyRunFinished({
    state,
    title: updated.title,
    difficulty: updated.difficulty,
    language: updated.language,
    slug: updated.problemSlug,
    submissionStatus: updated.submissionStatus,
    runtime: updated.runtime,
    memory: updated.memory,
    error: updated.error,
    screenshotPath,
  });
  logger.info({ date: updated.date, state }, 'run finalized');
}

function humanMessage(reason: string): string {
  switch (reason) {
    case 'AUTHENTICATION_REQUIRED':
      return 'Stored session expired or missing. Re-run `npm run auth:setup` locally and re-upload the profile to the Render disk.';
    case 'CLOUDFLARE_VERIFICATION_REQUIRED':
      return 'LeetCode presented a verification page. Open the service, complete verification manually, and refresh the stored profile.';
    default:
      return reason;
  }
}

/** Starts the cron schedule. Returns a stop function for graceful shutdown. */
export function startScheduler(): () => void {
  const { hour, minute, timezone } = config.schedule;
  const expression = `${minute} ${hour} * * *`;
  const task = cron.schedule(
    expression,
    () => {
      void triggerRun('cron');
    },
    { timezone },
  );
  logger.info({ expression, timezone }, 'daily scheduler armed');

  if (config.schedule.runOnBoot) {
    logger.info('RUN_ON_BOOT=true — triggering an immediate run');
    void triggerRun('boot');
  }

  return () => task.stop();
}
