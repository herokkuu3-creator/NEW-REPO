import cron from 'node-cron';
import { randomUUID } from 'node:crypto';
import { Prisma, SolutionPost } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../database/prisma';
import { logger } from '../logger';
import { sendTelegramMessage } from '../notifications/telegram';
import type { ContestKind, ContestQuestionSummary, ContestSummary } from '../leetcode/contest';
import type { StageCallback } from './article';
import { isCoarenaPauseCode, isCoarenaPaused } from './coarenaLimits';
import { publishGeneratedPost, selectedAccountIds } from './scheduler';
import { generateForRun, PostError } from './service';

export const WEEKLY_CONTEST_CRON = '31 9 * * 0';
export const BIWEEKLY_CONTEST_CRON = '31 21 * * 6';
export const CONTEST_RECOVERY_CRON = '*/5 * * * *';
export const CONTEST_TIMEZONE = 'Asia/Kolkata';
export const CONTEST_SCHEDULE_STATE_KEY = 'solution-post-contest-schedule:state';
export const CONTEST_RETRY_LIMIT = 5;

const CONTEST_JOB_LEASE_MS = 25 * 60 * 1000;
const DAY_MS = 86_400_000;
// Verified live anchor: Biweekly Contest 195 took place on Saturday 2026-11-07 IST.
const BIWEEKLY_ANCHOR_IST_DAY_INDEX = Math.floor(Date.UTC(2026, 10, 7) / DAY_MS);

const inProgressKinds = new Set<ContestKind>();

export interface ContestAccountResult {
  accountId: string;
  contestSlug: string;
  questionLabel: 'Q1' | 'Q2';
  questionSlug: string;
  postId?: string;
  status: 'PUBLISHED' | 'DRAFT_READY' | 'AWAITING_APPROVAL' | 'FAILED' | 'SKIPPED' | 'RETRY_PENDING';
  publishedUrl?: string | null;
  error?: string;
}

export interface ContestProgressEvent {
  accountId: string;
  questionIndex: 0 | 1;
  questionLabel: 'Q1' | 'Q2';
  questionTitle: string;
  stage: string;
  detail?: string;
  error?: string;
  publishedUrl?: string | null;
}

interface IstParts {
  year: number;
  month: number;
  day: number;
  weekday: string;
  hour: number;
  minute: number;
  istDate: string;
  dayIndex: number;
}

interface BudgetRecord {
  attempts: number;
  lastAttemptAt: number;
  lastError?: string;
}

type GenerateContestPostFn = (
  accountId: string,
  runId: string,
  force?: boolean,
  onStage?: StageCallback,
  publicationMode?: 'daily' | 'manual',
  options?: { intent?: 'community-solution' | 'contest-solution'; articleStyle?: 'standard' | 'one-liner' },
) => Promise<SolutionPost>;

const generateContestPost = generateForRun as GenerateContestPostFn;

function getIstParts(now: Date = new Date()): IstParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: CONTEST_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes): string => parts.find(p => p.type === type)?.value ?? '';
  const year = Number(read('year'));
  const month = Number(read('month'));
  const day = Number(read('day'));
  const weekday = read('weekday');
  const hour = Number(read('hour'));
  const minute = Number(read('minute'));
  const istDate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const dayIndex = Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
  return { year, month, day, weekday, hour, minute, istDate, dayIndex };
}

function isBiweeklyDayIndex(dayIndex: number): boolean {
  const diff = dayIndex - BIWEEKLY_ANCHOR_IST_DAY_INDEX;
  return ((diff % 14) + 14) % 14 === 0;
}

/** Returns true when the IST calendar date is a scheduled Biweekly Contest Saturday (14-day cadence). */
export function isBiweeklyContestSaturdayIST(now: Date = new Date()): boolean {
  const ist = getIstParts(now);
  return ist.weekday === 'Sat' && isBiweeklyDayIndex(ist.dayIndex);
}

/**
 * Returns true when `now` falls inside the automatic execution / catch-up window in Asia/Kolkata:
 * - Weekly: Sunday >= 09:31 IST (same Sunday)
 * - Biweekly: Biweekly Saturday >= 21:31 IST, plus up to 3 hours into early Sunday IST (00:00–02:59)
 */
