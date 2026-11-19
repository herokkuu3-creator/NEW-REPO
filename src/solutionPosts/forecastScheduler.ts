import { randomUUID } from 'node:crypto';
import cron from 'node-cron';
import { z } from 'zod';
import { config } from '../config';
import { getAccountById, getAccountIdentityById } from '../database/accounts';
import { getSystemState, getSystemStates, setSystemState, SystemKeys } from '../database/models';
import { prisma } from '../database/prisma';
import { logger } from '../logger';
import { sendTelegramMessage } from '../notifications/telegram';
import { submitSingleQuestionDirectly } from '../scheduler/rangeSubmission';
import { DAY_MS, forecastPickSchema, predictNextDaily, utcDate, type ForecastPick } from './dailyForecast';
import { startArticleWorkKeepAlive } from './keepAlive';
import { publishPost } from './publisher';
import { generateForRun, PostError, retryPost } from './service';
import { approvePost } from './store';

const MINUTE = 60_000;
const PREPARE_MS = 60 * MINUTE;
const RETRY_MS = 10 * MINUTE;
const LEASE_MS = 3 * MINUTE;
const MAX_ATTEMPTS = 3;
const SETTINGS_KEY = 'daily-forecast:settings';
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const settingsSchema = z.object({ accountId: z.string().min(1), time: z.string().regex(TIME_PATTERN),
  firstTarget: z.string().date(), revision: z.string().uuid() });
const pickState = forecastPickSchema.extend({
  status: z.enum(['pending', 'submitting', 'accepted', 'ready', 'published', 'skipped', 'failed', 'uncertain']),
  generationAttempts: z.number().int().nonnegative().default(0), publicationAttempts: z.number().int().nonnegative().default(0),
  retryAt: z.number().optional(), error: z.string().optional(), url: z.string().optional(),
});
const jobSchema = z.object({
  method: z.enum(['editorials', 'editorials+AI']).optional(), picks: z.array(pickState).max(2).default([]),
  attempts: z.number().int().nonnegative().default(0), retryAt: z.number().optional(), error: z.string().optional(),
});
type Job = z.infer<typeof jobSchema>;
type PickState = z.infer<typeof pickState>;
type Settings = z.infer<typeof settingsSchema>;
const terminal = new Set<PickState['status']>(['published', 'skipped', 'failed', 'uncertain']);

export function isForecastPostingTime(value: string): boolean { return TIME_PATTERN.test(value); }

export function forecastWindow(now: number, time: string) {
  if (!isForecastPostingTime(time)) throw new PostError('INVALID_FORECAST_TIME');
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(3));
  const start = Math.floor(now / DAY_MS) * DAY_MS;
  const postingAt = start + ((hour * 60 + minute - 330 + 1440) % 1440) * MINUTE;
  return { target: utcDate(start + DAY_MS), postingAt, prepareAt: Math.max(start, postingAt - PREPARE_MS), deadline: start + DAY_MS };
}

function readSettings(raw: string | null): Settings | null {
  return raw && raw !== 'off' ? settingsSchema.parse(JSON.parse(raw)) : null;
}

const jobKey = (target: string, accountId: string) => `${SystemKeys.forecastJobPrefix}${target}:${accountId}`;
const readJob = (raw: string | null) => jobSchema.parse(raw ? JSON.parse(raw) : {});
let nextSettingsPoll = 0;
let stopWindowKeepAlive: (() => void) | undefined;

function keepForecastWindowAwake(active: boolean) {
  if (active) stopWindowKeepAlive ??= startArticleWorkKeepAlive();
  else { stopWindowKeepAlive?.(); stopWindowKeepAlive = undefined; }
}

export async function saveForecastSchedule(accountId: string, time: string, now = Date.now()) {
  if (!config.solutionPosts.autoPublish) throw new PostError('SOLUTION_POST_AUTO_PUBLISH_DISABLED');
  const window = forecastWindow(now, time);
  const account = await getAccountIdentityById(accountId);
  if (!account || account.status === 'DISABLED') throw new PostError('ACCOUNT_UNAVAILABLE');
  const current = readSettings(await getSystemState(SETTINGS_KEY));
  if (current?.accountId === accountId && current.time === time) return current;
  const firstTarget = window.postingAt + MINUTE > now ? window.target : utcDate(window.deadline + DAY_MS);
  const settings = { accountId, time, firstTarget, revision: randomUUID() };
  await setSystemState(SETTINGS_KEY, JSON.stringify(settings));
  nextSettingsPoll = 0;
  return settings;
}

export async function disableForecastSchedule() {
  await setSystemState(SETTINGS_KEY, 'off');
  nextSettingsPoll = 0;
  keepForecastWindowAwake(false);
}

