import { request as playwrightRequest } from 'playwright';
import { logger } from '../logger';
import { AccountRecord, getAccountById, listEnabledAccounts, parseStoredStorageState } from '../database/accounts';
import { LeetCodeApi, looksLikeChallenge, SubmissionOutcome } from '../leetcode/apiClient';
import { fetchQuestionData, RawQuestionData } from '../leetcode/dailyChallenge';
import { checkSession, SessionCheckResult } from '../browser/sessionCheck';
import { fetchWalkcccPage, signatureMatchesStarter, WalkcccError, WalkcccPage } from '../solutions/walkccc';
import {
  fetchCommunitySolution,
  resolveLeetCodeSlugByNumber,
  CommunitySolution,
  FetchCommunitySolutionOptions,
} from '../solutions/communitySolutions';
import { shouldRetryWithOriginal, stripCppComments } from '../codeforces/codeSanitizer';
import { ParsedProblem } from '../leetcode/parser';
import { isRunInProgress } from './dailyWorker';
import { config } from '../config';
import { refreshLeetCodeAccount, AccountRefreshOutcome } from '../security/sessionAutoRefresh';

/**
 * Question-range submission (Telegram /questionrangesubmission 200-400).
 *
 * For each selected account — strictly ONE account at a time, and one
 * question at a time — every question number in the range is solved with
 * walkccc's C++ solution (the page is looked up by the plain question number)
 * and submitted through LeetCode's own API.
 *
 * Staying clear of Cloudflare:
 *   - API only: no HTML page of leetcode.com is ever loaded (same path as the
 *     daily run), and no Chromium is launched — one lightweight HTTP session
 *     per account, reused for the whole range.
 *   - A fixed pause (default 30s) after every question that touched LeetCode.
 *   - 403 / 429 / HTML-instead-of-JSON ("blocked") answers are never pushed
 *     through: the SAME question is retried after an exponential back-off
 *     (1, 2, 4 min). Several blocked questions in a row trigger one long
 *     cool-down; if LeetCode is still blocking after that, the account is
 *     stopped early (remaining questions are reported, not hammered).
 *   - While the daily run is in progress the range pauses, so the two never
 *     submit at the same time.
 *
 * Only one range job runs at a time. Additional requests are queued FIFO and
 * start automatically when the current job completes or is cancelled.
 * /cancelrange stops the active job (immediately during a pause, or right
 * after the question that is being judged).
 */

// ---------------------------------------------------------------------------
// Range parsing
// ---------------------------------------------------------------------------

export const MAX_QUESTION_NUMBER = 9999;
export const MAX_RANGE_SIZE = 1000;

export interface QuestionRange {
  from: number;
  to: number;
}

export type RangeParse = { ok: true; range: QuestionRange } | { ok: false; error: string };

/** Accepts "200-400", "200 - 400", "200–400", "200 to 400", or a single "200". */
export function parseQuestionRange(input: string): RangeParse {
  const m = /^\s*#?(\d{1,5})\s*(?:(?:-|–|—|to|\.\.)\s*#?(\d{1,5}))?\s*$/i.exec(input ?? '');
  if (!m) return { ok: false, error: 'Send the range as two question numbers, e.g. 200-400' };
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  if (from < 1 || to < 1) return { ok: false, error: 'Question numbers start at 1.' };
  if (from > MAX_QUESTION_NUMBER || to > MAX_QUESTION_NUMBER) {
    return { ok: false, error: `Question numbers go up to ${MAX_QUESTION_NUMBER}.` };
  }
  if (from > to) return { ok: false, error: `The start (${from}) must not be after the end (${to}).` };
  if (to - from + 1 > MAX_RANGE_SIZE) {
    return { ok: false, error: `That is ${to - from + 1} questions — at most ${MAX_RANGE_SIZE} per run.` };
  }
  return { ok: true, range: { from, to } };
}

