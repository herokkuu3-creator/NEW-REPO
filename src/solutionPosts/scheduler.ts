import cron from 'node-cron';
import { randomUUID } from 'node:crypto';
import { Prisma, SolutionPost } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../database/prisma';
import { logger } from '../logger';
import { generateForRun, resolveCurrentDaily, retryPost, PostError } from './service';
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
async function publishGeneratedPost(post: SolutionPost): Promise<SolutionPost> {
  let ready = post;
  if (ready.status === 'AWAITING_APPROVAL') {
    if (!ready.contentHash) throw new PostError('CONTENT_HASH_MISSING');
    ready = await approvePost(ready.id, ready.contentHash);
  }
  if (ready.status === 'DRAFT_READY') return publishPost(ready.id);
  return ready;
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
export async function runCombined(accountIds: string[], now = new Date()) {
  if (!accountIds.length || new Set(accountIds).size !== accountIds.length) throw new PostError('SELECT_ACCOUNTS_REQUIRED');
  const accounts = await prisma.account.findMany({ where: { id: { in: accountIds }, status: { not: 'DISABLED' } } });
  if (accounts.length !== accountIds.length) throw new PostError('ACCOUNT_UNAVAILABLE');
  const results: Array<{ accountId: string; postId?: string; status: string; error?: string }> = [];
  for (const account of accounts) {
    let release: (() => Promise<void>) | null = null;
    try {
      release = await acquireDailyLease(account.id, now.toISOString().slice(0, 10));
      if (!release) { results.push({ accountId: account.id, status: 'SKIPPED', error: 'ACCOUNT_JOB_IN_PROGRESS' }); continue; }
      const daily = await resolveCurrentDaily(account, now);
      let run = await prisma.dailyRun.findUnique({ where: { accountId_date: { accountId: account.id, date: daily.date } } });
      if (!run || run.problemSlug !== daily.slug || run.state !== 'SUCCESS' || !run.submissionId || run.submissionStatus !== 'Accepted') {
        // Lazy import avoids loading the submission stack for draft-only commands.
        const { runSubmissionNow } = await import('../scheduler/dailyWorker');
        const report = await runSubmissionNow('solution-post-combined', { accountIds: [account.id], expectedChallengeDate: daily.date });
        if (!report) throw new PostError('SUBMISSION_WORKER_BUSY');
        run = await prisma.dailyRun.findUnique({ where: { accountId_date: { accountId: account.id, date: daily.date } } });
      }
      if (!run || run.problemSlug !== daily.slug) throw new PostError('ACCEPTED_SUBMISSION_REQUIRED');
      const existing = await prisma.solutionPost.findUnique({ where: {
        accountId_problemSlug_intent: { accountId: account.id, problemSlug: daily.slug, intent: 'community-solution' },
      } });
      // Never resubmit accepted code for generation retries. Uncertain publications are left for reconciliation.
      let post = existing && ['FAILED', 'RETRY_PENDING'].includes(existing.status) ?
        await retryPost(existing.id) : await generateForRun(account.id, run.id);
      if (config.solutionPosts.autoPublish) post = await publishGeneratedPost(post);
      results.push({ accountId: account.id, postId: post.id, status: post.status });
    } catch (error) {
      results.push({ accountId: account.id, status: 'FAILED', error: error instanceof PostError ? error.code : 'COMBINED_WORKFLOW_FAILED' });
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
