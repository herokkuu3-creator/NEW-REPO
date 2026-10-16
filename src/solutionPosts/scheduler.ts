import cron from 'node-cron';
import { randomUUID } from 'node:crypto';
import { Prisma, SolutionPost } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../database/prisma';
import { logger } from '../logger';
import { generateForRun, resolveCurrentDaily, retryPost, PostError } from './service';
import { startRangeJob } from '../scheduler/rangeSubmission';
import { approvePost, recoverGeneration } from './store';
import { publishPost } from './publisher';

export const POST_CRON = '0 6 * * *';
export const POST_TIMEZONE = 'Asia/Kolkata';
export function afterPostSchedule(now: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: POST_TIMEZONE, hour: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  return Number(parts.find(p => p.type === 'hour')?.value) >= 6;
}

/**
 * Publication remains idempotent: completed posts return immediately, and an
 * uncertain POST click remains PUBLISHING for reconciliation rather than a
 * second click. This scheduler is the only automatic publication entry point.
 */
export async function publishGeneratedPost(post: SolutionPost): Promise<SolutionPost> {
  let ready = post;
  if (ready.status === 'AWAITING_APPROVAL') {
    if (!ready.contentHash) throw new PostError('CONTENT_HASH_MISSING');
    ready = await approvePost(ready.id, ready.contentHash);
  }
  if (ready.status === 'DRAFT_READY') return publishPost(ready.id);
  return ready;
}

/** The durable list shared by the 06:00 scheduler and the Telegram picker. */
export async function selectedAccountIds(): Promise<string[]> {
  const selected = await prisma.solutionPostPreference.findMany({ where: { enabled: true }, orderBy: { accountId: 'asc' } });
  return selected.map(item => item.accountId);
}

export type SolutionWorkflowStage =
  | 'starting'
  | 'resolving_daily'
  | 'submitting'
  | 'accepted'
  | 'generating_article'
  | 'publishing_article'
  | 'published'
  | 'article_ready'
  | 'failed'
  | 'skipped';

export interface SolutionWorkflowProgress {
  accountId: string;
  stage: SolutionWorkflowStage;
  questionNumber?: number;
  submissionId?: string;
  postId?: string;
  status?: string;
  error?: string;
}

type ProgressReporter = (event: SolutionWorkflowProgress) => void | Promise<void>;

async function reportProgress(reporter: ProgressReporter | undefined, event: SolutionWorkflowProgress): Promise<void> {
  logger.info({ workflow: 'solution-post', ...event }, 'solution workflow progress');
  if (!reporter) return;
  try { await reporter(event); }
  catch (error) { logger.warn({ accountId: event.accountId, stage: event.stage, err: error }, 'solution workflow progress reporter failed'); }
}

function errorCode(error: unknown, fallback: string): string {
  return error instanceof PostError ? error.code : fallback;
}

/**
 * Submit one explicitly requested public question for selected accounts, then
 * create and publish the same reviewed article used by the daily workflow.
 * Manual runs use a non-daily key so they cannot overwrite or suppress the
 * actual DailyRun for the calendar day.
 */
