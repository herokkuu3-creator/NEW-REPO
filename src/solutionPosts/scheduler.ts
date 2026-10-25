import cron from 'node-cron';
import { randomUUID } from 'node:crypto';
import { Prisma, SolutionPost } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../database/prisma';
import { logger } from '../logger';
import { generateForRun, resolveCurrentDaily, retryPost, PostError } from './service';
import { submitSingleQuestionDirectly } from '../scheduler/rangeSubmission';
import type { AccountRecord } from '../database/accounts';
import { approvePost, recoverGeneration } from './store';
import { publishPost } from './publisher';
import { sendTelegramMessage } from '../notifications/telegram';

export const POST_CRON = '0 6 * * *';
export const POST_TIMEZONE = 'Asia/Kolkata';
export const SCHEDULE_STATE_KEY = 'solution-post-scheduler:last-tick';
let scheduledRunInProgress = false;
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
  if (ready.status === 'AWAITING_APPROVAL' || (ready.status === 'DRAFT_READY' && ready.approvedHash !== ready.contentHash)) {
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
  previousError?: string;
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

function acceptedDailyRun(run: { problemSlug: string; state: string; submissionId: string | null; submissionStatus: string | null } | null, slug: string): boolean {
  return !!run && run.problemSlug === slug && run.state === 'SUCCESS' && !!run.submissionId && run.submissionStatus === 'Accepted';
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
      const submitRes = await submitSingleQuestionDirectly(account as unknown as AccountRecord, questionNumber);
      if (submitRes.outcome.status !== 'accepted' || !submitRes.capture || !submitRes.outcome.submissionId) {
        throw new PostError('ACCEPTED_SUBMISSION_REQUIRED');
      }
      const capture = submitRes.capture;
      const submissionId = submitRes.outcome.submissionId;
      await reportProgress(onProgress, { accountId: account.id, stage: 'accepted', questionNumber, submissionId });
      const date = `manual:${questionNumber}:${now.toISOString().slice(0, 10)}`;
      const run = await prisma.dailyRun.upsert({ where: { accountId_date: { accountId: account.id, date } },
        create: { accountId: account.id, date, problemSlug: capture.slug, title: capture.title, difficulty: capture.difficulty,
          language: capture.language, solution: capture.code, submissionId, submissionStatus: 'Accepted', state: 'SUCCESS' },
        update: { problemSlug: capture.slug, title: capture.title, difficulty: capture.difficulty, language: capture.language,
          solution: capture.code, submissionId, submissionStatus: 'Accepted', state: 'SUCCESS', error: null },
      });
      await reportProgress(onProgress, { accountId: account.id, stage: 'generating_article', questionNumber, submissionId });
      const existing = await prisma.solutionPost.findUnique({ where: {
        accountId_problemSlug_intent: { accountId: account.id, problemSlug: capture.slug, intent: 'community-solution' },
      } });
      let post = existing && ['FAILED', 'RETRY_PENDING'].includes(existing.status)
        ? await retryPost(existing.id, true)
        : await generateForRun(account.id, run.id, true);
      if (post.status === 'FAILED') {
        const error = post.lastError || 'GENERATION_FAILED';
        results.push({ accountId: account.id, postId: post.id, status: 'FAILED', error });
        await reportProgress(onProgress, { accountId: account.id, stage: 'failed', questionNumber, submissionId, postId: post.id, error });
        continue;
      }
      if (config.solutionPosts.autoPublish) {
        await reportProgress(onProgress, { accountId: account.id, stage: 'publishing_article', questionNumber, submissionId, postId: post.id });
        post = await publishGeneratedPost(post);
      }
      results.push({ accountId: account.id, postId: post.id, status: post.status });
      await reportProgress(onProgress, { accountId: account.id, stage: post.status === 'PUBLISHED' ? 'published' : 'article_ready', questionNumber,
        submissionId, postId: post.id, status: post.status });
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
export async function runCombined(accountIds: string[], now = new Date(), onProgress?: ProgressReporter,
  options: { retryFailedGeneration?: boolean } = {}) {
  if (!accountIds.length || new Set(accountIds).size !== accountIds.length) throw new PostError('SELECT_ACCOUNTS_REQUIRED');
  const accounts = await prisma.account.findMany({ where: { id: { in: accountIds }, status: { not: 'DISABLED' } } });
  if (accounts.length !== accountIds.length) throw new PostError('ACCOUNT_UNAVAILABLE');
  const results: Array<{ accountId: string; postId?: string; status: string; error?: string; previousError?: string }> = [];
  const accepted: Array<{ accountId: string; slug: string; runId: string; submissionId: string }> = [];
  // Finish code submissions for every selected account before invoking the AI.
  // A slow or unavailable article provider must not hold up anyone's daily streak.
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
      if (!acceptedDailyRun(run, daily.slug)) {
        // Lazy import avoids loading the submission stack for draft-only commands.
        const { runSubmissionNow } = await import('../scheduler/dailyWorker');
        await reportProgress(onProgress, { accountId: account.id, stage: 'submitting' });
        const report = await runSubmissionNow('solution-post-combined', { accountIds: [account.id], expectedChallengeDate: daily.date });
        if (!report) throw new PostError('SUBMISSION_WORKER_BUSY');
        run = await prisma.dailyRun.findUnique({ where: { accountId_date: { accountId: account.id, date: daily.date } } });
      }
      if (!acceptedDailyRun(run, daily.slug) || !run) throw new PostError('ACCEPTED_SUBMISSION_REQUIRED');
      await reportProgress(onProgress, { accountId: account.id, stage: 'accepted', submissionId: run.submissionId! });
      accepted.push({ accountId: account.id, slug: daily.slug, runId: run.id, submissionId: run.submissionId! });
    } catch (error) {
      const code = errorCode(error, 'DAILY_SUBMISSION_FAILED');
      results.push({ accountId: account.id, status: 'FAILED', error: code });
      await reportProgress(onProgress, { accountId: account.id, stage: 'failed', error: code });
    } finally { if (release) await release().catch(() => undefined); }
  }
  for (const run of accepted) {
    let release: (() => Promise<void>) | null = null;
    const accountId = run.accountId;
    try {
      release = await acquireDailyLease(accountId, now.toISOString().slice(0, 10));
      if (!release) {
        results.push({ accountId, status: 'SKIPPED', error: 'ACCOUNT_JOB_IN_PROGRESS' });
        await reportProgress(onProgress, { accountId, stage: 'skipped', error: 'ACCOUNT_JOB_IN_PROGRESS' });
        continue;
      }
      const existing = await prisma.solutionPost.findUnique({ where: {
        accountId_problemSlug_intent: { accountId, problemSlug: run.slug, intent: 'community-solution' },
      } });
      // Never resubmit accepted code for generation retries. Uncertain publications are left for reconciliation.
      await reportProgress(onProgress, { accountId, stage: 'generating_article', submissionId: run.submissionId });
      let post = existing && ['FAILED', 'RETRY_PENDING'].includes(existing.status) ?
        await retryPost(existing.id, options.retryFailedGeneration === true) :
        await generateForRun(accountId, run.runId, options.retryFailedGeneration === true);
      if (['CHECKING_ELIGIBILITY', 'GENERATING', 'VALIDATING', 'PUBLISHING'].includes(post.status)) {
        results.push({ accountId, postId: post.id, status: 'SKIPPED', error: 'ACCOUNT_JOB_IN_PROGRESS' });
        await reportProgress(onProgress, { accountId, stage: 'skipped', postId: post.id, error: 'ACCOUNT_JOB_IN_PROGRESS' });
        continue;
      }
      if (post.status === 'FAILED') {
        const error = post.lastError || 'GENERATION_FAILED';
        results.push({ accountId, postId: post.id, status: 'FAILED', error });
        await reportProgress(onProgress, { accountId, stage: 'failed', submissionId: run.submissionId, postId: post.id, error });
        continue;
      }
      if (config.solutionPosts.autoPublish) {
        await reportProgress(onProgress, { accountId, stage: 'publishing_article', submissionId: run.submissionId, postId: post.id });
        post = await publishGeneratedPost(post);
      }
      results.push({ accountId, postId: post.id, status: post.status, ...(post.lastError ? { error: post.lastError } : {}) });
      await reportProgress(onProgress, { accountId, stage: post.status === 'PUBLISHED' ? 'published' : 'article_ready',
        submissionId: run.submissionId, postId: post.id, status: post.status });
    } catch (error) {
      const code = errorCode(error, 'COMBINED_WORKFLOW_FAILED');
      const details = error instanceof PostError ? error.details : undefined;
      const failure = { accountId, status: 'FAILED', error: code,
        ...(details ? { postId: details.postId, ...(details.previousError ? { previousError: details.previousError } : {}) } : {}) };
      results.push(failure);
      await reportProgress(onProgress, { ...failure, stage: 'failed', submissionId: run.submissionId });
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

export function isScheduledSolutionRunInProgress(): boolean { return scheduledRunInProgress; }

/** Called by cron, restart catch-up, and the authenticated external wake endpoint. */
export async function runScheduledSolutionPosts(now = new Date()) {
  if (scheduledRunInProgress) return { status: 'BUSY' as const };
  if (!afterPostSchedule(now)) return { status: 'BEFORE_SCHEDULE' as const };
  scheduledRunInProgress = true;
  const startedAt = now.toISOString();
  const saveState = async (value: object) => {
    const state = JSON.stringify({ startedAt, date: now.toISOString().slice(0, 10), ...value });
    await prisma.systemState.upsert({ where: { key: SCHEDULE_STATE_KEY },
      create: { key: SCHEDULE_STATE_KEY, value: state }, update: { value: state } });
  };
  try {
    await recoverGeneration(now);
    const preferences = await prisma.solutionPostPreference.findMany({ where: { enabled: true } });
    const selected = await prisma.account.findMany({ where: { id: { in: preferences.map(p => p.accountId) }, status: { not: 'DISABLED' } } });
    const today = now.toISOString().slice(0, 10);
    const ids = selected.map(a => a.id);
    const [runs, posts] = await Promise.all([
      prisma.dailyRun.findMany({ where: { accountId: { in: ids }, date: today } }),
      prisma.solutionPost.findMany({ where: { accountId: { in: ids } } }),
    ]);
    const eligibleIds = ids.filter(id => {
      const run = runs.find(r => r.accountId === id);
      // A manual/existing article never substitutes for today's accepted code.
      if (!run || !acceptedDailyRun(run, run.problemSlug)) return true;
      const post = posts.find(p => p.accountId === id && p.problemSlug === run.problemSlug);
      if (!post) return true;
      if (['DRAFT_READY', 'AWAITING_APPROVAL'].includes(post.status)) return config.solutionPosts.autoPublish;
      return ['PENDING', 'RETRY_PENDING', 'FAILED'].includes(post.status) && post.retryCount < 4;
    });
    const pendingIds: string[] = [];
    for (const id of eligibleIds) if (await reserveScheduledAttempt(id, today)) pendingIds.push(id);
    if (!pendingIds.length) {
      await saveState({ status: 'IDLE', selected: ids.length, eligible: eligibleIds.length,
        reason: !ids.length ? 'NO_SELECTED_ACCOUNTS' : eligibleIds.length ? 'DAILY_RETRY_LIMIT' : 'NO_PENDING_WORK' });
      return { status: 'IDLE' as const };
    }
    await saveState({ status: 'RUNNING', accountIds: pendingIds });
    const results = await runCombined(pendingIds, now);
    for (const result of results) {
      // Contention is not an execution failure and must not use up the day's retries.
      if (['SUBMISSION_WORKER_BUSY', 'ACCOUNT_JOB_IN_PROGRESS'].includes(result.error ?? '')) {
        const key = `solution-post-schedule-budget:${result.accountId}:${today}`;
        const old = await prisma.systemState.findUnique({ where: { key } });
        if (old) await prisma.systemState.updateMany({ where: { key, value: old.value },
          data: { value: String(Math.max(0, Number(old.value) - 1)) } });
      }
    }
    await saveState({ status: 'FINISHED', finishedAt: new Date().toISOString(), results });
    logger.info({ results, timezone: POST_TIMEZONE, autoPublish: config.solutionPosts.autoPublish }, 'daily solution article workflow finished');
    if (config.telegram.enabled) {
      const failures = results.filter(r => r.status === 'FAILED');
      await sendTelegramMessage(`06:00 IST daily workflow: ${results.filter(r => r.status === 'PUBLISHED').length} article(s) published; ${failures.length} failed.` +
        (failures.length ? '\n' + failures.map(r => `${r.accountId}: ${r.error ?? 'WORKFLOW_FAILED'}`).join('\n') : '')).catch(() => undefined);
    }
    return { status: 'FINISHED' as const, results };
  } catch (error) {
    const code = errorCode(error, 'SCHEDULE_OPERATION_FAILED');
    await saveState({ status: 'FAILED', error: code }).catch(() => undefined);
    logger.warn({ code }, 'solution scheduler failed; inspect /admin/solutions/diagnostics');
    return { status: 'FAILED' as const, error: code };
  } finally { scheduledRunInProgress = false; }
}

export function startSolutionPostScheduler(): () => void {
  const tick = () => void runScheduledSolutionPosts();
  // The recovery timer also catches up after a restart; uniqueness and leases arbitrate multiple processes.
  const daily = cron.schedule(POST_CRON, tick, { timezone: POST_TIMEZONE });
  const recovery = cron.schedule('*/10 * * * *', tick, { timezone: POST_TIMEZONE });
  tick();
  return () => { daily.stop(); recovery.stop(); };
}
