import { createHash } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { prisma } from '../database/prisma';
import { VisualAsset, VisualPlan, renderVisualGif } from './visuals';

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
    await prisma.systemState.upsert({ where: { key: `solution-visual:${digest}` },
      create: { key: `solution-visual:${digest}`, value: bytes.toString('base64') }, update: {} });
    assets.push({ id: plan.id, url: `${origin}/solution-assets/${digest}.gif`, alt: plan.caption });
  }
  return assets;
}

export function registerVisualAssetRoutes(app: FastifyInstance) {
  app.get('/solution-assets/:file', async (req, reply) => {
    const { file } = req.params as { file: string };
    if (!/^[a-f0-9]{64}\.gif$/.test(file)) return reply.code(404).send();
    const digest = file.slice(0, -4);
    const record = await prisma.systemState.findUnique({ where: { key: `solution-visual:${digest}` } });
    if (!record || record.value.length > 700000) return reply.code(404).send();
    const bytes = Buffer.from(record.value, 'base64');
    if (bytes.subarray(0, 6).toString() !== 'GIF89a' || createHash('sha256').update(bytes).digest('hex') !== digest) return reply.code(404).send();
    return reply.header('Content-Type', 'image/gif').header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'public, max-age=31536000, immutable').send(bytes);
  });
}
