import cron from 'node-cron';
import { AccountStatus } from '@prisma/client';
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
import {
  AccountRecord,
  ensureAccountsSeeded,
  listEnabledAccounts,
  parseStoredStorageState,
  patchAccount,
} from '../database/accounts';
import { AccountOutcome, buildReport, RunReport, summarizeReport } from './report';
import { BrowserSession, launchWithStorageStateObject } from '../browser/playwright';
import { checkSession } from '../browser/sessionCheck';
import { detectVerificationPage } from '../browser/cloudflareDetector';
import { captureDiagnostics, pruneDiagnostics } from '../browser/diagnostics';
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
import { notifyMultiRunReport } from '../notifications/notifier';

/**
 * The daily pipeline — MULTI-ACCOUNT.
 *
 * Every trigger (cron, boot, admin API, manual CLI) processes EVERY stored
 * account in sequence, each with its own cookies, session check, and run
 * row, and finishes with ONE aggregated report (persisted to SystemState,
 * sent to Telegram, returned to callers):
 *
 *   for each account:
 *     launch a browser context from its own storageState
 *     check the session (API-only, no page navigation)
 *       - LeetCode says signed out -> EXPIRED: reported, next account
 *       - the request itself fails -> failed (health unknown), next account
 *     solve + submit the daily challenge (deduped per account per day)
 *
 * Duplicate submissions are structurally impossible: the unique
 * (accountId, date) row is created before any submission work.
 *
 * Two transports (unchanged, applied per account):
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

/** Reasons that override the per-account per-day dedupe (re-attempt failed rows). */
function isForceReason(reason: string): boolean {
  return reason === 'admin-api' || reason === 'session-renewal' || reason === 'manual-cli';
}

