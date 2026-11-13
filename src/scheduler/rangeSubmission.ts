import * as os from 'os';
import * as fs from 'fs';
import { request as playwrightRequest } from 'playwright';
import { z } from 'zod';
import { logger } from '../logger';
import { AccountRecord, getAccountById, listEnabledAccounts, parseStoredStorageState } from '../database/accounts';
import {
  buildBrowserClientHeaders,
  cookieMatchesOrigin,
  deduplicateLeetCodeCookies,
  isSubmissionLimitError,
  LeetCodeApi,
  LeetCodeHttpError,
  leetCodeRequestFailure,
  looksLikeChallenge,
  SubmissionOutcome,
} from '../leetcode/apiClient';
import { persistRotatedCookiesFromContext } from '../leetcode/sessionManager';
import { type GhostBrowserSession, openGhostBrowserSession, submitViaGhostBrowser } from '../leetcode/ghostSubmit';
import { type StorageStateShape } from '../browser/cookiePayload';
import { resolveLeetCodeResidentialProxy } from '../codeforces/proxyManager';
import { toPlaywrightProxy } from '../codeforces/proxyRotator';
import { RangeRequestGate, RangeRequestWait } from './rangeRequestGate';
import { fetchQuestionData, RawQuestionData } from '../leetcode/dailyChallenge';
import { checkSession, SessionCheckResult } from '../browser/sessionCheck';
import {
  fetchWalkcccPage,
  signatureMatchesStarter,
  WalkcccError,
  WalkcccPage,
} from '../solutions/walkccc';
import {
  fetchCommunitySolution,
  resolveLeetCodeSlugByNumber,
  CommunitySolution,
  FetchCommunitySolutionOptions,
} from '../solutions/communitySolutions';
import { shouldRetryWithOriginal, stripCppComments } from '../codeforces/codeSanitizer';
import { parseProblem, ParsedProblem } from '../leetcode/parser';
import { isRunInProgress } from './dailyWorker';
import { config } from '../config';
import { accountQuestionOrders, QuestionReservations } from './questionOrder';
import { refreshLeetCodeAccount, AccountRefreshOutcome } from '../security/sessionAutoRefresh';
import { claimDailyCheckin } from '../leetcode/dailyCheckin';
import {
  AI_SOLVE_FAILURE_THRESHOLD,
  createDbQuestionFailureStore,
  QuestionFailureStore,
} from './questionFailureCounter';
import { solveQuestionWithConfiguredAi } from '../ai/codeSolver';

/**
 * Question-range submission (Telegram /questionrangesubmission 200-400).
 *
 * Each worker handles one account and one question at a time. Workers share
 * request pacing and can prepare questions or read verdicts between submits.
 *
 * Staying clear of Cloudflare:
 *   - API only: no HTML page of leetcode.com is ever loaded (same path as the
 *     daily run), and no Chromium is launched — one lightweight HTTP session
 *     per account, reused for the whole range.
 *   - A shared 30s minimum between submission starts, including retries.
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
  capture?: { slug: string; title: string; difficulty: string; language: string; code: string };
}

export interface AccountRangeResult {
  label: string;
  username: string | null;
  range: QuestionRange;
  results: QuestionResult[];
  /** Set when the account could not run at all (bad cookies, session rejected). */
  fatal?: string;
  /** Set when the account stopped before the end of the range. */
  stoppedEarly?: 'cancelled' | 'blocked' | 'submission-limit';
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

interface RangeSubmitProgress {
  onWait(wait: RangeRequestWait): void;
  onSend(): void;
}

export interface RangeApi {
  checkSession(): Promise<SessionCheckResult>;
  question(slug: string): Promise<RawQuestionData>;
  submit(p: { slug: string; questionId: string; lang: string; code: string }, progress?: RangeSubmitProgress): Promise<string>;
  submitWithBrowserFallback?(
    p: { slug: string; questionId: string; lang: string; code: string },
    signal?: AbortSignal,
  ): Promise<string>;
  awaitResult(submissionId: string, slug: string): Promise<SubmissionOutcome>;
  graphql?<T>(query: string, variables: Record<string, unknown>, schema: unknown): Promise<T>;
}

export interface RangeSession {
  api: RangeApi;
  close(): Promise<void>;
}

type RangeQuestionMetadata = Pick<RawQuestionData, 'questionId' | 'isPaidOnly' | 'title' | 'difficulty'> & {
  starterCode?: string;
  codeSnippets?: RawQuestionData['codeSnippets'];
  contentHtml?: RawQuestionData['contentHtml'];
  exampleTestcases?: RawQuestionData['exampleTestcases'];
  metaData?: RawQuestionData['metaData'];
  frontendId?: RawQuestionData['frontendId'];
  topicTags?: RawQuestionData['topicTags'];
};

interface RangeQuestionLookup {
  slugHint?: string;
  questionCache?: Map<string, RangeQuestionMetadata>;
}

export interface RangeProgressEvent {
  phase:
    | 'checking'
    | 'processing'
    | 'waiting-submit'
    | 'submitting'
    | 'verdict'
    | 'accepted'
    | 'failed'
    | 'premium'
    | 'error'
    | 'waiting'
    | 'waiting-question'
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
  waitReason?: RangeRequestWait['reason'];
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
  /** Tests may inject an order; production generates a new permutation per account. */
  questionOrder?: (numbers: readonly number[], accountId: string) => number[];
  listAccounts(): Promise<AccountRecord[]>;
  getAccount(id: string): Promise<AccountRecord | null>;
  openSession(account: AccountRecord, signal?: AbortSignal): Promise<RangeSession>;
  refreshAccount?(account: AccountRecord): Promise<AccountRefreshOutcome | null>;
  /** The walkccc page for a question number: the slug (and often the solution). */
  getPage(questionNumber: number): Promise<WalkcccPage>;
  /** Direct LeetCode slug resolution by question number when walkccc has no page. */
  resolveSlug?(questionNumber: number, options?: FetchCommunitySolutionOptions): Promise<string | null>;
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
  /** Optional additional pause for callers providing their own transport. */
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
  /** Persistent/injectable failure tracker for solution-section attempts per question. */
  questionFailures?: QuestionFailureStore;
  /** AI solver invoked after 3 failed solution-section attempts (4th attempt). */
  solveWithAi?: (
    problem: ParsedProblem,
    language: string,
  ) => Promise<{ code: string; model?: string; providerLabel?: string }>;
}

// ---------------------------------------------------------------------------
// Concurrency & Memory Budgeting
// ---------------------------------------------------------------------------