export async function getForecastScheduleStatus(now = Date.now()) {
  const settings = readSettings(await getSystemState(SETTINGS_KEY));
  if (!settings) return null;
  const window = forecastWindow(now, settings.time);
  const previousTarget = utcDate(window.deadline - DAY_MS);
  const [account, jobs] = await Promise.all([getAccountIdentityById(settings.accountId),
    getSystemStates([jobKey(window.target, settings.accountId), jobKey(previousTarget, settings.accountId)])]);
  const current = jobs[jobKey(window.target, settings.accountId)];
  const previous = jobs[jobKey(previousTarget, settings.accountId)];
  const last = current ? { target: window.target, expired: false, ...readJob(current) } :
    previous ? { target: previousTarget, expired: true, ...readJob(previous) } : null;
  const complete = current && last && (last.attempts >= MAX_ATTEMPTS || (last.method && last.picks.every(pick => terminal.has(pick.status))));
  const nextTarget = window.target < settings.firstTarget ? settings.firstTarget : complete ? utcDate(window.deadline + DAY_MS) : window.target;
  return { settings, nextTarget,
    account, last, autoPublish: config.solutionPosts.autoPublish };
}

async function claimLease(key: string) {
  const owner = randomUUID();
  try { await prisma.systemState.create({ data: { key, value: owner }, select: { key: true } }); }
  catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error;
    const claim = await prisma.systemState.updateMany({ where: { key, updatedAt: { lt: new Date(Date.now() - LEASE_MS) } },
      data: { value: owner } });
    if (!claim.count) return null;
  }
  const heartbeat = setInterval(() => {
    void prisma.systemState.updateMany({ where: { key, value: owner }, data: { updatedAt: new Date() } })
      .catch(() => logger.warn('forecast lease heartbeat failed'));
  }, MINUTE);
  heartbeat.unref();
  return { owner, release: async () => {
    clearInterval(heartbeat);
    await prisma.systemState.deleteMany({ where: { key, value: owner } });
  } };
}

const notify = async (message: string) => {
  if (config.telegram.enabled) await sendTelegramMessage(message).catch(() => undefined);
};

function summarizePick(pick: PickState) {
  return `#${pick.number} ${pick.title} · ${pick.status}${pick.error ? ` (${pick.error})` : ''}${pick.url ? `\n${pick.url}` : ''}`;
}

const articleKey = (accountId: string, problemSlug: string) => ({ accountId_problemSlug_intent: { accountId, problemSlug, intent: 'community-solution' } });
const errorCode = (error: unknown, fallback: string) => error instanceof PostError ? error.code : fallback;

async function stageCandidate(
  pick: PickState, account: NonNullable<Awaited<ReturnType<typeof getAccountById>>>, target: string,
  deadline: number, check: () => Promise<void>, save: () => Promise<void>,
) {
  const existing = await prisma.solutionPost.findUnique({ where: articleKey(account.id, pick.slug),
    select: { status: true, publishedUrl: true, lastError: true } });
  if (existing && ['PUBLISHED', 'PUBLISHING', 'SKIPPED', 'DRAFT_READY', 'AWAITING_APPROVAL'].includes(existing.status)) {
    applyPostResult(pick, existing);
    return;
  }
  const date = `forecast:${pick.number}:${target}`;
  const where = { accountId_date: { accountId: account.id, date } };
  let run = await prisma.dailyRun.findUnique({ where, select: { id: true, state: true, problemSlug: true, submissionId: true, submissionStatus: true } });
  if (run && (run.state !== 'SUCCESS' || run.problemSlug !== pick.slug || !run.submissionId || run.submissionStatus !== 'Accepted')) {
    pick.status = 'failed'; pick.error = 'FORECAST_SUBMISSION_MISMATCH'; return;
  }
  if (!run) {
    if (pick.status === 'submitting') {
      pick.status = 'uncertain'; pick.error = 'SUBMISSION_INTERRUPTED'; return;
    }
    await check();
    let dispatched = false;
    const beforeSubmit = async () => {
      if (!dispatched) {
        await check();
        pick.status = 'submitting';
        await save();
        dispatched = true;
      }
      await check();
    };
    const { outcome, capture } = await submitSingleQuestionDirectly(account, pick.number, undefined, {
      slug: pick.slug, signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())), beforeSubmit,
    });
    if (outcome.status !== 'accepted' || capture?.slug !== pick.slug || !outcome.submissionId) {
      pick.status = dispatched && (outcome.status === 'error' || outcome.status === 'accepted') ? 'uncertain' : 'failed';
      pick.error = pick.status === 'uncertain' ? 'SUBMISSION_UNVERIFIED' : `SUBMISSION_${outcome.status.toUpperCase()}`;
      return;
    }
    run = await prisma.dailyRun.create({ data: { accountId: account.id, date, problemSlug: capture.slug,
      title: capture.title, difficulty: capture.difficulty, language: capture.language, solution: capture.code,
      submissionId: outcome.submissionId, submissionStatus: 'Accepted', state: 'SUCCESS' },
    select: { id: true, state: true, problemSlug: true, submissionId: true, submissionStatus: true } });
  }
  pick.status = 'accepted';
  await check();
  if (pick.generationAttempts >= MAX_ATTEMPTS) {
    pick.status = 'failed'; pick.error ??= 'ARTICLE_GENERATION_RETRY_LIMIT'; return;
  }
  const post = await prisma.solutionPost.findUnique({ where: articleKey(account.id, pick.slug),
    select: { id: true, status: true, leaseUntil: true } });
  if (post?.leaseUntil && post.leaseUntil.getTime() > Date.now()) {
    pick.retryAt = post.leaseUntil.getTime(); return;
  }
  pick.generationAttempts++;
  await save();
  const generated = post?.status === 'FAILED' ? await retryPost(post.id) : await generateForRun(account.id, run.id);
  applyPostResult(pick, generated);
  if (pick.status === 'accepted') pick.retryAt = Math.max(Date.now() + RETRY_MS, generated.leaseUntil?.getTime() ?? 0);
}

