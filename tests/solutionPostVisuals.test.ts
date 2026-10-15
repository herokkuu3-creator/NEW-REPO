import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ findUnique: vi.fn(), upsert: vi.fn() }));
vi.mock('../src/database/prisma', () => ({ prisma: { systemState: db } }));
import { visualPlanSchema, renderVisualFallback, renderVisualFrame, renderVisualGif } from '../src/solutionPosts/visuals';
import { publicVisualOrigin, registerVisualAssetRoutes, storeVisualAssets, verifyHostedVisualAssets } from '../src/solutionPosts/visualStore';
import { articleSchema, contextSchema, renderArticle } from '../src/solutionPosts/article';

const context = contextSchema.parse({ accountId: 'a', username: 'alice', problemId: '1', slug: 'example',
  title: 'Distinct squares', difficulty: 'Easy', problem: 'Sum squares of distinct counts.',
  submissionId: '123', language: 'cpp', code: 'class Solution {};', challengeDate: '2026-10-15' });
const article = articleSchema.parse({ title: '✨ Count Once, Square It! | Simple Sets',
  sections: ['intuition', 'approach', 'correctness', 'dryRun', 'takeaways'].map(kind => ({ kind, heading: `${kind} explained`,
    markdown: 'Extend the right boundary and square the distinct count.' })),
  time: { bound: 'O(n^2)', reason: 'Expected constant-time insertion per interval.' },
  space: { bound: 'O(n)', reason: 'The set holds at most n values.' } });

const plan = visualPlanSchema.parse({ id: 'visual-1', after: 'intuition', title: 'A duplicate does not grow the set',
  caption: 'Grow the window; count unique values.', frames: [
    { label: 'i=0, j=0', items: ['1', '2', '1'], active: [0], state: 'set={1}', metric: '1 squared = 1', note: 'Insert one value.' },
    { label: 'i=0, j=1', items: ['1', '2', '1'], active: [0, 1], state: 'set={1,2}', metric: '2 squared = 4', note: 'A new value grows the set.' },
    { label: 'i=0, j=2', items: ['1', '2', '1'], active: [0, 1, 2], state: 'set={1,2}', metric: '2 squared = 4', note: 'The repeated 1 leaves the count unchanged.' },
  ] });

describe('original solution animations', () => {
  it('encodes every trace step as a looping, delayed GIF with bounded size', async () => {
    const bytes = await renderVisualGif(plan);
    const metadata = await sharp(bytes, { animated: true }).metadata();
    expect(bytes.subarray(0, 6).toString()).toBe('GIF89a');
    expect(metadata.width).toBe(720); expect(metadata.pageHeight).toBe(360);
    expect(metadata.pages).toBe(3); expect(metadata.loop).toBe(0);
    expect(metadata.delay).toEqual([1450, 1450, 2300]);
    expect(bytes.length).toBeLessThan(500000);
    const frames = await sharp(bytes, { animated: true }).raw().toBuffer();
    const pageBytes = frames.length / 3;
    expect(frames.subarray(0, pageBytes).equals(frames.subarray(pageBytes, pageBytes * 2))).toBe(false);
  });
  it('rejects invalid highlighted positions and escapes SVG/Markdown text', () => {
    const bad = structuredClone(plan); bad.frames[0]!.active = [6];
    expect(() => visualPlanSchema.parse(bad)).toThrow();
    const hostile = structuredClone(plan);
    hostile.title = '<script>alert(1)</script>';
    hostile.caption = '![bad](https://evil.test/x)';
    hostile.frames[0]!.state = '<img src=x onerror=alert(1)>|value';
    expect(renderVisualFrame(hostile, 0)).not.toContain('<script>');
    const fallback = renderVisualFallback(hostile);
    expect(fallback).not.toContain('<img'); expect(fallback).not.toContain('![bad](');
  });
  it('interleaves hosted diagrams with short text while retaining source exactly once', () => {
    const result = renderArticle({ ...article, visuals: [plan] }, context,
      [{ id: plan.id, url: 'https://assets.example.test/a.gif', alt: plan.caption }]);
    expect(result.indexOf('![Grow the window')).toBeLessThan(result.indexOf('## approach'));
    expect(result.split(context.code)).toHaveLength(2);
    expect(result).not.toContain('## correctness');
    expect(renderArticle({ ...article, visuals: [plan] }, context)).toContain('| Step | State | Result |');
  });
  it('stores content-addressed media durably and serves it without exposing system state', async () => {
    db.upsert.mockResolvedValue({});
    const assets = await storeVisualAssets([plan], 'https://app.example.test');
    const saved = db.upsert.mock.calls.at(-1)![0];
    const bytes = Buffer.from(saved.create.value, 'base64');
    const digest = createHash('sha256').update(bytes).digest('hex');
    expect(assets[0]?.url).toBe(`https://app.example.test/solution-assets/${digest}.gif`);
    db.findUnique.mockResolvedValue({ value: saved.create.value });
    const app = Fastify(); registerVisualAssetRoutes(app);
    const response = await app.inject(`/solution-assets/${digest}.gif`);
    expect(response.statusCode).toBe(200); expect(response.rawPayload.equals(bytes)).toBe(true);
    expect(response.headers['content-type']).toBe('image/gif');
    expect(response.headers['cache-control']).toContain('immutable');
    db.findUnique.mockResolvedValue({ value: Buffer.from('not an image').toString('base64') });
    expect((await app.inject(`/solution-assets/${digest}.gif`)).statusCode).toBe(404);
    expect((await app.inject('/solution-assets/private-key.gif')).statusCode).toBe(404);
    await app.close();
  });
  it('falls back without writing assets when a persistent public HTTPS host is unavailable', async () => {
    db.upsert.mockClear();
    for (const url of ['http://example.com', 'https://localhost', 'https://127.0.0.1', 'https://10.0.0.1', 'bad']) {
      expect(publicVisualOrigin(url)).toBeNull(); expect(await storeVisualAssets([plan], url)).toEqual([]);
    }
    expect(db.upsert).not.toHaveBeenCalled();
  });
  it('requires exactly two publicly reachable GIF assets before publication', async () => {
    const second = visualPlanSchema.parse({ ...plan, id: 'visual-2', after: 'dryRun', title: 'The contribution joins the total', frames: [
      { ...plan.frames[0]!, state: 'answer=1', metric: '+1' },
      { ...plan.frames[1]!, state: 'answer=5', metric: '+4' },
    ] });
    const firstBytes = await renderVisualGif(plan); const secondBytes = await renderVisualGif(second);
    const firstHash = createHash('sha256').update(firstBytes).digest('hex');
    const secondHash = createHash('sha256').update(secondBytes).digest('hex');
    const assets = [
      { id: 'visual-1', url: `https://app.example.test/solution-assets/${firstHash}.gif`, alt: plan.caption },
      { id: 'visual-2', url: `https://app.example.test/solution-assets/${secondHash}.gif`, alt: second.caption },
    ];
    const fetcher = vi.fn(async (url: string) => new Response(url.includes(secondHash) ? secondBytes : firstBytes,
      { status: 200, headers: { 'content-type': 'image/gif' } }));
    await expect(verifyHostedVisualAssets(assets, 'https://app.example.test', fetcher)).resolves.toBe(true);
    await expect(verifyHostedVisualAssets([assets[0]!], 'https://app.example.test', fetcher)).resolves.toBe(false);
    await expect(verifyHostedVisualAssets([{ ...assets[0]!, url: 'https://other.example.test/a.gif' }, assets[1]!], 'https://app.example.test', fetcher)).resolves.toBe(false);
  });
});
