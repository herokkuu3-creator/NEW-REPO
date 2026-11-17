import { createHash } from 'node:crypto';
import { FastifyInstance, FastifyReply } from 'fastify';
import { prisma } from '../database/prisma';
import { VisualAsset, VisualPlan, renderVisualGif } from './visuals';

export const MAX_VISUAL_CACHE_ENTRIES = 32;
export const MAX_VISUAL_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_VISUAL_BASE64_LENGTH = 700_000;

const visualCache = new Map<string, Buffer>();
let visualCacheBytes = 0;

function defaultCacheEnabled(): boolean {
  return process.env.NODE_ENV !== 'test' && !process.env.VITEST;
}

function getCachedVisual(digest: string): Buffer | undefined {
  const hit = visualCache.get(digest);
  if (!hit) return undefined;
  visualCache.delete(digest);
  visualCache.set(digest, hit);
  return hit;
}

function setCachedVisual(digest: string, bytes: Buffer): void {
  if (bytes.length > MAX_VISUAL_CACHE_BYTES) return;
  const existing = visualCache.get(digest);
  if (existing) {
    visualCacheBytes -= existing.length;
    visualCache.delete(digest);
  }
  while ((visualCache.size >= MAX_VISUAL_CACHE_ENTRIES || visualCacheBytes + bytes.length > MAX_VISUAL_CACHE_BYTES) &&
      visualCache.size > 0) {
    const oldestKey = visualCache.keys().next().value;
    if (!oldestKey) break;
    const oldest = visualCache.get(oldestKey);
    if (oldest) visualCacheBytes -= oldest.length;
    visualCache.delete(oldestKey);
  }
  visualCache.set(digest, bytes);
  visualCacheBytes += bytes.length;
}

/** Clears the bounded in-memory visual LRU cache (intended for tests). */
export function clearVisualAssetCache(): void {
  visualCache.clear();
  visualCacheBytes = 0;
}

export function publicVisualOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      /^(localhost|127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[)/i.test(url.hostname)) return null;
    return url.origin;
  } catch { return null; }
}

/** Durable generated media lives in the existing DB, not ephemeral Render disk. */
export async function storeVisualAssets(plans: VisualPlan[], baseUrl: string): Promise<VisualAsset[]> {
  const origin = publicVisualOrigin(baseUrl);
  if (!origin) return [];
  const assets: VisualAsset[] = [];
  for (const plan of plans) {
    const bytes = await renderVisualGif(plan);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const encoded = bytes.toString('base64');
    await prisma.systemState.upsert({
      where: { key: `solution-visual:${digest}` },
      create: { key: `solution-visual:${digest}`, value: encoded },
      update: {},
      select: { key: true },
    });
    if (defaultCacheEnabled() && encoded.length <= MAX_VISUAL_BASE64_LENGTH) {
      setCachedVisual(digest, bytes);
    }
    assets.push({ id: plan.id, url: `${origin}/solution-assets/${digest}.gif`, alt: plan.caption });
  }
  return assets;
}

/**
 * Checks the exact URLs that will be inserted into a public article.  Storing a
 * GIF is not enough: a bad public URL, route, proxy, or deployment can still
 * leave readers with broken media.  Publication calls this before it clicks
 * LeetCode's Post button.
 */
export async function verifyHostedVisualAssets(assets: VisualAsset[], baseUrl: string,
  fetcher: typeof fetch = globalThis.fetch): Promise<boolean> {
  const origin = publicVisualOrigin(baseUrl);
  if (!origin || assets.length !== 2 || new Set(assets.map(asset => asset.id)).size !== 2 ||
      new Set(assets.map(asset => asset.url)).size !== 2) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    for (const asset of assets) {
      let parsed: URL;
      try { parsed = new URL(asset.url); } catch { return false; }
      if (parsed.origin !== origin || !/^\/solution-assets\/[a-f0-9]{64}\.gif$/.test(parsed.pathname)) return false;
      let bytes: Buffer;
      try {
        const response = await fetcher(asset.url, { redirect: 'error', signal: controller.signal });
        if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('image/gif')) return false;
        bytes = Buffer.from(await response.arrayBuffer());
      } catch {
        return false;
      }
      if (bytes.length < 32 || !['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())) return false;
    }
    return true;
  } finally { clearTimeout(timer); }
}

function sendGifReply(reply: FastifyReply, etag: string, bytes: Buffer) {
  return reply
    .header('Content-Type', 'image/gif')
    .header('X-Content-Type-Options', 'nosniff')
    .header('Cache-Control', 'public, max-age=31536000, immutable')
    .header('ETag', etag)
    .send(bytes);
}

export function registerVisualAssetRoutes(app: FastifyInstance, options?: { enableCache?: boolean }) {
  const useCache = options?.enableCache ?? defaultCacheEnabled();
  app.get('/solution-assets/:file', async (req, reply) => {
    const { file } = req.params as { file: string };
    if (!/^[a-f0-9]{64}\.gif$/.test(file)) return reply.code(404).send();
    const digest = file.slice(0, -4);
    const etag = `"${digest}"`;
    const ifNoneMatch = req.headers['if-none-match'];
    if (typeof ifNoneMatch === 'string' && ifNoneMatch.split(',').some(tag => {
      const trimmed = tag.trim();
      return trimmed === etag || trimmed === `W/${etag}` || trimmed === digest;
    })) {
      return reply.code(304).header('ETag', etag).header('Cache-Control', 'public, max-age=31536000, immutable').send();
    }
    if (useCache) {
      const cached = getCachedVisual(digest);
      if (cached) return sendGifReply(reply, etag, cached);
    }
    const record = await prisma.systemState.findUnique({
      where: { key: `solution-visual:${digest}` },
      select: { value: true },
    });
    if (!record || record.value.length > MAX_VISUAL_BASE64_LENGTH) return reply.code(404).send();
    const bytes = Buffer.from(record.value, 'base64');
    if (bytes.subarray(0, 6).toString() !== 'GIF89a' || createHash('sha256').update(bytes).digest('hex') !== digest) return reply.code(404).send();
    if (useCache) setCachedVisual(digest, bytes);
    return sendGifReply(reply, etag, bytes);
  });
}