export async function runManualQuestion(questionNumber: number, accountIds: string[], now = new Date(), onProgress?: ProgressReporter) {
  if (!Number.isInteger(questionNumber) || questionNumber < 1 || questionNumber > 9999) throw new PostError('INVALID_QUESTION_NUMBER');
  if (!accountIds.length || new Set(accountIds).size !== accountIds.length) throw new PostError('SELECT_ACCOUNTS_REQUIRED');
  const accounts = await prisma.account.findMany({ where: { id: { in: accountIds }, status: { not: 'DISABLED' } } });
  if (accounts.length !== accountIds.length) throw new PostError('ACCOUNT_UNAVAILABLE');
  const results: Array<{ accountId: string; postId?: string; status: string; error?: string }> = [];
  for (const account of accounts) {
    try {
      await reportProgress(onProgress, { accountId: account.id, stage: 'starting', questionNumber });
      await reportProgress(onProgress, { accountId: account.id, stage: 'submitting', questionNumber });
      const job = await startRangeJob({ from: questionNumber, to: questionNumber }, account.id);
      if (!('done' in job)) throw new PostError(job.reason === 'no-accounts' ? 'SELECT_ACCOUNTS_REQUIRED' : 'ACCOUNT_UNAVAILABLE');
      const rangeResults = await job.done;
      const accepted = rangeResults[0]?.results.find(result => result.status === 'accepted' && result.capture);
      if (!accepted?.capture || !accepted.submissionId) throw new PostError('ACCEPTED_SUBMISSION_REQUIRED');
      const capture = accepted.capture;
      await reportProgress(onProgress, { accountId: account.id, stage: 'accepted', questionNumber, submissionId: accepted.submissionId });
      const date = `manual:${questionNumber}:${now.toISOString().slice(0, 10)}`;
      const run = await prisma.dailyRun.upsert({ where: { accountId_date: { accountId: account.id, date } },
        create: { accountId: account.id, date, problemSlug: capture.slug, title: capture.title, difficulty: capture.difficulty,
          language: capture.language, solution: capture.code, submissionId: accepted.submissionId, submissionStatus: 'Accepted', state: 'SUCCESS' },
        update: { problemSlug: capture.slug, title: capture.title, difficulty: capture.difficulty, language: capture.language,
          solution: capture.code, submissionId: accepted.submissionId, submissionStatus: 'Accepted', state: 'SUCCESS', error: null },
      });
      await reportProgress(onProgress, { accountId: account.id, stage: 'generating_article', questionNumber, submissionId: accepted.submissionId });
      const existing = await prisma.solutionPost.findUnique({ where: {
        accountId_problemSlug_intent: { accountId: account.id, problemSlug: capture.slug, intent: 'community-solution' },
      } });
      let post = existing && ['FAILED', 'RETRY_PENDING'].includes(existing.status)
        ? await retryPost(existing.id, true)
        : await generateForRun(account.id, run.id);
      if (post.status === 'FAILED') {
        const error = post.lastError || 'GENERATION_FAILED';
        results.push({ accountId: account.id, postId: post.id, status: 'FAILED', error });
        await reportProgress(onProgress, { accountId: account.id, stage: 'failed', questionNumber, submissionId: accepted.submissionId, postId: post.id, error });
        continue;
      }
      if (config.solutionPosts.autoPublish) {
        await reportProgress(onProgress, { accountId: account.id, stage: 'publishing_article', questionNumber, submissionId: accepted.submissionId, postId: post.id });
        post = await publishGeneratedPost(post);
      }
      results.push({ accountId: account.id, postId: post.id, status: post.status });
      await reportProgress(onProgress, { accountId: account.id, stage: post.status === 'PUBLISHED' ? 'published' : 'article_ready', questionNumber,
        submissionId: accepted.submissionId, postId: post.id, status: post.status });
    } catch (error) {
      const code = errorCode(error, 'MANUAL_WORKFLOW_FAILED');
      results.push({ accountId: account.id, status: 'FAILED', error: code });
      await reportProgress(onProgress, { accountId: account.id, stage: 'failed', questionNumber, error: code });
    }
  }
  return results;
}

/** A database CAS lease serializes combined runs across replicas and scheduler restarts. */
async function acquireDailyLease(accountId: string, date: string) {
  const key = `solution-post-job:${accountId}:${date}`;
  const maxTimeout = Math.max(config.solutionPosts.timeoutMs, ...Object.values(config.solutionPosts.modelTimeoutMs));
  const duration = 2 * Math.max(1, config.solutionPosts.models.length) * (config.solutionPosts.retries + 1) *
    (maxTimeout + 8000) + 15 * 60 * 1000;
  const value = JSON.stringify({ owner: randomUUID(), until: Date.now() + duration });
  try { await prisma.systemState.create({ data: { key, value } }); }
  catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    const old = await prisma.systemState.findUnique({ where: { key } });
    if (!old) return null;
    let until = Infinity;
    try { until = Number(JSON.parse(old.value).until); } catch { /* corrupt lock requires operator review */ }
    if (!Number.isFinite(until) || until >= Date.now()) return null;
    const claim = await prisma.systemState.updateMany({ where: { key, value: old.value }, data: { value } });
    if (claim.count !== 1) return null;
  }
  return async () => { await prisma.systemState.deleteMany({ where: { key, value } }); };
}

