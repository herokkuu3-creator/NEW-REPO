import { chromium, Page } from 'playwright';
import { Account, Prisma, SolutionPost } from '@prisma/client';
import { z } from 'zod';
import { config } from '../config';
import { logger } from '../logger';
import { prisma } from '../database/prisma';
import { getSystemState, setSystemState } from '../database/models';
import { parseStoredStorageState } from '../database/accounts';
import { attachBandwidthSaverRoute, buildLaunchArgs } from '../browser/playwright';
import { checkSession } from '../browser/sessionCheck';
import { LeetCodeApi } from '../leetcode/apiClient';
import { htmlToText } from '../leetcode/parser';
import { fetchDailyChallenge, fetchQuestionData } from '../leetcode/dailyChallenge';
import { AIModelRouter, RoutingError, SOLUTION_ARTICLE_WORK_MS } from './router';
import { FirecrawlAgentRouter } from './firecrawlAgent';
import { isSageProvider } from '../config/solutionPostProvider';
import { questionIllustration } from './questionVisuals';
import { CURRENT_VISUAL_VERSION, reservePostPresentation, usesAnimatedPresentation, type ArticlePresentation } from './presentation';
import { FIRECRAWL_STAGE_BUDGET_MS } from './firecrawlRateGate';
import { articleNeedsRefresh, ArticleReviewError, contextSchema, generateArticle, hash, SubmissionContext, StageCallback } from './article';
import { OutputValidationError } from './router';
import { ensurePost, move } from './store';
import { storeVisualAssets } from './visualStore';
import { loadSolutionKeyPool, maskSolutionApiKey, resetSolutionApiKeyPool, rotateSolutionApiKey, type SolutionKeyPool } from './keyPool';
import { startArticleWorkKeepAlive } from './keepAlive';
import { generateImplementation, IMPLEMENTATION_STAGE_BUDGET } from './implementation';
import { extractRelevantCodeSnippets, generateMultiLanguageCode, supportsMultiLanguage } from './multiLanguage';
import { CoarenaRouter, loadCoarenaKey, loadCoarenaModelOrder, maskCoarenaKey, type CoarenaReply } from './coarena';
import { CoarenaPause, isCoarenaPauseCode, isCoarenaPaused } from './coarenaLimits';
import { notifySolutionPostSchedulerWork } from './schedulerGate';

type PublicationMode = SubmissionContext['resumePublication'];
const checkpointPrefix = (postId: string) => 'solution-post-coarena-reply:' + postId + ':';

function awaitingCoarena(post: SolutionPost): boolean {
  return isCoarenaPaused(post) && (post.leaseUntil?.getTime() ?? 0) > Date.now();
}

export class PostError extends Error {
  constructor(public readonly code: string, public readonly details?: {
    postId: string; retryCount: number; previousError: string | null;
  }) { super(code); }
}

export const SOLUTION_POST_RETRY_LIMIT = 5;

function checkGenerationBudget(post: SolutionPost, force: boolean): void {
  if (post.retryCount < SOLUTION_POST_RETRY_LIMIT) return;
  const details = { postId: post.id, retryCount: post.retryCount, previousError: post.lastError };
  logger.warn({ accountId: post.accountId, ...details, explicitRetry: force },
    force ? 'solution article retry explicitly requested' : 'solution article automatic retry budget exhausted');
  if (!force) throw new PostError('GENERATION_RETRY_LIMIT', details);
}

/** Keys before activeIndex were exhausted this month and must not be retried. */
export function activeSolutionApiKeys(pool: Pick<SolutionKeyPool, 'keys' | 'activeIndex'>): string[] {
  return pool.keys.slice(Math.max(0, pool.activeIndex));
}

export type AccountSessionRecord = Pick<Account, 'id' | 'label' | 'username' | 'status' | 'storageState'>;

const ACCOUNT_SESSION_SELECT = {
  id: true,
  label: true,
  username: true,
  status: true,
  storageState: true,
} satisfies Prisma.AccountSelect;

const SOLUTION_POST_METADATA_WITH_CONTEXT_SELECT = {
  id: true,
  accountId: true,
  problemSlug: true,
  submissionId: true,
  intent: true,
  context: true,
  codeHash: true,
  status: true,
  title: true,
  style: true,
  model: true,
  reviewModel: true,
  contentHash: true,
  approvedHash: true,
  publishedUrl: true,
  lastError: true,
  retryCount: true,
  leaseUntil: true,
  createdAt: true,
  updatedAt: true,
  publishedAt: true,
} satisfies Prisma.SolutionPostSelect;

