import { AccountStatus, DailyRun, RunState } from '@prisma/client';
import { config } from '../config';
import { logger } from '../logger';
import { prisma } from '../database/prisma';
import { AccountRecord, parseStoredStorageState } from '../database/accounts';
import { StorageStateShape } from '../browser/cookiePayload';
import { checkSession, SessionCheckResult } from '../browser/sessionCheck';
import { refreshLeetCodeAccount } from '../security/sessionAutoRefresh';
import {
  LeetCodeApi,
  LeetCodeHttpError,
  leetCodeRequestFailure,
  looksLikeChallenge,
  SubmissionOutcome,
} from '../leetcode/apiClient';
import { fetchQuestionData, RawQuestionData } from '../leetcode/dailyChallenge';
import { ParsedProblem, parseProblem } from '../leetcode/parser';
import { ContestQuestionSummary } from '../leetcode/contest';
import { submitViaGhostBrowser } from '../leetcode/ghostSubmit';
import {
  openLightweightLeetCodeSession,
  persistRotatedCookiesFromContext,
} from '../leetcode/sessionManager';
import { validateAiOutputForLanguage } from '../ai/codeSolver';
import {
  buildContestOneLinerSolvePrompt,
  buildJudgeRepairMessage,
  buildRepairMessage,
  JudgeFailureDetail,
} from '../ai/prompts';
import { createLLMProvider, LLMMessage, LLMProvider } from '../ai/provider';
import { AIModelRouter } from './router';
import { createCodeSolverRouter, PostError } from './service';

const MAX_UNLOCK_RETRIES = 3;
const DEFAULT_UNLOCK_RETRY_WAIT_MS = 15_000;
const MAX_JUDGE_ATTEMPTS = 3;
const CONTEST_SOLVE_MAX_TOKENS_FLOOR = 1536;

export interface ContestSolveProgress {
  stage: 'resolving_contest' | 'solving_code' | 'submitting' | 'accepted' | 'retrying_judge';
  detail: string;
}

export interface SolveContestQuestionParams {
  accountId: string;
  contestSlug: string;
  contestTitle: string;
  question: ContestQuestionSummary;
  istDate: string; // YYYY-MM-DD
  forceFreshSubmit?: boolean;
  onStage?: (progress: ContestSolveProgress) => void | Promise<void>;
}

export interface ContestApiLike {
  submitSolution(params: {
    slug: string;
    questionId: string;
    lang: string;
    code: string;
  }): Promise<string>;
  awaitSubmission(submissionId: string, slug: string): Promise<SubmissionOutcome>;
}

export interface ContestSessionLike {
  api: ContestApiLike;
  request?: {
    get(
      url: string,
      options?: { headers?: Record<string, string> }
    ): Promise<{ ok(): boolean; status(): number; json(): Promise<unknown> }>;
  };
  persistUpdatedCookiesIfChanged?: () => Promise<boolean>;
  close?: () => Promise<void>;
}

export interface ContestDailyRunStore {
  findUnique(args: {
    where: { accountId_date: { accountId: string; date: string } };
  }): Promise<DailyRun | null>;
  upsert(args: {
    where: { accountId_date: { accountId: string; date: string } };
    create: Omit<DailyRun, 'id' | 'createdAt' | 'updatedAt'>;
    update: Partial<Omit<DailyRun, 'id' | 'accountId' | 'date' | 'createdAt' | 'updatedAt'>>;
  }): Promise<DailyRun>;
}

export interface ContestAccountStore {
  findUnique(args: { where: { id: string } }): Promise<AccountRecord | null>;
}

export interface ContestPrismaLike {
  dailyRun: ContestDailyRunStore;
  account: ContestAccountStore;
}

export interface ContestRouterLike {
  generate<T>(
    messages: LLMMessage[],
    validate: (raw: string) => T,
    maxTokens: number,
    allowFallbackToLongerTimeout?: boolean,
    label?: string
  ): Promise<{ value: T; model: string }>;
}

