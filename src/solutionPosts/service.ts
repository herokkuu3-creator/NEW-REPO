import { chromium, Page } from 'playwright';
import { Account, SolutionPost } from '@prisma/client';
import { config } from '../config';
import { logger } from '../logger';
import { prisma } from '../database/prisma';
import { parseStoredStorageState } from '../database/accounts';
import { checkSession } from '../browser/sessionCheck';
import { LeetCodeApi } from '../leetcode/apiClient';
import { fetchDailyChallenge, fetchQuestionData } from '../leetcode/dailyChallenge';
import { AIModelRouter, RoutingError } from './router';
import { ArticleReviewError, contextSchema, generateArticle, hash, SubmissionContext } from './article';
import { ensurePost, move } from './store';
import { storeVisualAssets, verifyHostedVisualAssets } from './visualStore';
import { loadSolutionKeyPool, maskSolutionApiKey, rotateSolutionApiKey, type SolutionKeyPool } from './keyPool';

export class PostError extends Error {
  constructor(public readonly code: string) { super(code); }
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
    if (!account.username || session.username.toLowerCase() !== account.username.toLowerCase()) {
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
      submissionId: run.submissionId, language: run.language, code: run.solution, challengeDate: contextDate });
  });
}

export async function createPostRouter(): Promise<AIModelRouter> {
  const pool = await loadSolutionKeyPool();
  const activeKeys = activeSolutionApiKeys(pool);
  logger.info({ keyPool: { total: pool.keys.length, activeIndex: pool.activeIndex + 1,
    activeKey: activeKeys[0] ? maskSolutionApiKey(activeKeys[0]) : null, stored: pool.stored } }, 'solution article router configured');
  if (!activeKeys.length) throw new PostError(!pool.keys.length ? 'AI_CONFIGURATION_REQUIRED' :
    pool.lastFailure === 'HTTP_402_BILLING_REQUIRED' ? 'AI_BILLING_REQUIRED' : 'AI_KEYS_EXHAUSTED');
  return new AIModelRouter({ ...config.solutionPosts, apiKeys: activeKeys }, undefined, undefined,
    attempt => logger.info({ attempt }, 'solution article AI attempt finished'),
    async (failedKey, reason) => {
      const advanced = await rotateSolutionApiKey(failedKey, reason);
      logger.warn({ reason, activeKey: advanced.activeIndex + 1, totalKeys: advanced.keys.length }, 'solution article API key advanced');
    });
}