export function getContainerMemoryLimitMb(): number {
  if (process.env.CONTAINER_MAX_MEMORY_MB) {
    const parsed = parseInt(process.env.CONTAINER_MAX_MEMORY_MB, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  // Linux cgroup v2
  try {
    if (fs.existsSync('/sys/fs/cgroup/memory.max')) {
      const val = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
      if (val !== 'max') {
        const bytes = parseInt(val, 10);
        if (!isNaN(bytes) && bytes > 0) {
          return Math.floor(bytes / (1024 * 1024));
        }
      }
    }
  } catch {}
  // Linux cgroup v1
  try {
    if (fs.existsSync('/sys/fs/cgroup/memory/memory.limit_in_bytes')) {
      const val = fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim();
      const bytes = parseInt(val, 10);
      if (!isNaN(bytes) && bytes > 0 && bytes < 1024 * 1024 * 1024 * 1024) {
        return Math.floor(bytes / (1024 * 1024));
      }
    }
  } catch {}

  // If deployed on Render free tier (512 MB limit)
  if (process.env.RENDER || process.env.RENDER_SERVICE_ID) {
    return 512;
  }

  // System memory fallback
  try {
    const sysMb = Math.floor(os.totalmem() / (1024 * 1024));
    if (sysMb > 0) return sysMb;
  } catch {}

  return 512;
}

export interface RangeConcurrencyOptions {
  mode?: 'parallel' | 'sequential';
  maxConcurrency?: number;
  overrideTotalMb?: number;
  overrideUsedMb?: number;
  overrideAvailableMb?: number;
}

export interface ConcurrencyBudget {
  concurrency: number;
  totalLimitMb: number;
  usedMb: number;
  availableMb: number;
  perAccountMb: number;
  mode: 'parallel' | 'sequential';
}

export function calculateSafeRangeConcurrency(
  accountCount: number,
  options?: RangeConcurrencyOptions,
): ConcurrencyBudget {
  const mode = options?.mode ?? 'sequential';
  const totalLimitMb = options?.overrideTotalMb ?? getContainerMemoryLimitMb();
  const usedMb = options?.overrideUsedMb ?? Math.floor(process.memoryUsage().rss / (1024 * 1024));
  const availableMb = options?.overrideAvailableMb ?? Math.max(0, totalLimitMb - usedMb);
  const perAccountMb = 45;

  if (mode === 'sequential' || accountCount <= 1) {
    return {
      concurrency: 1,
      totalLimitMb,
      usedMb,
      availableMb,
      perAccountMb,
      mode,
    };
  }

  const safetyBufferMb = 120; // reserved for Node runtime, GC headroom & background services
  const usableMb = Math.max(0, availableMb - safetyBufferMb);
  const memoryAllowed = Math.floor(usableMb / perAccountMb);

  let envMax = 5;
  if (process.env.RANGE_MAX_CONCURRENCY) {
    const parsed = parseInt(process.env.RANGE_MAX_CONCURRENCY, 10);
    if (!isNaN(parsed) && parsed > 0) envMax = parsed;
  }
  const maxCap = options?.maxConcurrency ?? envMax;

  // Safe concurrency: at least 1, at most accountCount, at most maxCap, at most memoryAllowed (fallback 1)
  const concurrency = Math.max(1, Math.min(accountCount, maxCap, Math.max(1, memoryAllowed)));

  return {
    concurrency,
    totalLimitMb,
    usedMb,
    availableMb,
    perAccountMb,
    mode: 'parallel',
  };
}

export interface StartRangeOptions extends RangeConcurrencyOptions {
  accountIds?: readonly string[];
  jobType?: 'range' | 'incomplete';
  incompleteCount?: number;
  customQuestions?: number[];
  resolveQuestions?: (account: AccountRecord, api: RangeApi) => Promise<readonly (number | { number: number; slug: string })[]>;
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
  mode?: 'parallel' | 'sequential';
  concurrency?: number;
  activeAccounts?: string[];
  jobType?: 'range' | 'incomplete';
  incompleteCount?: number;
  customQuestions?: number[];
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
  options?: StartRangeOptions;
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
  target: string | 'all' | readonly string[],
  deps: RangeDeps = defaultRangeDeps(),
  options?: StartRangeOptions,
): Promise<StartRangeResult> {
  let accounts: AccountRecord[];
  if (target === 'all') {
    accounts = await deps.listAccounts();
    if (options?.accountIds && options.accountIds.length > 0) {
      accounts = accounts.filter(
        (a) =>
          options.accountIds!.includes(a.id) ||
          options.accountIds!.includes(a.label) ||
          (a.username && options.accountIds!.includes(a.username)),
      );
    }
    if (accounts.length === 0) return { started: false, reason: 'no-accounts' };
  } else if (typeof target !== 'string') {
    const all = await deps.listAccounts();
    accounts = all.filter(
      (a) =>
        target.includes(a.id) ||
        target.includes(a.label) ||
        (a.username && target.includes(a.username)),
    );
    if (accounts.length === 0) return { started: false, reason: 'account-not-found' };
  } else {
    const account = await deps.getAccount(target);
    if (!account) return { started: false, reason: 'account-not-found' };
    accounts = [account];
  }

  // Re-check after the async account lookup: another request may have
  // started the active job while this request was resolving its accounts.
  // Also respect any existing queue so a newly-arrived request never jumps
  // ahead of jobs that were already waiting.
  if (activeJob || queuedJobs.length > 0) return enqueueRangeJob(range, accounts, deps, options);

  const job = createRangeJob(range, accounts, deps, options);
  return { started: true, accounts, done: job.done };
}

function createRangeJob(
  range: QuestionRange,
  accounts: AccountRecord[],
  deps: RangeDeps,
  options?: StartRangeOptions,
): RangeJob {
  const abort = new AbortController();
  const budget = calculateSafeRangeConcurrency(accounts.length, options);
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
    mode: budget.mode,
    concurrency: budget.concurrency,
    activeAccounts: [],
    jobType: options?.jobType,
    incompleteCount: options?.incompleteCount,
    customQuestions: options?.customQuestions,
  };
  const job: RangeJob = { info, abort, done: Promise.resolve([]) };
  activeJob = job;
  job.done = executeRangeJob(job, range, accounts, deps, options);
  return job;
}

function enqueueRangeJob(
  range: QuestionRange,
  accounts: AccountRecord[],
  deps: RangeDeps,
  options?: StartRangeOptions,
): Extract<StartRangeResult, { queued: true }> {
  let resolve!: (results: AccountRangeResult[]) => void;
  const done = new Promise<AccountRangeResult[]>((res) => {
    resolve = res;
  });
  const queued: QueuedRangeJob = {
    range: { ...range },
    accounts,
    deps,
    options,
    position: queuedJobs.length + 1,
    enqueuedAt: deps.now(),
    resolve,
  };
  queuedJobs.push(queued);
  logger.info(
    { position: queued.position, range, accounts: accounts.map((a) => a.label), mode: options?.mode },
    'range job queued behind active job',
  );
  return { started: false, queued: true, position: queued.position, accounts, done };
}

function startNextQueuedRangeJob(): void {
  if (activeJob) return;
  const queued = queuedJobs.shift();
  if (!queued) return;
  const job = createRangeJob(queued.range, queued.accounts, queued.deps, queued.options);
  job.done.then(queued.resolve);
}

async function executeRangeJob(
  job: RangeJob,
  range: QuestionRange,
  accounts: AccountRecord[],
  deps: RangeDeps,
  options?: StartRangeOptions,
): Promise<AccountRangeResult[]> {
  const { info, abort } = job;
  const all: AccountRangeResult[] = [];
  const stopKeepAlive = deps.keepAlive();
  const usedCommunityUuidsByQuestion = new Map<number, Set<string>>();
  const questionCache = new Map<string, RangeQuestionMetadata>();

  const budget = calculateSafeRangeConcurrency(accounts.length, options);
  info.mode = budget.mode;
  info.concurrency = budget.concurrency;
  info.activeAccounts = [];

  logger.info(
    {
      range,
      accountCount: accounts.length,
      mode: budget.mode,
      concurrency: budget.concurrency,
      totalLimitMb: budget.totalLimitMb,
      usedMb: budget.usedMb,
      availableMb: budget.availableMb,
    },
    'starting range job execution',
  );

  const concurrency = budget.concurrency;
  const results: AccountRangeResult[] = new Array(accounts.length);
  let numbers = info.customQuestions && info.customQuestions.length > 0
    ? [...info.customQuestions]
    : Array.from({ length: rangeSize(range) }, (_, i) => range.from + i);
  const reservations = new QuestionReservations();

  try {
    // Build once for the job so parallel workers receive coordinated starts.
    const orders = options?.jobType === 'incomplete'
      ? accounts.map(() => [...numbers])
      : (deps.questionOrder ? accounts.map(account => deps.questionOrder!(numbers, account.id)) :
      accountQuestionOrders(numbers, accounts.length));
    logger.info({ scheduling: 'distinct-starts-with-question-reservations', mode: budget.mode,
      firstQuestions: orders.map(order => order[0]), accountCount: accounts.length }, 'range question scheduling configured');
    let nextAccountIdx = 0;

    const runWorker = async (_workerId: number): Promise<void> => {
      while (!abort.signal.aborted) {
        if (nextAccountIdx >= accounts.length) break;
        const accountIdx = nextAccountIdx++;
        const account = accounts[accountIdx]!;

        if (!info.activeAccounts) info.activeAccounts = [];
        info.activeAccounts.push(account.label);
        info.currentLabel = info.activeAccounts.join(', ');
        info.accountIndex = Math.min(accounts.length, info.accountIndex + 1);

        try {
          const result = await runAccountRange(
            account,
            range,
            deps,
            info,
            abort.signal,
            accountIdx + 1,
            accounts.length,
            usedCommunityUuidsByQuestion,
            orders[accountIdx]!,
            reservations,
            questionCache,
            options,
          );
          results[accountIdx] = result;
          await deps
            .notify(formatAccountRangeSummary(result, accountIdx + 1, accounts.length))
            .catch((err) => logger.warn({ err: errText(err) }, 'range summary notification failed'));
        } finally {
          info.activeAccounts = (info.activeAccounts ?? []).filter((l) => l !== account.label);
          info.currentLabel = info.activeAccounts.length > 0 ? info.activeAccounts.join(', ') : null;
        }

        // Short breather before this worker picks up another account
        if (deps.questionGapMs > 0 && nextAccountIdx < accounts.length && !abort.signal.aborted) {
          const gap = concurrency === 1 ? deps.questionGapMs : Math.min(5000, deps.questionGapMs);
          await deps.sleep(gap, abort.signal);
        }
      }
    };

    const workerCount = Math.min(concurrency, accounts.length);
    const workers: Promise<void>[] = [];
    for (let w = 0; w < workerCount; w++) {
      const workerIdx = w;
      workers.push((async () => {
        if (workerIdx > 0 && !abort.signal.aborted) {
          await deps.sleep(workerIdx * 2000, abort.signal);
        }
        await runWorker(workerIdx);
      })());
    }
    await Promise.all(workers);

    for (const r of results) {
      if (r) all.push(r);
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
  plannedOrder: number[],
  reservations: QuestionReservations,
  questionCache: Map<string, RangeQuestionMetadata>,
  options?: StartRangeOptions,
): Promise<AccountRangeResult> {
  let numbers = info.customQuestions && info.customQuestions.length > 0
    ? [...info.customQuestions]
    : Array.from({ length: rangeSize(range) }, (_, i) => range.from + i);
  let order = [...plannedOrder];
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
    const attempted = new Set(result.results.map(item => item.number));
    result.notAttempted = numbers.filter(number => !attempted.has(number));
    result.finishedAt = deps.now();
    return result;
  };

  let session!: RangeSession;
  try {
    session = await deps.openSession(account, signal);
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
            session = await deps.openSession(account, signal);
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
        questionNumber: order[0]!,
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
      questionNumber: order[0]!,
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
          session = await deps.openSession(account, signal);
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
        questionNumber: order[0]!,
        detail: result.fatal,
      });
      return finish();
    }
    result.username = check.username ?? account.username;

    // Perform daily check-in (+1 LeetCoin)
    if (session.api.graphql) {
      await claimDailyCheckin({ graphql: session.api.graphql as never }, account.label).catch(() => undefined);
    }

    const resolvedSlugs = new Map<number, string>();
    let accountStepTotal = order.length || rangeSize(range);
    if (options?.resolveQuestions) {
      try {
        const resolved = await options.resolveQuestions(account, session.api);
        numbers = resolved.map(question => {
          if (typeof question === 'number') return question;
          if (question.slug) resolvedSlugs.set(question.number, question.slug);
          return question.number;
        });
        if (resolved.length === 0) {
          logger.info({ account: account.label }, 'no incomplete questions found');
          await deps.notify(`👤 Account ${index}/${total}: ${who(result)}\n🎉 All checked questions are already accepted on this account!`).catch(() => undefined);
          return finish();
        }
        order = [...numbers];
        accountStepTotal = order.length || rangeSize(range);
      } catch (err) {
        const errMsg = errText(err);
        logger.warn({ account: account.label, err: errMsg }, 'failed to resolve incomplete questions for account');
        result.fatal = `failed to resolve incomplete questions: ${errMsg}`;
        void deps.onProgress?.({
          phase: 'error',
          label: account.label,
          username: account.username,
          accIndex: index - 1,
          accTotal: total,
          stepIndex: 1,
          stepTotal: accountStepTotal,
          questionNumber: order[0] ?? range.from,
          detail: result.fatal,
        });
        await deps.notify(`❌ Account ${index}/${total}: ${who(result)}\n⚠️ Failed to lookup incomplete questions: ${errMsg}`).catch(() => undefined);
        return finish();
      }
    }

    await deps
      .notify(
        `👤 Account ${index}/${total}: ${who(result)}\n🎯 ${info.jobType === 'incomplete' ? `${numbers.length} Incomplete Questions (${numbers.slice(0, 5).map(n => `#${n}`).join(', ')}${numbers.length > 5 ? '…' : ''})` : `Questions #${range.from}–#${range.to} (${numbers.length})`} — starting now`,
      )
      .catch(() => undefined);

    let blockedStreak = 0;
    let cooledDown = false;
    let accountDone = 0;

    logger.info({ accountId: account.id, count: order.length, firstQuestions: order.slice(0, 10) }, 'account question range shuffled');
    const pending = [...order];
    while (pending.length) {
      if (signal.aborted) break;
      await waitForDailyRun(deps, info, signal);
      if (signal.aborted) break;

      const n = await reservations.claim(pending, signal, () => {
        void deps.onProgress?.({ phase: 'waiting-question', label: account.label, username: result.username,
          accIndex: index - 1, accTotal: total, stepIndex: result.results.length + 1,
          stepTotal: accountStepTotal, questionNumber: pending[0]!,
          detail: 'Waiting for another account to finish a remaining question' });
      });
      if (n === null) break;
      pending.splice(pending.indexOf(n), 1);
      const stepIndex = result.results.length + 1;
      const stepTotal = accountStepTotal;
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
      let solved: OneOutcome;
      try {
        logger.info({ accountId: account.id, question: n, stepIndex }, 'range question reserved');
        solved = await solveOneWithRetries(n, session.api, deps, signal, usedUuids, progressCtx, {
          slugHint: resolvedSlugs.get(n),
          questionCache,
          renewSession: async () => {
            if (!deps.refreshAccount) return null;
            const renewal = await deps.refreshAccount(account).catch(() => null);
            if (renewal?.status !== 'refreshed' && renewal?.status !== 'valid') return null;
            const updated = await deps.getAccount(account.id);
            if (!updated) return null;
            const replacement = await deps.openSession(updated, signal);
            let identity: SessionCheckResult;
            try { identity = await replacement.api.checkSession(); }
            catch (error) { await replacement.close().catch(() => undefined); throw error; }
            if (!identity.authenticated || !identity.username ||
              (result.username && identity.username.toLowerCase() !== result.username.toLowerCase())) {
              await replacement.close(); return null;
            }
            await session.close().catch(() => undefined);
            account = updated; session = replacement;
            return replacement.api;
          },
        });
      } finally {
        reservations.release(n);
      }
      const { outcome, touchedLeetCode, blocked, submissionLimit } = solved;
      if (outcome === null) break; // cancelled during a back-off wait
      result.results.push(outcome);
      accountDone++;
      info.doneInAccount++;
      info.counts[outcome.status]++;
      logger.info({ label: account.label, question: n, status: outcome.status, detail: outcome.detail }, 'range question finished');

      if (submissionLimit) {
        result.stoppedEarly = 'submission-limit';
        logger.warn({ account: account.label, question: n }, 'terminating flow for account due to LeetCode submission limit');
        await deps
          .notify(
            `🛑 Account ${index}/${total}: ${who(result)}\n⚠️ LeetCode daily submission limit reached on #${n}. Terminating flow for this account.`
          )
          .catch(() => undefined);
        break;
      }

      if (deps.progressEvery > 0 && accountDone % deps.progressEvery === 0 && stepIndex < order.length) {
        const c = info.counts;
        await deps
          .notify(`📈 ${who(result)}: ${accountDone}/${rangeSize(range)} done — ✅ ${c.accepted} · ❌ ${c.failed} · ⚠️ ${c.error}`)
          .catch(() => undefined);
      }

      // Blocked handling: a streak means LeetCode is refusing this IP/session.
      blockedStreak = blocked ? blockedStreak + 1 : 0;
      if (!blocked) cooledDown = false;
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

      if (deps.questionGapMs > 0 && stepIndex < order.length && touchedLeetCode && !signal.aborted) {
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
      stepIndex: result.results.length,
      stepTotal: accountStepTotal,
      questionNumber: result.results.at(-1)?.number ?? order[0]!,
    });

    if (signal.aborted) result.stoppedEarly = 'cancelled';
    return finish();
  } catch (err) {
    result.fatal = `unexpected: ${errText(err)}`;
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
  submissionLimit?: boolean;
  sessionFailure?: boolean;
}

