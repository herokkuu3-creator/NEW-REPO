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
import { loadSolutionKeyPool, rotateSolutionApiKey } from './keyPool';

export class PostError extends Error {
  constructor(public readonly code: string) { super(code); }
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
  return withAccount(account, async (api, _page, username) => {
    const verdict = await api.awaitSubmission(run.submissionId!, run.problemSlug, 30000, { firstPollDelayMs: 0 });
    if (verdict.classification !== 'ACCEPTED') throw new PostError('ACCEPTED_SUBMISSION_REQUIRED');
    const question = await fetchQuestionData(api, run.problemSlug);
    if (!question.questionId || question.slug !== run.problemSlug || question.isPaidOnly) {
      throw new PostError('PROBLEM_UNAVAILABLE');
    }
    return contextSchema.parse({ accountId, username, problemId: question.questionId, slug: run.problemSlug,
      title: run.title, difficulty: run.difficulty, problem: question.contentHtml,
      submissionId: run.submissionId, language: run.language, code: run.solution, challengeDate: run.date });
  });
}

export async function createPostRouter(): Promise<AIModelRouter> {
  const pool = await loadSolutionKeyPool();
  if (!pool.keys.length) throw new PostError('AI_CONFIGURATION_REQUIRED');
  return new AIModelRouter({ ...config.solutionPosts, apiKeys: pool.keys }, undefined, undefined,
    attempt => logger.info({ attempt }, 'solution article AI attempt finished'),
    async (failedKey, reason) => {
      const advanced = await rotateSolutionApiKey(failedKey);
      logger.warn({ reason, activeKey: advanced.activeIndex + 1, totalKeys: advanced.keys.length }, 'solution article API key advanced');
    });
}

export async function generatePost(context: SubmissionContext, router?: AIModelRouter): Promise<SolutionPost> {
  let post = await ensurePost(context);
  if (!['PENDING', 'RETRY_PENDING'].includes(post.status)) return post;
  if (post.retryCount >= 4) throw new PostError('GENERATION_RETRY_LIMIT');
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
          error instanceof RoutingError ? 'AI_MODELS_EXHAUSTED' :
            error instanceof PostError ? error.code : 'GENERATION_FAILED',
        ...(error instanceof ArticleReviewError ? { ...error.draft,
          contentHash: hash(`${error.draft.title}\n${error.draft.markdown}`), approvedHash: null } : {}),
        ...(error instanceof RoutingError ? { attempts: JSON.stringify(error.attempts) } : {}) });
    }
    return post;
  }
}

export async function generateForRun(accountId: string, runId: string): Promise<SolutionPost> {
  const run = await prisma.dailyRun.findUniqueOrThrow({ where: { id: runId } });
  if (run.accountId !== accountId) throw new PostError('ACCOUNT_IDENTITY_MISMATCH');
  const existing = await prisma.solutionPost.findUnique({ where: { accountId_problemSlug_intent: {
    accountId, problemSlug: run.problemSlug, intent: 'community-solution',
  } } });
  if (existing && !['PENDING', 'RETRY_PENDING'].includes(existing.status)) return existing;
  return generatePost(await loadContext(accountId, runId));
}

export async function retryPost(id: string): Promise<SolutionPost> {
  let post = await prisma.solutionPost.findUniqueOrThrow({ where: { id } });
  if (post.retryCount >= 4) throw new PostError('GENERATION_RETRY_LIMIT');
  if (post.status === 'FAILED') post = await move(post, 'RETRY_PENDING');
  if (post.status !== 'RETRY_PENDING') throw new PostError('NOT_RETRYABLE');
  const context = contextSchema.parse(JSON.parse(post.context));
  const run = await prisma.dailyRun.findFirst({ where: { accountId: post.accountId, submissionId: post.submissionId } });
  if (!run) throw new PostError('SUBMISSION_CONTEXT_MISSING');
  const verified = await loadContext(post.accountId, run.id);
  if (hash(verified.code) !== post.codeHash || verified.slug !== context.slug) throw new PostError('SOURCE_INTEGRITY_FAILED');
  return generatePost(context);
}

export async function resolveCurrentDaily(account: Account, now = new Date()) {
  return withAccount(account, async api => {
    for (let n = 0; n < 3; n++) {
      const daily = await fetchDailyChallenge(api);
      if (daily.date === now.toISOString().slice(0, 10)) return daily;
      if (n < 2) await new Promise(r => setTimeout(r, 1500 * 2 ** n));
    }
    throw new PostError('DAILY_CHALLENGE_NOT_REFRESHED');
  });
}
