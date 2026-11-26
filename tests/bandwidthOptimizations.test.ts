import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import Fastify from 'fastify';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  systemStateFindUnique: vi.fn(),
  systemStateFindMany: vi.fn(),
  systemStateUpsert: vi.fn(),
  dailyRunFindFirst: vi.fn(),
  accountFindMany: vi.fn(),
  queryRaw: vi.fn(),
  sendTelegramMessage: vi.fn(async () => true),
}));

vi.mock('../src/database/prisma', () => ({
  prisma: {
    systemState: {
      findUnique: (...args: unknown[]) => h.systemStateFindUnique(...args),
      findMany: (...args: unknown[]) => h.systemStateFindMany(...args),
      upsert: (...args: unknown[]) => h.systemStateUpsert(...args),
    },
    dailyRun: {
      findFirst: (...args: unknown[]) => h.dailyRunFindFirst(...args),
    },
    account: {
      findMany: (...args: unknown[]) => h.accountFindMany(...args),
    },
    $queryRaw: (...args: unknown[]) => h.queryRaw(...args),
  },
}));

vi.mock('../src/notifications/telegram', () => ({
  sendTelegramMessage: (...args: unknown[]) => h.sendTelegramMessage(...args),
  sendTelegramMessageWithId: vi.fn(async () => 1),
  editTelegramMessage: vi.fn(async () => true),
}));

import { config } from '../src/config';
import { startHealthServer } from '../src/api/health';
import { logRingBuffer } from '../src/logger';
import { attachBandwidthSaverRoute, blockNonEssentialBrowserAsset } from '../src/browser/playwright';
import {
  getTelegramWebhookSecret,
  registerTelegramWebhookRoute,
  resolveTelegramWebhookUrl,
  shouldUseTelegramWebhook,
  startTelegramBot,
  TELEGRAM_WEBHOOK_PATH,
} from '../src/notifications/telegramBot';
import { RECOVERY_COOKIE, registerRecoveryRoutes } from '../src/recovery/routes';
import type { RecoveryService } from '../src/recovery/service';
import { renderVisualGif, visualPlanSchema } from '../src/solutionPosts/visuals';
import {
  clearVisualAssetCache,
  registerVisualAssetRoutes,
  verifyHostedVisualAssets,
} from '../src/solutionPosts/visualStore';