async function solveOneWithRetries(
  n: number,
  api: RangeApi,
  deps: RangeDeps,
  signal: AbortSignal,
  usedCommunityUuids?: Set<string>,
  progressCtx?: RangeProgressContext,
  { renewSession, ...lookup }: RangeQuestionLookup & { renewSession?: () => Promise<RangeApi | null> } = {},
): Promise<OneOutcome> {
  let touched = false;
  let renewed = false;
  for (let attempt = 0; ; attempt++) {
    const r = await solveOne(n, api, deps, usedCommunityUuids, progressCtx, signal, lookup);
    touched ||= r.touchedLeetCode;
    if (r.sessionFailure && !renewed && renewSession && !signal.aborted) {
      renewed = true;
      const replacement = await renewSession().catch(() => null);
      if (replacement) { api = replacement; continue; }
    }
    if (r.submissionLimit || (r.blocked && r.outcome.submissionId)) return { ...r, touchedLeetCode: touched };
    if (!r.blocked) {
      if (r.sessionFailure && progressCtx) void deps.onProgress?.({ ...progressCtx, phase: 'error', questionNumber: n, detail: r.outcome?.detail });
      return { ...r, touchedLeetCode: touched };
    }
    const wait = retryDelay(deps.blockedBackoffMs[attempt], r.retryAfterMs);
    if (wait === undefined) {
      if (progressCtx) void deps.onProgress?.({ ...progressCtx, phase: 'error', questionNumber: n, detail: r.outcome?.detail });
      return { ...r, touchedLeetCode: touched };
    }
    logger.warn({ question: n, attempt: attempt + 1, waitMs: wait }, 'LeetCode blocked the request - backing off before retrying');
    await deps.sleep(wait, signal);
    if (signal.aborted) return { outcome: null, touchedLeetCode: touched, blocked: true };
  }
}