async function reserveScheduledAttempt(accountId: string, date: string): Promise<boolean> {
  const key = `solution-post-schedule-budget:${accountId}:${date}`;
  const old = await prisma.systemState.findUnique({ where: { key } });
  const count = old ? Number(old.value) : 0;
  if (!Number.isInteger(count) || count < 0 || count >= 4) return false;
  if (old) return (await prisma.systemState.updateMany({ where: { key, value: old.value },
    data: { value: String(count + 1) } })).count === 1;
  try { await prisma.systemState.create({ data: { key, value: '1' } }); return true; }
  catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return false;
    throw error;
  }
}

/** Each selected account is independent. Existing daily worker handles code submission unchanged. */
export async function runCombined(accountIds: string[], now = new Date(), onProgress?: ProgressReporter) {
  if (!accountIds.length || new Set(accountIds).size !== accountIds.length) throw new PostError('SELECT_ACCOUNTS_REQUIRED');
  const accounts = await prisma.account.findMany({ where: { id: { in: accountIds }, status: { not: 'DISABLED' } } });
  if (accounts.length !== accountIds.length) throw new PostError('ACCOUNT_UNAVAILABLE');
  const results: Array<{ accountId: string; postId?: string; status: string; error?: string }> = [];
  for (const account of accounts) {
    let release: (() => Promise<void>) | null = null;
    try {
      await reportProgress(onProgress, { accountId: account.id, stage: 'starting' });
      release = await acquireDailyLease(account.id, now.toISOString().slice(0, 10));
      if (!release) {
        results.push({ accountId: account.id, status: 'SKIPPED', error: 'ACCOUNT_JOB_IN_PROGRESS' });
        await reportProgress(onProgress, { accountId: account.id, stage: 'skipped', error: 'ACCOUNT_JOB_IN_PROGRESS' });
        continue;
      }
      await reportProgress(onProgress, { accountId: account.id, stage: 'resolving_daily' });
      const daily = await resolveCurrentDaily(account, now);
      let run = await prisma.dailyRun.findUnique({ where: { accountId_date: { accountId: account.id, date: daily.date } } });
      if (!run || run.problemSlug !== daily.slug || run.state !== 'SUCCESS' || !run.submissionId || run.submissionStatus !== 'Accepted') {
        // Lazy import avoids loading the submission stack for draft-only commands.
        const { runSubmissionNow } = await import('../scheduler/dailyWorker');
        await reportProgress(onProgress, { accountId: account.id, stage: 'submitting' });
        const report = await runSubmissionNow('solution-post-combined', { accountIds: [account.id], expectedChallengeDate: daily.date });
        if (!report) throw new PostError('SUBMISSION_WORKER_BUSY');
        run = await prisma.dailyRun.findUnique({ where: { accountId_date: { accountId: account.id, date: daily.date } } });
      }
      if (!run || run.problemSlug !== daily.slug) throw new PostError('ACCEPTED_SUBMISSION_REQUIRED');
      await reportProgress(onProgress, { accountId: account.id, stage: 'accepted', submissionId: run.submissionId ?? undefined });
      const existing = await prisma.solutionPost.findUnique({ where: {
        accountId_problemSlug_intent: { accountId: account.id, problemSlug: daily.slug, intent: 'community-solution' },
      } });
      // Never resubmit accepted code for generation retries. Uncertain publications are left for reconciliation.
      await reportProgress(onProgress, { accountId: account.id, stage: 'generating_article', submissionId: run.submissionId ?? undefined });
      let post = existing && ['FAILED', 'RETRY_PENDING'].includes(existing.status) ?
        await retryPost(existing.id, true) : await generateForRun(account.id, run.id, true);
      if (post.status === 'FAILED') {
        const error = post.lastError || 'GENERATION_FAILED';
        results.push({ accountId: account.id, postId: post.id, status: 'FAILED', error });
        await reportProgress(onProgress, { accountId: account.id, stage: 'failed', submissionId: run.submissionId ?? undefined, postId: post.id, error });
        continue;
      }
      if (config.solutionPosts.autoPublish) {
        await reportProgress(onProgress, { accountId: account.id, stage: 'publishing_article', submissionId: run.submissionId ?? undefined, postId: post.id });
        post = await publishGeneratedPost(post);
      }
      results.push({ accountId: account.id, postId: post.id, status: post.status });
      await reportProgress(onProgress, { accountId: account.id, stage: post.status === 'PUBLISHED' ? 'published' : 'article_ready',
        submissionId: run.submissionId ?? undefined, postId: post.id, status: post.status });
    } catch (error) {
      const code = errorCode(error, 'COMBINED_WORKFLOW_FAILED');
      results.push({ accountId: account.id, status: 'FAILED', error: code });
      await reportProgress(onProgress, { accountId: account.id, stage: 'failed', error: code });
    } finally { if (release) await release().catch(() => undefined); }
  }
  return results;
}

