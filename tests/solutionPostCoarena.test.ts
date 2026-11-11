import OpenAI from 'openai';
import { afterEach, expect, it, vi } from 'vitest';
import { AIModelRouter, RoutingError } from '../src/solutionPosts/router';
import { CoarenaRouter, COARENA_WRITER, type CoarenaReply } from '../src/solutionPosts/coarena';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const request = [{ role: 'user' as const, content: 'Write an article.' }];
const validate = (output: string) => output.trim();

it.each([
  { left_usd: 0, requests_left: null },
  { left_usd: 4, requests_left: 0 },
])('pauses when a daily allowance is spent ($left_usd dollars left, $requests_left requests left)', async limits => {
  const reset = Date.now() + 60 * 60_000;
  const fetcher = vi.fn(async () => Response.json({ data: { free: true, usd_per_day: 5, today: {
    used_usd: 5 - limits.left_usd, resets_at: reset, ...limits,
  } } }));
  vi.stubGlobal('fetch', fetcher);
  const infer = vi.spyOn(AIModelRouter.prototype, 'generate');
  const fallback = vi.fn();
  const router = new CoarenaRouter('coa_daily_' + limits.requests_left, fallback);
  await expect(router.generate(request, validate)).rejects.toMatchObject({
    code: 'COARENA_DAILY_LIMIT', retryAt: new Date(reset),
  });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fallback).not.toHaveBeenCalled();
  expect(infer).not.toHaveBeenCalled();
});

it('uses the primary when within the free allowance without initializing Discovery', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: { free: true, usd_per_day: 5, today: {
    used_usd: 0, left_usd: 5, resets_at: 1000, requests_left: null,
  } } })));
  const infer = vi.spyOn(AIModelRouter.prototype, 'generate').mockResolvedValue({ value: 'primary', model: COARENA_WRITER, attempts: [] });
  const fallback = vi.fn(async () => { throw new Error('unexpected fallback'); });
  const router = new CoarenaRouter('coa_test', fallback);
  expect((await router.generate(request, validate, 1024, true, 'technical review implementation')).value).toBe('primary');
  expect(infer).toHaveBeenCalledWith([...request, { role: 'user', content: 'Return the result as a JSON object.' }],
    validate, 2400, true, 'technical review implementation');
  expect(fallback).not.toHaveBeenCalled();
});

it.each([
  [429, 'rate_limit_exceeded', 'COARENA_RATE_LIMIT'],
  [429, 'concurrency_limit_exceeded', 'COARENA_RATE_LIMIT'],
  [429, 'insufficient_quota', 'COARENA_DAILY_LIMIT'],
  [503, 'upstream_capacity', 'COARENA_CAPACITY'],
] as const)('respects %s %s without falling back', async (httpStatus, providerCode, code) => {
  const reset = Date.now() + 60 * 60_000;
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: { free: true, usd_per_day: 5, today: {
    used_usd: 0, left_usd: 5, resets_at: reset, requests_left: null,
  } } })));
  vi.spyOn(AIModelRouter.prototype, 'generate').mockRejectedValue(new RoutingError([{ model: COARENA_WRITER,
    provider: 'coarena', attempt: 1, elapsedMs: 1, outcome: 'HTTP_' + httpStatus, httpStatus, providerCode, retryAfterMs: 25_000 }]));
  const fallback = vi.fn();
  const router = new CoarenaRouter('coa_' + providerCode, fallback);
  const start = Date.now();
  const pause = await router.generate(request, validate).catch(error => error);
  expect(pause).toMatchObject({ code });
  if (code === 'COARENA_DAILY_LIMIT') expect(pause.retryAt.getTime()).toBe(reset);
  else expect(pause.retryAt.getTime()).toBeGreaterThanOrEqual(start + 25_000);
  expect(fallback).not.toHaveBeenCalled();
});

it('replays completed inference from the checkpoint without another provider request', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: { free: true, usd_per_day: 5, today: {
    used_usd: 0, left_usd: 5, resets_at: Date.now() + 60_000, requests_left: null,
  } } })));
  const replies = new Map<string, CoarenaReply>();
  const checkpoint = {
    read: async (id: string) => structuredClone(replies.get(id) ?? null),
    save: async (id: string, reply: CoarenaReply) => { replies.set(id, structuredClone(reply)); },
  };
  const infer = vi.spyOn(AIModelRouter.prototype, 'generate').mockImplementation(async (_input, parse) => ({
    value: parse(' saved output '), model: COARENA_WRITER, attempts: [],
  }));
  const first = new CoarenaRouter('coa_checkpoint', vi.fn(), undefined, undefined, checkpoint);
  expect((await first.generate(request, validate)).value).toBe('saved output');
  const resumed = new CoarenaRouter('coa_checkpoint', vi.fn(), undefined, undefined, checkpoint);
  expect((await resumed.generate(request, validate)).value).toBe('saved output');
  expect(infer).toHaveBeenCalledOnce();
});

it('reads Retry-After from a padded Coarena response using the actual OpenAI transport', async () => {
  const baseUrl = 'https://coarena.ai/api/v1';
  const fetcher = vi.fn(async (url: URL) => {
    if (url.toString().endsWith('/models')) return Response.json({ data: [{ id: COARENA_WRITER }] });
    return Response.json({ error: { code: 'concurrency_limit_exceeded', message: 'busy' } },
      { headers: { 'retry-after': '14' } });
  });
  const client = new OpenAI({ apiKey: 'coa_padded', baseURL: baseUrl, fetch: fetcher as never, maxRetries: 0 });
  const router = new AIModelRouter({ apiKey: 'coa_padded', baseUrl, models: [COARENA_WRITER],
    timeoutMs: 1000, retries: 0, maxTokens: 32 }, client);
  await expect(router.generate(request, validate)).rejects.toMatchObject({
    lastFailure: 'HTTP_429', attempts: [expect.objectContaining({ httpStatus: 429,
      providerCode: 'concurrency_limit_exceeded', retryAfterMs: 14_000 })],
  });
});