function retryDelay(backoff: number | undefined, retryAfterMs?: number): number | undefined {
  if (backoff !== undefined && retryAfterMs !== undefined) {
    return Math.max(1_000, retryAfterMs);
  }
  return backoff;
}

function isMissingWalkcccPage(error: unknown): boolean {
  return error instanceof WalkcccError && /^no walkccc page for problem\b/i.test(error.message);
}

const PREFERRED_LANGUAGE_ORDER = [
  'cpp',
  'mysql',
  'postgresql',
  'mssql',
  'oraclesql',
  'pythondata',
  'python3',
  'python',
  'java',
  'javascript',
  'typescript',
  'bash',
  'c',
  'csharp',
  'golang',
  'rust',
  'ruby',
  'swift',
  'kotlin',
  'php',
  'scala',
  'dart',
] as const;

const LANGUAGE_RANK = new Map<string, number>(PREFERRED_LANGUAGE_ORDER.map((l, i) => [l, i]));
const MAX_COMMUNITY_LANGUAGE_PROBES = 4;

function pickCandidateSnippets(
  codeSnippets?: RawQuestionData['codeSnippets'],
  fallbackCppStarter?: string,
): Array<{ langSlug: string; code: string }> {
  if (codeSnippets?.length) {
    return [...codeSnippets]
      .filter((s) => Boolean(s?.langSlug))
      .sort((a, b) => (LANGUAGE_RANK.get(a.langSlug) ?? 999) - (LANGUAGE_RANK.get(b.langSlug) ?? 999))
      .map((s) => ({ langSlug: s.langSlug, code: s.code ?? '' }));
  }
  if (fallbackCppStarter !== undefined) {
    return [{ langSlug: 'cpp', code: fallbackCppStarter }];
  }
  return [];
}

function buildProblemForLanguage(
  n: number,
  slug: string,
  questionTitle: string,
  q: RangeQuestionMetadata,
  snippet: { langSlug: string; code: string },
): ParsedProblem {
  if (q.contentHtml) {
    try {
      return parseProblem(
        {
          questionId: q.questionId,
          isPaidOnly: q.isPaidOnly,
          frontendId: q.frontendId || String(n),
          title: questionTitle,
          slug,
          difficulty: q.difficulty,
          contentHtml: q.contentHtml,
          exampleTestcases: q.exampleTestcases ?? '',
          metaData: q.metaData ?? null,
          codeSnippets: q.codeSnippets?.length
            ? q.codeSnippets
            : [{ lang: snippet.langSlug, langSlug: snippet.langSlug, code: snippet.code }],
          topicTags: q.topicTags ?? [],
        },
        snippet.langSlug,
      );
    } catch {
      // Fall back to minimal problem descriptor when HTML is empty or stubbed in tests.
    }
  }
  return {
    questionId: q.questionId ?? null,
    frontendId: q.frontendId || String(n),
    slug,
    title: questionTitle,
    difficulty: q.difficulty,
    descriptionText: questionTitle,
    descriptionHtml: q.contentHtml ?? '',
    examples: [],
    constraints: [],
    exampleTestcasesRaw: q.exampleTestcases ?? '',
    starterCode: snippet.code,
    language: snippet.langSlug,
  };
}