/** Explicitly replaces selections. An empty list clears scheduling. */
export async function setSelectedAccounts(accountIds: string[]) {
  const unique = [...new Set(accountIds)];
  const count = await prisma.account.count({ where: { id: { in: unique }, status: { not: 'DISABLED' } } });
  if (count !== unique.length) throw new PostError('ACCOUNT_UNAVAILABLE');
  await prisma.$transaction(async tx => {
    await tx.solutionPostPreference.updateMany({ data: { enabled: false } });
    for (const accountId of unique) await tx.solutionPostPreference.upsert({ where: { accountId },
      create: { accountId, enabled: true }, update: { enabled: true } });
  });
  return { accountIds: unique, cron: POST_CRON, timezone: POST_TIMEZONE,
    publishing: config.solutionPosts.autoPublish ? 'automatic' : 'review-required' };
}

export function startSolutionPostScheduler(): () => void {
  let running = false;
  const tick = async () => {
    if (running || !afterPostSchedule(new Date())) return;
    running = true;
    try {
      await recoverGeneration();
      const preferences = await prisma.solutionPostPreference.findMany({ where: { enabled: true } });
      if (!preferences.length) return;
      const today = new Date().toISOString().slice(0, 10);
      const posts = await prisma.solutionPost.findMany({ where: { accountId: { in: preferences.map(p => p.accountId) } } });
      const eligibleIds = preferences.filter(p => !posts.some(post => {
        let date: string | undefined;
        try { date = (JSON.parse(post.context) as { challengeDate: string }).challengeDate; } catch { return false; }
        return post.accountId === p.accountId && date === today &&
          (!['FAILED', 'RETRY_PENDING', 'PENDING'].includes(post.status) || post.retryCount >= 4);
      })).map(p => p.accountId);
      const pendingIds: string[] = [];
      for (const id of eligibleIds) if (await reserveScheduledAttempt(id, today)) pendingIds.push(id);
      if (!pendingIds.length) return;
      const results = await runCombined(pendingIds);
      logger.info({ results, timezone: POST_TIMEZONE, autoPublish: config.solutionPosts.autoPublish }, 'daily solution article workflow finished');
    } catch { logger.warn('solution draft scheduler failed; inspect solution history'); }
    finally { running = false; }
  };
  // The recovery timer also catches up after a restart; uniqueness and leases arbitrate multiple processes.
  const daily = cron.schedule(POST_CRON, () => void tick(), { timezone: POST_TIMEZONE });
  const recovery = cron.schedule('*/10 * * * *', () => void tick(), { timezone: POST_TIMEZONE });
  void tick();
  return () => { daily.stop(); recovery.stop(); };
}