export interface ContestSolverDeps {
  prisma?: ContestPrismaLike;
  openSession?: (
    state: StorageStateShape,
    account: AccountRecord
  ) => Promise<ContestSessionLike>;
  checkSession?: (api: ContestApiLike) => Promise<SessionCheckResult>;
  refreshAccount?: (account: AccountRecord) => Promise<{ status: string; error?: string }>;
  fetchQuestionData?: (api: ContestApiLike, slug: string) => Promise<RawQuestionData | null>;
  parseProblem?: (raw: RawQuestionData, language?: string) => ParsedProblem;
  createRouter?: () => Promise<ContestRouterLike | null>;
  createProvider?: () => LLMProvider;
  validateOutput?: (raw: string, language: string) => string;
  submitViaGhost?: typeof submitViaGhostBrowser;
  fetchJudgeDetail?: (
    session: ContestSessionLike,
    submissionId: string,
    slug: string,
    outcome: SubmissionOutcome
  ) => Promise<JudgeFailureDetail>;
  sleep?: (ms: number) => Promise<void>;
  language?: string;
  unlockRetryWaitMs?: number;
  maxUnlockRetries?: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildContestRunDateKey(
  contestSlug: string,
  questionSlug: string,
  istDate: string
): string {
  return `contest:${contestSlug}:${questionSlug}:${istDate}`;
}

function isContestQuestionNullError(err: unknown): boolean {
  if (err instanceof PostError && err.code === 'CONTEST_PROBLEM_LOCKED') {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg.includes('GraphQL response failed validation') &&
    /expected object, received null|received null/i.test(msg)
  ) {
    return true;
  }
  return /contest_problem_locked|question.*null/i.test(msg);
}

async function resolveDefaultRouter(): Promise<ContestRouterLike | null> {
  try {
    return await createCodeSolverRouter({});
  } catch (err) {
    if (
      err instanceof PostError &&
      (err.code === 'API_KEY_REQUIRED' || err.code === 'SOLUTION_KEYS_EXHAUSTED')
    ) {
      logger.warn(
        { code: err.code },
        'configured Coarena/Discovery keys unavailable for contest solver'
      );
      return null;
    }
    if (config.solutionPosts.apiKeys.length > 0) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'falling back to configured solutionPosts env API keys for contest solver'
      );
      return new AIModelRouter({
        ...config.solutionPosts,
        apiKeys: config.solutionPosts.apiKeys,
      });
    }
    return null;
  }
}

async function openAuthenticatedContestSession(
  initialAccount: AccountRecord,
  accountStore: ContestAccountStore,
  openSessionFn: (state: StorageStateShape, account: AccountRecord) => Promise<ContestSessionLike>,
  checkSessionFn: (api: ContestApiLike) => Promise<SessionCheckResult>,
  refreshAccountFn: (account: AccountRecord) => Promise<{ status: string; error?: string }>
): Promise<{
  account: AccountRecord;
  storageState: StorageStateShape;
  session: ContestSessionLike;
}> {
  let account = initialAccount;
  let parsedState = parseStoredStorageState(account.storageState);

  if (!parsedState.ok) {
    const refreshed = await refreshAccountFn(account);
    if (refreshed.status === 'refreshed' || refreshed.status === 'valid') {
      const reloaded = await accountStore.findUnique({ where: { id: account.id } });
      if (reloaded) {
        account = reloaded;
        parsedState = parseStoredStorageState(account.storageState);
      }
    }
    if (!parsedState.ok) {
      throw new Error(`Invalid storageState for account "${account.label}": ${parsedState.error}`);
    }
  }

  let session = await openSessionFn(parsedState.state, account);
  let check: SessionCheckResult;
  try {
    check = await checkSessionFn(session.api);
  } catch (error) {
    await session.close?.().catch(() => undefined);
    throw error;
  }
  if (!check.authenticated && check.cause === 'signed-out') {
    await session.close?.().catch(() => undefined);
    const refreshed = await refreshAccountFn(account);
    if (refreshed.status !== 'refreshed' && refreshed.status !== 'valid') {
      throw new Error(
        `LeetCode session expired for account "${account.label}": ${refreshed.error ?? 're-login failed'}`
      );
    }
    const reloaded = await accountStore.findUnique({ where: { id: account.id } });
    if (reloaded) {
      account = reloaded;
      const reparsed = parseStoredStorageState(account.storageState);
      if (reparsed.ok) {
        parsedState = reparsed;
      }
    }
    session = await openSessionFn(parsedState.state, account);
    let recheck: SessionCheckResult;
    try {
      recheck = await checkSessionFn(session.api);
    } catch (error) {
      await session.close?.().catch(() => undefined);
      throw error;
    }
    if (!recheck.authenticated && recheck.cause === 'signed-out') {
      await session.close?.().catch(() => undefined);
      throw new Error(`LeetCode session remains signed out for account "${account.label}"`);
    }
  }

  return { account, storageState: parsedState.state, session };
}