export async function generatePost(context: SubmissionContext, router?: AIModelRouter, force = false): Promise<SolutionPost> {
  let post = await ensurePost(context);
  if (!['PENDING', 'RETRY_PENDING'].includes(post.status)) return post;
  if (!force && post.retryCount >= 4) throw new PostError('GENERATION_RETRY_LIMIT');
  if (force && post.retryCount >= 4) {
    post = await prisma.solutionPost.update({ where: { id: post.id }, data: { retryCount: 0 } });
  }
  // Use the immutable original snapshot when a later submission for the same problem exists.
  const savedContext = contextSchema.parse(JSON.parse(post.context));
  if (hash(savedContext.code) !== post.codeHash) throw new PostError('SOURCE_INTEGRITY_FAILED');
  const maxTimeout = Math.max(config.solutionPosts.timeoutMs, ...Object.values(config.solutionPosts.modelTimeoutMs));
  const leaseMs = 2 * Math.max(1, config.solutionPosts.models.length) * (config.solutionPosts.retries + 1) *
    (maxTimeout + 8000) + 120000;
  post = await move(post, 'CHECKING_ELIGIBILITY', { leaseUntil: new Date(Date.now() + leaseMs), retryCount: { increment: 1 } });
  try {
    // Context comes only from a verified accepted DailyRun; publishing rechecks eligibility and identity.
    const recent = await prisma.solutionPost.findMany({ where: { accountId: post.accountId, title: { not: null } },
      orderBy: { createdAt: 'desc' }, take: 8 });
    post = await move(post, 'GENERATING', { lastError: null });
    const activeRouter = router ?? await createPostRouter();
    const article = await generateArticle(activeRouter, savedContext,
      recent.map(r => ({ style: r.style ?? '', title: r.title ?? '' })),
      plans => storeVisualAssets(plans, config.api.publicUrl));
    // Public posts must contain the two independently generated, durable GIFs.
    // Never degrade a scheduled post to trace tables: that makes a successful
    // generation look complete while silently dropping the required visuals.
    if (article.visualFallback || article.visuals.length !== 2 || article.assets.length !== 2 ||
      !await verifyHostedVisualAssets(article.assets, config.api.publicUrl)) {
      throw new PostError('TWO_PUBLIC_GIFS_REQUIRED');
    }
    post = await move(post, 'VALIDATING', { title: article.title, markdown: article.markdown,
      style: article.style, model: article.model, reviewModel: article.reviewModel,
      attempts: JSON.stringify(article.attempts), contentHash: hash(`${article.title}\n${article.markdown}`), approvedHash: null });
    post = await move(post, 'DRAFT_READY', { leaseUntil: null });
    return move(post, 'AWAITING_APPROVAL');
  } catch (error) {
    // A CAS failure must not overwrite the current owner's result.
    if (['CHECKING_ELIGIBILITY', 'GENERATING', 'VALIDATING'].includes(post.status)) {
      post = await move(post, 'FAILED', { leaseUntil: null,
        lastError: error instanceof ArticleReviewError ? 'TECHNICAL_REVIEW_FAILED' :
          error instanceof RoutingError ? (error.lastFailure === 'PROVIDER_ACCESS_BLOCKED' ? 'AI_PROVIDER_ACCESS_BLOCKED' :
            error.lastFailure ? `AI_ERROR: ${error.lastFailure}` : 'AI_MODELS_EXHAUSTED') :
            error instanceof PostError ? error.code : 'GENERATION_FAILED',
        ...(error instanceof ArticleReviewError ? { ...error.draft,
          contentHash: hash(`${error.draft.title}\n${error.draft.markdown}`), approvedHash: null } : {}),
        ...(error instanceof RoutingError ? { attempts: JSON.stringify(error.attempts) } : {}) });
    }
    return post;
  }
}

export async function generateForRun(accountId: string, runId: string, force = false): Promise<SolutionPost> {
  const run = await prisma.dailyRun.findUniqueOrThrow({ where: { id: runId } });
  if (run.accountId !== accountId) throw new PostError('ACCOUNT_IDENTITY_MISMATCH');
  const existing = await prisma.solutionPost.findUnique({ where: { accountId_problemSlug_intent: {
    accountId, problemSlug: run.problemSlug, intent: 'community-solution',
  } } });
  if (existing && !['PENDING', 'RETRY_PENDING'].includes(existing.status)) {
    if (force && existing.status === 'FAILED') {
      return retryPost(existing.id, true);
    }
    return existing;
  }
  return generatePost(await loadContext(accountId, runId), undefined, force);
}

export async function retryPost(id: string, force = false): Promise<SolutionPost> {
  let post = await prisma.solutionPost.findUniqueOrThrow({ where: { id } });
  if (!force && post.retryCount >= 4) throw new PostError('GENERATION_RETRY_LIMIT');
  if (force && post.retryCount >= 4) {
    post = await prisma.solutionPost.update({ where: { id }, data: { retryCount: 0 } });
  }
  if (post.status === 'FAILED') post = await move(post, 'RETRY_PENDING');
  if (post.status !== 'RETRY_PENDING') throw new PostError('NOT_RETRYABLE');
  const context = contextSchema.parse(JSON.parse(post.context));
  const run = await prisma.dailyRun.findFirst({ where: { accountId: post.accountId, submissionId: post.submissionId } });
  if (!run) throw new PostError('SUBMISSION_CONTEXT_MISSING');
  const verified = await loadContext(post.accountId, run.id);
  if (hash(verified.code) !== post.codeHash || verified.slug !== context.slug) throw new PostError('SOURCE_INTEGRITY_FAILED');
  return generatePost(context, undefined, force);
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
        { lastError: { startsWith: 'AI_ERROR:' } },
      ],
    },
    data: {
      status: 'RETRY_PENDING',
      retryCount: 0,
    },
  });
  // Credentials can be repaired after the four automatic attempts. Reset the
  // matching scheduler budget too; resetting only posts leaves the schedule stuck.
  await prisma.systemState.deleteMany({ where: { key: { startsWith: 'solution-post-schedule-budget:' } } });
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