/** Solves + submits ONE question. Never throws. */
async function solveOne(
  n: number,
  api: RangeApi,
  deps: RangeDeps,
  usedCommunityUuids?: Set<string>,
  progressCtx?: RangeProgressContext,
  signal?: AbortSignal,
  { slugHint, questionCache }: RangeQuestionLookup = {},
): Promise<{ outcome: QuestionResult; touchedLeetCode: boolean; blocked: boolean; submissionLimit?: boolean; sessionFailure?: boolean; retryAfterMs?: number }> {
  let questionTitle: string | null = null;
  let slug: string | null = slugHint || null;
  let stage = 'question';
  let submittedId: string | undefined;

  const err = (detail: string, touched = true, blocked = false, submissionId?: string) => {
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
        submissionId,
      });
    }
    return {
      outcome: { number: n, status: 'error' as const, detail, ...(submissionId && { submissionId }) },
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

  // Incomplete-question discovery already supplies a LeetCode slug. Load the
  // Walkccc page only to resolve a bare number or to get the fallback code.
  let walkcccPage: Promise<WalkcccPage | null> | undefined;
  const getWalkcccPage = () => walkcccPage ??= deps.getPage(n).catch(error => {
    if (!isMissingWalkcccPage(error)) {
      logger.warn({ question: n, err: shortErr(error) }, 'walkccc getPage failed');
    }
    return null;
  });

  try {
    const graphql = rangeGraphql(api);
    if (!slug) {
      const page = await getWalkcccPage();
      slug = page?.slug ?? null;
      questionTitle = page?.title ?? null;
    }
    if (!slug && deps.resolveSlug) {
      slug = graphql ? await deps.resolveSlug(n, { graphql }) : await deps.resolveSlug(n);
    }
    if (!slug) return err('no walkccc page', false);

    // 2) Premium check: locked questions are skipped before touching solutions or judge
    let cachedQ = questionCache?.get(slug);
    if (!cachedQ) {
      const {
        questionId,
        isPaidOnly,
        title,
        difficulty,
        codeSnippets,
        slug: returnedSlug,
        frontendId,
        contentHtml,
        exampleTestcases,
        metaData,
        topicTags,
      } = await api.question(slug);
      cachedQ = {
        questionId,
        isPaidOnly,
        title,
        difficulty,
        starterCode: codeSnippets?.find(snippet => snippet.langSlug === 'cpp')?.code,
        codeSnippets,
        contentHtml,
        exampleTestcases,
        metaData,
        frontendId,
        topicTags,
      };
      // Public submission metadata is the same for every authenticated account in this job.
      // Keep only the fields used by the solver and let failures be retried normally.
      if (
        questionCache &&
        questionCache.size < MAX_RANGE_SIZE &&
        !isPaidOnly &&
        questionId &&
        (codeSnippets?.length || cachedQ.starterCode) &&
        returnedSlug === slug &&
        Number(frontendId) === n
      ) {
        questionCache.set(slug, cachedQ);
      }
    }
    const q: RangeQuestionMetadata = cachedQ;
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

    const candidateSnippets = pickCandidateSnippets(q.codeSnippets, q.starterCode);
    if (candidateSnippets.length === 0) {
      logger.info({ question: n, slug }, 'range question has no code editor/snippet - skipping');
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
          verdict: 'Skipped (no code editor)',
        });
      }
      return { outcome: { number: n, status: 'premium', detail: 'no code snippet for this question' }, touchedLeetCode: true, blocked: false };
    }

    const failureState = deps.questionFailures
      ? await deps.questionFailures.get(n).catch(() => ({ failures: 0, failedUuids: [] as string[], updatedAt: '' }))
      : { failures: 0, failedUuids: [] as string[], updatedAt: '' };
    const excludeUuids = new Set<string>([
      ...(usedCommunityUuids ?? []),
      ...failureState.failedUuids,
    ]);

    const getWalkcccForLang = async (langSlug: string, problem: ParsedProblem): Promise<string | null> => {
      const page = await getWalkcccPage();
      if (!page) return null;
      if (langSlug === 'cpp') {
        return page.code && signatureMatchesStarter(page.code, problem) ? page.code : null;
      }
      return page.byLanguage?.[langSlug] ?? null;
    };

    // Retry verdict reads against the SAME ID; a polling failure must never
    // restart the irreversible submission or choose another source solution.
    const readVerdict = async (id: string) => {
      stage = 'verdict'; submittedId = id;
      for (let attempt = 0; ; attempt++) {
        if (progressCtx) void deps.onProgress?.({ ...progressCtx, phase: 'verdict', questionNumber: n, questionTitle, slug, submissionId: id });
        try { return await api.awaitResult(id, slug!); }
        catch (error) {
          const failure = leetCodeRequestFailure(error);
          logger.warn({ question: n, account: progressCtx?.label, stage, submissionId: id, category: failure.category }, 'range verdict request failed');
          const wait = retryDelay(deps.blockedBackoffMs[attempt], error instanceof LeetCodeHttpError ? error.retryAfterMs : undefined);
          if (!looksLikeChallenge(error) || wait === undefined || signal?.aborted) throw error;
          if (progressCtx) void deps.onProgress?.({ ...progressCtx, phase: 'blocked', questionNumber: n, questionTitle: questionTitle!, slug: slug!,
            submissionId: id, detail: `${failure.detail}; retrying verdict in ${Math.ceil(wait / 1000)}s` });
          await deps.sleep(wait, signal ?? new AbortController().signal);
          if (signal?.aborted) throw Error('Verdict polling cancelled; submission already sent');
        }
      }
    };
    const sendCode = async (code: string, lang: string) => {
      stage = 'submit';
      if (signal?.aborted) throw Error('Range cancelled before submission');
      const progress = progressCtx && { ...progressCtx, questionNumber: n, questionTitle, slug };
      try {
        return await api.submit({ slug: slug!, questionId, lang, code }, progress && {
          onWait: ({ ms, reason }) => { void deps.onProgress?.({ ...progress, phase: 'waiting-submit', waitSeconds: Math.ceil(ms / 1000), waitReason: reason }); },
          onSend: () => { void deps.onProgress?.({ ...progress, phase: 'submitting', ...(lang !== 'cpp' ? { detail: lang } : {}) }); },
        });
      } catch (submitErr) {
        const failure = leetCodeRequestFailure(submitErr);
        const canUpgradeGhost =
          typeof api.submitWithBrowserFallback === 'function' &&
          !signal?.aborted &&
          !(submitErr instanceof LeetCodeHttpError && submitErr.status === 200) &&
          (failure.category === 'challenge' ||
            failure.category === 'access-denied' ||
            failure.category === 'session-csrf');
        if (!canUpgradeGhost) throw submitErr;

        logger.warn(
          {
            account: progressCtx?.label,
            question: n,
            slug,
            language: lang,
            category: failure.category,
            httpStatus: submitErr instanceof LeetCodeHttpError ? submitErr.status : undefined,
            rawErr: shortErr(submitErr),
          },
          'API submit challenged/rejected; retrying via ghost-mode stealth Chromium session',
        );
        if (progress) {
          void deps.onProgress?.({
            ...progress,
            phase: 'submitting',
            detail: `${lang} · ghost browser`,
          });
        }
        return await api.submitWithBrowserFallback!({ slug: slug!, questionId, lang, code }, signal);
      }
    };

    // 4) Submit with comment-stripping fallback (C++ only) + judge failure fallback
    const submitCode = async (code: string, lang: string) => {
      const strippedCode = lang === 'cpp' ? stripCppComments(code) : code;
      const useStripped = lang === 'cpp' && strippedCode.trim().length > 0 && strippedCode !== code;
      const codeToTryFirst = useStripped ? strippedCode : code;
      const subId = await sendCode(codeToTryFirst, lang);

      let verdict = await readVerdict(subId);

      if (useStripped && verdict.classification !== 'UNKNOWN' && shouldRetryWithOriginal(verdict.statusDisplay)) {
        logger.warn(
          { question: n, slug, verdict: verdict.statusDisplay },
          'comment-stripped code failed with compile/runtime error; retrying with original code',
        );
        const retrySubId = await sendCode(code, lang);
        verdict = await readVerdict(retrySubId);
        return { verdict, submissionId: retrySubId, code };
      }

      return { verdict, submissionId: subId, code };
    };

    const emitAccepted = async (lang: string, code: string, subId: string, sourceTag?: string) => {
      await deps.questionFailures?.reset(n).catch(() => undefined);
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
          slug: slug!,
          verdict: 'Accepted',
          ...(sourceTag || lang !== 'cpp' ? { detail: sourceTag ? `${sourceTag} · ${lang}` : lang } : {}),
          submissionId: subId,
        });
      }
      return {
        outcome: {
          number: n,
          status: 'accepted' as const,
          submissionId: subId,
          capture: { slug: slug!, title: questionTitle!, difficulty: q!.difficulty, language: lang, code },
        },
        touchedLeetCode: true,
        blocked: false,
      };
    };

    const emitJudgeTimeout = (subId: string) => {
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
          slug: slug!,
          detail: 'judge timeout',
          submissionId: subId,
        });
      }
      return {
        outcome: { number: n, status: 'error' as const, detail: 'judge timeout', submissionId: subId },
        touchedLeetCode: true,
        blocked: false,
      };
    };

    const emitJudgeFailed = async (
      statusDisplay: string,
      subId: string,
      lang: string,
      communityUuid?: string,
      sourceTag?: string,
    ) => {
      const updated = await deps.questionFailures
        ?.recordFailure(n, {
          reason: `${sourceTag ? `${sourceTag} ` : ''}(${lang}): ${statusDisplay}`,
          ...(communityUuid && { communityUuid }),
        })
        .catch(() => null);
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
          slug: slug!,
          verdict: statusDisplay,
          ...(updated || sourceTag || lang !== 'cpp'
            ? {
                detail: [
                  sourceTag ?? (lang !== 'cpp' ? lang : ''),
                  updated ? `attempt ${updated.failures}/${AI_SOLVE_FAILURE_THRESHOLD + 1}` : '',
                ]
                  .filter(Boolean)
                  .join(' · '),
              }
            : {}),
          submissionId: subId,
        });
      }
      return {
        outcome: { number: n, status: 'failed' as const, detail: statusDisplay, submissionId: subId },
        touchedLeetCode: true,
        blocked: false,
      };
    };

    // On the 4th+ attempt after 3 solution-section failures, invoke configured AI first.
    let aiError: string | null = null;
    if (failureState.failures >= AI_SOLVE_FAILURE_THRESHOLD && deps.solveWithAi) {
      const aiSnippet = candidateSnippets[0]!;
      const aiProblem = buildProblemForLanguage(n, slug, questionTitle, q, aiSnippet);
      logger.info(
        { question: n, slug, language: aiSnippet.langSlug, priorFailures: failureState.failures },
        'solution section failed 3+ times; invoking AI solver with configured keys',
      );
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
          questionTitle,
          slug,
          detail: `Using AI (${aiSnippet.langSlug}) after ${failureState.failures} failures`,
        });
      }
      try {
        const aiResult = await deps.solveWithAi(aiProblem, aiSnippet.langSlug);
        const aiSubmit = await submitCode(aiResult.code, aiSnippet.langSlug);
        if (aiSubmit.verdict.classification === 'ACCEPTED') {
          return emitAccepted(aiSnippet.langSlug, aiSubmit.code, aiSubmit.submissionId, 'AI');
        }
        if (aiSubmit.verdict.classification === 'UNKNOWN') {
          return emitJudgeTimeout(aiSubmit.submissionId);
        }
        return emitJudgeFailed(aiSubmit.verdict.statusDisplay, aiSubmit.submissionId, aiSnippet.langSlug, undefined, 'AI');
      } catch (errVal) {
        if (looksLikeChallenge(errVal) || isSubmissionLimitError(errVal)) throw errVal;
        aiError = shortErr(errVal);
        logger.warn({ question: n, slug, language: aiSnippet.langSlug, err: aiError }, 'AI solver attempt failed; falling back to solution section');
      }
    }

    const languagesToTry = candidateSnippets.slice(0, MAX_COMMUNITY_LANGUAGE_PROBES);
    let chosenLang = languagesToTry[0]!.langSlug;
    let chosenProblem = buildProblemForLanguage(n, slug, questionTitle, q, languagesToTry[0]!);
    let communityCode: string | undefined;
    let communityUuid: string | undefined;
    let communityError: unknown;
    let walkcccOnlyCode: string | undefined;

    for (const snippet of languagesToTry) {
      const langProblem = buildProblemForLanguage(n, slug, questionTitle, q, snippet);
      if (deps.fetchCommunity) {
        try {
          const commSol = await deps.fetchCommunity(slug, langProblem, {
            language: snippet.langSlug,
            excludeUuids,
            randomize: true,
            ...(graphql && { graphql }),
          });
          if (commSol?.code) {
            usedCommunityUuids?.add(commSol.uuid);
            excludeUuids.add(commSol.uuid);
            communityCode = commSol.code;
            communityUuid = commSol.uuid;
            chosenLang = snippet.langSlug;
            chosenProblem = langProblem;
            break;
          }
        } catch (commErr) {
          communityError = commErr;
          if (looksLikeChallenge(commErr)) throw commErr;
          logger.warn(
            { question: n, slug, language: snippet.langSlug, err: shortErr(commErr) },
            'community solution fetch failed for language; checking fallback',
          );
        }
      }

      const walkCode = await getWalkcccForLang(snippet.langSlug, langProblem);
      if (walkCode) {
        walkcccOnlyCode = walkCode;
        chosenLang = snippet.langSlug;
        chosenProblem = langProblem;
        break;
      }
    }

    const solutionCode = communityCode || walkcccOnlyCode;

    if (!solutionCode) {
      if (looksLikeChallenge(communityError)) throw communityError;
      const reason = aiError
        ? `AI solver failed (${aiError}) and no valid solution found`
        : !deps.fetchCommunity && languagesToTry.length === 1 && chosenLang === 'cpp'
          ? 'no walkccc C++ solution for this question'
          : languagesToTry.length === 1 && chosenLang === 'cpp'
            ? 'no valid C++ solution found'
            : 'no valid solution found';
      await deps.questionFailures?.recordFailure(n, { reason }).catch(() => undefined);
      return err(reason);
    }

    let { verdict, submissionId, code: acceptedCode } = await submitCode(solutionCode, chosenLang);

    if (communityCode && verdict.classification !== 'ACCEPTED' && verdict.classification !== 'UNKNOWN') {
      const fallbackCode = await getWalkcccForLang(chosenLang, chosenProblem);
      if (fallbackCode && fallbackCode !== solutionCode) {
        logger.warn({ question: n, slug, language: chosenLang, verdict: verdict.statusDisplay }, 'judge rejected the solution; trying the alternate source');
        ({ verdict, submissionId, code: acceptedCode } = await submitCode(fallbackCode, chosenLang));
      }
    }

    if (verdict.classification === 'ACCEPTED') {
      return emitAccepted(chosenLang, acceptedCode, submissionId);
    }
    if (verdict.classification === 'UNKNOWN') {
      return emitJudgeTimeout(submissionId);
    }
    return emitJudgeFailed(verdict.statusDisplay, submissionId, chosenLang, communityUuid);
  } catch (e) {
    const failure = leetCodeRequestFailure(e);
    logger.warn({
      account: progressCtx?.label,
      question: n,
      slug,
      stage,
      submissionId: submittedId,
      category: failure.category,
      httpStatus: e instanceof LeetCodeHttpError ? e.status : undefined,
      rawErr: shortErr(e),
      reason: failure.detail,
    }, 'range request failed');
    if (isSubmissionLimitError(e)) {
      const msg = `LeetCode submission limit reached: ${shortErr(e)}`;
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
          detail: msg,
        });
      }
      return {
        outcome: { number: n, status: 'error', detail: msg },
        touchedLeetCode: true,
        blocked: false,
        submissionLimit: true,
      };
    }
    if (stage === 'submit' && (failure.category === 'unknown-submit-response' ||
      (e instanceof LeetCodeHttpError && ((e.status === 200 && failure.category === 'challenge') || (e.status ?? 0) >= 500)) ||
      /timed? ?out|timeout|econnreset|socket hang up/i.test(errText(e)))) {
      return err('Submission outcome unknown; check LeetCode submission history before retrying');
    }
    if (submittedId) {
      const detail = stage === 'verdict'
        ? `Submission #${submittedId} sent; verdict unconfirmed: ${failure.detail}`
        : `Submission #${submittedId} judged; follow-up request failed: ${failure.detail}`;
      return err(detail, true, looksLikeChallenge(e), submittedId);
    }
    if (failure.category === 'session-csrf' || failure.category === 'session-auth') {
      return { outcome: { number: n, status: 'error', detail: failure.detail }, touchedLeetCode: true, blocked: false, sessionFailure: true };
    }
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
          detail: `${failure.detail}${e instanceof LeetCodeHttpError && e.retryAfterMs !== undefined ? `; retry after ${Math.ceil(e.retryAfterMs / 1000)}s` : ''}`,
        });
      }
      // The temporary notice is an active status, not a completed-question
      // error. Emit the final error only after bounded retries are exhausted.
      return { outcome: { number: n, status: 'error', detail: failure.detail }, touchedLeetCode: true, blocked: true,
        retryAfterMs: e instanceof LeetCodeHttpError ? e.retryAfterMs : undefined };
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
  if (r.stoppedEarly === 'submission-limit') {
    lines.push('', `🛑 Stopped early: LeetCode daily submission limit reached — ${r.notAttempted.length} not attempted`);
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
  const isParallel = j.mode === 'parallel' && (j.concurrency ?? 1) > 1;
  const modeStr = isParallel
    ? ` · ⚡ Parallel (${j.concurrency}x)`
    : ' · 🐢 Sequential';
  const lines = [
    j.jobType === 'incomplete'
      ? `⏳ Incomplete questions solver in progress (${j.incompleteCount ?? size} questions)${modeStr}`
      : `⏳ Question-range job in progress (#${j.range.from}–#${j.range.to})${modeStr}`,
    j.activeAccounts && j.activeAccounts.length > 1
      ? `👥 Active accounts (${j.activeAccounts.length}/${j.accountLabels.length}): ${j.activeAccounts.join(', ')}`
      : `👤 Account ${j.accountIndex}/${j.accountLabels.length}: ${j.currentLabel ?? '—'}`,
    isParallel
      ? `📍 ${j.doneInAccount}/${size * j.accountLabels.length} submissions done${j.currentQuestion ? ` — latest on #${j.currentQuestion}` : ''}`
      : `📍 ${j.doneInAccount}/${size} done${j.currentQuestion ? ` — now on #${j.currentQuestion}` : ''}`,
    `✅ ${j.counts.accepted} · ❌ ${j.counts.failed} · ⚠️ ${j.counts.error}${j.counts.premium ? ` · 🔒 ${j.counts.premium}` : ''}`,
    `⏱️ Running for ${formatDuration(now - j.startedAt)}`,
  ];
  if (queuedCount > 0) lines.push(`🗂️ Queue: ${queuedCount} waiting`);
  if (j.pausedReason) lines.push(`⏸️ Paused: ${j.pausedReason}`);
  if (j.cancelling) lines.push('🛑 Cancelling — stopping after the current question');
  else lines.push('', 'Send /cancelrange to stop it.');
  return lines.join('\n');
}

