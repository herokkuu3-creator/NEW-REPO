import { randomUUID } from 'node:crypto';
import type { SolutionPost } from '@prisma/client';
import { prisma } from '../database/prisma';
import { config } from '../config';
import { createPostRouter, generateForRun, loadContext, PostError, withAccount } from './service';
import { contextSchema, hash, type SubmissionContext } from './article';
import { generateImplementation } from './implementation';
import { RoutingError } from './router';
import { approvePost } from './store';
import { checkEligibility, publishPost, verifyArticleCode } from './publisher';
import { acquireDailyLease } from './scheduler';
import { logger } from '../logger';
import { publishDailyPost, dailyPublicationStatus } from './dailyPublication';

export const TEST_CONTROL_KEY = 'solution-post-server-test:control';
const jobKey = (id: string) => `solution-post-server-test:job:${id}`;
type Control = { accountId: string; until: number; active?: string };

/** Explicit, temporary opt-in for one account. No schedule/preferences are changed. */
export async function configureServerTest(accountId: string | null) {
  const old = await prisma.systemState.findUnique({ where: { key: TEST_CONTROL_KEY } });
  const control: Control | null = old ? JSON.parse(old.value) : null;
  if (control?.active && control.until > Date.now()) throw new PostError('SERVER_TEST_IN_PROGRESS');
  if (!accountId) {
    await prisma.systemState.deleteMany({ where: { key: TEST_CONTROL_KEY } });
    return { enabled: false };
  }
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  if (account.status !== 'ACTIVE') throw new PostError('ACCOUNT_UNAVAILABLE');
  const next: Control = { accountId, until: Date.now() + 60 * 60 * 1000 };
  // A simultaneous enable must not overwrite another caller's claimed job.
  if (old) {
    const updated = await prisma.systemState.updateMany({ where: { key: TEST_CONTROL_KEY, value: old.value },
      data: { value: JSON.stringify(next) } });
    if (!updated.count) throw new PostError('SERVER_TEST_IN_PROGRESS');
  } else await prisma.systemState.create({ data: { key: TEST_CONTROL_KEY, value: JSON.stringify(next) } });
  return { enabled: true, accountId, expiresAt: new Date(next.until).toISOString() };
}

export async function readServerTest(id: string) {
  const row = await prisma.systemState.findUniqueOrThrow({ where: { key: jobKey(id) } });
  const job = JSON.parse(row.value);
  if ((job.status === 'DEFERRED' || job.postStatus === 'PUBLISHING') && job.postId) {
    const post = await prisma.solutionPost.findUniqueOrThrow({ where: { id: job.postId } });
    if (post.status === 'PUBLISHED') {
      Object.assign(job, { status: 'PUBLISHED', stage: 'finished', postStatus: post.status, url: post.publishedUrl,
        lastError: null, finishedAt: post.publishedAt?.toISOString() });
      await prisma.systemState.updateMany({ where: { key: jobKey(id), value: row.value }, data: { value: JSON.stringify(job) } });
    }
  }
  return job;
}

function reviewedDraftContext(post: SolutionPost, originalSubmissionId: string): SubmissionContext | null {
  if (!['AWAITING_APPROVAL', 'DRAFT_READY'].includes(post.status) || post.submissionId !== originalSubmissionId) return null;
  if (!post.title || !post.markdown || hash(`${post.title}\n${post.markdown}`) !== post.contentHash) throw new PostError('REVIEW_REQUIRED');
  const context = contextSchema.parse(JSON.parse(post.context));
  if (context.accountId !== post.accountId || context.slug !== post.problemSlug || context.submissionId !== originalSubmissionId ||
      hash(context.code) !== post.codeHash) throw new PostError('SOURCE_INTEGRITY_FAILED');
  if (!context.articleImplementation) return null;
  verifyArticleCode(post.markdown, context);
  return context;
}

async function judgeImplementation(context: SubmissionContext, code: string, save: (update: object) => Promise<void>) {
  const account = await prisma.account.findUniqueOrThrow({ where: { id: context.accountId } });
  await withAccount(account, async (api, _page, username) => {
    const baseline = await checkEligibility(api, context, username);
    await save({ stage: 'submitting_implementation', baseline, implementationHash: hash(code) });
    const submissionId = await api.submitSolution({ slug: context.slug, questionId: context.problemId,
      lang: context.language, code });
    await save({ stage: 'awaiting_verdict', submissionId });
    const verdict = await api.awaitSubmission(submissionId, context.slug, 90_000);
    await save({ status: verdict.classification === 'ACCEPTED' ? 'ACCEPTED' : 'FAILED', stage: 'finished',
      verdict, lastError: verdict.classification === 'ACCEPTED' ? null : verdict.classification,
      finishedAt: new Date().toISOString() });
  });
}

