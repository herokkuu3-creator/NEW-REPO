import { randomUUID } from 'node:crypto';
import { SolutionPost } from '@prisma/client';
import { prisma } from '../database/prisma';
import { publishPost } from './publisher';
import { logger } from '../logger';
import { config } from '../config';
import { sendTelegramMessage } from '../notifications/telegram';
import { startArticleWorkKeepAlive } from './keepAlive';
import { articleNeedsRefresh, contextSchema } from './article';

export const DAILY_PUBLICATION_GAP_MS = 20 * 60 * 1000;
export const DAILY_PUBLICATION_STATE_KEY = 'solution-post-daily-publication:gate';
const queuePrefix = 'solution-post-daily-publication:queue:';
type Gate = { nextAt: number; owner?: string; leaseUntil?: number; lastPostId?: string; lastPublishedAt?: string };
let draining = false;
let stopQueueKeepAlive: (() => void) | undefined;

export async function dailyPublicationStatus() {
  const row = await prisma.systemState.findUnique({ where: { key: DAILY_PUBLICATION_STATE_KEY } });
  const gate: Gate = row ? JSON.parse(row.value) : { nextAt: 0 };
  return { minimumGapMs: DAILY_PUBLICATION_GAP_MS,
    nextEligibleAt: gate.nextAt ? new Date(gate.nextAt).toISOString() : null,
    lastPostId: gate.lastPostId, lastPublishedAt: gate.lastPublishedAt };
}

async function claimSlot(now: number) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const row = await prisma.systemState.findUnique({ where: { key: DAILY_PUBLICATION_STATE_KEY } });
    const gate: Gate = row ? JSON.parse(row.value) : { nextAt: 0 };
    if (!Number.isFinite(gate.nextAt)) throw Error('INVALID_DAILY_PUBLICATION_GATE');
    if (gate.nextAt > now || (gate.owner && (gate.leaseUntil ?? Infinity) > now)) return null;
    // Reserve the worst-case publication window before the request. A crash
    // after the request but before saving its result must still preserve the gap.
    const value = JSON.stringify({ ...gate, nextAt: now + 10 * 60 * 1000 + DAILY_PUBLICATION_GAP_MS,
      owner: randomUUID(), leaseUntil: now + 10 * 60 * 1000 });
    if (row) {
      if ((await prisma.systemState.updateMany({ where: { key: DAILY_PUBLICATION_STATE_KEY, value: row.value }, data: { value } })).count) {
        return { value, gate };
      }
    } else {
      try { await prisma.systemState.create({ data: { key: DAILY_PUBLICATION_STATE_KEY, value } }); return { value, gate }; }
      catch (error) { if ((error as { code?: string }).code !== 'P2002') throw error; }
    }
  }
  return null;
}

/** Durable daily-only queue; manual publishing never enters this gate. */
export async function publishDailyPost(id: string, now = new Date()): Promise<SolutionPost> {
  let post = await prisma.solutionPost.findUniqueOrThrow({ where: { id } });
  const key = queuePrefix + id;
  if (['PUBLISHED', 'PUBLISHING', 'SKIPPED'].includes(post.status)) {
    await prisma.systemState.deleteMany({ where: { key } }); return post;
  }
  if (post.status !== 'DRAFT_READY') throw Error('DAILY_DRAFT_NOT_READY');
  if (articleNeedsRefresh(contextSchema.parse(JSON.parse(post.context)))) {
    await prisma.systemState.deleteMany({ where: { key } });
    return { ...post, lastError: 'ARTICLE_LAYOUT_REFRESH_REQUIRED' };
  }
  await prisma.systemState.upsert({ where: { key }, create: { key,
    value: JSON.stringify({ postId: id, queuedAt: now.toISOString(), failures: 0 }) }, update: {} });
  const claim = await claimSlot(now.getTime());
  if (!claim) {
    logger.info({ postId: id, ...await dailyPublicationStatus() }, 'daily article queued for publication spacing');
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

/** Runs every minute and on boot; cooldowns consume no generation retries. */
export async function processDailyPublicationQueue() {
  if (draining) return;
  draining = true;
  try {
    const pending = await prisma.systemState.findMany({ where: { key: { startsWith: queuePrefix } }, orderBy: { updatedAt: 'asc' }, take: 100 });
    const hasWork = pending.some(row => { try { return (JSON.parse(row.value).failures ?? 0) < 4; } catch { return false; } });
    if (hasWork && !stopQueueKeepAlive) stopQueueKeepAlive = startArticleWorkKeepAlive();
    else if (!hasWork && stopQueueKeepAlive) { stopQueueKeepAlive(); stopQueueKeepAlive = undefined; }
    for (const row of pending) {
      try {
        const { postId, failures = 0 } = JSON.parse(row.value);
        if (failures >= 4) continue;
        const post = await publishDailyPost(postId);
        if (post.status === 'PUBLISHED') {
          if (config.telegram.enabled) await sendTelegramMessage(`✅ Queued daily article published\n${post.publishedUrl}`).catch(() => undefined);
          break;
        }
        if (post.lastError === 'DAILY_PUBLICATION_COOLDOWN') break;
      } catch {
        const data = JSON.parse(row.value);
        await prisma.systemState.updateMany({ where: { key: row.key, value: row.value },
          data: { value: JSON.stringify({ ...data, failures: (data.failures ?? 0) + 1 }) } });
        logger.warn({ postId: data.postId }, 'queued daily publication failed; draft retained');
      }
    }
  } finally { draining = false; }
}