function applyPostResult(pick: PickState, post: { status: string; publishedUrl: string | null; lastError: string | null }) {
  const statuses: Partial<Record<string, PickState['status']>> = {
    PUBLISHED: 'published', PUBLISHING: 'uncertain', SKIPPED: 'skipped', DRAFT_READY: 'ready', AWAITING_APPROVAL: 'ready',
  };
  pick.status = statuses[post.status] ?? 'accepted';
  pick.error = post.status === 'PUBLISHING' ? 'PUBLICATION_UNCERTAIN_RECONCILE_FIRST' : post.lastError ?? undefined;
  pick.url = post.publishedUrl ?? undefined;
}

async function publishCandidate(pick: PickState, accountId: string, check: () => Promise<void>, save: () => Promise<void>) {
  const post = await prisma.solutionPost.findUniqueOrThrow({ where: articleKey(accountId, pick.slug),
    select: { id: true, status: true, contentHash: true, approvedHash: true, lastError: true, publishedUrl: true } });
  if (!['DRAFT_READY', 'AWAITING_APPROVAL'].includes(post.status)) { applyPostResult(pick, post); return; }
  if (pick.publicationAttempts >= MAX_ATTEMPTS) { pick.status = 'failed'; pick.error ??= 'PUBLICATION_RETRY_LIMIT'; return; }
  await check();
  pick.publicationAttempts++;
  await save();
  if (!post.contentHash) throw new PostError('CONTENT_HASH_MISSING');
  if (post.status !== 'DRAFT_READY' || post.approvedHash !== post.contentHash) await approvePost(post.id, post.contentHash);
  applyPostResult(pick, await publishPost(post.id, { beforePublish: check, automaticEngagement: false }));
}

let ticking = false;