describe('Bandwidth Optimizations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearVisualAssetCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('compresses multi-frame solution GIFs via sharp inter-frame delta while preserving GIF89a, dimensions, pages, loop, and delays', async () => {
    const plan = visualPlanSchema.parse({
      id: 'visual-1',
      after: 'intuition',
      title: 'Two-pointer window contraction',
      caption: 'Slide the left boundary when the sum exceeds the target.',
      layout: 'split-screen',
      theme: 'aurora',
      frames: [
        { label: 'Step 1', items: ['2', '7', '11', '15'], active: [0, 1], state: 'sum=9', metric: 'len=2', note: 'Expand right pointer.' },
        { label: 'Step 2', items: ['2', '7', '11', '15'], active: [1, 2], state: 'sum=18', metric: 'len=2', note: 'Shift window right.' },
        { label: 'Step 3', items: ['2', '7', '11', '15'], active: [2, 3], state: 'sum=26', metric: 'len=2', note: 'Inspect final pair.' },
      ],
    });

    const bytes = await renderVisualGif(plan);
    const meta = await sharp(bytes, { animated: true }).metadata();

    expect(bytes.subarray(0, 6).toString()).toBe('GIF89a');
    expect(meta.width).toBe(900);
    expect(meta.pageHeight).toBe(480);
    expect(meta.pages).toBe(9);
    expect(meta.loop).toBe(0);
    expect(meta.delay).toEqual([120, 160, 1170, 120, 160, 1170, 120, 160, 2020]);
    expect(bytes.length).toBeLessThan(80_000);
  });

  it('supports HEAD and HTTP Range (206 Partial Content) on /solution-assets/:file and range-based verifyHostedVisualAssets', async () => {
    const fakeGif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(200, 0x2a)]);
    const digest = createHash('sha256').update(fakeGif).digest('hex');
    h.systemStateFindUnique.mockResolvedValue({ value: fakeGif.toString('base64') });

    const app = Fastify();
    registerVisualAssetRoutes(app, { enableCache: true });

    const headRes = await app.inject({
      method: 'HEAD',
      url: `/solution-assets/${digest}.gif`,
    });
    expect(headRes.statusCode).toBe(200);
    expect(headRes.headers['content-type']).toBe('image/gif');
    expect(headRes.headers['content-length']).toBe(String(fakeGif.length));
    expect(headRes.headers['cdn-cache-control']).toContain('immutable');
    expect(headRes.headers['cloudflare-cdn-cache-control']).toContain('immutable');
    expect(headRes.headers['accept-ranges']).toBe('bytes');
    expect(headRes.rawPayload.length).toBe(0);

    const rangeRes = await app.inject({
      method: 'GET',
      url: `/solution-assets/${digest}.gif`,
      headers: { range: 'bytes=0-63' },
    });
    expect(rangeRes.statusCode).toBe(206);
    expect(rangeRes.headers['content-range']).toBe(`bytes 0-63/${fakeGif.length}`);
    expect(rangeRes.rawPayload.length).toBe(64);
    expect(rangeRes.rawPayload.equals(fakeGif.subarray(0, 64))).toBe(true);

    const invalidRange = await app.inject({
      method: 'GET',
      url: `/solution-assets/${digest}.gif`,
      headers: { range: 'bytes=500-600' },
    });
    expect(invalidRange.statusCode).toBe(416);

    const secondGif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(180, 0x3b)]);
    const secondDigest = createHash('sha256').update(secondGif).digest('hex');
    const assets = [
      { id: 'visual-1', url: `https://cdn.example.test/solution-assets/${digest}.gif`, alt: 'first' },
      { id: 'visual-2', url: `https://cdn.example.test/solution-assets/${secondDigest}.gif`, alt: 'second' },
    ];

    const rangeFetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Range).toBe('bytes=0-63');
      const src = String(url).includes(secondDigest) ? secondGif : fakeGif;
      return new Response(src.subarray(0, 64), {
        status: 206,
        headers: {
          'content-type': 'image/gif',
          'content-range': `bytes 0-63/${src.length}`,
        },
      });
    });

    await expect(
      verifyHostedVisualAssets(assets, 'https://cdn.example.test', rangeFetcher as unknown as typeof fetch),
    ).resolves.toBe(true);

    // Rejects when 206 Content-Range reports total size < 32 bytes
    const tinyRangeFetcher = vi.fn(async () =>
      new Response(Buffer.from('GIF89a'), {
        status: 206,
        headers: {
          'content-type': 'image/gif',
          'content-range': 'bytes 0-5/12',
        },
      }),
    );
    await expect(
      verifyHostedVisualAssets(assets, 'https://cdn.example.test', tinyRangeFetcher as unknown as typeof fetch),
    ).resolves.toBe(false);

    await app.close();
  });

  it('shares concurrent GIF reads and returns 304 only for assets that exist', async () => {
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(100)]);
    const digest = createHash('sha256').update(gif).digest('hex');
    h.systemStateFindUnique.mockImplementation(async ({ where }) => {
      await new Promise<void>(resolve => setImmediate(resolve));
      return where.key === `solution-visual:${digest}` ? { value: gif.toString('base64') } : null;
    });
    const app = Fastify();
    registerVisualAssetRoutes(app, { enableCache: true });
    await app.ready();

    try {
      const url = `/solution-assets/${digest}.gif`;
      const [read, conditional] = await Promise.all([
        app.inject({ method: 'GET', url }),
        app.inject({ method: 'GET', url, headers: { 'if-none-match': `W/"${digest}"` } }),
      ]);
      expect(read.rawPayload).toEqual(gif);
      expect(conditional.statusCode).toBe(304);
      expect(h.systemStateFindUnique).toHaveBeenCalledOnce();

      const missing = 'a'.repeat(64);
      const response = await app.inject({
        method: 'GET',
        url: `/solution-assets/${missing}.gif`,
        headers: { 'if-none-match': `"${missing}"` },
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('serves ETag and 304 Not Modified on /auth/recover/session/frame and includes visibility throttling in viewer HTML', async () => {
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x01, 0x02]);
    const mockService: Partial<RecoveryService> = {
      portalStatus: vi.fn((secret) =>
        secret === 'sec-1'
          ? {
              phase: 'awaiting_verification' as const,
              message: 'Verify',
              label: 'main',
              final: false,
              viewport: { width: 1024, height: 720 },
            }
          : null,
      ),
      portalFrame: vi.fn(async (secret) => (secret === 'sec-1' ? jpegBytes : null)),
    };

    const app = Fastify();
    registerRecoveryRoutes(app, mockService as RecoveryService);

    const viewerRes = await app.inject({
      method: 'GET',
      url: '/auth/recover/session',
      headers: { cookie: `${RECOVERY_COOKIE}=sec-1` },
    });
    expect(viewerRes.statusCode).toBe(200);
    expect(viewerRes.body).toContain('If-None-Match');
    expect(viewerRes.body).toContain('document.hidden');
    expect(viewerRes.body).toContain('visibilitychange');

    const firstFrame = await app.inject({
      method: 'GET',
      url: '/auth/recover/session/frame',
      headers: { cookie: `${RECOVERY_COOKIE}=sec-1` },
    });
    expect(firstFrame.statusCode).toBe(200);
    expect(firstFrame.headers['cache-control']).toBe('no-store');
    const etag = firstFrame.headers.etag;
    expect(typeof etag).toBe('string');
    expect(firstFrame.rawPayload.equals(jpegBytes)).toBe(true);

    const cachedFrame = await app.inject({
      method: 'GET',
      url: '/auth/recover/session/frame',
      headers: {
        cookie: `${RECOVERY_COOKIE}=sec-1`,
        'if-none-match': etag as string,
      },
    });
    expect(cachedFrame.statusCode).toBe(304);
    expect(cachedFrame.headers.etag).toBe(etag);
    expect(cachedFrame.rawPayload.length).toBe(0);

    await app.close();
  });

  it('compresses JSON/HTML responses > 1 KB when Accept-Encoding includes gzip while leaving binary GIFs and non-gzip requests uncompressed', async () => {
    for (let i = 0; i < 40; i++) {
      logRingBuffer.push({
        level: 30,
        time: '2026-11-19T12:00:00.000Z',
        msg: `sample log entry number ${i} with enough diagnostic text to exceed one kilobyte easily`,
      });
    }
    const fakeGif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(1500, 0x11)]);
    const digest = createHash('sha256').update(fakeGif).digest('hex');
    h.systemStateFindUnique.mockResolvedValue({ value: fakeGif.toString('base64') });

    const app = await startHealthServer(
      {
        triggerRun: async () => ({ started: true, message: 'ok' }),
        isRunInProgress: () => false,
        runSubmission: async () => null,
      },
      { pinCode: '1234' },
    );

    try {
      const plainRes = await app.inject({
        method: 'GET',
        url: '/logs?limit=40',
        headers: { authorization: `Bearer ${config.api.setupToken}` },
      });
      expect(plainRes.statusCode).toBe(200);
      expect(plainRes.headers['content-encoding']).toBeUndefined();
      expect(JSON.parse(plainRes.body).ok).toBe(true);

      const gzipRes = await app.inject({
        method: 'GET',
        url: '/logs?limit=40',
        headers: {
          authorization: `Bearer ${config.api.setupToken}`,
          'accept-encoding': 'gzip, deflate, br',
        },
      });
      expect(gzipRes.statusCode).toBe(200);
      expect(gzipRes.headers['content-encoding']).toBe('gzip');
      expect(gzipRes.headers.vary).toContain('Accept-Encoding');
      expect(gzipRes.rawPayload.length).toBeLessThan(plainRes.rawPayload.length);
      const decompressed = gunzipSync(gzipRes.rawPayload).toString('utf8');
      expect(JSON.parse(decompressed).ok).toBe(true);

      const gifRes = await app.inject({
        method: 'GET',
        url: `/solution-assets/${digest}.gif`,
        headers: { 'accept-encoding': 'gzip, deflate, br' },
      });
      expect(gifRes.statusCode).toBe(200);
      expect(gifRes.headers['content-encoding']).toBeUndefined();
      expect(gifRes.rawPayload.equals(fakeGif)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('registers Telegram webhook on Render HTTPS without polling getUpdates and deduplicates incoming webhook updates', async () => {
    const prevTg = { ...config.telegram };
    const prevPublicUrl = config.api.publicUrl;
    Object.assign(config.telegram, {
      enabled: true,
      commands: true,
      botToken: 'test-bot-token-123',
      chatId: '9999',
      mode: 'auto',
    });
    config.api.publicUrl = 'https://leetcode-daily-agent-ascq.onrender.com';
    vi.stubEnv('RENDER_INSTANCE_ID', 'srv-render-1');

    const tgCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const m = /\/bot[^/]+\/([^/?]+)/.exec(String(url))?.[1] ?? 'unknown';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      tgCalls.push({ method: m, body });
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }));

    const app = Fastify();
    registerTelegramWebhookRoute(app);

    let stop: (() => void) | undefined;
    try {
      expect(resolveTelegramWebhookUrl()).toBe('https://leetcode-daily-agent-ascq.onrender.com/telegram/webhook');
      expect(shouldUseTelegramWebhook()).toBe(true);

      stop = startTelegramBot();
      await new Promise((r) => setTimeout(r, 40));

      expect(tgCalls.some((c) => c.method === 'setWebhook')).toBe(true);
      expect(tgCalls.some((c) => c.method === 'getUpdates')).toBe(false);

      // Unauthorized webhook POST rejected with 401
      const unauth = await app.inject({
        method: 'POST',
        url: TELEGRAM_WEBHOOK_PATH,
        payload: { update_id: 500, message: { message_id: 1, chat: { id: '9999' }, text: '/help' } },
      });
      expect(unauth.statusCode).toBe(401);

      const secret = getTelegramWebhookSecret()!;
      const valid1 = await app.inject({
        method: 'POST',
        url: TELEGRAM_WEBHOOK_PATH,
        headers: { 'x-telegram-bot-api-secret-token': secret },
        payload: { update_id: 501, message: { message_id: 2, chat: { id: '9999' }, text: '/help' } },
      });
      expect(valid1.statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 30));
      const sendsAfterFirst = h.sendTelegramMessage.mock.calls.length;
      expect(sendsAfterFirst).toBeGreaterThanOrEqual(1);

      // Duplicate update_id is ignored
      const validDup = await app.inject({
        method: 'POST',
        url: TELEGRAM_WEBHOOK_PATH,
        headers: { 'x-telegram-bot-api-secret-token': secret },
        payload: { update_id: 501, message: { message_id: 2, chat: { id: '9999' }, text: '/help' } },
      });
      expect(validDup.statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 30));
      expect(h.sendTelegramMessage.mock.calls.length).toBe(sendsAfterFirst);
    } finally {
      stop?.();
      await app.close();
      Object.assign(config.telegram, prevTg);
      config.api.publicUrl = prevPublicUrl;
    }
  });

  it('blocks decorative images, fonts, media, and analytics in blockNonEssentialBrowserAsset while allowing Cloudflare and app scripts', async () => {
    expect(blockNonEssentialBrowserAsset('https://leetcode.com/logo.png', 'image')).toBe(true);
    expect(blockNonEssentialBrowserAsset('https://leetcode.com/fonts/inter.woff2', 'font')).toBe(true);
    expect(blockNonEssentialBrowserAsset('https://leetcode.com/intro.mp4', 'media')).toBe(true);
    expect(blockNonEssentialBrowserAsset('https://www.google-analytics.com/g/collect', 'fetch')).toBe(true);
    expect(blockNonEssentialBrowserAsset('https://www.clarity.ms/tag/abc', 'script')).toBe(true);

    expect(blockNonEssentialBrowserAsset('https://leetcode.com/graphql', 'fetch')).toBe(false);
    expect(blockNonEssentialBrowserAsset('https://leetcode.com/app.js', 'script')).toBe(false);
    expect(blockNonEssentialBrowserAsset('https://leetcode.com/app.css', 'stylesheet')).toBe(false);
    expect(blockNonEssentialBrowserAsset('https://challenges.cloudflare.com/turnstile/v0/api.js', 'script')).toBe(false);
    expect(blockNonEssentialBrowserAsset('https://challenges.cloudflare.com/logo.png', 'image')).toBe(false);
    expect(blockNonEssentialBrowserAsset('https://leetcode.com/cdn-cgi/challenge-platform/h/g/jsd', 'script')).toBe(false);
    expect(blockNonEssentialBrowserAsset('blob:https://leetcode.com/123', 'script')).toBe(false);
    expect(blockNonEssentialBrowserAsset('data:image/png;base64,AAA', 'image')).toBe(false);

    // Safe no-op on mocked context without .route
    await expect(attachBandwidthSaverRoute({} as never)).resolves.toBeUndefined();
  });
});