export function rangeSize(r: QuestionRange): number {
  return r.to - r.from + 1;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type QuestionStatus = 'accepted' | 'failed' | 'error' | 'premium';

export interface QuestionResult {
  number: number;
  status: QuestionStatus;
  /** Judge verdict (failed) or short reason (error). */
  detail?: string;
  submissionId?: string;
  /** Exact accepted source retained only for the manual article workflow. */
  capture?: { slug: string; title: string; difficulty: string; language: 'cpp'; code: string };
}

export interface AccountRangeResult {
  label: string;
  username: string | null;
  range: QuestionRange;
  results: QuestionResult[];
  /** Set when the account could not run at all (bad cookies, session rejected). */
  fatal?: string;
  /** Set when the account stopped before the end of the range. */
  stoppedEarly?: 'cancelled' | 'blocked';
  /** Question numbers never attempted because of an early stop. */
  notAttempted: number[];
  startedAt: number;
  finishedAt: number;
}

export function countResults(results: QuestionResult[]): Record<QuestionStatus, number> {
  const c = { accepted: 0, failed: 0, error: 0, premium: 0 };
  for (const r of results) c[r.status]++;
  return c;
}

// ---------------------------------------------------------------------------
// Dependencies (all injectable, so the engine is fully testable offline)
// ---------------------------------------------------------------------------

export interface RangeApi {
  checkSession(): Promise<SessionCheckResult>;
  question(slug: string): Promise<RawQuestionData>;
  submit(p: { slug: string; questionId: string; lang: string; code: string }): Promise<string>;
  awaitResult(submissionId: string, slug: string): Promise<SubmissionOutcome>;
}

export interface RangeSession {
  api: RangeApi;
  close(): Promise<void>;
}

export interface RangeProgressEvent {
  phase:
    | 'checking'
    | 'processing'
    | 'submitting'
    | 'verdict'
    | 'accepted'
    | 'failed'
    | 'premium'
    | 'error'
    | 'waiting'
    | 'blocked'
    | 'cancelled'
    | 'completed';
  label: string;
  username?: string | null;
  accIndex: number;
  accTotal: number;
  stepIndex: number;
  stepTotal: number;
  questionNumber: number;
  questionTitle?: string | null;
  slug?: string | null;
  verdict?: string | null;
  submissionId?: string | null;
  detail?: string | null;
  waitSeconds?: number;
}

export interface RangeProgressContext {
  label: string;
  username?: string | null;
  accIndex: number;
  accTotal: number;
  stepIndex: number;
  stepTotal: number;
}

export interface RangeDeps {
  listAccounts(): Promise<AccountRecord[]>;
  getAccount(id: string): Promise<AccountRecord | null>;
  openSession(account: AccountRecord): Promise<RangeSession>;
  refreshAccount?(account: AccountRecord): Promise<AccountRefreshOutcome | null>;
  /** The walkccc page for a question number: the slug (and often the solution). */
  getPage(questionNumber: number): Promise<WalkcccPage>;
  /** Direct LeetCode slug resolution by question number when walkccc has no page. */
  resolveSlug?(questionNumber: number): Promise<string | null>;
  /** Fetches community solutions (or mocked in tests). */
  fetchCommunity?(
    slug: string,
    problem: ParsedProblem,
    options?: FetchCommunitySolutionOptions,
  ): Promise<CommunitySolution>;
  notify(text: string): Promise<void>;
  /** Real-time progress updates for Telegram live progress bar (matching Codeforces format). */
  onProgress?: (event: RangeProgressEvent) => Promise<void> | void;
  /** Resolves after `ms`, or early (without throwing) when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  isDailyRunInProgress(): boolean;
  now(): number;
  /** Pause after each question that touched LeetCode (default 30s). */
  questionGapMs: number;
  /** Back-off before retrying a blocked question: 1st, 2nd, 3rd retry. */
  blockedBackoffMs: number[];
  /** Consecutive blocked questions that trigger the long cool-down. */
  blockedStreakLimit: number;
  /** The long cool-down after a streak of blocked questions. */
  blockedCooldownMs: number;
  /** How often to re-check while the daily run is in progress. */
  dailyRunPollMs: number;
  /** Send a short progress message every N questions (0 = never). */
  progressEvery: number;
  /** Keeps the host awake while the job runs; returns a stop function. */
  keepAlive(): () => void;
}

// ---------------------------------------------------------------------------
// The single job
// ---------------------------------------------------------------------------

export interface RangeJobInfo {
  range: QuestionRange;
  accountLabels: string[];
  accountIndex: number; // 1-based, 0 before the first account starts
  currentLabel: string | null;
  currentQuestion: number | null;
  doneInAccount: number;
  counts: Record<QuestionStatus, number>;
  startedAt: number;
  cancelling: boolean;
  pausedReason: string | null;
}

interface RangeJob {
  info: RangeJobInfo;
  abort: AbortController;
  done: Promise<AccountRangeResult[]>;
}

interface QueuedRangeJob {
  range: QuestionRange;
  accounts: AccountRecord[];
  deps: RangeDeps;
  position: number;
  enqueuedAt: number;
  resolve: (results: AccountRangeResult[]) => void;
}

let activeJob: RangeJob | null = null;
const queuedJobs: QueuedRangeJob[] = [];

export function isRangeJobActive(): boolean {
  return activeJob !== null;
}

export function currentRangeJob(): RangeJobInfo | null {
  return activeJob ? { ...activeJob.info, counts: { ...activeJob.info.counts } } : null;
}

/** Number of range jobs waiting behind the active job. */
export function rangeQueueLength(): number {
  return queuedJobs.length;
}

/** Requests cancellation. Returns false when no job is running. */
export function cancelRangeJob(): boolean {
  if (!activeJob) return false;
  activeJob.info.cancelling = true;
  activeJob.abort.abort();
  return true;
}

export type StartRangeResult =
  | { started: true; accounts: AccountRecord[]; done: Promise<AccountRangeResult[]> }
  | {
      started: false;
      queued: true;
      position: number;
      accounts: AccountRecord[];
      done: Promise<AccountRangeResult[]>;
    }
  | { started: false; reason: 'no-accounts' | 'account-not-found' };

/**
 * Starts a range job in the background for one account (by id) or all
 * enabled accounts (`'all'`). If another job is already active, the request
 * is queued FIFO instead of being rejected.
 */
export async function startRangeJob(
  range: QuestionRange,
  target: string | 'all',
  deps: RangeDeps = defaultRangeDeps(),
): Promise<StartRangeResult> {
  let accounts: AccountRecord[];
  if (target === 'all') {
    accounts = await deps.listAccounts();
    if (accounts.length === 0) return { started: false, reason: 'no-accounts' };
  } else {
    const account = await deps.getAccount(target);
    if (!account) return { started: false, reason: 'account-not-found' };
    accounts = [account];
  }

  // Re-check after the async account lookup: another request may have
  // started the active job while this request was resolving its accounts.
  // Also respect any existing queue so a newly-arrived request never jumps
  // ahead of jobs that were already waiting.
  if (activeJob || queuedJobs.length > 0) return enqueueRangeJob(range, accounts, deps);

  const job = createRangeJob(range, accounts, deps);
  return { started: true, accounts, done: job.done };
}

function createRangeJob(range: QuestionRange, accounts: AccountRecord[], deps: RangeDeps): RangeJob {
  const abort = new AbortController();
  const info: RangeJobInfo = {
    range,
    accountLabels: accounts.map((a) => a.label),
    accountIndex: 0,
    currentLabel: null,
    currentQuestion: null,
    doneInAccount: 0,
    counts: { accepted: 0, failed: 0, error: 0, premium: 0 },
    startedAt: deps.now(),
    cancelling: false,
    pausedReason: null,
  };
  const job: RangeJob = { info, abort, done: Promise.resolve([]) };
  activeJob = job;
  job.done = executeRangeJob(job, range, accounts, deps);
  return job;
}

function enqueueRangeJob(
  range: QuestionRange,
  accounts: AccountRecord[],
  deps: RangeDeps,
): Extract<StartRangeResult, { queued: true }> {
  let resolve!: (results: AccountRangeResult[]) => void;
  const done = new Promise<AccountRangeResult[]>((res) => {
    resolve = res;
  });
  const queued: QueuedRangeJob = {
    range: { ...range },
    accounts,
    deps,
    position: queuedJobs.length + 1,
    enqueuedAt: deps.now(),
    resolve,
  };
  queuedJobs.push(queued);
  logger.info(
    { position: queued.position, range, accounts: accounts.map((a) => a.label) },
    'range job queued behind active job',
  );
  return { started: false, queued: true, position: queued.position, accounts, done };
}

function startNextQueuedRangeJob(): void {
  if (activeJob) return;
  const queued = queuedJobs.shift();
  if (!queued) return;
  const job = createRangeJob(queued.range, queued.accounts, queued.deps);
  job.done.then(queued.resolve);
}

async function executeRangeJob(
  job: RangeJob,
  range: QuestionRange,
  accounts: AccountRecord[],
  deps: RangeDeps,
): Promise<AccountRangeResult[]> {
  const { info, abort } = job;
  const all: AccountRangeResult[] = [];
  const stopKeepAlive = deps.keepAlive();
  const usedCommunityUuidsByQuestion = new Map<number, Set<string>>();
  try {
    for (let i = 0; i < accounts.length; i++) {
      if (abort.signal.aborted) break;
      const account = accounts[i]!;
      info.accountIndex = i + 1;
      info.currentLabel = account.label;
      info.currentQuestion = null;
      info.doneInAccount = 0;
      info.counts = { accepted: 0, failed: 0, error: 0, premium: 0 };

      const result = await runAccountRange(
        account,
        range,
        deps,
        info,
        abort.signal,
        i + 1,
        accounts.length,
        usedCommunityUuidsByQuestion,
      );
      all.push(result);
      await deps
        .notify(formatAccountRangeSummary(result, i + 1, accounts.length))
        .catch((err) => logger.warn({ err: errText(err) }, 'range summary notification failed'));

      // Short breather before the next account (skipped when cancelled).
      if (i < accounts.length - 1 && !abort.signal.aborted) {
        await deps.sleep(deps.questionGapMs, abort.signal);
      }
    }
    await deps
      .notify(formatRangeJobFinished(range, all, accounts.length, abort.signal.aborted, deps.now() - info.startedAt))
      .catch(() => undefined);
    return all;
  } catch (err) {
    logger.error({ err: errText(err) }, 'range job crashed');
    await deps.notify(`💥 The question-range job crashed: ${errText(err)}`).catch(() => undefined);
    return all;
  } finally {
    stopKeepAlive();
    if (activeJob === job) {
      activeJob = null;
      startNextQueuedRangeJob();
    }
  }
}

// ---------------------------------------------------------------------------
// Per-account loop
// ---------------------------------------------------------------------------

async function runAccountRange(
  account: AccountRecord,
  range: QuestionRange,
  deps: RangeDeps,
  info: RangeJobInfo,
  signal: AbortSignal,
  index: number,
  total: number,
  usedCommunityUuidsByQuestion: Map<number, Set<string>> = new Map(),
): Promise<AccountRangeResult> {
  const result: AccountRangeResult = {
    label: account.label,
    username: account.username,
    range,
    results: [],
    notAttempted: [],
    startedAt: deps.now(),
    finishedAt: 0,
  };
  const finish = (): AccountRangeResult => {
    result.finishedAt = deps.now();
    return result;
  };

  let session!: RangeSession;
  try {
    session = await deps.openSession(account);
  } catch (err) {
    let recovered = false;
    if (deps.refreshAccount) {
      logger.warn({ account: account.label, err: errText(err) }, 'could not open session; attempting auto-refresh via credentials');
      const refreshOutcome = await deps.refreshAccount(account).catch(() => null);
      if (refreshOutcome?.status === 'refreshed') {
        const updated = await deps.getAccount(account.id);
        if (updated) {
          account = updated;
          try {
            session = await deps.openSession(account);
            recovered = true;
          } catch {
            // failed again
          }
        }
      }
    }
    if (!recovered) {
      result.fatal = `could not open a session: ${errText(err)}`;
      for (let n = range.from; n <= range.to; n++) result.notAttempted.push(n);
      void deps.onProgress?.({
        phase: 'error',
        label: account.label,
        username: account.username,
        accIndex: index - 1,
        accTotal: total,
        stepIndex: 1,
        stepTotal: rangeSize(range),
        questionNumber: range.from,
        detail: result.fatal,
      });
      return finish();
    }
  }

  try {
    void deps.onProgress?.({
      phase: 'checking',
      label: account.label,
      username: account.username,
      accIndex: index - 1,
      accTotal: total,
      stepIndex: 1,
      stepTotal: rangeSize(range),
      questionNumber: range.from,
    });

    let check = await session.api.checkSession();
    if (!check.authenticated && check.cause === 'signed-out' && deps.refreshAccount) {
      logger.warn({ account: account.label }, 'LeetCode range check reported signed-out; attempting auto-refresh via credentials');
      const refreshOutcome = await deps.refreshAccount(account).catch(() => null);
      if (refreshOutcome?.status === 'refreshed') {
        logger.info({ account: account.label }, 'LeetCode session auto-refreshed via credentials for range job — retrying session check');
        const updated = await deps.getAccount(account.id);
        if (updated) {
          account = updated;
          await session.close().catch(() => undefined);
          session = await deps.openSession(account);
          check = await session.api.checkSession();
        }
      }
    }

    if (!check.authenticated) {
      result.fatal =
        check.cause === 'signed-out'
          ? 'LeetCode rejected this session (signed out) — send fresh cookies'
          : 'could not verify the session (LeetCode request failed)';
      for (let n = range.from; n <= range.to; n++) result.notAttempted.push(n);
      void deps.onProgress?.({
        phase: 'error',
        label: account.label,
        username: account.username,
        accIndex: index - 1,
        accTotal: total,
        stepIndex: 1,
        stepTotal: rangeSize(range),
        questionNumber: range.from,
        detail: result.fatal,
      });
      return finish();
    }
    result.username = check.username ?? account.username;

    await deps
      .notify(
        `👤 Account ${index}/${total}: ${who(result)}\n🎯 Questions #${range.from}–#${range.to} (${rangeSize(range)}) — starting now`,
      )
      .catch(() => undefined);

    let blockedStreak = 0;
    let cooledDown = false;

    for (let n = range.from; n <= range.to; n++) {
      if (signal.aborted) break;
      await waitForDailyRun(deps, info, signal);
      if (signal.aborted) break;

      const stepIndex = n - range.from + 1;
      const stepTotal = rangeSize(range);
      info.currentQuestion = n;
      let usedUuids = usedCommunityUuidsByQuestion.get(n);
      if (!usedUuids) {
        usedUuids = new Set<string>();
        usedCommunityUuidsByQuestion.set(n, usedUuids);
      }
      const progressCtx: RangeProgressContext = {
        label: account.label,
        username: result.username,
        accIndex: index - 1,
        accTotal: total,
        stepIndex,
        stepTotal,
      };
      const { outcome, touchedLeetCode, blocked } = await solveOneWithRetries(
        n,
        session.api,
        deps,
        signal,
        usedUuids,
        progressCtx,
      );
      if (outcome === null) break; // cancelled during a back-off wait
      result.results.push(outcome);
      info.doneInAccount++;
      info.counts[outcome.status]++;
      logger.info({ label: account.label, question: n, status: outcome.status, detail: outcome.detail }, 'range question finished');

      if (deps.progressEvery > 0 && info.doneInAccount % deps.progressEvery === 0 && n < range.to) {
        const c = info.counts;
        await deps
          .notify(`📈 ${who(result)}: ${info.doneInAccount}/${rangeSize(range)} done — ✅ ${c.accepted} · ❌ ${c.failed} · ⚠️ ${c.error}`)
          .catch(() => undefined);
      }

      // Blocked handling: a streak means LeetCode is refusing this IP/session.
      blockedStreak = blocked ? blockedStreak + 1 : 0;
      if (blockedStreak >= deps.blockedStreakLimit) {
        if (cooledDown) {
          result.stoppedEarly = 'blocked';
          break;
        }
        cooledDown = true;
        blockedStreak = 0;
        const minutes = Math.round(deps.blockedCooldownMs / 60_000);
        info.pausedReason = `LeetCode is blocking requests — cooling down ${minutes} min`;
        await deps
          .notify(`🧊 LeetCode is blocking requests for ${who(result)} — cooling down for ${minutes} min before continuing.`)
          .catch(() => undefined);
        await deps.sleep(deps.blockedCooldownMs, signal);
        info.pausedReason = null;
      }

      if (n < range.to && touchedLeetCode && !signal.aborted) {
        void deps.onProgress?.({
          phase: 'waiting',
          label: account.label,
          username: result.username,
          accIndex: index - 1,
          accTotal: total,
          stepIndex,
          stepTotal,
          questionNumber: n,
          waitSeconds: Math.round(deps.questionGapMs / 1000),
        });
        await deps.sleep(deps.questionGapMs, signal);
      }
    }

    void deps.onProgress?.({
      phase: signal.aborted ? 'cancelled' : 'completed',
      label: account.label,
      username: result.username,
      accIndex: index - 1,
      accTotal: total,
      stepIndex: rangeSize(range),
      stepTotal: rangeSize(range),
      questionNumber: range.to,
    });

    if (signal.aborted) result.stoppedEarly = 'cancelled';
    const last = result.results.at(-1)?.number ?? range.from - 1;
    for (let n = last + 1; n <= range.to; n++) result.notAttempted.push(n);
    return finish();
  } catch (err) {
    result.fatal = `unexpected: ${errText(err)}`;
    const last = result.results.at(-1)?.number ?? range.from - 1;
    for (let n = last + 1; n <= range.to; n++) result.notAttempted.push(n);
    return finish();
  } finally {
    info.currentQuestion = null;
    await session.close().catch(() => undefined);
  }
}

async function waitForDailyRun(deps: RangeDeps, info: RangeJobInfo, signal: AbortSignal): Promise<void> {
  if (!deps.isDailyRunInProgress()) return;
  info.pausedReason = 'the daily run is in progress';
  logger.info('range job paused while the daily run is in progress');
  while (deps.isDailyRunInProgress() && !signal.aborted) {
    await deps.sleep(deps.dailyRunPollMs, signal);
  }
  info.pausedReason = null;
}

interface OneOutcome {
  outcome: QuestionResult | null; // null = cancelled mid-wait
  touchedLeetCode: boolean;
  blocked: boolean;
}

async function solveOneWithRetries(
  n: number,
  api: RangeApi,
  deps: RangeDeps,
  signal: AbortSignal,
  usedCommunityUuids?: Set<string>,
  progressCtx?: RangeProgressContext,
): Promise<OneOutcome> {
  let touched = false;
  for (let attempt = 0; ; attempt++) {
    const r = await solveOne(n, api, deps, usedCommunityUuids, progressCtx);
    touched ||= r.touchedLeetCode;
    if (!r.blocked) return { ...r, touchedLeetCode: touched };
    const wait = deps.blockedBackoffMs[attempt];
    if (wait === undefined) return { ...r, touchedLeetCode: touched }; // retries exhausted
    logger.warn({ question: n, attempt: attempt + 1, waitMs: wait }, 'LeetCode blocked the request - backing off before retrying');
    await deps.sleep(wait, signal);
    if (signal.aborted) return { outcome: null, touchedLeetCode: touched, blocked: true };
  }
}

/** Solves + submits ONE question. Never throws. */
async function solveOne(
  n: number,
  api: RangeApi,
  deps: RangeDeps,
  usedCommunityUuids?: Set<string>,
  progressCtx?: RangeProgressContext,
): Promise<{ outcome: QuestionResult; touchedLeetCode: boolean; blocked: boolean }> {
  let questionTitle: string | null = null;
  let slug: string | null = null;

  const err = (detail: string, touched = true, blocked = false) => {
    if (progressCtx) {
      void deps.onProgress?.({
        phase: 'error',
        label: progressCtx.label,
        username: progressCtx.username,
        accIndex: progressCtx.accIndex,
        accTotal: progressCtx.accTotal,
        stepIndex: progressCtx.stepIndex,
        stepTotal: progressCtx.stepTotal,
        questionNumber: n,
        questionTitle: questionTitle ?? slug ?? undefined,
        slug: slug ?? undefined,
        detail,
      });
    }
    return {
      outcome: { number: n, status: 'error' as const, detail },
      touchedLeetCode: touched,
      blocked,
    };
  };

  if (progressCtx) {
    void deps.onProgress?.({
      phase: 'processing',
      label: progressCtx.label,
      username: progressCtx.username,
      accIndex: progressCtx.accIndex,
      accTotal: progressCtx.accTotal,
      stepIndex: progressCtx.stepIndex,
      stepTotal: progressCtx.stepTotal,
      questionNumber: n,
    });
  }

  // 1) Slug resolution:
  //    Try walkccc first (shared cache, no LeetCode API call).
  //    If walkccc has no page or no slug, fall back to LeetCode GraphQL slug resolution.
  let walkcccPage: WalkcccPage | null = null;

  try {
    walkcccPage = await deps.getPage(n);
    if (walkcccPage?.slug) {
      slug = walkcccPage.slug;
    }
    if (walkcccPage?.title) {
      questionTitle = walkcccPage.title;
    }
  } catch (e) {
    if (e instanceof WalkcccError && /no walkccc page/i.test(e.message)) {
      logger.debug({ question: n }, 'no walkccc page for question; resolving slug via LeetCode');
    } else {
      logger.warn({ question: n, err: shortErr(e) }, 'walkccc getPage failed; resolving slug via LeetCode');
    }
  }

  if (!slug && deps.resolveSlug) {
    try {
      slug = await deps.resolveSlug(n);
    } catch (e) {
      logger.warn({ question: n, err: shortErr(e) }, 'failed to resolve LeetCode slug by number');
    }
  }

  if (!slug) {
    return err('no walkccc page', false);
  }

  try {
    // 2) Premium check: locked questions are skipped before touching solutions or judge
    const q = await api.question(slug);
    questionTitle = q.title ?? questionTitle ?? slug;
    if (q.isPaidOnly) {
      logger.info({ question: n, slug }, 'range question is premium-locked - skipping');
      if (progressCtx) {
        void deps.onProgress?.({
          phase: 'premium',
          label: progressCtx.label,
          username: progressCtx.username,
          accIndex: progressCtx.accIndex,
          accTotal: progressCtx.accTotal,
          stepIndex: progressCtx.stepIndex,
          stepTotal: progressCtx.stepTotal,
          questionNumber: n,
          questionTitle,
          slug,
          verdict: 'Premium Locked',
        });
      }
      return { outcome: { number: n, status: 'premium' }, touchedLeetCode: true, blocked: false };
    }
    if (!q.questionId) return err('LeetCode returned no question id');
    const questionId = q.questionId;

    const cpp = q.codeSnippets.find((s) => s.langSlug === 'cpp');
    if (!cpp) return err('no C++ for this question');
    const problem: ParsedProblem = { starterCode: cpp.code } as ParsedProblem;

    // 3) Obtain solution:
    //    Primary: LeetCode Community Solutions (random 1..10 per account, diversifying across accounts)
    //    Fallback: Walkccc solution
    let solutionCode: string | null = null;
    let fallbackWalkcccCode: string | null = null;
    let chosenSource: 'community' | 'walkccc' = 'walkccc';
    let chosenUuid: string | null = null;

    if (walkcccPage?.code && signatureMatchesStarter(walkcccPage.code, problem)) {
      fallbackWalkcccCode = walkcccPage.code;
    }

    const commFetcher = deps.fetchCommunity;

    if (commFetcher) {
      try {
        const commSol = await commFetcher(slug, problem, {
          language: 'cpp',
          excludeUuids: usedCommunityUuids,
          randomize: true,
        });
        if (commSol?.code) {
          solutionCode = commSol.code;
          chosenSource = 'community';
          chosenUuid = commSol.uuid;
        }
      } catch (commErr) {
        logger.warn({ question: n, slug, err: shortErr(commErr) }, 'community solution fetch failed; checking walkccc fallback');
      }
    }

    if (!solutionCode && fallbackWalkcccCode) {
      solutionCode = fallbackWalkcccCode;
      chosenSource = 'walkccc';
    }

    if (!solutionCode && !walkcccPage) {
      try {
        const p = await deps.getPage(n);
        if (p?.code && signatureMatchesStarter(p.code, problem)) {
          solutionCode = p.code;
          fallbackWalkcccCode = p.code;
          chosenSource = 'walkccc';
        }
      } catch {
        // ignore
      }
    }

    if (!solutionCode) {
      if (walkcccPage && !walkcccPage.code && !commFetcher) {
        return err('no walkccc C++ solution for this question');
      }
      return err('no valid C++ solution found');
    }

    if (chosenUuid && usedCommunityUuids) {
      usedCommunityUuids.add(chosenUuid);
    }

    // 4) Submit with comment-stripping fallback + judge failure fallback
    const submitCode = async (code: string) => {
      const strippedCode = stripCppComments(code);
      const useStripped = strippedCode.trim().length > 0 && strippedCode !== code;
      const codeToTryFirst = useStripped ? strippedCode : code;

      if (progressCtx) {
        void deps.onProgress?.({
          phase: 'submitting',
          label: progressCtx.label,
          username: progressCtx.username,
          accIndex: progressCtx.accIndex,
          accTotal: progressCtx.accTotal,
          stepIndex: progressCtx.stepIndex,
          stepTotal: progressCtx.stepTotal,
          questionNumber: n,
          questionTitle,
          slug,
        });
      }

      const subId = await api.submit({ slug: slug!, questionId, lang: 'cpp', code: codeToTryFirst });

      if (progressCtx) {
        void deps.onProgress?.({
          phase: 'verdict',
          label: progressCtx.label,
          username: progressCtx.username,
          accIndex: progressCtx.accIndex,
          accTotal: progressCtx.accTotal,
          stepIndex: progressCtx.stepIndex,
          stepTotal: progressCtx.stepTotal,
          questionNumber: n,
          questionTitle,
          slug,
          submissionId: subId,
        });
      }

      let verdict = await api.awaitResult(subId, slug!);

      if (useStripped && shouldRetryWithOriginal(verdict.statusDisplay)) {
        logger.warn(
          { question: n, slug, verdict: verdict.statusDisplay },
          'comment-stripped code failed with compile/runtime error; retrying with original code',
        );
        const retrySubId = await api.submit({ slug: slug!, questionId, lang: 'cpp', code });
        verdict = await api.awaitResult(retrySubId, slug!);
        return { verdict, submissionId: retrySubId, code };
      }

      return { verdict, submissionId: subId, code };
    };

    let { verdict, submissionId, code: acceptedCode } = await submitCode(solutionCode);

    // If verdict was rejected (wrong answer, compile error, runtime error) and we have a walkccc fallback:
    if (
      verdict.classification !== 'ACCEPTED' &&
      chosenSource === 'community' &&
      fallbackWalkcccCode &&
      fallbackWalkcccCode !== solutionCode
    ) {
      logger.warn(
        { question: n, slug, verdict: verdict.statusDisplay },
        'community solution was rejected by judge; attempting walkccc fallback',
      );
      try {
        const fallbackRes = await submitCode(fallbackWalkcccCode);
        if (fallbackRes.verdict.classification === 'ACCEPTED') {
          if (progressCtx) {
            void deps.onProgress?.({
              phase: 'accepted',
              label: progressCtx.label,
              username: progressCtx.username,
              accIndex: progressCtx.accIndex,
              accTotal: progressCtx.accTotal,
              stepIndex: progressCtx.stepIndex,
              stepTotal: progressCtx.stepTotal,
              questionNumber: n,
              questionTitle,
              slug,
              verdict: 'Accepted',
              submissionId: fallbackRes.submissionId,
            });
          }
          return {
            outcome: { number: n, status: 'accepted', submissionId: fallbackRes.submissionId,
              capture: { slug: slug!, title: questionTitle!, difficulty: q.difficulty, language: 'cpp', code: fallbackRes.code } },
            touchedLeetCode: true,
            blocked: false,
          };
        }
        verdict = fallbackRes.verdict;
        submissionId = fallbackRes.submissionId;
        acceptedCode = fallbackRes.code;
      } catch (fbErr) {
        logger.warn({ question: n, slug, err: shortErr(fbErr) }, 'walkccc fallback submission failed');
      }
    }

    if (verdict.classification === 'ACCEPTED') {
      if (progressCtx) {
        void deps.onProgress?.({
          phase: 'accepted',
          label: progressCtx.label,
          username: progressCtx.username,
          accIndex: progressCtx.accIndex,
          accTotal: progressCtx.accTotal,
          stepIndex: progressCtx.stepIndex,
          stepTotal: progressCtx.stepTotal,
          questionNumber: n,
          questionTitle,
          slug,
          verdict: 'Accepted',
          submissionId,
        });
      }
      return { outcome: { number: n, status: 'accepted', submissionId,
        capture: { slug, title: questionTitle!, difficulty: q.difficulty, language: 'cpp', code: acceptedCode } }, touchedLeetCode: true, blocked: false };
    }
    if (verdict.classification === 'UNKNOWN') {
      if (progressCtx) {
        void deps.onProgress?.({
          phase: 'error',
          label: progressCtx.label,
          username: progressCtx.username,
          accIndex: progressCtx.accIndex,
          accTotal: progressCtx.accTotal,
          stepIndex: progressCtx.stepIndex,
          stepTotal: progressCtx.stepTotal,
          questionNumber: n,
          questionTitle,
          slug,
          detail: 'judge timeout',
          submissionId,
        });
      }
      return {
        outcome: { number: n, status: 'error', detail: 'judge timeout', submissionId },
        touchedLeetCode: true,
        blocked: false,
      };
    }
    if (progressCtx) {
      void deps.onProgress?.({
        phase: 'failed',
        label: progressCtx.label,
        username: progressCtx.username,
        accIndex: progressCtx.accIndex,
        accTotal: progressCtx.accTotal,
        stepIndex: progressCtx.stepIndex,
        stepTotal: progressCtx.stepTotal,
        questionNumber: n,
        questionTitle,
        slug,
        verdict: verdict.statusDisplay,
        submissionId,
      });
    }
    return {
      outcome: { number: n, status: 'failed', detail: verdict.statusDisplay, submissionId },
      touchedLeetCode: true,
      blocked: false,
    };
  } catch (e) {
    if (looksLikeChallenge(e)) {
      if (progressCtx) {
        void deps.onProgress?.({
          phase: 'blocked',
          label: progressCtx.label,
          username: progressCtx.username,
          accIndex: progressCtx.accIndex,
          accTotal: progressCtx.accTotal,
          stepIndex: progressCtx.stepIndex,
          stepTotal: progressCtx.stepTotal,
          questionNumber: n,
          questionTitle: questionTitle ?? slug ?? undefined,
          slug: slug ?? undefined,
          detail: 'blocked by LeetCode',
        });
      }
      return err('blocked by LeetCode', true, true);
    }
    return err(shortErr(e));
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const MAX_LIST = 60;

function who(r: { label: string; username: string | null }): string {
  return r.username && r.username !== r.label ? `${r.label} (${r.username})` : r.label;
}

function numberList(ns: number[]): string {
  const shown = ns.slice(0, MAX_LIST).map((n) => `#${n}`).join(', ');
  return ns.length > MAX_LIST ? `${shown} … +${ns.length - MAX_LIST} more` : shown;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** The per-account notification: Accepted / Failed (+ numbers) / Error (+ numbers). */
export function formatAccountRangeSummary(r: AccountRangeResult, index: number, total: number): string {
  const head = `🏁 Account ${index}/${total}: ${who(r)}\n🎯 Questions #${r.range.from}–#${r.range.to}`;
  if (r.fatal) {
    return `${head}\n\n🚫 Not processed: ${r.fatal}${r.notAttempted.length ? `\n⏭️ Not attempted: ${r.notAttempted.length}` : ''}`;
  }
  const c = countResults(r.results);
  const failed = r.results.filter((x) => x.status === 'failed');
  const errors = r.results.filter((x) => x.status === 'error');
  const premium = r.results.filter((x) => x.status === 'premium');
  const lines = [head, '', `✅ Accepted: ${c.accepted}`, `❌ Failed: ${c.failed}`];
  if (failed.length) {
    // Group by verdict: "Wrong Answer: #212, #218"
    for (const [verdict, ns] of groupBy(failed)) lines.push(`   • ${verdict}: ${numberList(ns)}`);
  }
  if (premium.length) {
    lines.push(`🔒 Premium (locked): ${premium.length} — ${numberList(premium.map((x) => x.number))}`);
  }
  lines.push(`⚠️ Error: ${c.error}`);
  if (errors.length) {
    for (const [reason, ns] of groupBy(errors)) lines.push(`   • ${reason}: ${numberList(ns)}`);
  }
  if (r.stoppedEarly === 'cancelled') lines.push('', `🛑 Cancelled — ${r.notAttempted.length} question(s) not attempted`);
  if (r.stoppedEarly === 'blocked') {
    lines.push('', `🧱 Stopped early: LeetCode kept blocking requests — ${r.notAttempted.length} not attempted (${numberList(r.notAttempted.slice(0, 1))} onwards)`);
  }
  lines.push(`⏱️ Took ${formatDuration(r.finishedAt - r.startedAt)}`);
  return truncate(lines.join('\n'));
}

function groupBy(rs: QuestionResult[]): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const r of rs) {
    const k = r.detail ?? 'unknown';
    const list = m.get(k);
    if (list) list.push(r.number);
    else m.set(k, [r.number]);
  }
  return m;
}

export function formatRangeJobFinished(
  range: QuestionRange,
  results: AccountRangeResult[],
  totalAccounts: number,
  cancelled: boolean,
  elapsedMs: number,
): string {
  const sum = { accepted: 0, failed: 0, error: 0, premium: 0 };
  for (const r of results) {
    const c = countResults(r.results);
    sum.accepted += c.accepted;
    sum.failed += c.failed;
    sum.error += c.error;
    sum.premium += c.premium;
  }
  const head = cancelled
    ? `🛑 Question-range job cancelled (#${range.from}–#${range.to})`
    : `🎉 Question-range job finished (#${range.from}–#${range.to})`;
  return [
    head,
    `👥 Accounts processed: ${results.length}/${totalAccounts}`,
    `✅ ${sum.accepted} accepted · ❌ ${sum.failed} failed · ⚠️ ${sum.error} errors${sum.premium ? ` · 🔒 ${sum.premium} premium` : ''}`,
    `⏱️ Total time: ${formatDuration(elapsedMs)}`,
  ].join('\n');
}

export function formatRangeJobStatus(j: RangeJobInfo, now: number, queuedCount = 0): string {
  const size = rangeSize(j.range);
  const lines = [
    `⏳ Question-range job in progress (#${j.range.from}–#${j.range.to})`,
    `👤 Account ${j.accountIndex}/${j.accountLabels.length}: ${j.currentLabel ?? '—'}`,
    `📍 ${j.doneInAccount}/${size} done${j.currentQuestion ? ` — now on #${j.currentQuestion}` : ''}`,
    `✅ ${j.counts.accepted} · ❌ ${j.counts.failed} · ⚠️ ${j.counts.error}${j.counts.premium ? ` · 🔒 ${j.counts.premium}` : ''}`,
    `⏱️ Running for ${formatDuration(now - j.startedAt)}`,
  ];
  if (queuedCount > 0) lines.push(`🗂️ Queue: ${queuedCount} waiting`);
  if (j.pausedReason) lines.push(`⏸️ Paused: ${j.pausedReason}`);
  if (j.cancelling) lines.push('🛑 Cancelling — stopping after the current question');
  else lines.push('', 'Send /cancelrange to stop it.');
  return lines.join('\n');
}

/** Rough duration estimate for one account (judge ≈ 8s + the pause per question). */
export function estimateAccountMs(range: QuestionRange, gapMs: number): number {
  return rangeSize(range) * (gapMs + 8_000);
}

function truncate(s: string, max = 4000): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function shortErr(err: unknown): string {
  const t = errText(err).replace(/\s+/g, ' ').trim();
  return t.length > 80 ? `${t.slice(0, 80)}…` : t;
}

// ---------------------------------------------------------------------------
// Real dependencies
// ---------------------------------------------------------------------------

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** One HTTP session (no browser) carrying the account's own cookies. */
async function openRequestSession(account: AccountRecord): Promise<RangeSession> {
  const state = parseStoredStorageState(account.storageState);
  if (!state.ok) throw new Error(state.error);
  const ctx = await playwrightRequest.newContext({
    userAgent: USER_AGENT,
    storageState: { cookies: state.state.cookies, origins: [] },
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const cookieJar = {
    request: ctx,
    cookies: async (url?: string | readonly string[]) => {
      const all = (await ctx.storageState()).cookies;
      const host = typeof url === 'string' ? new URL(url).hostname : null;
      return host ? all.filter((c) => host === c.domain.replace(/^\./, '') || host.endsWith(c.domain)) : all;
    },
  };
  const api = new LeetCodeApi(cookieJar as never);
  return {
    api: {
      checkSession: () => checkSession(api),
      question: (slug) => fetchQuestionData(api, slug),
      submit: (p) => api.submitSolution(p),
      awaitResult: (id, slug) => api.awaitSubmission(id, slug),
    },
    close: () => ctx.dispose(),
  };
}

/**
 * walkccc lookups are shared by every account in the job (the solution for
 * question N is the same for everyone). Definitive answers — the solution, or
 * "no page for this number" — are kept; transient network errors are not.
 */
export class RangeSolutionCache {
  private readonly entries = new Map<number, Promise<WalkcccPage>>();
  constructor(
    private readonly fetcher: (n: number) => Promise<WalkcccPage> = fetchWalkcccPage,
    private readonly maxEntries = MAX_RANGE_SIZE,
  ) {}

  get(n: number): Promise<WalkcccPage> {
    const hit = this.entries.get(n);
    if (hit) return hit;
    const p = this.fetcher(n);
    this.entries.set(n, p);
    p.catch((e) => {
      if (!(e instanceof WalkcccError) && this.entries.get(n) === p) this.entries.delete(n);
    });
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return p;
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Render's free tier spins an idle service down after ~15 min without
 * INCOMING traffic — Telegram long-polling is outgoing and does not count, so
 * a multi-hour range job would be killed mid-way. While a job runs, ping our
 * own public /health every 10 minutes (through Render's edge, so it counts).
 */
function selfKeepAlive(): () => void {
  const base = config.api.publicUrl;
  if (!/^https:\/\//.test(base)) return () => undefined;
  const url = `${base.replace(/\/+$/, '')}/health`;
  const timer = setInterval(() => {
    void fetch(url, { signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
  }, 10 * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

let sharedCache = new RangeSolutionCache();

export function defaultRangeDeps(
  notify: (text: string) => Promise<void> = async () => undefined,
  onProgress?: (event: RangeProgressEvent) => Promise<void> | void,
): RangeDeps {
  // A fresh cache per job keeps memory bounded to one range.
  sharedCache = new RangeSolutionCache();
  return {
    listAccounts: listEnabledAccounts,
    getAccount: getAccountById,
    openSession: openRequestSession,
    refreshAccount: (acc) => refreshLeetCodeAccount(acc).catch(() => null),
    getPage: (n) => sharedCache.get(n),
    resolveSlug: (n) => resolveLeetCodeSlugByNumber(n),
    fetchCommunity: (slug, problem, options) => fetchCommunitySolution(slug, problem, options),
    notify,
    onProgress,
    sleep: abortableSleep,
    isDailyRunInProgress: isRunInProgress,
    now: () => Date.now(),
    questionGapMs: 30_000,
    blockedBackoffMs: [60_000, 120_000, 240_000],
    blockedStreakLimit: 3,
    blockedCooldownMs: 10 * 60_000,
    dailyRunPollMs: 15_000,
    progressEvery: 25,
    keepAlive: selfKeepAlive,
  };
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export interface SingleQuestionSubmitResult {
  outcome: QuestionResult;
  capture?: {
    slug: string;
    title: string;
    difficulty: string;
    language: string;
    code: string;
  };
}

/**
 * Submits a single question directly without queueing or touching the active range job.
 * This completely isolates solution posts and manual questions from range jobs.
 */
export async function submitSingleQuestionDirectly(
  account: AccountRecord,
  questionNumber: number,
  deps: RangeDeps = defaultRangeDeps(),
): Promise<SingleQuestionSubmitResult> {
  let session!: RangeSession;
  try {
    session = await deps.openSession(account);
  } catch (err) {
    let recovered = false;
    if (deps.refreshAccount) {
      const refreshOutcome = await deps.refreshAccount(account).catch(() => null);
      if (refreshOutcome?.status === 'refreshed') {
        const updated = await deps.getAccount(account.id);
        if (updated) {
          account = updated;
          try {
            session = await deps.openSession(account);
            recovered = true;
          } catch {
            // failed again
          }
        }
      }
    }
    if (!recovered) {
      return {
        outcome: {
          number: questionNumber,
          status: 'error',
          detail: `could not open session: ${errText(err)}`,
        },
      };
    }
  }

  try {
    let check = await session.api.checkSession();
    if (!check.authenticated && check.cause === 'signed-out' && deps.refreshAccount) {
      const refreshOutcome = await deps.refreshAccount(account).catch(() => null);
      if (refreshOutcome?.status === 'refreshed') {
        const updated = await deps.getAccount(account.id);
        if (updated) {
          account = updated;
          await session.close().catch(() => undefined);
          session = await deps.openSession(account);
          check = await session.api.checkSession();
        }
      }
    }

    if (!check.authenticated) {
      const detail =
        check.cause === 'signed-out'
          ? 'LeetCode rejected this session (signed out) — send fresh cookies'
          : 'could not verify the session (LeetCode request failed)';
      return {
        outcome: {
          number: questionNumber,
          status: 'error',
          detail,
        },
      };
    }

    const usedUuids = new Set<string>();
    const abort = new AbortController();
    const { outcome } = await solveOneWithRetries(
      questionNumber,
      session.api,
      deps,
      abort.signal,
      usedUuids,
    );

    if (!outcome) {
      return {
        outcome: {
          number: questionNumber,
          status: 'error',
          detail: 'submission aborted',
        },
      };
    }

    return {
      outcome,
      capture: outcome.status === 'accepted' ? outcome.capture : undefined,
    };
  } finally {
    await session.close().catch(() => undefined);
  }
}

/** Test hook: forget any job (only used by tests). */
export function __resetRangeJobForTests(): void {
  activeJob = null;
  queuedJobs.length = 0;
}
