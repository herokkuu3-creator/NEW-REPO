import { randomUUID } from 'node:crypto';
import { Prisma, SolutionPost } from '@prisma/client';
import { prisma } from '../database/prisma';
import { publishPost } from './publisher';
import { logger } from '../logger';
import { config } from '../config';
import { sendTelegramMessage } from '../notifications/telegram';
import { startArticleWorkKeepAlive } from './keepAlive';
import { articleNeedsRefresh, contextSchema } from './article';

export const DAILY_PUBLICATION_GAP_MS = 20 * 60 * 1000;
export const DAILY_PUBLICATION_STATE_KEY = 'solution-post-daily-publication:gate';
const queueDomainPrefix = 'solution-post-daily-publication:';
const queuePrefix = 'solution-post-daily-publication:queue:';
type Gate = { nextAt: number; owner?: string; leaseUntil?: number; lastPostId?: string; lastPublishedAt?: string };
let draining = false;
let stopQueueKeepAlive: (() => void) | undefined;
let nextDailyQueuePollAt = 0;

export function notifyDailyPublicationQueued(): void {
  nextDailyQueuePollAt = 0;
}

const DAILY_POST_SELECT = {
  id: true,
  accountId: true,
  problemSlug: true,
  submissionId: true,
  intent: true,
  context: true,
  codeHash: true,
  status: true,
  title: true,
  style: true,
  model: true,
  reviewModel: true,
  contentHash: true,
  approvedHash: true,
  publishedUrl: true,
  lastError: true,
  retryCount: true,
  leaseUntil: true,
  createdAt: true,
  updatedAt: true,
  publishedAt: true,
} satisfies Prisma.SolutionPostSelect;

function formatGateStatus(gate: Gate) {
  return {
    minimumGapMs: DAILY_PUBLICATION_GAP_MS,
    nextEligibleAt: gate.nextAt ? new Date(gate.nextAt).toISOString() : null,
    lastPostId: gate.lastPostId,
    lastPublishedAt: gate.lastPublishedAt,
  };
}

function isGateBlocked(gate: Gate, now: number): boolean {
  return gate.nextAt > now || (Boolean(gate.owner) && (gate.leaseUntil ?? Infinity) > now);
}

export async function dailyPublicationStatus() {
  const row = await prisma.systemState.findUnique({
    where: { key: DAILY_PUBLICATION_STATE_KEY },
    select: { value: true },
  });
  const gate: Gate = row ? JSON.parse(row.value) : { nextAt: 0 };
  return formatGateStatus(gate);
}

async function claimSlot(now: number): Promise<{ claimed: true; value: string; gate: Gate } | { claimed: false; gate: Gate }> {
  let latestGate: Gate = { nextAt: 0 };
  for (let attempt = 0; attempt < 8; attempt++) {
    const row = await prisma.systemState.findUnique({
      where: { key: DAILY_PUBLICATION_STATE_KEY },
      select: { value: true },
    });
    const gate: Gate = row ? JSON.parse(row.value) : { nextAt: 0 };
    latestGate = gate;
    if (!Number.isFinite(gate.nextAt)) throw Error('INVALID_DAILY_PUBLICATION_GATE');
    if (isGateBlocked(gate, now)) return { claimed: false, gate };
    // Reserve the worst-case publication window before the request. A crash
    // after the request but before saving its result must still preserve the gap.
    const value = JSON.stringify({ ...gate, nextAt: now + 10 * 60 * 1000 + DAILY_PUBLICATION_GAP_MS,
      owner: randomUUID(), leaseUntil: now + 10 * 60 * 1000 });
    if (row) {
      if ((await prisma.systemState.updateMany({ where: { key: DAILY_PUBLICATION_STATE_KEY, value: row.value }, data: { value } })).count) {
        return { claimed: true, value, gate };
      }
    } else {
      try {
        await prisma.systemState.create({ data: { key: DAILY_PUBLICATION_STATE_KEY, value }, select: { key: true } });
        return { claimed: true, value, gate };
      } catch (error) { if ((error as { code?: string }).code !== 'P2002') throw error; }
    }
  }
  return { claimed: false, gate: latestGate };
}