export async function runForecastTick(now = Date.now()) {
  if (ticking || !config.solutionPosts.autoPublish || now < nextSettingsPoll) return;
  ticking = true;
  try {
    const raw = await getSystemState(SETTINGS_KEY);
    const settings = readSettings(raw);
    if (!settings) { keepForecastWindowAwake(false); nextSettingsPoll = now + 5 * MINUTE; return; }
    const window = forecastWindow(now, settings.time);
    if (now < window.prepareAt || window.target < settings.firstTarget) { keepForecastWindowAwake(false); return; }
    const key = jobKey(window.target, settings.accountId);
    const leaseKey = `${key}:lease`;
    const job = readJob(await getSystemState(key));
    if ((job.method && job.picks.every(pick => terminal.has(pick.status))) || job.attempts >= MAX_ATTEMPTS) {
      keepForecastWindowAwake(false); return;
    }
    keepForecastWindowAwake(true);
    if ((job.retryAt ?? 0) > now) return;
    if (job.method && job.picks.every(pick => terminal.has(pick.status) || (pick.retryAt ?? 0) > now ||
      (pick.status === 'ready' && now < window.postingAt))) return;
    const lease = await claimLease(leaseKey);
    if (!lease) return;
    try {
      const activeJob = readJob(await getSystemState(key));
      if ((activeJob.retryAt ?? 0) > now) return;
      const check = async (forPublication = false) => {
        const clock = Date.now();
        if (clock >= window.deadline || (forPublication && clock < window.postingAt)) throw new PostError('FORECAST_OUTSIDE_WINDOW');
        const [current, identity] = await Promise.all([getSystemStates([SETTINGS_KEY, leaseKey]),
          prisma.account.findUnique({ where: { id: settings.accountId }, select: { status: true } })]);
        if (current[SETTINGS_KEY] !== raw || current[leaseKey] !== lease.owner) throw new PostError('FORECAST_SCHEDULE_CHANGED');
        if (!identity || identity.status === 'DISABLED') throw new PostError('ACCOUNT_UNAVAILABLE');
        if (Date.now() >= window.deadline) throw new PostError('FORECAST_OUTSIDE_WINDOW');
      };
      const save = async () => {
        const value = JSON.stringify(activeJob);
        await prisma.$transaction(async transaction => {
          const owned = await transaction.systemState.updateMany({ where: { key: leaseKey, value: lease.owner }, data: { updatedAt: new Date() } });
          if (!owned.count) throw new PostError('FORECAST_LEASE_LOST');
          await transaction.systemState.upsert({ where: { key }, create: { key, value }, update: { value } });
        });
      };
      if (!activeJob.method && activeJob.attempts < MAX_ATTEMPTS) {
        try {
          await check();
          const forecast = await predictNextDaily(new Date(now));
          await check();
          activeJob.method = forecast.method;
          activeJob.picks = forecast.picks.map(pick => pickState.parse({ ...pick, status: 'pending' }));
          delete activeJob.error;
          delete activeJob.retryAt;
          await save();
          await notify(`LeetCode forecast for ${window.target} UTC (${forecast.method})\n` +
            (forecast.picks.map(pick => `#${pick.number} ${pick.title}`).join('\n') || 'No eligible problems were found.'));
        } catch (error) {
          const code = errorCode(error, 'FORECAST_DATA_UNAVAILABLE');
          if (['FORECAST_SCHEDULE_CHANGED', 'FORECAST_OUTSIDE_WINDOW', 'FORECAST_LEASE_LOST'].includes(code)) return;
          activeJob.attempts++;
          activeJob.retryAt = Date.now() + RETRY_MS;
          activeJob.error = code;
          logger.warn({ target: window.target, code, errorName: error instanceof Error ? error.name : undefined }, 'forecast data could not be loaded');
          await save();
          if (activeJob.attempts >= MAX_ATTEMPTS) await notify(`LeetCode forecast for ${window.target} UTC stopped (${activeJob.error}).`);
          return;
        }
      }
      if (!activeJob.picks.some(pick => !terminal.has(pick.status))) return;
      const account = await getAccountById(settings.accountId);
      if (!account || account.status === 'DISABLED') {
        for (const pick of activeJob.picks) if (!terminal.has(pick.status)) { pick.status = 'failed'; pick.error = 'ACCOUNT_UNAVAILABLE'; }
        await save();
        await notify(`LeetCode forecast for ${window.target} UTC stopped (ACCOUNT_UNAVAILABLE).`);
        return;
      }
      const picks = [...activeJob.picks].sort((a, b) => Number(b.status === 'ready') - Number(a.status === 'ready'));
      for (const pick of picks) {
        if (terminal.has(pick.status) || (pick.retryAt ?? 0) > Date.now()) continue;
        try {
          await check();
          delete pick.retryAt;
          if (pick.status !== 'ready') await stageCandidate(pick, account, window.target, window.deadline, check, save);
          if (pick.status === 'ready' && Date.now() >= window.postingAt) await publishCandidate(pick, account.id, () => check(true), save);
        } catch (error) {
          const code = errorCode(error, 'FORECAST_WORK_FAILED');
          if (['FORECAST_SCHEDULE_CHANGED', 'FORECAST_OUTSIDE_WINDOW', 'FORECAST_LEASE_LOST'].includes(code)) return;
          pick.error = code;
          if ((pick.status === 'ready' && pick.publicationAttempts >= MAX_ATTEMPTS) ||
            (pick.status === 'accepted' && pick.generationAttempts >= MAX_ATTEMPTS)) {
            // The next tick still reads the durable publication result before
            // deciding whether an interrupted request can be retried.
            pick.retryAt = Date.now() + MINUTE;
          } else pick.retryAt = Date.now() + RETRY_MS;
        }
        await save();
        if (terminal.has(pick.status)) await notify(`LeetCode forecast for ${window.target} UTC\n${summarizePick(pick)}`);
      }
    } finally {
      await lease.release().catch(() => undefined);
    }
  } finally { ticking = false; }
}

export function formatForecastPicks(picks: ForecastPick[]) {
  return picks.map(pick => `#${pick.number} ${pick.title} (${pick.difficulty})\nhttps://leetcode.com/problems/${pick.slug}/`).join('\n\n');
}

export function startForecastScheduler() {
  const tick = () => { void runForecastTick().catch(error => logger.warn({ errorName: error?.name }, 'forecast scheduler tick failed')); };
  const task = cron.schedule('* * * * *', tick);
  tick();
  return () => { task.stop(); keepForecastWindowAwake(false); };
}