async function fetchContestQuestionWithUnlockRetry(
  api: ContestApiLike,
  slug: string,
  fetchFn: (api: ContestApiLike, slug: string) => Promise<RawQuestionData | null>,
  maxUnlockRetries: number,
  retryWaitMs: number,
  sleepFn: (ms: number) => Promise<void>
): Promise<RawQuestionData> {
  for (let attempt = 0; attempt <= maxUnlockRetries; attempt++) {
    try {
      const raw = await fetchFn(api, slug);
      if (raw && raw.questionId) {
        return raw;
      }
    } catch (err) {
      if (!isContestQuestionNullError(err)) {
        throw err;
      }
    }

    if (attempt < maxUnlockRetries && retryWaitMs > 0) {
      logger.info(
        { slug, attempt: attempt + 1, maxUnlockRetries, retryWaitMs },
        'contest problem not yet unlocked; waiting before retry'
      );
      await sleepFn(retryWaitMs);
    }
  }

  throw new PostError('CONTEST_PROBLEM_LOCKED');
}

async function generateCandidateWithFallback(
  messages: LLMMessage[],
  language: string,
  attemptLabel: string,
  validateOutput: (raw: string, lang: string) => string,
  router: ContestRouterLike | null,
  getProvider: () => LLMProvider | null
): Promise<string> {
  const maxTokens = Math.max(CONTEST_SOLVE_MAX_TOKENS_FLOOR, config.llm.maxTokens || 2048);

  if (router) {
    try {
      const result = await router.generate(
        messages,
        (raw) => validateOutput(raw, language),
        maxTokens,
        false,
        attemptLabel
      );
      return result.value;
    } catch (routerErr) {
      const fallbackProvider = getProvider();
      if (!fallbackProvider) {
        throw routerErr;
      }
      logger.warn(
        { err: routerErr instanceof Error ? routerErr.message : String(routerErr), attemptLabel },
        'contest router generation failed; falling back to direct LLM provider'
      );
    }
  }

  const provider = getProvider();
  if (!provider) {
    throw new Error(
      'AI contest solver unavailable: no configured Coarena/Discovery key or LLM API key succeeded'
    );
  }

  const workingMessages: LLMMessage[] = [...messages];
  const firstReply = await provider.generate(workingMessages, { maxTokens, temperature: 0.2 });
  try {
    return validateOutput(firstReply, language);
  } catch (validationErr) {
    const reason = validationErr instanceof Error ? validationErr.message : String(validationErr);
    workingMessages.push({ role: 'assistant', content: firstReply });
    workingMessages.push(buildRepairMessage(firstReply, reason));
    const repairedReply = await provider.generate(workingMessages, { maxTokens, temperature: 0.1 });
    return validateOutput(repairedReply, language);
  }
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const val of values) {
    if (typeof val === 'string' && val.trim().length > 0) {
      return val;
    }
    if (Array.isArray(val)) {
      const joined = val.filter((v) => typeof v === 'string').join('\n').trim();
      if (joined.length > 0) {
        return joined;
      }
    }
  }
  return null;
}

async function defaultFetchJudgeDetail(
  session: ContestSessionLike,
  submissionId: string,
  slug: string,
  outcome: SubmissionOutcome
): Promise<JudgeFailureDetail> {
  const fallback: JudgeFailureDetail = {
    statusMsg: outcome.statusDisplay || outcome.rawStatusMsg || 'Rejected',
  };

  if (!session.request || typeof session.request.get !== 'function') {
    return fallback;
  }

  const urls = [
    `https://leetcode.com/submissions/detail/${submissionId}/v2/check/`,
    `https://leetcode.com/submissions/detail/${submissionId}/check/`,
  ];

  for (const url of urls) {
    try {
      const res = await session.request.get(url, {
        headers: {
          Accept: 'application/json',
          Referer: `https://leetcode.com/problems/${slug}/`,
        },
      });
      if (!res.ok()) {
        continue;
      }
      const data = (await res.json()) as Record<string, unknown> | null;
      if (!data || typeof data !== 'object') {
        continue;
      }
      const rawState = typeof data.state === 'string' ? data.state.toUpperCase() : '';
      if (rawState === 'PENDING' || rawState === 'STARTED') {
        continue;
      }
      return {
        statusMsg: firstNonEmptyString(data.status_msg, outcome.statusDisplay, outcome.rawStatusMsg) ?? 'Rejected',
        compileError: firstNonEmptyString(data.full_compile_error, data.compile_error),
        runtimeError: firstNonEmptyString(data.full_runtime_error, data.runtime_error),
        lastTestcase: firstNonEmptyString(data.last_testcase, data.input_formatted, data.input),
        expectedOutput: firstNonEmptyString(data.expected_output),
        codeOutput: firstNonEmptyString(data.code_output, data.std_output, data.std_output_list),
      };
    } catch {
      // Best-effort detail lookup; fall back cleanly to SubmissionOutcome status.
    }
  }

  return fallback;
}