export function isInContestCatchupWindow(kind: ContestKind, now: Date = new Date()): boolean {
  const ist = getIstParts(now);
  const minuteOfDay = ist.hour * 60 + ist.minute;
  if (kind === 'weekly') {
    return ist.weekday === 'Sun' && minuteOfDay >= 9 * 60 + 31;
  }
  if (ist.weekday === 'Sat') {
    return isBiweeklyDayIndex(ist.dayIndex) && minuteOfDay >= 21 * 60 + 31;
  }
  // Allow early Sunday IST catch-up (first 3 hours after midnight) immediately after a biweekly Saturday.
  return ist.weekday === 'Sun' && ist.hour < 3 && isBiweeklyDayIndex(ist.dayIndex - 1);
}

export function isContestScheduledRunInProgress(kind?: ContestKind): boolean {
  return kind ? inProgressKinds.has(kind) : inProgressKinds.size > 0;
}

function targetContestIstDate(kind: ContestKind, now: Date): string {
  const ist = getIstParts(now);
  if (kind === 'biweekly' && ist.weekday === 'Sun' && ist.hour < 3) {
    // At 00:00–02:59 IST Sunday, subtracting 12 hours reliably lands on the preceding Saturday IST.
    return getIstParts(new Date(now.getTime() - 12 * 3600 * 1000)).istDate;
  }
  return ist.istDate;
}

function contestDoneKey(contestSlug: string, accountId: string, questionSlug: string): string {
  return `contest-post-done:${contestSlug}:${accountId}:${questionSlug}`;
}

function contestBudgetKey(contestSlug: string, accountId: string, questionSlug: string): string {
  return `contest-post-budget:${contestSlug}:${accountId}:${questionSlug}`;
}

function contestLeaseKey(contestSlug: string): string {
  return `contest-post-job:${contestSlug}`;
}

function contestQuestionLeaseKey(accountId: string, contestSlug: string, questionSlug: string): string {
  return `contest-question-job:${accountId}:${contestSlug}:${questionSlug}`;
}

async function acquireCasLease(key: string, durationMs = CONTEST_JOB_LEASE_MS): Promise<(() => Promise<void>) | null> {
  const value = JSON.stringify({ owner: randomUUID(), until: Date.now() + durationMs });
  try {
    await prisma.systemState.create({ data: { key, value } });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    const existing = await prisma.systemState.findUnique({ where: { key } });
    if (!existing) return null;
    let until = Infinity;
    try { until = Number(JSON.parse(existing.value).until); } catch { /* corrupt lock stays held */ }
    if (!Number.isFinite(until) || until >= Date.now()) return null;
    const claimed = await prisma.systemState.updateMany({ where: { key, value: existing.value }, data: { value } });
    if (claimed.count !== 1) return null;
  }
  return async () => {
    await prisma.systemState.deleteMany({ where: { key, value } });
  };
}

