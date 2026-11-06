import { randomUUID } from 'node:crypto';
import { prisma } from '../database/prisma';
import { config } from '../config';
import { generateForRun, PostError } from './service';
import { approvePost } from './store';
import { publishPost } from './publisher';
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

/** Return 202 immediately; every operation, including the Post click, runs on Render. */
export async function startServerTest(runId: string, publicationMode: 'daily' | 'manual' = 'manual') {
  if (!process.env.RENDER_INSTANCE_ID) throw new PostError('RENDER_SERVER_REQUIRED');
  const old = await prisma.systemState.findUnique({ where: { key: TEST_CONTROL_KEY } });
  const control: Control | null = old ? JSON.parse(old.value) : null;
  if (!control || control.until <= Date.now()) throw new PostError('SERVER_TEST_DISABLED');
  if (control.active) throw new PostError('SERVER_TEST_IN_PROGRESS');
  const run = await prisma.dailyRun.findUniqueOrThrow({ where: { id: runId } });
  if (run.accountId !== control.accountId || run.state !== 'SUCCESS' || run.submissionStatus !== 'Accepted' || !run.submissionId) {
    throw new PostError('ACCEPTED_SUBMISSION_REQUIRED');
  }
  const id = randomUUID();
  const claimed = JSON.stringify({ ...control, active: id });
  const claim = await prisma.systemState.updateMany({ where: { key: TEST_CONTROL_KEY, value: old!.value }, data: { value: claimed } });
  if (!claim.count) throw new PostError('SERVER_TEST_IN_PROGRESS');
  const job = { id, accountId: control.accountId, runId, publicationMode, executionHost: 'render',
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
        lastError: error instanceof PostError ? error.code : 'SERVER_TEST_FAILED' });
    } finally {
      if (release) await release().catch(() => undefined);
      await prisma.systemState.updateMany({ where: { key: TEST_CONTROL_KEY, value: claimed }, data: { value: old!.value } });
      logger.info({ testId: id, accountId: control.accountId, status: job.status }, 'solution article server test finished');
    }
  })().catch(error => logger.error({ testId: id, errorName: error?.name }, 'solution article server test storage failed'));
  return { ...job, publicBaseUrl: config.api.publicUrl };
}
