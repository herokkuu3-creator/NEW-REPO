import { chromium, Page } from 'playwright';
import { Account, SolutionPost } from '@prisma/client';
import { z } from 'zod';
import { config } from '../config';
import { logger } from '../logger';
import { prisma } from '../database/prisma';
import { parseStoredStorageState } from '../database/accounts';
import { checkSession } from '../browser/sessionCheck';
import { LeetCodeApi } from '../leetcode/apiClient';
import { fetchDailyChallenge, fetchQuestionData } from '../leetcode/dailyChallenge';
import { AIModelRouter, RoutingError, SOLUTION_ARTICLE_WORK_MS } from './router';
import { FirecrawlAgentRouter } from './firecrawlAgent';
import { isSageProvider } from '../config/solutionPostProvider';
import { reservePostPresentation } from './presentation';
import { FIRECRAWL_STAGE_BUDGET_MS } from './firecrawlRateGate';
import { articleNeedsRefresh, ArticleReviewError, contextSchema, generateArticle, hash, SubmissionContext, StageCallback } from './article';
import { OutputValidationError } from './router';
import { ensurePost, move } from './store';
import { storeVisualAssets, verifyHostedVisualAssets } from './visualStore';
import { loadSolutionKeyPool, maskSolutionApiKey, resetSolutionApiKeyPool, rotateSolutionApiKey, type SolutionKeyPool } from './keyPool';
import { startArticleWorkKeepAlive } from './keepAlive';
import { generateImplementation, IMPLEMENTATION_STAGE_BUDGET } from './implementation';
import { CoarenaRouter, loadCoarenaKey, maskCoarenaKey } from './coarena';

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