/** Rough duration at full utilization of the shared submit slots plus the last verdict. */
export function estimateAccountMs(range: QuestionRange, gapMs: number): number {
  return Math.max(0, rangeSize(range) - 1) * gapMs + 8_000;
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
const serverRangeGate = new RangeRequestGate();

/** One HTTP session carrying the account's cookies, transport UA, and proxy, with ghost-mode Chromium upgrade on challenge. */
export async function openRequestSession(
  account: AccountRecord,
  signal?: AbortSignal,
  sessionDeps: {
    resolveProxy?: typeof resolveLeetCodeResidentialProxy;
    submitGhost?: typeof submitViaGhostBrowser;
    openGhostSession?: typeof openGhostBrowserSession;
    persistCookies?: typeof persistRotatedCookiesFromContext;
    gate?: RangeRequestGate;
  } = {},
): Promise<RangeSession> {
  const state = parseStoredStorageState(account.storageState);
  if (!state.ok) throw new Error(state.error);

  const initialState = state.state;
  const resolveProxy = sessionDeps.resolveProxy ?? resolveLeetCodeResidentialProxy;
  const customGhostSubmit = sessionDeps.submitGhost;
  const openGhost = sessionDeps.openGhostSession ?? openGhostBrowserSession;
  const persistCookies = sessionDeps.persistCookies ?? persistRotatedCookiesFromContext;
  const gate = sessionDeps.gate ?? serverRangeGate;

  const proxyUrl = initialState.transport?.proxyUrl ?? (await resolveProxy())?.url;
  const proxy = proxyUrl ? toPlaywrightProxy(proxyUrl) : undefined;
  if (proxyUrl && !proxy) {
    throw new Error('LEETCODE_PROXY_INVALID');
  }
  const userAgent = initialState.transport?.userAgent ?? USER_AGENT;

  const createCtx = (s: StorageStateShape) =>
    playwrightRequest.newContext({
      userAgent,
      proxy,
      storageState: {
        cookies: deduplicateLeetCodeCookies(s.cookies ?? []) as never,
        origins: [],
      },
      extraHTTPHeaders: buildBrowserClientHeaders(userAgent),
    });

  let currentState: StorageStateShape = {
    ...initialState,
    cookies: deduplicateLeetCodeCookies(initialState.cookies ?? []),
    transport: initialState.transport ?? (proxyUrl ? { proxyUrl, userAgent } : { userAgent }),
  };
  let activeCtx = await createCtx(currentState);

  const syncContextFromStorage = async (nextState: StorageStateShape) => {
    const mergedState: StorageStateShape = {
      ...nextState,
      cookies: deduplicateLeetCodeCookies(nextState.cookies ?? []),
      transport: nextState.transport ?? currentState.transport,
      origins: nextState.origins?.length ? nextState.origins : currentState.origins,
    };
    const previousCtx = activeCtx;
    activeCtx = await createCtx(mergedState);
    currentState = mergedState;
    await previousCtx.dispose().catch(() => undefined);
    await persistCookies(account, initialState, { storageState: async () => mergedState }).catch(() => false);
  };

  const requestProxy = {
    get: (...args: Parameters<typeof activeCtx.get>) => activeCtx.get(...args),
    post: (...args: Parameters<typeof activeCtx.post>) => activeCtx.post(...args),
    head: (...args: Parameters<typeof activeCtx.head>) => activeCtx.head(...args),
    delete: (...args: Parameters<typeof activeCtx.delete>) => activeCtx.delete(...args),
    fetch: (...args: Parameters<typeof activeCtx.fetch>) => activeCtx.fetch(...args),
    put: (...args: Parameters<typeof activeCtx.put>) => activeCtx.put(...args),
    patch: (...args: Parameters<typeof activeCtx.patch>) => activeCtx.patch(...args),
    storageState: (...args: Parameters<typeof activeCtx.storageState>) => activeCtx.storageState(...args),
    dispose: () => activeCtx.dispose(),
  };

  const cookieJar = {
    request: requestProxy,
    cookies: async (url?: string | readonly string[]) => {
      const storage = await activeCtx.storageState();
      const nowSec = Date.now() / 1000;
      const all = (storage.cookies ?? []).filter(
        (c) => !c.expires || c.expires <= 0 || c.expires > nowSec,
      );
      const targetUrl = typeof url === 'string' ? url : Array.isArray(url) ? url[0] : undefined;
      return targetUrl ? all.filter((c) => cookieMatchesOrigin(c.domain, targetUrl)) : all;
    },
  };
  const cancelled = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, cancelled.signal]) : cancelled.signal;
  const api = new LeetCodeApi(cookieJar as never, {
    beforeRequest: (deadline) => gate.wait(false, abortableSleep, requestSignal, undefined, deadline),
    observe: (error) => gate.observe(error),
    signal: requestSignal,
    timeoutMs: 20_000,
  });
  let ghostSession: GhostBrowserSession | null = null;
  let preferGhostSubmit = false;
  let ghostSyncedDuringSubmit = false;

  const ensureGhostSession = async (): Promise<GhostBrowserSession> => {
    if (ghostSession) return ghostSession;
    const snapshot = await activeCtx.storageState().catch(() => null);
    const latestState: StorageStateShape = snapshot
      ? {
          ...currentState,
          cookies: snapshot.cookies as StorageStateShape['cookies'],
        }
      : currentState;
    ghostSession = await openGhost(latestState, {
      userAgent,
      proxyUrl,
      onStorageState: async (nextState) => {
        ghostSyncedDuringSubmit = true;
        await syncContextFromStorage(nextState);
      },
    });
    return ghostSession;
  };

  return {
    api: {
      checkSession: () => checkSession(api),
      question: (slug) => fetchQuestionData(api, slug),
      submit: async (p, progress) => {
        if (!customGhostSubmit && preferGhostSubmit && ghostSession) {
          await gate.wait(true, abortableSleep, requestSignal, progress?.onWait);
          progress?.onSend();
          ghostSyncedDuringSubmit = false;
          try {
            const res = await ghostSession.submit({
              slug: p.slug,
              questionId: p.questionId,
              lang: p.lang,
              code: p.code,
              signal: requestSignal,
            });
            if (!ghostSyncedDuringSubmit) {
              await syncContextFromStorage(res.storageState);
            }
            gate.clearCooldown();
            return res.submissionId;
          } catch (err) {
            gate.observe(err);
            throw err;
          }
        }
        return api.submitSolution(p, async () => {
          await gate.wait(true, abortableSleep, requestSignal, progress?.onWait);
          progress?.onSend();
        });
      },
      submitWithBrowserFallback: async (p, fallbackSignal) => {
        const effectiveSignal = fallbackSignal ?? requestSignal;
        if (customGhostSubmit) {
          const snapshot = await activeCtx.storageState().catch(() => null);
          const latestState: StorageStateShape = snapshot
            ? {
                ...currentState,
                cookies: snapshot.cookies as StorageStateShape['cookies'],
              }
            : currentState;
          let synced = false;
          const ghostResult = await customGhostSubmit(
            latestState,
            {
              slug: p.slug,
              questionId: p.questionId,
              lang: p.lang,
              code: p.code,
              userAgent,
              proxyUrl,
              onStorageState: async (nextState) => {
                synced = true;
                await syncContextFromStorage(nextState);
              },
            },
            effectiveSignal,
          );
          if (!synced) {
            await syncContextFromStorage(ghostResult.storageState);
          }
          gate.clearCooldown();
          return ghostResult.submissionId;
        }

        const hadExistingSession = Boolean(ghostSession && preferGhostSubmit);
        if (hadExistingSession) {
          await ghostSession?.close().catch(() => undefined);
          ghostSession = null;
        }
        const activeGhost = await ensureGhostSession();
        preferGhostSubmit = true;
        ghostSyncedDuringSubmit = false;
        const ghostResult = await activeGhost.submit({
          slug: p.slug,
          questionId: p.questionId,
          lang: p.lang,
          code: p.code,
          signal: effectiveSignal,
          forceNavigate: true,
        });
        if (!ghostSyncedDuringSubmit) {
          await syncContextFromStorage(ghostResult.storageState);
        }
        gate.clearCooldown();
        return ghostResult.submissionId;
      },
      awaitResult: (id, slug) => api.awaitSubmission(id, slug, 180_000, { pollIntervalMs: 4_000 }),
      graphql: (q, v, s) => api.graphql(q, v, s as never),
    },
    close: async () => {
      cancelled.abort();
      await ghostSession?.close().catch(() => undefined);
      ghostSession = null;
      await persistCookies(account, initialState, activeCtx).catch(() => false);
      await activeCtx.dispose().catch(() => undefined);
    },
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
      if (!isMissingWalkcccPage(e) && this.entries.get(n) === p) this.entries.delete(n);
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

function rangeGraphql(api?: RangeApi): FetchCommunitySolutionOptions['graphql'] {
  if (!api?.graphql) return undefined;
  return (query, variables) => api.graphql!(query, variables, z.unknown());
}

export function defaultRangeDeps(
  notify: (text: string) => Promise<void> = async () => undefined,
  onProgress?: (event: RangeProgressEvent) => Promise<void> | void,
): RangeDeps {
  // A fresh cache per job keeps memory bounded to one range.
  const cache = new RangeSolutionCache();
  return {
    listAccounts: listEnabledAccounts,
    getAccount: getAccountById,
    openSession: openRequestSession,
    refreshAccount: (acc) => refreshLeetCodeAccount(acc).catch(() => null),
    getPage: (n) => cache.get(n),
    resolveSlug: resolveLeetCodeSlugByNumber,
    fetchCommunity: fetchCommunitySolution,
    notify,
    onProgress,
    sleep: abortableSleep,
    isDailyRunInProgress: isRunInProgress,
    now: () => Date.now(),
    questionGapMs: 0,
    blockedBackoffMs: [60_000, 120_000, 240_000],
    blockedStreakLimit: 3,
    blockedCooldownMs: 10 * 60_000,
    dailyRunPollMs: 15_000,
    progressEvery: 25,
    keepAlive: selfKeepAlive,
    questionFailures: createDbQuestionFailureStore(),
    solveWithAi: solveQuestionWithConfiguredAi,
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