async function publishDailyPostInternal(id: string, now: Date, alreadyQueued: boolean): Promise<SolutionPost> {
  let post = await prisma.solutionPost.findUniqueOrThrow({
    where: { id },
    select: DAILY_POST_SELECT,
  }) as unknown as SolutionPost;
  const key = queuePrefix + id;
  if (['PUBLISHED', 'PUBLISHING', 'SKIPPED'].includes(post.status)) {
    await prisma.systemState.deleteMany({ where: { key } }); return post;
  }
  if (post.status !== 'DRAFT_READY') throw Error('DAILY_DRAFT_NOT_READY');
  if (articleNeedsRefresh(contextSchema.parse(JSON.parse(post.context)))) {
    await prisma.systemState.deleteMany({ where: { key } });
    return { ...post, lastError: 'ARTICLE_LAYOUT_REFRESH_REQUIRED' };
  }
  if (!alreadyQueued) {
    await prisma.systemState.upsert({
      where: { key },
      create: { key, value: JSON.stringify({ postId: id, queuedAt: now.toISOString(), failures: 0 }) },
      update: {},
      select: { key: true },
    });
  }
  const claim = await claimSlot(now.getTime());
  if (!claim.claimed) {
    logger.info({ postId: id, ...formatGateStatus(claim.gate) }, 'daily article queued for publication spacing');
    return { ...post, lastError: 'DAILY_PUBLICATION_COOLDOWN' };
  }
  // Keep the conservative reservation if publication throws. A database error
  // can occur after the remote mutation even when its outcome cannot be saved.
  let next: Gate = JSON.parse(claim.value);
  try {
    post = await publishPost(id);
    if (post.status === 'PUBLISHED' || post.status === 'PUBLISHING') {
      // Uncertain publication also reserves a gap. Never allow the next
      // account to race an API request whose outcome is still unknown.
      const published = post.publishedAt?.getTime() ?? Date.now();
      next = { nextAt: published + DAILY_PUBLICATION_GAP_MS, lastPostId: id,
        lastPublishedAt: post.publishedAt?.toISOString() };
      logger.info({ postId: id, publishedAt: next.lastPublishedAt,
        nextEligibleAt: new Date(next.nextAt).toISOString(), minimumGapMs: DAILY_PUBLICATION_GAP_MS },
      'daily article publication slot completed');
    } else next = claim.gate;
    if (['PUBLISHED', 'PUBLISHING', 'SKIPPED'].includes(post.status)) await prisma.systemState.deleteMany({ where: { key } });
    return post;
  } finally {
    await prisma.systemState.updateMany({ where: { key: DAILY_PUBLICATION_STATE_KEY, value: claim.value },
      data: { value: JSON.stringify(next) } });
  }
}

/** Durable daily-only queue; manual publishing never enters this gate. */
export async function publishDailyPost(id: string, now = new Date()): Promise<SolutionPost> {
  notifyDailyPublicationQueued();
  return publishDailyPostInternal(id, now, false);
}

/** Runs every minute and on boot; cooldowns consume no generation retries. */
export async function processDailyPublicationQueue(now = new Date()) {
  if (draining) return;
  const nowMs = now.getTime();
  if (process.env.NODE_ENV !== 'test' && nowMs < nextDailyQueuePollAt) return;
  draining = true;
  try {
    const rows = await prisma.systemState.findMany({
      where: { key: { startsWith: queueDomainPrefix } },
      select: { key: true, value: true },
      orderBy: { updatedAt: 'asc' },
      take: 101,
    });
    const pending = rows.filter(row => row.key.startsWith(queuePrefix));
    const runnable: Array<{ key: string; value: string; postId: string; failures: number }> = [];
    for (const row of pending) {
      try {
        const parsed = JSON.parse(row.value) as { postId?: string; failures?: number };
        const failures = parsed.failures ?? 0;
        if (parsed.postId && failures < 4) {
          runnable.push({ key: row.key, value: row.value, postId: parsed.postId, failures });
        }
      } catch {
        // Ignore unreadable queue payload.
      }
    }
    const hasWork = runnable.length > 0;
    if (hasWork && !stopQueueKeepAlive) stopQueueKeepAlive = startArticleWorkKeepAlive();
    else if (!hasWork && stopQueueKeepAlive) { stopQueueKeepAlive(); stopQueueKeepAlive = undefined; }
    if (!hasWork) {
      nextDailyQueuePollAt = nowMs + 60 * 60_000;
      return;
    }

    // Avoid fetching SolutionPost rows or context blobs on every minute tick while the gate is in cooldown.
    let gateRow: { value: string } | null | undefined = rows.find(row => row.key === DAILY_PUBLICATION_STATE_KEY);
    if (!gateRow && rows.length >= 101) {
      gateRow = await prisma.systemState.findUnique({
        where: { key: DAILY_PUBLICATION_STATE_KEY },
        select: { value: true },
      });
    }
    if (gateRow) {
      try {
        const gate: Gate = JSON.parse(gateRow.value);
        if (Number.isFinite(gate.nextAt) && isGateBlocked(gate, Date.now())) {
          const until = gate.nextAt > Date.now() ? gate.nextAt : (gate.leaseUntil ?? Date.now() + 60 * 60_000);
          nextDailyQueuePollAt = Math.min(until, Date.now() + 60 * 60_000);
          return;
        }
      } catch {
        // Let claimSlot surface invalid gate state if corrupt.
      }
    }

    let publishedOne = false;
    let hitCooldown = false;
    for (const item of runnable) {
      try {
        const post = await publishDailyPostInternal(item.postId, new Date(), true);
        if (post.status === 'PUBLISHED') {
          publishedOne = true;
          if (config.telegram.enabled) await sendTelegramMessage(`✅ Queued daily article published\n${post.publishedUrl}`).catch(() => undefined);
          break;
        }
        if (post.lastError === 'DAILY_PUBLICATION_COOLDOWN') {
          hitCooldown = true;
          break;
        }
      } catch {
        const data = JSON.parse(item.value);
        await prisma.systemState.updateMany({ where: { key: item.key, value: item.value },
          data: { value: JSON.stringify({ ...data, failures: (data.failures ?? 0) + 1 }) } });
        logger.warn({ postId: data.postId }, 'queued daily publication failed; draft retained');
      }
    }
    if (publishedOne) {
      nextDailyQueuePollAt = runnable.length > 1
        ? Date.now() + Math.min(DAILY_PUBLICATION_GAP_MS, 60 * 60_000)
        : Date.now() + 60 * 60_000;
    } else if (hitCooldown) {
      nextDailyQueuePollAt = Date.now() + Math.min(DAILY_PUBLICATION_GAP_MS, 5 * 60_000);
    } else {
      nextDailyQueuePollAt = 0;
    }
  } finally { draining = false; }
}