/** A normal isolated browser context. No shared profile, solver, credential forwarding, or challenge bypass. */
export async function withAccount<T>(account: Account,
  action: (api: LeetCodeApi, page: Page, username: string) => Promise<T>): Promise<T> {
  const parsed = parseStoredStorageState(account.storageState);
  if (!parsed.ok || account.status === 'DISABLED') throw new PostError('ACCOUNT_UNAVAILABLE');
  const browser = await chromium.launch({ headless: config.browser.headless });
  try {
    const context = await browser.newContext({ storageState: parsed.state });
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
  const run = await prisma.dailyRun.findUniqueOrThrow({ where: { id: runId } });
  if (run.accountId !== accountId || run.state !== 'SUCCESS' || !run.solution || !run.submissionId ||
    run.submissionStatus !== 'Accepted') throw new PostError('ACCEPTED_SUBMISSION_REQUIRED');
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  // Manual question submissions use a namespaced DailyRun key so they never
  // collide with the real calendar-day run. The article context still needs a
  // normal ISO challenge date for validation and presentation.
  const contextDate = /^\d{4}-\d{2}-\d{2}$/.test(run.date) ? run.date :
    /^manual:\d+:(\d{4}-\d{2}-\d{2})$/.exec(run.date)?.[1] ?? new Date().toISOString().slice(0, 10);
  return withAccount(account, async (api, _page, username) => {
    const verdict = await api.awaitSubmission(run.submissionId!, run.problemSlug, 30000, { firstPollDelayMs: 0 });
    if (verdict.classification !== 'ACCEPTED') throw new PostError('ACCEPTED_SUBMISSION_REQUIRED');
    const question = await fetchQuestionData(api, run.problemSlug);
    if (!question.questionId || question.slug !== run.problemSlug || question.isPaidOnly) {
      throw new PostError('PROBLEM_UNAVAILABLE');
    }
    return contextSchema.parse({ accountId, username, problemId: question.questionId, slug: run.problemSlug,
      title: run.title, difficulty: run.difficulty, problem: question.contentHtml,
      submissionId: run.submissionId, language: run.language, code: run.solution,
      challengeDate: contextDate, topicTags: question.topicTags ?? [] });
  });
}

export async function createPostRouter(correlation: { postId?: string; accountId?: string } = {},
  providerOverride?: 'firecrawl' | 'bazaarlink', reportKey?: (label: string) => void): Promise<AIModelRouter> {
  const deadlineAt = providerOverride ? undefined : Date.now() + SOLUTION_ARTICLE_WORK_MS;
  const key = providerOverride ? null : await loadCoarenaKey().catch(() => null);
  if (key) return new CoarenaRouter(key, () => createDiscoveryRouter(correlation, reportKey, deadlineAt), attempt => {
    if (attempt.attempt > 0 && attempt.model !== 'discovery') reportKey?.(`Coarena · ${maskCoarenaKey(key)}`);
    logger.info({ ...correlation, attempt }, 'solution article AI attempt finished');
  }, deadlineAt);
  if ((providerOverride ?? config.solutionPosts.aiProvider) === 'firecrawl') {
    if (!config.solutionPosts.firecrawlApiKey) throw new PostError('FIRECRAWL_KEY_REQUIRED');
    return new FirecrawlAgentRouter(config.solutionPosts.firecrawlApiKey, config.solutionPosts.agentMaxCredits,
      attempt => logger.info({ ...correlation, attempt }, 'solution article AI attempt finished'));
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
    await prisma.systemState.create({ data: { key, value: post.id } });
    return true;
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error;
    const reservation = await prisma.systemState.findUnique({ where: { key } });
    return reservation?.value === post.id;
  }
}

export async function generatePost(context: SubmissionContext, router?: AIModelRouter, force = false, onStage?: StageCallback): Promise<SolutionPost> {
  let post = await ensurePost(context);
  if (!['PENDING', 'RETRY_PENDING'].includes(post.status)) return post;
  checkGenerationBudget(post, force);
  // Use the immutable original snapshot when a later submission for the same problem exists.
  const originalContext = contextSchema.parse(JSON.parse(post.context));
  if (hash(originalContext.code) !== post.codeHash) throw new PostError('SOURCE_INTEGRITY_FAILED');
  const savedContext = { ...originalContext, presentation: originalContext.presentation?.format ? originalContext.presentation :
    await reservePostPresentation(post.problemSlug) };
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
    post = await move(post, 'GENERATING', { lastError: null });
    let currentKey: string | undefined;
    const activeRouter = router ?? await createPostRouter({ postId: post.id, accountId: post.accountId }, undefined, label => {
      if (label === currentKey) return;
      currentKey = label;
      void Promise.resolve(onStage?.('article_provider', label)).catch(() => undefined);
    });
    await onStage?.('generating_article', 'Writing and reviewing a distinct implementation…');
    const implementation = await generateImplementation(activeRouter, savedContext, previous,
      fingerprint => reserveImplementation(post, savedContext, fingerprint));
    implementationAttempts = implementation.attempts;
    const articleContext = { ...savedContext, articleImplementation: implementation.value };
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
    const article = await generateArticle(activeRouter, articleContext,
      [...recentStyles].map(([title, style]) => ({ title, style })),
      plans => storeVisualAssets(plans, config.api.publicUrl), priorFailure, onStage);
    // Public posts must contain the two independently generated, durable GIFs.
    // Never degrade a scheduled post to trace tables: that makes a successful
    // generation look complete while silently dropping the required visuals.
    if (article.visualFallback || article.visuals.length !== 2 || article.assets.length !== 2 ||
      !await verifyHostedVisualAssets(article.assets, config.api.publicUrl)) {
      throw new PostError('TWO_PUBLIC_GIFS_REQUIRED');
    }
    post = await move(post, 'VALIDATING', { title: article.title, markdown: article.markdown,
      style: article.style, model: article.model, reviewModel: article.reviewModel, context: JSON.stringify(articleContext),
      attempts: JSON.stringify([...implementationAttempts, ...article.attempts]),
      contentHash: hash(`${article.title}\n${article.markdown}`), approvedHash: null });
    post = await move(post, 'DRAFT_READY', { leaseUntil: null });
    return move(post, 'AWAITING_APPROVAL');
  } catch (error) {
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
  } finally { stopKeepAlive(); }
}