/** A normal isolated browser context. No shared profile, solver, credential forwarding, or challenge bypass. */
export async function withAccount<T>(account: AccountSessionRecord,
  action: (api: LeetCodeApi, page: Page, username: string) => Promise<T>): Promise<T> {
  const parsed = parseStoredStorageState(account.storageState);
  if (!parsed.ok || account.status === 'DISABLED') throw new PostError('ACCOUNT_UNAVAILABLE');
  const browser = await chromium.launch({
    headless: config.browser.headless,
    args: buildLaunchArgs(config.browser.headless),
  });
  try {
    const context = await browser.newContext({ storageState: parsed.state });
    await attachBandwidthSaverRoute(context);
    const page = await context.newPage();
    const api = new LeetCodeApi(context);
    const session = await checkSession(api);
    if (!session.authenticated || !session.username) throw new PostError('AUTHENTICATION_REQUIRED');
    if (account.username && session.username.toLowerCase() !== account.username.toLowerCase()) {
      throw new PostError('ACCOUNT_IDENTITY_MISMATCH');
    }
    return await action(api, page, session.username);
  } finally { await browser.close(); }
}

export async function loadContext(accountId: string, runId: string): Promise<SubmissionContext> {
  const run = await prisma.dailyRun.findUniqueOrThrow({
    where: { id: runId },
    select: {
      accountId: true,
      state: true,
      solution: true,
      submissionId: true,
      submissionStatus: true,
      date: true,
      problemSlug: true,
      title: true,
      difficulty: true,
      language: true,
    },
  });
  if (run.accountId !== accountId || run.state !== 'SUCCESS' || !run.solution || !run.submissionId ||
    run.submissionStatus !== 'Accepted') throw new PostError('ACCEPTED_SUBMISSION_REQUIRED');
  const account = await prisma.account.findUniqueOrThrow({
    where: { id: accountId },
    select: ACCOUNT_SESSION_SELECT,
  });
  // Manual, forecast, and contest submissions use namespaced DailyRun keys so they
  // never collide with the real calendar-day run. The article context still needs a
  // normal ISO challenge date for validation and presentation.
  const contextDate = /^\d{4}-\d{2}-\d{2}$/.test(run.date) ? run.date :
    /^(?:(?:manual|forecast):\d+|contest:[^:]+:[^:]+):(\d{4}-\d{2}-\d{2})$/.exec(run.date)?.[1] ?? new Date().toISOString().slice(0, 10);
  return withAccount(account, async (api, _page, username) => {
    const verdict = await api.awaitSubmission(run.submissionId!, run.problemSlug, 30000, { firstPollDelayMs: 0 });
    if (verdict.classification !== 'ACCEPTED') throw new PostError('ACCEPTED_SUBMISSION_REQUIRED');
    const question = await fetchQuestionData(api, run.problemSlug);
    if (!question.questionId || question.slug !== run.problemSlug || question.isPaidOnly) {
      throw new PostError('PROBLEM_UNAVAILABLE');
    }
    const codeSnippets = extractRelevantCodeSnippets(question.codeSnippets, run.language);
    return contextSchema.parse({ accountId, username, problemId: question.questionId, slug: run.problemSlug,
      title: run.title, difficulty: run.difficulty, problem: htmlToText(question.contentHtml) || question.contentHtml,
      submissionId: run.submissionId, language: run.language, code: run.solution,
      challengeDate: contextDate, topicTags: question.topicTags ?? [],
      ...(codeSnippets ? { codeSnippets } : {}) });
  });
}