async function submitCandidateCode(
  session: ContestSessionLike,
  account: AccountRecord,
  storageState: StorageStateShape,
  params: { slug: string; questionId: string; lang: string; code: string },
  submitViaGhostFn: typeof submitViaGhostBrowser
): Promise<{ submissionId: string; updatedState?: StorageStateShape }> {
  try {
    const submissionId = await session.api.submitSolution(params);
    return { submissionId };
  } catch (submitErr) {
    const failure = leetCodeRequestFailure(submitErr);
    const canUpgradeGhost =
      !(submitErr instanceof LeetCodeHttpError && submitErr.status === 200) &&
      (looksLikeChallenge(submitErr) ||
        failure.category === 'access-denied' ||
        failure.category === 'session-csrf');

    if (!canUpgradeGhost) {
      throw submitErr;
    }

    logger.warn(
      { label: account.label, slug: params.slug, category: failure.category },
      'contest API submit challenged/rejected; retrying via ghost-mode browser fallback'
    );

    const ghostResult = await submitViaGhostFn(storageState, {
      slug: params.slug,
      questionId: params.questionId,
      lang: params.lang,
      code: params.code,
      onStorageState: async (updatedState) => {
        await persistRotatedCookiesFromContext(account, storageState, {
          storageState: async () => updatedState,
        });
      },
    });
    return {
      submissionId: ghostResult.submissionId,
      updatedState: ghostResult.storageState,
    };
  }
}