export async function generateForRun(accountId: string, runId: string, force = false, onStage?: StageCallback): Promise<SolutionPost> {
  const run = await prisma.dailyRun.findUniqueOrThrow({ where: { id: runId } });
  if (run.accountId !== accountId) throw new PostError('ACCOUNT_IDENTITY_MISMATCH');
  const existing = await prisma.solutionPost.findUnique({ where: { accountId_problemSlug_intent: {
    accountId, problemSlug: run.problemSlug, intent: 'community-solution',
  } } });
  if (existing && !['PENDING', 'RETRY_PENDING'].includes(existing.status)) {
    if ((force && existing.status === 'FAILED') || (['DRAFT_READY', 'AWAITING_APPROVAL'].includes(existing.status) &&
      articleNeedsRefresh(contextSchema.parse(JSON.parse(existing.context))))) {
      return retryPost(existing.id, true, onStage);
    }
    return existing;
  }
  return generatePost(await loadContext(accountId, runId), undefined, force, onStage);
}

export async function requeueInterruptedGeneration(id: string, updatedAt: Date): Promise<SolutionPost> {
  const post = await prisma.solutionPost.findUniqueOrThrow({ where: { id } });
  if (!['CHECKING_ELIGIBILITY', 'GENERATING', 'VALIDATING'].includes(post.status) ||
      post.updatedAt.getTime() !== updatedAt.getTime() || Date.now() - updatedAt.getTime() < SOLUTION_ARTICLE_WORK_MS) {
    throw new PostError('GENERATION_RECOVERY_CONFLICT');
  }
  const key = 'solution-post-job:' + post.accountId + ':' + updatedAt.toISOString().slice(0, 10);
  const lock = await prisma.systemState.findUnique({ where: { key } });
  const recovered = await move(post, 'RETRY_PENDING', { leaseUntil: null, lastError: 'GENERATION_INTERRUPTED' });
  // Remove only the account lock observed before this generation made progress.
  if (lock && lock.updatedAt <= updatedAt) await prisma.systemState.deleteMany({ where: { key, value: lock.value } });
  return recovered;
}

export async function retryPost(id: string, force = false, onStage?: StageCallback): Promise<SolutionPost> {
  const post = await prisma.solutionPost.findUniqueOrThrow({ where: { id } });
  const refreshDraft = force && ['DRAFT_READY', 'AWAITING_APPROVAL'].includes(post.status);
  if (!refreshDraft && !['FAILED', 'RETRY_PENDING'].includes(post.status)) throw new PostError('NOT_RETRYABLE');
  const context = contextSchema.parse(JSON.parse(post.context));
  if (refreshDraft && !articleNeedsRefresh(context)) throw new PostError('NOT_RETRYABLE');
  checkGenerationBudget(post, force);
  const run = await prisma.dailyRun.findFirst({ where: { accountId: post.accountId, submissionId: post.submissionId } });
  if (!run) throw new PostError('SUBMISSION_CONTEXT_MISSING');
  const verified = await loadContext(post.accountId, run.id);
  if (hash(verified.code) !== post.codeHash || verified.slug !== context.slug) throw new PostError('SOURCE_INTEGRITY_FAILED');
  if (refreshDraft) {
    await move(post, 'RETRY_PENDING', { approvedHash: null, contentHash: null });
  } else if (post.status === 'FAILED') {
    await move(post, 'RETRY_PENDING');
  }
  return generatePost(context, undefined, force, onStage);
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
  return updated.count;
}

export async function resolveCurrentDaily(account: Account, now = new Date()) {
  const resolve = (candidate: Account) => withAccount(candidate, async api => {
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
    return resolve(await prisma.account.findUniqueOrThrow({ where: { id: account.id } }));
  }
}