export async function createPostRouter(correlation: { postId?: string; accountId?: string } = {},
  providerOverride?: 'firecrawl' | 'bazaarlink', reportKey?: (label: string) => void): Promise<AIModelRouter> {
  const deadlineAt = providerOverride ? undefined : Date.now() + SOLUTION_ARTICLE_WORK_MS;
  const key = providerOverride ? null : await loadCoarenaKey().catch(() => null);
  if (key) reportKey?.('Coarena · ' + maskCoarenaKey(key));
  if (key) return new CoarenaRouter(key, () => createDiscoveryRouter(correlation, reportKey, deadlineAt), attempt => {
    if (attempt.outcome === 'SUCCESS') reportKey?.('Coarena · ' + maskCoarenaKey(key) + ' · ' + attempt.model);
    logger.info({ ...correlation, attempt }, 'solution article AI attempt finished');
  }, deadlineAt, correlation.postId ? {
    async read(id) {
      const saved = await getSystemState(checkpointPrefix(correlation.postId!) + id);
      return saved ? JSON.parse(saved) as CoarenaReply : null;
    },
    save: (id, reply) => setSystemState(checkpointPrefix(correlation.postId!) + id, JSON.stringify(reply)),
  } : undefined, await loadCoarenaModelOrder());
  if ((providerOverride ?? config.solutionPosts.aiProvider) === 'firecrawl') {
    if (!config.solutionPosts.firecrawlApiKey) throw new PostError('FIRECRAWL_KEY_REQUIRED');
    return new FirecrawlAgentRouter(config.solutionPosts.firecrawlApiKey, config.solutionPosts.agentMaxCredits,
      attempt => logger.info({ ...correlation, attempt }, 'solution article AI attempt finished'));
  }
  return createDiscoveryRouter(correlation, reportKey, deadlineAt);
}

/**
 * Builds an AI router for solving failed LeetCode questions using configured
 * Coarena / Discovery / Sage keys (never Firecrawl web-research agent).
 */
export async function createCodeSolverRouter(
  correlation: { postId?: string; accountId?: string } = {},
  reportKey?: (label: string) => void,
  deadlineAt?: number,
): Promise<AIModelRouter> {
  const key = await loadCoarenaKey().catch(() => null);
  if (key) {
    reportKey?.('Coarena · ' + maskCoarenaKey(key));
    return new CoarenaRouter(
      key,
      () => createDiscoveryRouter(correlation, reportKey, deadlineAt),
      (attempt) => {
        if (attempt.outcome === 'SUCCESS') {
          reportKey?.('Coarena · ' + maskCoarenaKey(key) + ' · ' + attempt.model);
        }
        logger.info({ ...correlation, attempt }, 'question AI solver attempt finished');
      },
      deadlineAt,
    );
  }
  return createDiscoveryRouter(correlation, reportKey, deadlineAt);
}

async function createDiscoveryRouter(correlation: { postId?: string; accountId?: string }, reportKey?: (label: string) => void,
  deadlineAt?: number): Promise<AIModelRouter> {
  let pool = await loadSolutionKeyPool();
  let activeKeys = activeSolutionApiKeys(pool);
  if (!activeKeys.length && pool.keys.length > 0 &&
      !['HTTP_401', 'HTTP_402_BILLING_REQUIRED'].includes(pool.lastFailure ?? '')) {
    pool = await resetSolutionApiKeyPool().catch(() => ({ ...pool, activeIndex: 0 }));
    activeKeys = activeSolutionApiKeys(pool);
    if (!activeKeys.length) activeKeys = pool.keys;
  }
  if (pool.keys.length > 1 && !['HTTP_401', 'HTTP_402_BILLING_REQUIRED'].includes(pool.lastFailure ?? '')) {
    const start = Math.max(0, Math.min(pool.activeIndex ?? 0, pool.keys.length - 1));
    activeKeys = [...new Set([...pool.keys.slice(start), ...pool.keys.slice(0, start)])];
  }
  logger.info({ ...correlation, keyPool: { total: pool.keys.length, activeIndex: pool.activeIndex + 1,
    activeKey: activeKeys[0] ? maskSolutionApiKey(activeKeys[0]) : null, stored: pool.stored },
    keySource: config.solutionPosts.keySource, keyEnvironment: config.solutionPosts.keyEnvironment }, 'solution article router configured');
  if (!activeKeys.length) throw new PostError(!pool.keys.length ? config.solutionPosts.keyError ?? 'AI_CONFIGURATION_REQUIRED' :
    pool.lastFailure === 'HTTP_401' ? 'AI_AUTHENTICATION_FAILED' :
      pool.lastFailure === 'HTTP_402_BILLING_REQUIRED' ? 'AI_BILLING_REQUIRED' : 'AI_KEYS_EXHAUSTED');
  // Live MiniMax reviews produced contradictory arithmetic and fed those errors
  // back into repairs. Use reasoning models for factual repairs and verdicts;
  // every repaired draft still receives a fresh, independent review request.
  // Prefer the reviewer that returned usable verdicts in production. DeepSeek
  // remains an allowed fallback when Qwen is unavailable.
  const reviewModels = isSageProvider(config.solutionPosts.baseUrl) ?
    config.solutionPosts.models.filter(model => /^deepseek-|^qwen/i.test(model))
      .sort((a, b) => Number(/^qwen/i.test(b)) - Number(/^qwen/i.test(a))) : undefined;
  return new AIModelRouter({ ...config.solutionPosts, apiKeys: activeKeys, reviewModels, deadlineAt,
    deferOnRateLimit: deadlineAt !== undefined }, undefined, undefined,
    attempt => { if (isSageProvider(config.solutionPosts.baseUrl)) attempt.provider = 'discovery';
      const key = attempt.keySlot && activeKeys[attempt.keySlot - 1];
      if (attempt.attempt > 0 && attempt.model !== 'discovery' && key) reportKey?.(`Discovery · ${maskSolutionApiKey(key)}`);
      logger.info({ ...correlation, attempt }, 'solution article AI attempt finished'); },
    async (failedKey, reason) => {
      const advanced = await rotateSolutionApiKey(failedKey, reason);
      logger.warn({ ...correlation, reason, activeKey: advanced.activeIndex + 1, totalKeys: advanced.keys.length }, 'solution article API key advanced');
    });
}