/** Return 202 immediately and run the selected test on Render. */
export async function startServerTest(runId: string, publicationMode: 'daily' | 'manual' = 'manual',
  verification: 'publication' | 'judge' = 'publication') {
  if (!process.env.RENDER_INSTANCE_ID) throw new PostError('RENDER_SERVER_REQUIRED');
  const old = await prisma.systemState.findUnique({ where: { key: TEST_CONTROL_KEY } });
  const control: Control | null = old ? JSON.parse(old.value) : null;
  if (!control || control.until <= Date.now()) throw new PostError('SERVER_TEST_DISABLED');
  if (control.active) throw new PostError('SERVER_TEST_IN_PROGRESS');
  const run = await prisma.dailyRun.findUniqueOrThrow({ where: { id: runId } });
  const originalSubmissionId = run.submissionId;
  if (run.accountId !== control.accountId || run.state !== 'SUCCESS' || run.submissionStatus !== 'Accepted' || !originalSubmissionId) {
    throw new PostError('ACCEPTED_SUBMISSION_REQUIRED');
  }
  const id = randomUUID();
  const claimed = JSON.stringify({ ...control, active: id });
  const claim = await prisma.systemState.updateMany({ where: { key: TEST_CONTROL_KEY, value: old!.value }, data: { value: claimed } });
  if (!claim.count) throw new PostError('SERVER_TEST_IN_PROGRESS');
  const job = { id, accountId: control.accountId, runId, publicationMode, verification, executionHost: 'render',
    revision: process.env.RENDER_GIT_COMMIT ?? null, startedAt: new Date().toISOString(), status: 'RUNNING', stage: 'generation' };
  const save = async (update: object) => {
    Object.assign(job, update);
    await prisma.systemState.upsert({ where: { key: jobKey(id) },
      create: { key: jobKey(id), value: JSON.stringify(job) }, update: { value: JSON.stringify(job) } });
  };
  await save({});
  void (async () => {
    let release: (() => Promise<void>) | null = null;
    try {
      release = await acquireDailyLease(control.accountId, new Date().toISOString().slice(0, 10));
      if (!release) throw new PostError('ACCOUNT_JOB_IN_PROGRESS');
      if (verification === 'judge') {
        const draft = await prisma.solutionPost.findUnique({ where: { accountId_problemSlug_intent: {
          accountId: run.accountId, problemSlug: run.problemSlug, intent: 'community-solution',
        } } });
        const draftContext = draft ? reviewedDraftContext(draft, originalSubmissionId) : null;
        if (draft && draftContext?.articleImplementation) {
          await save({ implementationSource: 'reviewed_draft', postId: draft.id, postStatus: draft.status });
          return await judgeImplementation(draftContext, draftContext.articleImplementation.code, save);
        }
        await save({ stage: 'generating_implementation', implementationSource: 'server_generator' });
        const context = await loadContext(run.accountId, runId);
        if (context.submissionId !== originalSubmissionId) throw new PostError('SOURCE_INTEGRITY_FAILED');
        const router = await createPostRouter({ accountId: run.accountId });
        const implementation = await generateImplementation(router, context, [], async () => true);
        return await judgeImplementation(context, implementation.value.code, save);
      }
      let post = await generateForRun(control.accountId, runId, true);
      await save({ postId: post.id, postStatus: post.status, lastError: post.lastError });
      if (post.status === 'AWAITING_APPROVAL') {
        if (!post.contentHash) throw new PostError('REVIEW_REQUIRED');
        post = await approvePost(post.id, post.contentHash);
      }
      if (post.status === 'DRAFT_READY') {
        await save({ stage: 'publication' });
        post = publicationMode === 'daily' ? await publishDailyPost(post.id) : await publishPost(post.id);
      }
      const deferred = post.lastError === 'DAILY_PUBLICATION_COOLDOWN';
      await save({ status: post.status === 'PUBLISHED' ? 'PUBLISHED' : deferred ? 'DEFERRED' : 'FAILED', stage: deferred ? 'publication_queued' : 'finished',
        postStatus: post.status, url: post.publishedUrl, lastError: post.lastError,
        ...(deferred ? await dailyPublicationStatus() : {}),
        finishedAt: new Date().toISOString() });
    } catch (error) {
      await save({ status: 'FAILED', stage: 'finished', finishedAt: new Date().toISOString(),
        lastError: error instanceof PostError ? error.code : error instanceof RoutingError ? error.lastFailure ?? 'SERVER_TEST_FAILED' : 'SERVER_TEST_FAILED' });
    } finally {
      if (release) await release().catch(() => undefined);
      await prisma.systemState.updateMany({ where: { key: TEST_CONTROL_KEY, value: claimed }, data: { value: old!.value } });
      logger.info({ testId: id, accountId: control.accountId, status: job.status }, 'solution article server test finished');
    }
  })().catch(error => logger.error({ testId: id, errorName: error?.name }, 'solution article server test storage failed'));
  return { ...job, publicBaseUrl: config.api.publicUrl };
}
