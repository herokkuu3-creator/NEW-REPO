import cron from 'node-cron';
import { config } from '../config';
import { logger } from '../logger';
import {
  DailyRunRecord,
  RunState,
  createRun,
  findRunByDate,
  finalizeRun,
  getSystemState,
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
import { LeetCodeApi, looksLikeChallenge } from '../leetcode/apiClient';
import { parseProblem, ProblemParseError } from '../leetcode/parser';
import { createLLMProvider } from '../ai/provider';
import { solveProblem } from '../ai/solver';
import { fetchWalkcccSolution, signatureMatchesStarter, WalkcccError } from '../solutions/walkccc';
import { ensureLanguage, openProblemPage, setEditorCode } from '../leetcode/editor';
import { submitCurrentEditor } from '../leetcode/submission';
import { notifyRunFinished, notifySessionExpired } from '../notifications/notifier';

/**
 * The daily pipeline. Every invocation ends in EXACTLY ONE terminal state,
 * persisted to PostgreSQL. Duplicate submissions are structurally
 * impossible: the unique `date` row is created before any submission work.
 *
 * Two transports:
 *   TRANSPORT=api (default) — every LeetCode interaction goes through its
 *     GraphQL + submit endpoints. No HTML page is ever loaded, which is what
 *     keeps the run clear of Cloudflare's page-level interstitial.
 *   TRANSPORT=browser — navigate the UI with Playwright (fills the editor).
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
  const forceRun = reason === 'admin-api';
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
    logger.info(
      { today, reason, timezone: config.schedule.timezone, transport: config.transport },
      'daily run starting',
    );

    // --- 0) Duplicate guard -------------------------------------------------
    const existing = await findRunByDate(today);
    if (!forceRun && existing && (existing.state === RunState.SUCCESS || existing.state === RunState.PENDING)) {
      logger.info({ today, state: existing.state }, 'today already handled — skipping');
      return existing.state;
    }

    // --- 1) Authenticate (API-only session check, no page navigation) --------
    const auth = await establishAuthenticatedSession();
    if (!auth.ok) {
      run = await upsertPlaceholderRun(today);
      await finalize(run, auth.reason, { error: humanMessage(auth.reason) });
      if (auth.reason === 'AUTHENTICATION_REQUIRED') {
        await maybeNotifySessionExpired(today);
      }
      return auth.reason;
    }
    session = auth.session;
    const api = auth.api;

    // --- 2) Locate today's daily challenge ----------------------------------
    let daily;
    try {
      daily = await fetchDailyChallenge(api);
    } catch (err) {
      if (err instanceof DailyProblemNotFoundError) {
        run = await upsertPlaceholderRun(today);
        await finalize(run, RunState.DAILY_PROBLEM_NOT_FOUND, {
          error: 'LeetCode returned no active daily challenge',
        });
        return RunState.DAILY_PROBLEM_NOT_FOUND;
      }
      if (looksLikeChallenge(err)) {
        run = await upsertPlaceholderRun(today);
        await finalize(run, RunState.CLOUDFLARE_VERIFICATION_REQUIRED, {
          error: `LeetCode blocked the API request: ${err instanceof Error ? err.message : String(err)}`,
        });
        return RunState.CLOUDFLARE_VERIFICATION_REQUIRED;
      }
      throw err;
    }

    // Re-check duplication against the actual slug (belt and suspenders).
    const existingAfterFetch = await findRunByDate(today);
    if (!forceRun && existingAfterFetch?.state === RunState.SUCCESS) {
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

    // --- 3) Fetch + parse the problem ---------------------------------------
    let problem;
    try {
      const raw = await fetchQuestionData(api, daily.slug);
      problem = parseProblem(raw, config.llm.language);
    } catch (err) {
      if (err instanceof ProblemParseError) {
        await finalize(run, RunState.PROBLEM_PARSE_FAILED, { error: err.message });
        return RunState.PROBLEM_PARSE_FAILED;
      }
      if (looksLikeChallenge(err)) {
        await finalize(run, RunState.CLOUDFLARE_VERIFICATION_REQUIRED, {
          error: `LeetCode blocked the problem request: ${err instanceof Error ? err.message : String(err)}`,
        });
        return RunState.CLOUDFLARE_VERIFICATION_REQUIRED;
      }
      throw err;
    }

    // --- 4) Obtain the solution (walkccc fetch by default; LLM on opt-in) ---
    const solution = await obtainSolution(problem, run);
    if (!solution.ok) return solution.state;
    const solutionCode = solution.code;

    run = await updateRun(run.id, { solution: solutionCode });

    // --- 5) Apply the solution ----------------------------------------------
    if (config.transport === 'api') {
      return await submitViaApi(api, problem, solutionCode, run);
    }

    return await submitViaBrowser(session, problem, solutionCode, run);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'daily run failed with unexpected error');
    if (session && config.transport === 'browser') {
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

// ---------------------------------------------------------------------------
// Solution acquisition
// ---------------------------------------------------------------------------

type SolutionResult =
  | { ok: true; code: string }
  | { ok: false; state: RunState };

async function obtainSolution(
  problem: ReturnType<typeof parseProblem>,
  run: DailyRunRecord,
): Promise<SolutionResult> {
  if (config.solution.source === 'walkccc') {
    try {
      const sol = await fetchWalkcccSolution(problem.frontendId);
      // Guard: walkccc's method name must match LeetCode's C++ starter, or the
      // submission is a guaranteed compile error.
      if (!signatureMatchesStarter(sol.code, problem)) {
        await finalize(run, RunState.SOLUTION_VALIDATION_FAILED, {
          solution: sol.code,
          error:
            'walkccc solution signature does not match the LeetCode C++ starter for this problem — flagged for review instead of submitting broken code',
        });
        return { ok: false, state: RunState.SOLUTION_VALIDATION_FAILED };
      }
      logger.info({ sourceUrl: sol.sourceUrl }, 'solution obtained from walkccc');
      return { ok: true, code: sol.code };
    } catch (err) {
      if (err instanceof WalkcccError) {
        await finalize(run, RunState.SOLUTION_VALIDATION_FAILED, { error: err.message });
        return { ok: false, state: RunState.SOLUTION_VALIDATION_FAILED };
      }
      throw err;
    }
  }

  const llm = createLLMProvider();
  const solved = await solveProblem(
    llm,
    problem,
    config.llm.language,
    config.llm.maxSolutionRetries,
  );
  if (solved.ok) return { ok: true, code: solved.code };

  const state =
    solved.reason === 'LLM_ERROR' ? RunState.LLM_ERROR : RunState.SOLUTION_VALIDATION_FAILED;
  await finalize(run, state, {
    error: solved.reason === 'LLM_ERROR' ? solved.error : solved.lastReport,
    solution: solved.reason === 'SOLUTION_VALIDATION_FAILED' ? solved.lastCode : undefined,
  });
  return { ok: false, state };
}

// ---------------------------------------------------------------------------
// Transport: API (default)
// ---------------------------------------------------------------------------

async function submitViaApi(
  api: LeetCodeApi,
  problem: ReturnType<typeof parseProblem>,
  code: string,
  run: DailyRunRecord,
): Promise<RunState> {
  if (!config.submission.autoSubmit) {
    // There is no editor to fill over the API — the only state-changing call is
    // a submission. Respect the safety default and stop before it.
    logger.warn(
      'TRANSPORT=api with AUTO_SUBMIT=false — the solution was produced and validated but NOT submitted (the API has no "fill editor only" step). Set AUTO_SUBMIT=true to submit.',
    );
    await finalize(run, RunState.SUCCESS, {
      submissionStatus: 'SOLVED_NOT_SUBMITTED (TRANSPORT=api, AUTO_SUBMIT=false)',
    });
    return RunState.SUCCESS;
  }

  if (!problem.questionId) {
    await finalize(run, RunState.SUBMISSION_ERROR, {
      error:
        'LeetCode did not return the internal questionId required by the submit endpoint — cannot submit',
    });
    return RunState.SUBMISSION_ERROR;
  }

  try {
    const submissionId = await api.submitSolution({
      slug: problem.slug,
      questionId: problem.questionId,
      lang: config.llm.language,
      code,
    });
    const result = await api.awaitSubmission(submissionId, problem.slug);

    if (result.classification === 'ACCEPTED') {
      await finalize(run, RunState.SUCCESS, {
        submissionId: result.submissionId,
        submissionStatus: result.statusDisplay,
        runtime: result.runtime,
        memory: result.memory,
      });
      return RunState.SUCCESS;
    }

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
    if (looksLikeChallenge(err)) {
      await finalize(run, RunState.CLOUDFLARE_VERIFICATION_REQUIRED, {
        error: `LeetCode blocked the submission request: ${msg}`,
      });
      return RunState.CLOUDFLARE_VERIFICATION_REQUIRED;
    }
    await finalize(run, RunState.SUBMISSION_ERROR, { error: msg });
    return RunState.SUBMISSION_ERROR;
  }
}

// ---------------------------------------------------------------------------
// Transport: browser (Playwright UI)
// ---------------------------------------------------------------------------

async function submitViaBrowser(
  session: BrowserSession,
  problem: ReturnType<typeof parseProblem>,
  code: string,
  run: DailyRunRecord,
): Promise<RunState> {
  const page = session.page;

  await openProblemPage(page, problem.slug);
  if (await guardCloudflare(session, run)) return RunState.CLOUDFLARE_VERIFICATION_REQUIRED;

  const languageOk = await ensureLanguage(page, config.llm.language);
  if (!languageOk) {
    logger.warn({ language: config.llm.language }, 'could not confirm language selection');
  }
  await setEditorCode(page, code);

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

  await captureDiagnostics(page, `rejected-${result.classification.toLowerCase()}`, session.browserLogs);
  await finalize(run, RunState.SUBMISSION_REJECTED, {
    submissionId: result.submissionId,
    submissionStatus: result.statusDisplay,
    runtime: result.runtime,
    memory: result.memory,
    error: `judge verdict: ${result.rawStatusMsg}`,
  });
  return RunState.SUBMISSION_REJECTED;
}

/**
 * Cloudflare guard for the browser transport: detection only. On any
 * verification page, capture a diagnostics bundle and stop the run.
 */
async function guardCloudflare(session: BrowserSession, run: DailyRunRecord): Promise<boolean> {
  const kind = await detectVerificationPage(session.page);
  if (!kind) return false;
  const bundle = await captureDiagnostics(session.page, `cloudflare-${kind}`, session.browserLogs);
  await finalize(
    run,
    RunState.CLOUDFLARE_VERIFICATION_REQUIRED,
    { error: `Cloudflare verification page detected (${kind}). Manual verification required.` },
    bundle?.screenshotPath,
  );
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
  await setSystemState(
    SystemKeys.lastRunSummary,
    JSON.stringify({
      date: updated.date,
      slug: updated.problemSlug,
      state: updated.state,
      at: updated.updatedAt.toISOString(),
    }),
  );
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

/**
 * Session-expired alert, deduped to at most one Telegram message per day —
 * repeated /admin/run-now pokes must not spam the chat. The flag is cleared
 * whenever a session authenticates successfully (auth.ts) or is renewed.
 */
async function maybeNotifySessionExpired(today: string): Promise<void> {
  try {
    const lastNotified = await getSystemState(SystemKeys.authNotifiedAt);
    if (lastNotified === today) return;
    await setSystemState(SystemKeys.authNotifiedAt, today);
    await notifySessionExpired();
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'session-expired notification failed');
  }
}

function humanMessage(reason: string): string {
  switch (reason) {
    case 'AUTHENTICATION_REQUIRED':
      return 'Stored session expired or missing. Send /renew to the Telegram bot to refresh it from your phone, or re-run `npm run auth:setup` locally and upload the new storageState to POST /admin/storage-state.';
    case 'CLOUDFLARE_VERIFICATION_REQUIRED':
      return 'LeetCode returned a bot-challenge response to the API. Try TRANSPORT=api, or complete verification in a normal browser and re-upload storageState.';
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