async function reserveImplementation(post: SolutionPost, context: SubmissionContext, fingerprint: string): Promise<boolean> {
  const key = `solution-implementation:${context.slug}:${context.language}:${fingerprint}`;
  try {
    await prisma.systemState.create({ data: { key, value: post.id }, select: { key: true } });
    return true;
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error;
    const reservation = await prisma.systemState.findUnique({ where: { key }, select: { value: true } });
    return reservation?.value === post.id;
  }
}

export async function generatePost(context: SubmissionContext, router?: AIModelRouter, force = false, onStage?: StageCallback,
  publicationMode?: PublicationMode): Promise<SolutionPost> {
  let post = await ensurePost(context);
  if (!['PENDING', 'RETRY_PENDING'].includes(post.status) || awaitingCoarena(post)) return post;
  const priorRetryCount = force && post.retryCount >= SOLUTION_POST_RETRY_LIMIT ? 0 : post.retryCount;
  checkGenerationBudget(post, force);
  // Use the immutable original snapshot when a later submission for the same problem exists.
  const originalContext = contextSchema.parse(JSON.parse(post.context));
  if (hash(originalContext.code) !== post.codeHash) throw new PostError('SOURCE_INTEGRITY_FAILED');
  const oldFormat = originalContext.presentation?.format;
  const presentation: ArticlePresentation = oldFormat && usesAnimatedPresentation(originalContext.presentation) ?
    { ...originalContext.presentation!, visualVersion: CURRENT_VISUAL_VERSION } :
    await reservePostPresentation(post.problemSlug);
  if (oldFormat?.optimization && presentation.format) presentation.format.optimization = true;
  const savedContext = { ...originalContext, resumePublication: publicationMode ?? originalContext.resumePublication, presentation };
  const workMs = config.solutionPosts.aiProvider === 'firecrawl' ? (6 + IMPLEMENTATION_STAGE_BUDGET) * FIRECRAWL_STAGE_BUDGET_MS : SOLUTION_ARTICLE_WORK_MS;
  const leaseMs = workMs + 120_000;
  // Reset an explicitly renewed attempt budget in the same CAS that claims
  // generation. A separate unconditional update can reset another worker's job.
  post = await move(post, 'CHECKING_ELIGIBILITY', { leaseUntil: new Date(Date.now() + leaseMs),
    context: JSON.stringify(savedContext),
    retryCount: force && post.retryCount >= SOLUTION_POST_RETRY_LIMIT ? 1 : { increment: 1 } });
  logger.info({ postId: post.id, accountId: post.accountId, retryCount: post.retryCount,
    explicitRetry: force, previousError: post.lastError }, 'solution article generation claimed');
  const stopKeepAlive = startArticleWorkKeepAlive();
  let implementationAttempts: Awaited<ReturnType<typeof generateImplementation>>['attempts'] = [];
  let useCoarena = false;
  try {
    // Context comes only from a verified accepted DailyRun; publishing rechecks eligibility and identity.
    const [recent, sameProblem] = await Promise.all([
      prisma.solutionPost.findMany({ where: { OR: [{ accountId: post.accountId }, { problemSlug: post.problemSlug }],
        id: { not: post.id }, title: { not: null } }, select: { style: true, title: true }, orderBy: { createdAt: 'desc' }, take: 8 }),
      prisma.solutionPost.findMany({ where: { problemSlug: post.problemSlug, id: { not: post.id }, title: { not: null } },
        select: { context: true, title: true }, orderBy: { createdAt: 'desc' }, take: 100 }),
    ]);
    const previous = sameProblem.flatMap(row => {
      try {
        const parsed = contextSchema.safeParse(JSON.parse(row.context));
        if (parsed.success && parsed.data.language === savedContext.language) {
          return [parsed.data.articleImplementation ?? { code: parsed.data.code }];
        }
      } catch { /* An unreadable historical snapshot has no comparable code. */ }
      return [];
    });
    post = await move(post, 'GENERATING', { lastError: isCoarenaPauseCode(post.lastError) ? post.lastError : null });
    let currentKey: string | undefined;
    const activeRouter = router ?? await createPostRouter({ postId: post.id, accountId: post.accountId }, undefined, label => {
      if (label === currentKey) return;
      currentKey = label;
      void Promise.resolve(onStage?.('article_provider', label)).catch(() => undefined);
    });
    useCoarena = activeRouter instanceof CoarenaRouter;
    let implementation = { value: savedContext.articleImplementation, attempts: implementationAttempts };
    if (!implementation.value && (savedContext.articleStyle !== 'one-liner' || previous.length > 0)) {
      await onStage?.('generating_article', 'Writing and reviewing a distinct implementation…');
      implementation = savedContext.articleStyle === 'one-liner'
        ? await generateImplementation(activeRouter, savedContext, previous,
            fingerprint => reserveImplementation(post, savedContext, fingerprint), { oneLiner: true })
        : await generateImplementation(activeRouter, savedContext, previous,
            fingerprint => reserveImplementation(post, savedContext, fingerprint));
    }
    implementationAttempts = implementation.attempts;
    let articleContext = implementation.value
      ? { ...savedContext, articleImplementation: implementation.value }
      : savedContext;
    if (!articleContext.multiLanguageCode && supportsMultiLanguage(articleContext.language)) {
      const multiLang = await generateMultiLanguageCode(activeRouter, articleContext);
      if (multiLang?.value.length) {
        articleContext = { ...articleContext, multiLanguageCode: multiLang.value };
        implementationAttempts = [...implementationAttempts, ...multiLang.attempts];
      }
    }
    let priorFailure: { markdown: string; issues: string[] } | undefined;
    try {
      const feedback = (JSON.parse(post.attempts ?? '[]') as Array<{ reviewIssues?: string[] }>).reverse().find(a => a.reviewIssues?.length);
      if (post.markdown && feedback?.reviewIssues) priorFailure = {
        markdown: post.markdown.replace(/^(`{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm, '[prior implementation omitted]')
          .replace(savedContext.code, '[accepted source omitted]'), issues: feedback.reviewIssues,
      };
    } catch { /* an unreadable historical diagnostic must not prevent a clean generation */ }
    const recentStyles = new Map(recent.map(item => [item.title ?? '', item.style ?? '']));
    for (const { title } of sameProblem) if (title && !recentStyles.has(title)) recentStyles.set(title, '');
    const visualBaseUrl = process.env.VISUAL_ASSET_BASE_URL?.trim() || config.api.visualAssetBaseUrl || config.api.publicUrl;
    const article = await generateArticle(activeRouter, articleContext,
      [...recentStyles].map(([title, style]) => ({ title, style })),
      plans => storeVisualAssets(plans, visualBaseUrl, { allowInternalReference: true }), priorFailure, onStage);
    // Generation stores the reviewed bytes. Publication verifies both files
    // after LeetCode's uploader has copied them to its CDN.
    if (article.visualFallback || article.visuals.length !== 2 || article.assets.length !== 2 ||
      new Set(article.assets.map(asset => asset.id)).size !== 2 || new Set(article.assets.map(asset => asset.url)).size !== 2) {
      throw new PostError('TWO_ARTICLE_GIFS_REQUIRED');
    }
    post = await move(post, 'VALIDATING', { title: article.title, markdown: article.markdown,
      style: article.style, model: article.model, reviewModel: article.reviewModel, context: JSON.stringify(articleContext),
      attempts: JSON.stringify([...implementationAttempts, ...article.attempts]),
      contentHash: hash(`${article.title}\n${article.markdown}`), approvedHash: null });
    post = await move(post, 'DRAFT_READY', { leaseUntil: null, lastError: null });
    post = await move(post, 'AWAITING_APPROVAL');
    await onStage?.('draft_ready', 'Article ready with both GIFs prepared for upload');
    return post;
  } catch (error) {
    if (error instanceof CoarenaPause || (error instanceof RoutingError && error.lastFailure === 'ARTICLE_TIME_BUDGET_EXCEEDED')) {
      const isBudget = error instanceof RoutingError && error.lastFailure === 'ARTICLE_TIME_BUDGET_EXCEEDED';
      const code = isBudget ? 'COARENA_CAPACITY' : (error as CoarenaPause).code;
      const retryAt = isBudget ? new Date(Date.now() + 60_000) : (error as CoarenaPause).retryAt;
      const errorAttempts = isBudget ? (error as RoutingError).attempts : (error as CoarenaPause).attempts;
      const attempts = [...implementationAttempts, ...errorAttempts];
      if (!errorAttempts.length) attempts.push({ model: 'limits', provider: 'coarena',
        attempt: 0, elapsedMs: 0, outcome: code, deferred: true });
      post = await move(post, 'RETRY_PENDING', { leaseUntil: retryAt, lastError: code,
        attempts: JSON.stringify(attempts), retryCount: priorRetryCount });
      logger.info({ postId: post.id, accountId: post.accountId, code, retryAt },
        'solution article waiting for Coarena');
      return post;
    }
    // A CAS failure must not overwrite the current owner's result.
    if (['CHECKING_ELIGIBILITY', 'GENERATING', 'VALIDATING'].includes(post.status)) {
      post = await move(post, 'FAILED', { leaseUntil: null,
        lastError: error instanceof RoutingError && error.lastFailure === 'HTTP_429' ? 'AI_RATE_LIMITED' :
          error instanceof ArticleReviewError ?
            error.lastFailure && error.lastFailure !== 'TECHNICAL_REVIEW_REJECTED' ? `AI_ERROR: ${error.lastFailure}` : 'TECHNICAL_REVIEW_FAILED' :
          error instanceof RoutingError ? (error.lastFailure === 'HTTP_401' ? 'AI_AUTHENTICATION_FAILED' :
            error.lastFailure === 'PROVIDER_ACCESS_BLOCKED' ? 'AI_PROVIDER_ACCESS_BLOCKED' :
            error.lastFailure ? `AI_ERROR: ${error.lastFailure}` : 'AI_MODELS_EXHAUSTED') :
            error instanceof PostError ? error.code : error instanceof OutputValidationError ? `AI_ERROR: ${error.category}` :
              error instanceof z.ZodError ? `AI_ERROR: SCHEMA:${error.issues.map(i => i.path.join('.')).join(',').slice(0, 200)}` : 'GENERATION_FAILED',
        ...(error instanceof ArticleReviewError ? { ...error.draft,
          contentHash: hash(`${error.draft.title}\n${error.draft.markdown}`), approvedHash: null } : {}),
        ...(error instanceof RoutingError || implementationAttempts.length ? {
          attempts: JSON.stringify([...implementationAttempts, ...(error instanceof RoutingError ? error.attempts : [])]),
        } : {}) });
      logger.warn({ postId: post.id, accountId: post.accountId, retryCount: post.retryCount,
        error: post.lastError }, 'solution article generation failed');
    }
    return post;
  } finally {
    stopKeepAlive();
    if (useCoarena && ['AWAITING_APPROVAL', 'FAILED'].includes(post.status)) {
      await prisma.systemState.deleteMany({ where: { key: { startsWith: checkpointPrefix(post.id) } } })
        .catch(() => undefined);
    }
  }
}

function draftNeedsRefresh(context: SubmissionContext): boolean {
  const presentation = context.presentation;
  if (articleNeedsRefresh(context) || !usesAnimatedPresentation(presentation)) return true;
  return (presentation?.visualVersion ?? 0) < 4 ||
    (presentation?.visualVersion === 4 && presentation.scenes?.[1] === 'terminal') ||
    (presentation?.visualVersion === 6 && questionIllustration(context) === 'grid');
}

async function interruptedLockKeys(
  post: Pick<SolutionPost, 'accountId' | 'submissionId'> & { intent?: string; context?: string },
  updatedAt: Date,
): Promise<string[]> {
  let intent = post.intent;
  if (!intent && typeof post.context === 'string') {
    try { intent = contextSchema.safeParse(JSON.parse(post.context)).data?.intent; } catch { /* ignore unreadable context */ }
  }
  if (intent !== 'contest-solution') return ['solution-post-job:' + post.accountId + ':' + updatedAt.toISOString().slice(0, 10)];
  if (!post.submissionId) return [];
  const run = await prisma.dailyRun?.findFirst?.({
    where: { accountId: post.accountId, submissionId: post.submissionId },
    select: { date: true },
  });
  const match = /^contest:([^:]+):([^:]+):\d{4}-\d{2}-\d{2}$/.exec(run?.date ?? '');
  if (!match) return [];
  const [, contestSlug, questionSlug] = match;
  return [
    `contest-post-job:${contestSlug}`,
    `contest-question-job:${post.accountId}:${contestSlug}:${questionSlug}`,
  ];
}

export async function generateForRun(accountId: string, runId: string, force = false, onStage?: StageCallback,
  publicationMode?: PublicationMode,
  options?: { intent?: SubmissionContext['intent']; articleStyle?: SubmissionContext['articleStyle'] }): Promise<SolutionPost> {
  const run = await prisma.dailyRun.findUniqueOrThrow({
    where: { id: runId },
    select: { accountId: true, problemSlug: true },
  });
  if (run.accountId !== accountId) throw new PostError('ACCOUNT_IDENTITY_MISMATCH');
  const intent = options?.intent ?? 'community-solution';
  const existing = await prisma.solutionPost.findUnique({
    where: { accountId_problemSlug_intent: { accountId, problemSlug: run.problemSlug, intent } },
    select: SOLUTION_POST_METADATA_WITH_CONTEXT_SELECT,
  });
  if (existing && awaitingCoarena(existing as unknown as SolutionPost)) return existing as unknown as SolutionPost;
  if (existing && !['PENDING', 'RETRY_PENDING'].includes(existing.status)) {
    if ((force && existing.status === 'FAILED') || (['DRAFT_READY', 'AWAITING_APPROVAL'].includes(existing.status) && !existing.approvedHash &&
      draftNeedsRefresh(contextSchema.parse(JSON.parse(existing.context))))) {
      return retryPost(existing.id, true, onStage, publicationMode);
    }
    return existing as unknown as SolutionPost;
  }
  const loaded = await loadContext(accountId, runId);
  const context = options ? {
    ...loaded,
    ...(options.intent ? { intent: options.intent } : {}),
    ...(options.articleStyle ? { articleStyle: options.articleStyle } : {}),
  } : loaded;
  return generatePost(context, undefined, force, onStage, publicationMode);
}

export async function requeueInterruptedGeneration(id: string, updatedAt: Date): Promise<SolutionPost> {
  const post = await prisma.solutionPost.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      accountId: true,
      submissionId: true,
      intent: true,
      status: true,
      lastError: true,
      updatedAt: true,
    },
  });
  if (!['CHECKING_ELIGIBILITY', 'GENERATING', 'VALIDATING'].includes(post.status) ||
      post.updatedAt.getTime() !== updatedAt.getTime() || Date.now() - updatedAt.getTime() < SOLUTION_ARTICLE_WORK_MS) {
    throw new PostError('GENERATION_RECOVERY_CONFLICT');
  }
  const keys = await interruptedLockKeys(post, updatedAt);
  const locks = await Promise.all(
    keys.map(async key => ({
      key,
      lock: await prisma.systemState.findUnique({ where: { key }, select: { value: true, updatedAt: true } }),
    })),
  );
  const recovered = await move(post as unknown as SolutionPost, 'RETRY_PENDING', isCoarenaPauseCode(post.lastError)
    ? { leaseUntil: new Date(), retryCount: { decrement: 1 } }
    : { leaseUntil: null, lastError: 'GENERATION_INTERRUPTED' });
  // Remove only the locks observed before this generation made progress.
  for (const { key, lock } of locks) {
    if (lock && lock.updatedAt <= updatedAt) await prisma.systemState.deleteMany({ where: { key, value: lock.value } });
  }
  return recovered;
}

export async function retryPost(id: string, force = false, onStage?: StageCallback,
  publicationMode?: PublicationMode): Promise<SolutionPost> {
  const post = await prisma.solutionPost.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      accountId: true,
      submissionId: true,
      status: true,
      lastError: true,
      leaseUntil: true,
      retryCount: true,
      codeHash: true,
      context: true,
      updatedAt: true,
    },
  }) as unknown as SolutionPost;
  if (awaitingCoarena(post)) return post;
  const refreshDraft = force && ['DRAFT_READY', 'AWAITING_APPROVAL'].includes(post.status);
  if (!refreshDraft && !['FAILED', 'RETRY_PENDING'].includes(post.status)) throw new PostError('NOT_RETRYABLE');
  const context = contextSchema.parse(JSON.parse(post.context));
  if (refreshDraft && !draftNeedsRefresh(context)) throw new PostError('NOT_RETRYABLE');
  if (isCoarenaPaused(post)) return generatePost(context, undefined, force, onStage, publicationMode);
  checkGenerationBudget(post, force);
  const run = await prisma.dailyRun.findFirst({
    where: { accountId: post.accountId, submissionId: post.submissionId },
    select: { id: true },
  });
  if (run) {
    const verified = await loadContext(post.accountId, run.id);
    if (hash(verified.code) !== post.codeHash || verified.slug !== context.slug) throw new PostError('SOURCE_INTEGRITY_FAILED');
  } else {
    if (!post.submissionId || context.accountId !== post.accountId ||
      context.submissionId !== post.submissionId || hash(context.code) !== post.codeHash) {
      throw new PostError('SOURCE_INTEGRITY_FAILED');
    }
    const account = await prisma.account.findUniqueOrThrow({
      where: { id: post.accountId },
      select: ACCOUNT_SESSION_SELECT,
    });
    await withAccount(account, async api => {
      const verdict = await api.awaitSubmission(post.submissionId, context.slug, 30000, { firstPollDelayMs: 0 });
      if (verdict.classification !== 'ACCEPTED') throw new PostError('ACCEPTED_SUBMISSION_REQUIRED');
    });
  }
  if (refreshDraft) {
    await move(post, 'RETRY_PENDING', { approvedHash: null, contentHash: null });
  } else if (post.status === 'FAILED') {
    await move(post, 'RETRY_PENDING');
  }
  return generatePost(context, undefined, force, onStage, publicationMode);
}

/** When API keys are renewed or reset, unlock any posts stalled on key errors or retry limits. */
export async function resetFailedSolutionPostRetries(): Promise<number> {
  const updated = await prisma.solutionPost.updateMany({
    where: {
      status: 'FAILED',
      OR: [
        { lastError: 'GENERATION_RETRY_LIMIT' },
        { lastError: 'AI_MODELS_EXHAUSTED' },
        { lastError: 'AI_CONFIGURATION_REQUIRED' },
        { lastError: 'AI_BILLING_REQUIRED' },
        { lastError: 'AI_KEYS_EXHAUSTED' },
        { lastError: 'AI_PROVIDER_ACCESS_BLOCKED' },
        { lastError: 'AI_AUTHENTICATION_FAILED' },
        { lastError: { startsWith: 'AI_ERROR:' } },
        { lastError: 'TECHNICAL_REVIEW_FAILED' },
      ],
    },
    data: {
      status: 'RETRY_PENDING',
      retryCount: 0,
    },
  });
  // Credentials can be repaired after the automatic attempts. Reset the
  // matching scheduler budget too; resetting only posts leaves the schedule stuck.
  await prisma.systemState.deleteMany({ where: { key: { startsWith: 'solution-post-schedule-budget:' } } });
  await prisma.systemState.deleteMany({ where: { key: { startsWith: 'solution-post-schedule-attempt-at:' } } });
  notifySolutionPostSchedulerWork();
  return updated.count;
}

export async function resolveCurrentDaily(account: Account, now = new Date()) {
  const resolve = (candidate: AccountSessionRecord) => withAccount(candidate, async api => {
    for (let n = 0; n < 3; n++) {
      const daily = await fetchDailyChallenge(api);
      if (daily.date === now.toISOString().slice(0, 10)) return daily;
      if (n < 2) await new Promise(r => setTimeout(r, 1500 * 2 ** n));
    }
    throw new PostError('DAILY_CHALLENGE_NOT_REFRESHED');
  });
  try { return await resolve(account); }
  catch (error) {
    if (!(error instanceof PostError) || !['AUTHENTICATION_REQUIRED', 'ACCOUNT_UNAVAILABLE'].includes(error.code) || account.status === 'DISABLED') throw error;
    // The article workflow runs at 06:00, before the separate morning session
    // checker. Give it the same stored-credential renewal as daily submissions.
    const { refreshLeetCodeAccount } = await import('../security/sessionAutoRefresh');
    const refreshed = await refreshLeetCodeAccount(account);
    if (!['valid', 'refreshed'].includes(refreshed.status)) throw new PostError('AUTHENTICATION_REQUIRED');
    return resolve(await prisma.account.findUniqueOrThrow({
      where: { id: account.id },
      select: ACCOUNT_SESSION_SELECT,
    }));
  }
}