function coarenaPauseDetail(post: Pick<SolutionPost, 'lastError' | 'leaseUntil'>): string {
  const retryAt = post.leaseUntil && new Intl.DateTimeFormat('en-IN', {
    timeZone: CONTEST_TIMEZONE,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(post.leaseUntil);
  const reason = post.lastError === 'COARENA_DAILY_LIMIT'
    ? 'daily allowance exhausted'
    : post.lastError === 'COARENA_RATE_LIMIT'
      ? 'request limit reached'
      : 'capacity temporarily unavailable';
  return `Coarena ${reason}. Automatic retry ${retryAt ? `from ${retryAt} IST.` : 'queued.'}`;
}

function extractErrorCode(error: unknown, fallback: string): string {
  if (error instanceof PostError) return error.code;
  if (error instanceof Error && error.message.trim()) return error.message.trim().slice(0, 200);
  return fallback;
}

function isContentionError(code: string | undefined): boolean {
  if (!code) return false;
  return isCoarenaPauseCode(code) ||
    code === 'ACCOUNT_JOB_IN_PROGRESS' ||
    code === 'SUBMISSION_WORKER_BUSY' ||
    code === 'AI_KEYS_EXHAUSTED';
}

function normalizeQuestionMeta(question: ContestQuestionSummary): { index: 0 | 1; label: 'Q1' | 'Q2' } {
  const index: 0 | 1 = question.index === 1 ? 1 : 0;
  return { index, label: index === 1 ? 'Q2' : 'Q1' };
}

async function emitContestProgress(
  reporter: ((event: ContestProgressEvent) => void | Promise<void>) | undefined,
  event: ContestProgressEvent,
): Promise<void> {
  logger.info({ workflow: 'contest-solution-post', ...event }, 'contest workflow progress');
  if (!reporter) return;
  try {
    await reporter(event);
  } catch (error) {
    logger.warn({ accountId: event.accountId, questionLabel: event.questionLabel, stage: event.stage, err: error },
      'contest workflow progress reporter failed');
  }
}

async function findExistingContestPost(accountId: string, problemSlug: string): Promise<SolutionPost | null> {
  return prisma.solutionPost.findUnique({
    where: {
      accountId_problemSlug_intent: {
        accountId,
        problemSlug,
        intent: 'contest-solution',
      },
    },
  });
}

async function processAccountQuestion(params: {
  accountId: string;
  contest: ContestSummary;
  question: ContestQuestionSummary;
  istDate: string;
  force: boolean;
  now: Date;
  onProgress?: (event: ContestProgressEvent) => void | Promise<void>;
}): Promise<ContestAccountResult> {
  const { accountId, contest, question, istDate, force, now, onProgress } = params;
  const { index: questionIndex, label: questionLabel } = normalizeQuestionMeta(question);
  const emit = (stage: string, extra: Partial<Omit<ContestProgressEvent, 'accountId' | 'questionIndex' | 'questionLabel' | 'questionTitle' | 'stage'>> = {}) =>
    emitContestProgress(onProgress, {
      accountId,
      questionIndex,
      questionLabel,
      questionTitle: question.title,
      stage,
      ...extra,
    });

  let release: (() => Promise<void>) | null = null;
  let currentPostId: string | undefined;

  try {
    await emit('starting');
    release = await acquireCasLease(contestQuestionLeaseKey(accountId, contest.titleSlug, question.titleSlug));
    if (!release) {
      await emit('skipped', { error: 'ACCOUNT_JOB_IN_PROGRESS' });
      return {
        accountId,
        contestSlug: contest.titleSlug,
        questionLabel,
        questionSlug: question.titleSlug,
        status: 'SKIPPED',
        error: 'ACCOUNT_JOB_IN_PROGRESS',
      };
    }

    const existing = await findExistingContestPost(accountId, question.titleSlug);
    if (existing) {
      currentPostId = existing.id;
      if (existing.status === 'PUBLISHED') {
        await emit('published', { publishedUrl: existing.publishedUrl ?? null });
        return {
          accountId,
          contestSlug: contest.titleSlug,
          questionLabel,
          questionSlug: question.titleSlug,
          postId: existing.id,
          status: 'PUBLISHED',
          publishedUrl: existing.publishedUrl ?? null,
        };
      }
      if (['CHECKING_ELIGIBILITY', 'GENERATING', 'VALIDATING', 'PUBLISHING'].includes(existing.status)) {
        const error = existing.status === 'PUBLISHING'
          ? (existing.lastError ?? 'PUBLICATION_UNCERTAIN_RECONCILE_FIRST')
          : 'ACCOUNT_JOB_IN_PROGRESS';
        await emit('skipped', { error });
        return {
          accountId,
          contestSlug: contest.titleSlug,
          questionLabel,
          questionSlug: question.titleSlug,
          postId: existing.id,
          status: 'SKIPPED',
          error,
        };
      }
      if (existing.status === 'SKIPPED') {
        await emit('skipped', { error: existing.lastError ?? undefined, publishedUrl: existing.publishedUrl ?? null });
        return {
          accountId,
          contestSlug: contest.titleSlug,
          questionLabel,
          questionSlug: question.titleSlug,
          postId: existing.id,
          status: 'SKIPPED',
          publishedUrl: existing.publishedUrl ?? null,
          ...(existing.lastError ? { error: existing.lastError } : {}),
        };
      }
      if (!force && isCoarenaPaused(existing) && existing.leaseUntil && existing.leaseUntil.getTime() > now.getTime()) {
        await emit('provider_paused', {
          error: existing.lastError ?? undefined,
          detail: coarenaPauseDetail(existing),
        });
        return {
          accountId,
          contestSlug: contest.titleSlug,
          questionLabel,
          questionSlug: question.titleSlug,
          postId: existing.id,
          status: 'RETRY_PENDING',
          ...(existing.lastError ? { error: existing.lastError } : {}),
        };
      }
      if (!force && existing.status === 'FAILED' && existing.retryCount >= CONTEST_RETRY_LIMIT && existing.lastError !== 'AI_KEYS_EXHAUSTED') {
        await emit('failed', { error: 'GENERATION_RETRY_LIMIT' });
        return {
          accountId,
          contestSlug: contest.titleSlug,
          questionLabel,
          questionSlug: question.titleSlug,
          postId: existing.id,
          status: 'FAILED',
          error: 'GENERATION_RETRY_LIMIT',
        };
      }
    }

    const { solveAndSubmitContestQuestion } = await import('./contestSolver');
    const run = await solveAndSubmitContestQuestion({
      accountId,
      contestSlug: contest.titleSlug,
      contestTitle: contest.title,
      question,
      istDate,
      forceFreshSubmit: force,
      onStage: (progress: { stage: string; detail: string }) => emit(progress.stage, { detail: progress.detail }),
    });

    if (!run || run.state !== 'SUCCESS' || !run.submissionId || run.submissionStatus !== 'Accepted') {
      throw new PostError('ACCEPTED_SUBMISSION_REQUIRED');
    }

    await emit('generating_article', { detail: 'Starting human 1-liner article & visual GIFs…' });
    const onStage: StageCallback = (stage, detail) => {
      void emit(stage, { detail });
    };
    const shouldForceRetry = force || (existing?.status === 'FAILED');
    let post = await generateContestPost(
      accountId,
      run.id,
      shouldForceRetry,
      onStage,
      'manual',
      { intent: 'contest-solution', articleStyle: 'one-liner' },
    );
    currentPostId = post.id;

    if (isCoarenaPaused(post)) {
      await emit('provider_paused', {
        error: post.lastError ?? undefined,
        detail: coarenaPauseDetail(post),
      });
      return {
        accountId,
        contestSlug: contest.titleSlug,
        questionLabel,
        questionSlug: question.titleSlug,
        postId: post.id,
        status: 'RETRY_PENDING',
        ...(post.lastError ? { error: post.lastError } : {}),
      };
    }

    if (['CHECKING_ELIGIBILITY', 'GENERATING', 'VALIDATING', 'PUBLISHING'].includes(post.status)) {
      await emit('skipped', { error: 'ACCOUNT_JOB_IN_PROGRESS' });
      return {
        accountId,
        contestSlug: contest.titleSlug,
        questionLabel,
        questionSlug: question.titleSlug,
        postId: post.id,
        status: 'SKIPPED',
        error: 'ACCOUNT_JOB_IN_PROGRESS',
      };
    }

    if (post.status === 'FAILED') {
      const error = post.lastError || 'GENERATION_FAILED';
      await emit('failed', { error });
      return {
        accountId,
        contestSlug: contest.titleSlug,
        questionLabel,
        questionSlug: question.titleSlug,
        postId: post.id,
        status: 'FAILED',
        error,
      };
    }

    if (config.solutionPosts.autoPublish && ['DRAFT_READY', 'AWAITING_APPROVAL'].includes(post.status)) {
      await emit('publishing_article', { detail: `Publishing ${questionLabel} article…` });
      post = await publishGeneratedPost(post, 'manual');
      currentPostId = post.id;
    }

    if (post.status === 'PUBLISHED') {
      await emit('published', { publishedUrl: post.publishedUrl ?? null });
      return {
        accountId,
        contestSlug: contest.titleSlug,
        questionLabel,
        questionSlug: question.titleSlug,
        postId: post.id,
        status: 'PUBLISHED',
        publishedUrl: post.publishedUrl ?? null,
      };
    }

    if (post.status === 'SKIPPED') {
      await emit('skipped', { error: post.lastError ?? undefined, publishedUrl: post.publishedUrl ?? null });
      return {
        accountId,
        contestSlug: contest.titleSlug,
        questionLabel,
        questionSlug: question.titleSlug,
        postId: post.id,
        status: 'SKIPPED',
        publishedUrl: post.publishedUrl ?? null,
        ...(post.lastError ? { error: post.lastError } : {}),
      };
    }

    if (post.status === 'DRAFT_READY' || post.status === 'AWAITING_APPROVAL') {
      await emit('article_ready', { detail: 'Article draft ready for review' });
      return {
        accountId,
        contestSlug: contest.titleSlug,
        questionLabel,
        questionSlug: question.titleSlug,
        postId: post.id,
        status: post.status,
      };
    }

    const fallbackError = post.lastError ?? (post.status === 'PUBLISHING' ? 'PUBLICATION_UNCERTAIN_RECONCILE_FIRST' : 'CONTEST_POST_PENDING');
    await emit(post.status === 'RETRY_PENDING' ? 'provider_paused' : 'failed', { error: fallbackError });
    return {
      accountId,
      contestSlug: contest.titleSlug,
      questionLabel,
      questionSlug: question.titleSlug,
      postId: post.id,
      status: post.status === 'FAILED' ? 'FAILED' : 'RETRY_PENDING',
      error: fallbackError,
    };
  } catch (error) {
    const code = extractErrorCode(error, 'CONTEST_WORKFLOW_FAILED');
    await emit('failed', { error: code });
    return {
      accountId,
      contestSlug: contest.titleSlug,
      questionLabel,
      questionSlug: question.titleSlug,
      ...(currentPostId ? { postId: currentPostId } : {}),
      status: 'FAILED',
      error: code,
    };
  } finally {
    if (release) await release().catch(() => undefined);
  }
}

/**
 * Runs the contest Q1/Q2 1-liner solve -> article -> immediate `'manual'` publish workflow
 * sequentially per account and per question so Playwright and Coarena lanes never self-contend.
 */
export async function runContestSolutionWorkflow(params: {
  contest: ContestSummary;
  questionIndices: readonly (0 | 1)[];
  accountIds: string[];
  onProgress?: (event: ContestProgressEvent) => void | Promise<void>;
  force?: boolean;
  now?: Date;
}): Promise<ContestAccountResult[]> {
  if (!params.accountIds.length || new Set(params.accountIds).size !== params.accountIds.length) {
    throw new PostError('SELECT_ACCOUNTS_REQUIRED');
  }
  const accounts = await prisma.account.findMany({
    where: { id: { in: params.accountIds }, status: { not: 'DISABLED' } },
  });
  if (accounts.length !== params.accountIds.length) {
    throw new PostError('ACCOUNT_UNAVAILABLE');
  }

  const accountById = new Map(accounts.map(account => [account.id, account]));
  const orderedAccounts = params.accountIds.map(id => accountById.get(id)!);

  const { selectStartingContestQuestions } = await import('../leetcode/contest');
  const questions = selectStartingContestQuestions(params.contest, params.questionIndices);
  if (!questions.length) return [];

  const now = params.now ?? new Date();
  const istDate = params.contest.endTimeSec > 0
    ? getIstParts(new Date(params.contest.endTimeSec * 1000)).istDate
    : getIstParts(now).istDate;
  const force = Boolean(params.force);

  const results: ContestAccountResult[] = [];
  for (const account of orderedAccounts) {
    for (const question of questions) {
      const result = await processAccountQuestion({
        accountId: account.id,
        contest: params.contest,
        question,
        istDate,
        force,
        now,
        onProgress: params.onProgress,
      });
      results.push(result);
    }
  }
  return results;
}

async function readBudget(key: string): Promise<BudgetRecord> {
  const row = await prisma.systemState.findUnique({ where: { key } });
  if (!row) return { attempts: 0, lastAttemptAt: 0 };
  try {
    const parsed = JSON.parse(row.value) as Partial<BudgetRecord>;
    return {
      attempts: Number.isFinite(parsed.attempts) ? Number(parsed.attempts) : 0,
      lastAttemptAt: Number.isFinite(parsed.lastAttemptAt) ? Number(parsed.lastAttemptAt) : 0,
      ...(typeof parsed.lastError === 'string' ? { lastError: parsed.lastError } : {}),
    };
  } catch {
    return { attempts: 0, lastAttemptAt: 0 };
  }
}

async function reserveBudgetAttempt(key: string, now: Date): Promise<boolean> {
  const existing = await prisma.systemState.findUnique({ where: { key } });
  const current = await readBudget(key);
  if (current.attempts < 0 || current.attempts >= CONTEST_RETRY_LIMIT) return false;
  const nextValue = JSON.stringify({
    attempts: current.attempts + 1,
    lastAttemptAt: now.getTime(),
  });
  if (existing) {
    const updated = await prisma.systemState.updateMany({ where: { key, value: existing.value }, data: { value: nextValue } });
    return updated.count === 1;
  }
  try {
    await prisma.systemState.create({ data: { key, value: nextValue } });
    return true;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return false;
    throw error;
  }
}

async function releaseBudgetAttempt(key: string, errorCode?: string): Promise<void> {
  const existing = await prisma.systemState.findUnique({ where: { key } });
  if (!existing) return;
  const current = await readBudget(key);
  const nextValue = JSON.stringify({
    attempts: Math.max(0, current.attempts - 1),
    lastAttemptAt: current.lastAttemptAt,
    ...(errorCode ? { lastError: errorCode } : {}),
  });
  await prisma.systemState.updateMany({ where: { key, value: existing.value }, data: { value: nextValue } });
}

async function saveScheduleState(value: Record<string, unknown>): Promise<void> {
  const serialized = JSON.stringify(value);
  await prisma.systemState.upsert({
    where: { key: CONTEST_SCHEDULE_STATE_KEY },
    create: { key: CONTEST_SCHEDULE_STATE_KEY, value: serialized },
    update: { value: serialized },
  });
}

async function isPairPending(
  contestSlug: string,
  accountId: string,
  questionSlug: string,
  now: Date,
): Promise<boolean> {
  const done = await prisma.systemState.findUnique({ where: { key: contestDoneKey(contestSlug, accountId, questionSlug) } });
  if (done) return false;

  const existingPost = await findExistingContestPost(accountId, questionSlug);
  if (existingPost) {
    if (['PUBLISHED', 'PUBLISHING', 'SKIPPED'].includes(existingPost.status)) return false;
    if (isCoarenaPaused(existingPost)) return false;
    if (['DRAFT_READY', 'AWAITING_APPROVAL'].includes(existingPost.status) && !config.solutionPosts.autoPublish) {
      return false;
    }
    if (existingPost.status === 'FAILED' && existingPost.retryCount >= CONTEST_RETRY_LIMIT && existingPost.lastError !== 'AI_KEYS_EXHAUSTED') {
      return false;
    }
  }

  const budget = await readBudget(contestBudgetKey(contestSlug, accountId, questionSlug));
  if (budget.attempts >= CONTEST_RETRY_LIMIT && existingPost?.lastError !== 'AI_KEYS_EXHAUSTED') {
    return false;
  }
  void now;
  return true;
}

/**
 * Scheduled entry point called by cron (`31 9 * * 0` / `31 21 * * 6`), recovery (`* /5 * * * *`),
 * startup boot catch-up, and `POST /admin/solutions/contest/scheduled`.
 */
export async function runScheduledContestPosts(
  kind: ContestKind,
  now: Date = new Date(),
  trigger: 'cron' | 'recovery' | 'boot' | 'manual' = 'recovery',
): Promise<{ status: string; contestSlug?: string; results?: ContestAccountResult[]; error?: string }> {
  if (inProgressKinds.has(kind)) return { status: 'BUSY' };
  if (trigger !== 'manual' && !isInContestCatchupWindow(kind, now)) {
    return { status: 'OUTSIDE_WINDOW' };
  }

  inProgressKinds.add(kind);
  let releaseContestLease: (() => Promise<void>) | null = null;
  const startedAt = now.toISOString();

  try {
    const { fetchLatestEndedContest, selectStartingContestQuestions } = await import('../leetcode/contest');
    const contest = await fetchLatestEndedContest(kind, now);
    if (!contest) {
      await saveScheduleState({ kind, trigger, startedAt, status: 'IDLE', reason: 'NO_CONTEST' });
      return { status: 'NO_CONTEST' };
    }

    const nowSec = Math.floor(now.getTime() / 1000);
    if (contest.endTimeSec > nowSec) {
      await saveScheduleState({ kind, trigger, startedAt, contestSlug: contest.titleSlug, status: 'IDLE', reason: 'CONTEST_NOT_ENDED' });
      return { status: 'CONTEST_NOT_ENDED', contestSlug: contest.titleSlug };
    }

    if (trigger !== 'manual') {
      const expectedIstDate = targetContestIstDate(kind, now);
      const contestEndIstDate = getIstParts(new Date(contest.endTimeSec * 1000)).istDate;
      const maxAgeSec = kind === 'biweekly' ? 6 * 3600 : 16 * 3600;
      if (contestEndIstDate !== expectedIstDate || nowSec - contest.endTimeSec > maxAgeSec) {
        await saveScheduleState({
          kind,
          trigger,
          startedAt,
          contestSlug: contest.titleSlug,
          status: 'IDLE',
          reason: 'STALE_CONTEST',
          contestEndIstDate,
          expectedIstDate,
        });
        return { status: 'STALE_CONTEST', contestSlug: contest.titleSlug };
      }
    }

    releaseContestLease = await acquireCasLease(contestLeaseKey(contest.titleSlug));
    if (!releaseContestLease) {
      return { status: 'BUSY', contestSlug: contest.titleSlug };
    }

    const prefIds = await selectedAccountIds();
    const accounts = prefIds.length
      ? await prisma.account.findMany({ where: { id: { in: prefIds }, status: { not: 'DISABLED' } }, orderBy: { label: 'asc' } })
      : [];
    const questions = selectStartingContestQuestions(contest, [0, 1]);
    if (!accounts.length || !questions.length) {
      await saveScheduleState({
        kind,
        trigger,
        startedAt,
        contestSlug: contest.titleSlug,
        status: 'IDLE',
        reason: !accounts.length ? 'NO_SELECTED_ACCOUNTS' : 'NO_QUESTIONS',
      });
      return { status: 'IDLE', contestSlug: contest.titleSlug };
    }

    const pendingByAccount: Array<{ accountId: string; indices: Array<0 | 1>; questions: ContestQuestionSummary[] }> = [];
    for (const account of accounts) {
      const pendingQuestions: ContestQuestionSummary[] = [];
      for (const q of questions) {
        if (!await isPairPending(contest.titleSlug, account.id, q.titleSlug, now)) continue;
        if (await reserveBudgetAttempt(contestBudgetKey(contest.titleSlug, account.id, q.titleSlug), now)) {
          pendingQuestions.push(q);
        }
      }
      if (pendingQuestions.length) {
        pendingByAccount.push({
          accountId: account.id,
          indices: pendingQuestions.map(q => normalizeQuestionMeta(q).index),
          questions: pendingQuestions,
        });
      }
    }

    if (!pendingByAccount.length) {
      await saveScheduleState({
        kind,
        trigger,
        startedAt,
        contestSlug: contest.titleSlug,
        status: 'IDLE',
        selected: accounts.length,
        reason: 'NO_PENDING_WORK',
      });
      return { status: 'IDLE', contestSlug: contest.titleSlug };
    }

    const accountList = pendingByAccount.map(item => item.accountId);
    await saveScheduleState({
      kind,
      trigger,
      startedAt,
      contestSlug: contest.titleSlug,
      contestTitle: contest.title,
      status: 'RUNNING',
      accountIds: accountList,
    });

    if (config.telegram.enabled) {
      await sendTelegramMessage(
        `🏆 Starting ${kind} contest workflow (${contest.title}): ${accountList.length} account(s), Q1 & Q2.`,
      ).catch(() => undefined);
    }

    const results: ContestAccountResult[] = [];
    let lastProgress: ContestProgressEvent | undefined;
    const onProgress = (event: ContestProgressEvent) => {
      lastProgress = event;
    };

    for (const entry of pendingByAccount) {
      const accountResults = await runContestSolutionWorkflow({
        contest,
        questionIndices: entry.indices,
        accountIds: [entry.accountId],
        onProgress,
        now,
      });
      results.push(...accountResults);
    }

    for (const result of results) {
      const doneKey = contestDoneKey(contest.titleSlug, result.accountId, result.questionSlug);
      const budgetKey = contestBudgetKey(contest.titleSlug, result.accountId, result.questionSlug);

      const completedForAuto = result.status === 'PUBLISHED' ||
        (result.status === 'SKIPPED' && result.error !== 'ACCOUNT_JOB_IN_PROGRESS' && result.error !== 'PUBLICATION_UNCERTAIN_RECONCILE_FIRST') ||
        (!config.solutionPosts.autoPublish && (result.status === 'DRAFT_READY' || result.status === 'AWAITING_APPROVAL'));

      if (completedForAuto) {
        await prisma.systemState.upsert({
          where: { key: doneKey },
          create: {
            key: doneKey,
            value: JSON.stringify({
              status: result.status,
              postId: result.postId ?? null,
              publishedUrl: result.publishedUrl ?? null,
              at: new Date().toISOString(),
            }),
          },
          update: {
            value: JSON.stringify({
              status: result.status,
              postId: result.postId ?? null,
              publishedUrl: result.publishedUrl ?? null,
              at: new Date().toISOString(),
            }),
          },
        });
      } else if (isContentionError(result.error)) {
        await releaseBudgetAttempt(budgetKey, result.error);
      }
    }

    await saveScheduleState({
      kind,
      trigger,
      startedAt,
      finishedAt: new Date().toISOString(),
      contestSlug: contest.titleSlug,
      contestTitle: contest.title,
      status: 'FINISHED',
      lastProgress,
      results,
    });

    logger.info({ kind, trigger, contestSlug: contest.titleSlug, results }, 'scheduled contest solution workflow finished');

    if (config.telegram.enabled) {
      const published = results.filter(r => r.status === 'PUBLISHED');
      const failed = results.filter(r => r.status === 'FAILED');
      const paused = results.filter(r => r.status === 'RETRY_PENDING');
      const lines = [
        `🏁 ${contest.title} workflow finished: ${published.length} published, ${failed.length} failed${paused.length ? `, ${paused.length} paused/queued` : ''}.`,
      ];
      for (const r of published) {
        lines.push(`✅ ${r.accountId} ${r.questionLabel}${r.publishedUrl ? `: ${r.publishedUrl}` : ''}`);
      }
      for (const r of failed) {
        lines.push(`❌ ${r.accountId} ${r.questionLabel}: ${r.error ?? 'WORKFLOW_FAILED'}`);
      }
      await sendTelegramMessage(lines.join('\n')).catch(() => undefined);
    }

    return { status: 'FINISHED', contestSlug: contest.titleSlug, results };
  } catch (error) {
    const code = extractErrorCode(error, 'CONTEST_SCHEDULE_FAILED');
    await saveScheduleState({
      kind,
      trigger,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: 'FAILED',
      error: code,
    }).catch(() => undefined);
    logger.warn({ kind, trigger, code }, 'contest scheduler failed');
    return { status: 'FAILED', error: code };
  } finally {
    if (releaseContestLease) await releaseContestLease().catch(() => undefined);
    inProgressKinds.delete(kind);
  }
}

export async function getContestSchedulerDiagnostics(): Promise<unknown> {
  const now = new Date();
  const ist = getIstParts(now);
  let stateRow: { value: string; updatedAt?: Date } | null = null;
  try {
    stateRow = await prisma.systemState.findUnique({ where: { key: CONTEST_SCHEDULE_STATE_KEY } });
  } catch {
    stateRow = null;
  }
  let state: unknown = null;
  if (stateRow?.value) {
    try { state = JSON.parse(stateRow.value); }
    catch { state = { raw: stateRow.value }; }
  }
  return {
    timezone: CONTEST_TIMEZONE,
    weeklyCron: WEEKLY_CONTEST_CRON,
    biweeklyCron: BIWEEKLY_CONTEST_CRON,
    recoveryCron: CONTEST_RECOVERY_CRON,
    istDate: ist.istDate,
    isBiweeklySaturdayIST: isBiweeklyContestSaturdayIST(now),
    inCatchupWindow: {
      weekly: isInContestCatchupWindow('weekly', now),
      biweekly: isInContestCatchupWindow('biweekly', now),
    },
    inProgress: {
      weekly: inProgressKinds.has('weekly'),
      biweekly: inProgressKinds.has('biweekly'),
    },
    state,
    updatedAt: stateRow?.updatedAt ? new Date(stateRow.updatedAt).toISOString() : null,
  };
}

/** Arms weekly (Sun 09:31 IST), biweekly (Sat 21:31 IST), and 5-minute recovery crons + boot tick. */
export function startContestPostScheduler(): () => void {
  const runKind = (kind: ContestKind, trigger: 'cron' | 'recovery' | 'boot') => {
    void runScheduledContestPosts(kind, new Date(), trigger).catch(error =>
      logger.warn({ kind, trigger, err: error }, 'contest scheduler tick failed'),
    );
  };
  const recoveryTick = (trigger: 'recovery' | 'boot') => {
    const now = new Date();
    if (isInContestCatchupWindow('weekly', now)) runKind('weekly', trigger);
    if (isInContestCatchupWindow('biweekly', now)) runKind('biweekly', trigger);
  };

  const weekly = cron.schedule(WEEKLY_CONTEST_CRON, () => runKind('weekly', 'cron'), { timezone: CONTEST_TIMEZONE });
  const biweekly = cron.schedule(BIWEEKLY_CONTEST_CRON, () => runKind('biweekly', 'cron'), { timezone: CONTEST_TIMEZONE });
  const recovery = cron.schedule(CONTEST_RECOVERY_CRON, () => recoveryTick('recovery'), { timezone: CONTEST_TIMEZONE });

  recoveryTick('boot');

  return () => {
    weekly.stop();
    biweekly.stop();
    recovery.stop();
  };
}