export async function solveAndSubmitContestQuestion(
  params: SolveContestQuestionParams,
  deps: ContestSolverDeps = {}
): Promise<DailyRun> {
  const prismaClient: ContestPrismaLike = deps.prisma ?? prisma;
  const runDateKey = buildContestRunDateKey(
    params.contestSlug,
    params.question.titleSlug,
    params.istDate
  );

  if (!params.forceFreshSubmit) {
    const existing = await prismaClient.dailyRun.findUnique({
      where: { accountId_date: { accountId: params.accountId, date: runDateKey } },
    });
    if (
      existing &&
      existing.state === RunState.SUCCESS &&
      existing.submissionStatus === 'Accepted' &&
      existing.submissionId
    ) {
      return existing;
    }
  }

  const account = await prismaClient.account.findUnique({
    where: { id: params.accountId },
  });
  if (!account) {
    throw new Error(`Account not found: ${params.accountId}`);
  }
  if (account.status === AccountStatus.DISABLED) {
    throw new Error(`Account "${account.label}" is disabled`);
  }

  await params.onStage?.({
    stage: 'resolving_contest',
    detail: `Loading ${params.question.label} (${params.question.titleSlug}) for ${params.contestTitle}`,
  });

  const openSessionFn = deps.openSession ?? ((state, acc) => openLightweightLeetCodeSession(state, acc));
  const checkSessionFn = deps.checkSession ?? ((api) => checkSession(api as LeetCodeApi));
  const refreshAccountFn = deps.refreshAccount ?? ((acc) => refreshLeetCodeAccount(acc));
  const fetchQuestionFn =
    deps.fetchQuestionData ?? ((api, slug) => fetchQuestionData(api as LeetCodeApi, slug));
  const parseProblemFn = deps.parseProblem ?? parseProblem;
  const validateOutput = deps.validateOutput ?? validateAiOutputForLanguage;
  const submitViaGhostFn = deps.submitViaGhost ?? submitViaGhostBrowser;
  const fetchJudgeDetailFn = deps.fetchJudgeDetail ?? defaultFetchJudgeDetail;
  const sleepFn = deps.sleep ?? defaultSleep;
  const language = deps.language ?? (config.llm.language || 'cpp');
  const maxUnlockRetries = deps.maxUnlockRetries ?? MAX_UNLOCK_RETRIES;
  const unlockRetryWaitMs = deps.unlockRetryWaitMs ?? DEFAULT_UNLOCK_RETRY_WAIT_MS;

  const {
    account: activeAccount,
    storageState: initialStorageState,
    session,
  } = await openAuthenticatedContestSession(
    account,
    prismaClient.account,
    openSessionFn,
    checkSessionFn,
    refreshAccountFn
  );
  let latestStorageState = initialStorageState;

  try {
    const rawQuestion = await fetchContestQuestionWithUnlockRetry(
      session.api,
      params.question.titleSlug,
      fetchQuestionFn,
      maxUnlockRetries,
      unlockRetryWaitMs,
      sleepFn
    );

    if (rawQuestion.isPaidOnly) {
      throw new Error(`Contest problem "${params.question.titleSlug}" is marked paid-only`);
    }

    const parsed = parseProblemFn(rawQuestion, language);
    const questionId = parsed.questionId || params.question.questionId;
    if (!questionId) {
      throw new Error(`Missing internal questionId for "${params.question.titleSlug}"`);
    }

    await params.onStage?.({
      stage: 'solving_code',
      detail: `Generating ${language} 1-liner solution for ${params.question.label}: ${parsed.title}`,
    });

    const router = deps.createRouter ? await deps.createRouter() : await resolveDefaultRouter();
    let cachedProvider: LLMProvider | null | undefined;
    const getDirectProvider = (): LLMProvider | null => {
      if (cachedProvider !== undefined) {
        return cachedProvider;
      }
      if (deps.createProvider) {
        cachedProvider = deps.createProvider();
        return cachedProvider;
      }
      if (config.llm.apiKey) {
        cachedProvider = createLLMProvider();
        return cachedProvider;
      }
      cachedProvider = null;
      return null;
    };

    let messages: LLMMessage[] = buildContestOneLinerSolvePrompt(parsed, language, true);
    let lastStatusMsg = 'Unknown Judge status';

    for (let attempt = 1; attempt <= MAX_JUDGE_ATTEMPTS; attempt++) {
      const code = await generateCandidateWithFallback(
        messages,
        language,
        `contest-solve-${params.question.titleSlug}-attempt-${attempt}`,
        validateOutput,
        router,
        getDirectProvider
      );

      await params.onStage?.({
        stage: 'submitting',
        detail: `Submitting ${params.question.label} (${params.question.titleSlug}) attempt ${attempt}/${MAX_JUDGE_ATTEMPTS}`,
      });

      const submission = await submitCandidateCode(
        session,
        activeAccount,
        latestStorageState,
        {
          slug: params.question.titleSlug,
          questionId,
          lang: language,
          code,
        },
        submitViaGhostFn
      );
      if (submission.updatedState) {
        latestStorageState = submission.updatedState;
      }

      const outcome = await session.api.awaitSubmission(
        submission.submissionId,
        params.question.titleSlug
      );

      if (outcome.classification === 'ACCEPTED') {
        await params.onStage?.({
          stage: 'accepted',
          detail: `Accepted ${params.question.label} on attempt ${attempt}/${MAX_JUDGE_ATTEMPTS}`,
        });

        const persistedFields = {
          problemSlug: params.question.titleSlug,
          title: parsed.title,
          difficulty: parsed.difficulty,
          language,
          solution: code,
          submissionId: outcome.submissionId,
          submissionStatus: 'Accepted',
          runtime: outcome.runtime,
          memory: outcome.memory,
          state: RunState.SUCCESS,
          error: null,
          attempts: attempt,
        };

        return await prismaClient.dailyRun.upsert({
          where: { accountId_date: { accountId: activeAccount.id, date: runDateKey } },
          create: {
            accountId: activeAccount.id,
            date: runDateKey,
            ...persistedFields,
          },
          update: persistedFields,
        });
      }

      const judgeDetail = await fetchJudgeDetailFn(
        session,
        submission.submissionId,
        params.question.titleSlug,
        outcome
      );
      lastStatusMsg = judgeDetail.statusMsg;

      if (attempt < MAX_JUDGE_ATTEMPTS) {
        const nextPreferOneLiner = attempt + 1 < MAX_JUDGE_ATTEMPTS;
        await params.onStage?.({
          stage: 'retrying_judge',
          detail: `Judge returned "${judgeDetail.statusMsg}" on attempt ${attempt}/${MAX_JUDGE_ATTEMPTS}; regenerating (${nextPreferOneLiner ? '1-liner' : 'clean fallback'})`,
        });

        const basePrompt = nextPreferOneLiner
          ? messages
          : buildContestOneLinerSolvePrompt(parsed, language, false);
        messages = [
          ...basePrompt,
          { role: 'assistant', content: code },
          buildJudgeRepairMessage(code, judgeDetail),
        ];
      }
    }

    throw new Error(
      `LeetCode Judge rejected all ${MAX_JUDGE_ATTEMPTS} contest solve attempts for "${params.question.titleSlug}" (${params.question.label}); last verdict: ${lastStatusMsg}`
    );
  } finally {
    await session.persistUpdatedCookiesIfChanged?.().catch(() => undefined);
    await session.close?.().catch(() => undefined);
  }
}