export async function executeDailyRun(reason: string): Promise<RunReport> {
  if (runInProgress) {
    logger.warn({ reason }, 'run skipped — already in progress');
    return buildReport({
      date: todayInTimezone(),
      reason,
      startedAt: new Date().toISOString(),
      outcomes: [],
    });
  }
  runInProgress = true;
  const startedAt = new Date().toISOString();
  const forceRun = isForceReason(reason);

  try {
    pruneDiagnostics();
    await ensureAccountsSeeded();

    const today = todayInTimezone();
    const accounts = await listEnabledAccounts();
    logger.info(
      { today, reason, accounts: accounts.length, transport: config.transport, forceRun },
      'multi-account daily run starting',
    );

    if (accounts.length === 0) {
      logger.warn(
        'no accounts configured — add cookies via POST /admin/accounts or Telegram /renew',
      );
      const report = buildReport({ date: today, reason, startedAt, outcomes: [] });
      await setSystemState(SystemKeys.lastReport, JSON.stringify(report));
      return report;
    }

    const outcomes: AccountOutcome[] = [];
    for (const account of accounts) {
      try {
        outcomes.push(await runForAccount(account, today, forceRun));
      } catch (err) {
        // runForAccount wraps its own pipeline; this is a last-resort guard
        // so one broken account can never abort the whole batch.
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ label: account.label, err: msg }, 'account run crashed unexpectedly');
        outcomes.push({
          label: account.label,
          username: account.username,
          kind: 'failed',
          error: `unexpected: ${msg}`,
        });
      }
    }

    const report = buildReport({ date: today, reason, startedAt, outcomes });
    await setSystemState(SystemKeys.lastReport, JSON.stringify(report));
    await notifyMultiRunReport(report);
    logger.info({ summary: summarizeReport(report) }, 'multi-account daily run finished');
    return report;
  } finally {
    runInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Per-account pipeline
// ---------------------------------------------------------------------------

async function runForAccount(
  account: AccountRecord,
  today: string,
  forceRun: boolean,
): Promise<AccountOutcome> {
  const label = account.label;

  // --- 0) The stored credential must parse ---------------------------------
  const state = parseStoredStorageState(account.storageState);
  if (!state.ok) {
    await patchAccount(account.id, { status: AccountStatus.UNKNOWN, lastError: state.error, checked: true });
    return { label, username: account.username, kind: 'failed', error: state.error };
  }

  let session: BrowserSession | null = null;
  try {
    // --- 1) Session check (API-only, no page navigation) -------------------
    session = await launchWithStorageStateObject(state.state, label);
    if (!session) {
      await patchAccount(account.id, {
        status: AccountStatus.UNKNOWN,
        lastError: 'browser launch failed',
        checked: true,
      });
      return {
        label,
        username: account.username,
        kind: 'failed',
        error: 'the browser could not be launched for this account',
      };
    }
    const api = new LeetCodeApi(session.context);
    const check = await checkSession(api);

    if (!check.authenticated) {
      if (check.cause === 'signed-out') {
        // A live "signed out" response from the agent server proves only that
        // LeetCode rejected this transferred session there. It does NOT prove
        // that the token itself has expired, so keep the cookies and classify
        // the account as REJECTED. Offline token expiry is the only path that
        // marks an account EXPIRED.
        await patchAccount(account.id, {
          status: AccountStatus.REJECTED,
          lastError: 'LeetCode rejected this transferred session from the agent server; token expiry is not established',
          checked: true,
        });
        logger.warn({ label }, 'account session REJECTED by LeetCode — skipping');
        return {
          label,
          username: account.username,
          kind: 'rejected',
          error:
            'LeetCode rejected the transferred session from the agent server — cookies were kept; re-capture only if this persists',
        };
      }
      // The request itself failed (network error / Cloudflare 403). NOT proof
      // of expiry — report honestly and leave the status untouched.
      await patchAccount(account.id, {
        lastError: 'session check failed (LeetCode request error) — cookie health unknown',
        checked: true,
      });
      return {
        label,
        username: account.username,
        kind: 'failed',
        error: 'could not verify the session (LeetCode request failed) — will retry next run',
      };
    }

    const username = check.username as string;
    await patchAccount(account.id, {
      username,
      status: AccountStatus.ACTIVE,
      lastError: null,
      checked: true,
    });
    logger.info({ label, username }, 'account authenticated');

    // --- 2) Per-account duplicate guard ------------------------------------
    const existing = await findRunByDate(account.id, today);
    if (
      !forceRun &&
      existing &&
      (existing.state === RunState.SUCCESS || existing.state === RunState.PENDING)
    ) {
      logger.info({ label, today, state: existing.state }, 'account already handled today — skipping');
      await patchAccount(account.id, { ran: true });
      return {
        label,
        username,
        kind: existing.state === RunState.SUCCESS ? 'solved' : 'skipped',
        state: existing.state,
        submissionStatus: existing.submissionStatus,
        runtime: existing.runtime,
        memory: existing.memory,
        error: existing.state === RunState.SUCCESS ? null : 'a run for this account is already pending',
      };
    }

    // --- 3) Locate today's daily challenge ---------------------------------
    let daily;
    try {
      daily = await fetchDailyChallenge(api);
    } catch (err) {
      if (err instanceof DailyProblemNotFoundError) {
        return await finalizePlaceholder(account, username, today, RunState.DAILY_PROBLEM_NOT_FOUND, 'LeetCode returned no active daily challenge');
      }
      if (looksLikeChallenge(err)) {
        return await finalizePlaceholder(
          account,
          username,
          today,
          RunState.CLOUDFLARE_VERIFICATION_REQUIRED,
          `LeetCode blocked the API request: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      throw err;
    }

    let run =
      existing ??
      (await createRun({
        accountId: account.id,
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

    // --- 4) Fetch + parse the problem --------------------------------------
    let problem;
    try {
      const raw = await fetchQuestionData(api, daily.slug);
      problem = parseProblem(raw, config.llm.language);
    } catch (err) {
      if (err instanceof ProblemParseError) {
        return await finishRun(account, username, run, RunState.PROBLEM_PARSE_FAILED, { error: err.message });
      }
      if (looksLikeChallenge(err)) {
        return await finishRun(
          account,
          username,
          run,
          RunState.CLOUDFLARE_VERIFICATION_REQUIRED,
          { error: `LeetCode blocked the problem request: ${err instanceof Error ? err.message : String(err)}` },
        );
      }
      throw err;
    }

    // --- 5) Obtain the solution (walkccc fetch by default; LLM on opt-in) --
    const solution = await obtainSolution(problem, run, account, username);
    if (!solution.ok) return solution.outcome;
    run = await updateRun(run.id, { solution: solution.code });

    // --- 6) Apply the solution ---------------------------------------------
    if (config.transport === 'api') {
      return await submitViaApi(account, username, api, problem, solution.code, run);
    }
    return await submitViaBrowser(account, username, session, problem, solution.code, run);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ label, err: msg }, 'account run failed with unexpected error');
    await patchAccount(account.id, { lastError: `unexpected: ${msg}`, ran: true }).catch(() => undefined);
    return { label, username: account.username, kind: 'failed', error: `unexpected: ${msg}` };
  } finally {
    if (session) await session.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Solution acquisition
// ---------------------------------------------------------------------------

type SolutionResult =
  | { ok: true; code: string }
  | { ok: false; outcome: AccountOutcome };

async function obtainSolution(
  problem: ReturnType<typeof parseProblem>,
  run: DailyRunRecord,
  account: AccountRecord,
  username: string,
): Promise<SolutionResult> {
  if (config.solution.source === 'walkccc') {
    try {
      const sol = await fetchWalkcccSolution(problem.frontendId);
      // Guard: walkccc's method name must match LeetCode's C++ starter, or the
      // submission is a guaranteed compile error.
      if (!signatureMatchesStarter(sol.code, problem)) {
        await finishRun(account, username, run, RunState.SOLUTION_VALIDATION_FAILED, {
          solution: sol.code,
          error:
            'walkccc solution signature does not match the LeetCode C++ starter for this problem — flagged for review instead of submitting broken code',
        });
        return {
          ok: false,
          outcome: {
            label: account.label,
            username,
            kind: 'failed',
            state: RunState.SOLUTION_VALIDATION_FAILED,
            error: 'walkccc solution signature does not match the starter — flagged for review',
          },
        };
      }
      logger.info({ label: account.label, sourceUrl: sol.sourceUrl }, 'solution obtained from walkccc');
      return { ok: true, code: sol.code };
    } catch (err) {
      if (err instanceof WalkcccError) {
        await finishRun(account, username, run, RunState.SOLUTION_VALIDATION_FAILED, { error: err.message });
        return {
          ok: false,
          outcome: {
            label: account.label,
            username,
            kind: 'failed',
            state: RunState.SOLUTION_VALIDATION_FAILED,
            error: err.message,
          },
        };
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
  await finishRun(account, username, run, state, {
    error: solved.reason === 'LLM_ERROR' ? solved.error : solved.lastReport,
    solution: solved.reason === 'SOLUTION_VALIDATION_FAILED' ? solved.lastCode : undefined,
  });
  return {
    ok: false,
    outcome: {
      label: account.label,
      username,
      kind: 'failed',
      state,
      error: solved.reason === 'LLM_ERROR' ? solved.error : solved.lastReport,
    },
  };
}

// ---------------------------------------------------------------------------
// Transport: API (default)
// ---------------------------------------------------------------------------

async function submitViaApi(
  account: AccountRecord,
  username: string,
  api: LeetCodeApi,
  problem: ReturnType<typeof parseProblem>,
  code: string,
  run: DailyRunRecord,
): Promise<AccountOutcome> {
  if (!config.submission.autoSubmit) {
    // There is no editor to fill over the API — the only state-changing call is
    // a submission. Respect the safety default and stop before it.
    logger.warn(
      { label: account.label },
      'TRANSPORT=api with AUTO_SUBMIT=false — the solution was produced and validated but NOT submitted (the API has no "fill editor only" step). Set AUTO_SUBMIT=true to submit.',
    );
    return finishRun(account, username, run, RunState.SUCCESS, {
      submissionStatus: 'SOLVED_NOT_SUBMITTED (TRANSPORT=api, AUTO_SUBMIT=false)',
    });
  }

  if (!problem.questionId) {
    return finishRun(account, username, run, RunState.SUBMISSION_ERROR, {
      error:
        'LeetCode did not return the internal questionId required by the submit endpoint — cannot submit',
    });
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
      return finishRun(account, username, run, RunState.SUCCESS, {
        submissionId: result.submissionId,
        submissionStatus: result.statusDisplay,
        runtime: result.runtime,
        memory: result.memory,
      });
    }

    return finishRun(account, username, run, RunState.SUBMISSION_REJECTED, {
      submissionId: result.submissionId,
      submissionStatus: result.statusDisplay,
      runtime: result.runtime,
      memory: result.memory,
      error: `judge verdict: ${result.rawStatusMsg}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (looksLikeChallenge(err)) {
      return finishRun(account, username, run, RunState.CLOUDFLARE_VERIFICATION_REQUIRED, {
        error: `LeetCode blocked the submission request: ${msg}`,
      });
    }
    return finishRun(account, username, run, RunState.SUBMISSION_ERROR, { error: msg });
  }
}

// ---------------------------------------------------------------------------
// Transport: browser (Playwright UI)
// ---------------------------------------------------------------------------

async function submitViaBrowser(
  account: AccountRecord,
  username: string,
  session: BrowserSession,
  problem: ReturnType<typeof parseProblem>,
  code: string,
  run: DailyRunRecord,
): Promise<AccountOutcome> {
  const page = session.page;

  await openProblemPage(page, problem.slug);
  const cf = await guardCloudflare(account, username, session, run);
  if (cf) return cf;

  const languageOk = await ensureLanguage(page, config.llm.language);
  if (!languageOk) {
    logger.warn({ label: account.label, language: config.llm.language }, 'could not confirm language selection');
  }
  await setEditorCode(page, code);

  if (!config.submission.autoSubmit) {
    logger.info({ label: account.label }, 'AUTO_SUBMIT=false — editor filled, not submitting');
    return finishRun(account, username, run, RunState.SUCCESS, {
      submissionStatus: 'EDITOR_FILLED (AUTO_SUBMIT=false)',
    });
  }

  let result;
  try {
    result = await submitCurrentEditor(page, problem.frontendId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await captureDiagnostics(page, 'submission-error', session.browserLogs);
    return finishRun(account, username, run, RunState.SUBMISSION_ERROR, { error: msg });
  }

  if (result.classification === 'ACCEPTED') {
    return finishRun(account, username, run, RunState.SUCCESS, {
      submissionId: result.submissionId,
      submissionStatus: result.statusDisplay,
      runtime: result.runtime,
      memory: result.memory,
    });
  }

  await captureDiagnostics(page, `rejected-${result.classification.toLowerCase()}`, session.browserLogs);
  return finishRun(account, username, run, RunState.SUBMISSION_REJECTED, {
    submissionId: result.submissionId,
    submissionStatus: result.statusDisplay,
    runtime: result.runtime,
    memory: result.memory,
    error: `judge verdict: ${result.rawStatusMsg}`,
  });
}

/**
 * Cloudflare guard for the browser transport: detection only. On any
 * verification page, capture a diagnostics bundle and stop this account's run.
 */
async function guardCloudflare(
  account: AccountRecord,
  username: string,
  session: BrowserSession,
  run: DailyRunRecord,
): Promise<AccountOutcome | null> {
  const kind = await detectVerificationPage(session.page);
  if (!kind) return null;
  await captureDiagnostics(session.page, `cloudflare-${kind}`, session.browserLogs);
  return finishRun(
    account,
    username,
    run,
    RunState.CLOUDFLARE_VERIFICATION_REQUIRED,
    { error: `Cloudflare verification page detected (${kind}). Manual verification required.` },
  );
}

// ---------------------------------------------------------------------------
// Run-row finalization
// ---------------------------------------------------------------------------

/** Placeholder row for an account whose run failed before the problem was identified. */
async function finalizePlaceholder(
  account: AccountRecord,
  username: string,
  today: string,
  state: RunState,
  error: string,
): Promise<AccountOutcome> {
  const existing = await findRunByDate(account.id, today);
  const run =
    existing ??
    (await createRun({
      accountId: account.id,
      date: today,
      problemSlug: '(unknown)',
      title: '(not fetched)',
      difficulty: '-',
      language: config.llm.language,
    }));
  return finishRun(account, username, run, state, { error });
}

/**
 * Terminal write for one account's run row + account bookkeeping. Deliberately
 * does NOT notify per account — the aggregated multi-account report is the
 * single Telegram message for the whole batch.
 */
async function finishRun(
  account: AccountRecord,
  username: string,
  run: DailyRunRecord,
  state: RunState,
  extra: Parameters<typeof finalizeRun>[2],
): Promise<AccountOutcome> {
  const updated = await finalizeRun(run.id, state, extra);
  await setSystemState(
    SystemKeys.lastRunSummary,
    JSON.stringify({
      account: account.label,
      username,
      date: updated.date,
      slug: updated.problemSlug,
      state: updated.state,
      at: updated.updatedAt.toISOString(),
    }),
  );
  const solved = state === RunState.SUCCESS;
  await patchAccount(account.id, {
    ran: true,
    lastResult: state,
    lastError: solved ? null : updated.error ?? state,
  });
  logger.info({ label: account.label, date: updated.date, state }, 'account run finalized');
  return {
    label: account.label,
    username,
    kind: solved ? 'solved' : 'failed',
    state,
    submissionStatus: updated.submissionStatus,
    runtime: updated.runtime,
    memory: updated.memory,
    error: solved ? null : updated.error,
  };
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
