import OpenAI from 'openai';
import { afterEach, expect, it, vi } from 'vitest';
import { AIModelRouter, RoutingError } from '../src/solutionPosts/router';
import * as state from '../src/database/models';
import { CoarenaRouter, COARENA_WRITER, loadCoarenaModelOrder, setCoarenaModelPreference, type CoarenaReply } from '../src/solutionPosts/coarena';

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

it.each([{ models: ['review-gone', 'review-available'] }, { models: [] }])(
  'uses an available reviewer with the configured priority $models', async ({ models }) => {
  const baseUrl = 'https://coarena.ai/api/v1';
  const fetcher = vi.fn(async (url: URL, options?: { body?: string }) => {
    if (url.toString().endsWith('/models')) return Response.json({ data: [{ id: 'review-available' }] });
    const model = JSON.parse(options!.body!).model;
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: model } }] });
  });
  const client = new OpenAI({ apiKey: 'coa_catalog', baseURL: baseUrl, fetch: fetcher as never, maxRetries: 0 });
  const router = new AIModelRouter({ apiKey: 'coa_catalog', baseUrl, models: ['writer', 'review-gone', 'review-available'],
    reviewModels: models, timeoutMs: 1000, retries: 0, maxTokens: 32 }, client);
  expect(await router.generate(request, validate, 32, true, 'technical review article')).toMatchObject({
    value: 'review-available', model: 'review-available',
  });
});

function mockCoarena(infer: (model: string) => Response, left = () => 5) {
  const models = { writers: ['writer-a', 'writer-b', 'writer-c'], reviewers: ['review-a', 'review-b', 'review-c'] };
  const fetchLimits = vi.fn(async () => Response.json({ data: { free: true, usd_per_day: 5, today: {
    used_usd: 5 - left(), left_usd: left(), resets_at: Date.now() + 60_000, requests_left: null,
  } } }));
  vi.stubGlobal('fetch', fetchLimits);
  const completion = vi.fn(infer);
  const client = new OpenAI({ apiKey: 'test', baseURL: 'https://coarena.ai/api/v1', maxRetries: 0,
    fetch: (async (url: URL, options?: { body?: string }) => {
      if (url.toString().endsWith('/models')) return Response.json({ data: [...models.writers, ...models.reviewers].map(id => ({ id })) });
      return completion(JSON.parse(options!.body!).model);
    }) as never });
  const fallback = vi.fn(async () => { throw new Error('unexpected Discovery fallback'); });
  const router = new CoarenaRouter('coa_route_' + Math.random(), fallback, undefined, undefined, undefined, models, client);
  return { router, completion, fallback, fetchLimits };
}

it('uses the third writer after model capacity and invalid JSON, and reports the model that served the reply', async () => {
  const { router, completion, fallback, fetchLimits } = mockCoarena(model => {
    if (model === 'writer-a') return Response.json({ error: { code: 'upstream_capacity' } }, { status: 503 });
    return Response.json({ model: model === 'writer-c' ? 'served-model' : model, choices: [
      { finish_reason: 'stop', message: { content: model === 'writer-b' ? 'broken JSON' : '{"ok":true}' } },
    ] });
  });
  const result = await router.generate(request, JSON.parse, 128, true, 'article implementation');
  expect(result).toMatchObject({ model: 'served-model', value: { ok: true },
    attempts: [{ model: 'writer-a', outcome: 'HTTP_503' }, { model: 'writer-b', outcome: 'INVALID_OUTPUT' },
      { model: 'served-model', requestedModel: 'writer-c', outcome: 'SUCCESS' }] });
  expect(completion.mock.calls.flat()).toEqual(['writer-a', 'writer-b', 'writer-c']);
  expect(fetchLimits).toHaveBeenCalledTimes(3);
  expect(fallback).not.toHaveBeenCalled();
}, 15000);

it('stops the review chain on an account limit and retains the preceding model failure', async () => {
  const { router, completion, fallback } = mockCoarena(model => model === 'review-a'
    ? Response.json({ error: { code: 'model_not_found' } }, { status: 404 })
    : Response.json({ error: { code: 'rate_limit_exceeded' } }, { status: 429, headers: { 'retry-after': '8' } }));
  await expect(router.generate(request, validate, 128, true, 'technical review article')).rejects.toMatchObject({
    code: 'COARENA_RATE_LIMIT', attempts: [{ model: 'review-a', httpStatus: 404 }, { model: 'review-b', httpStatus: 429 }],
  });
  expect(completion.mock.calls.flat()).toEqual(['review-a', 'review-b']);
  expect(fallback).not.toHaveBeenCalled();
}, 15000);

it('pauses before a fallback inference if the allowance was spent by the first attempt', async () => {
  let left = 5;
  const { router, completion, fallback } = mockCoarena(() => {
    left = 0;
    return Response.json({ error: { code: 'upstream_error' } }, { status: 502 });
  }, () => left);
  await expect(router.generate(request, validate)).rejects.toMatchObject({
    code: 'COARENA_DAILY_LIMIT', attempts: [{ model: 'writer-a', httpStatus: 502 }],
  });
  expect(completion.mock.calls.flat()).toEqual(['writer-a']);
  expect(fallback).not.toHaveBeenCalled();
}, 15000);

it('saves a preferred pair, keeps the alternate models, and restores automatic order', async () => {
  let stored: string | null = null;
  vi.spyOn(state, 'getSystemState').mockImplementation(async () => stored);
  vi.spyOn(state, 'setSystemState').mockImplementation(async (_key, value) => { stored = value; });
  await expect(setCoarenaModelPreference({ writer: 'gemini-3-8-flash', reviewer: 'claude-opus-5-5' })).resolves.toMatchObject({
    mode: 'preferred', writers: ['gemini-3-8-flash', 'claude-sonnet-5-5', 'kimi-k3-1-pro'],
    reviewers: ['claude-opus-5-5', 'gemini-4-argon', 'qwen3-8-2-4t-a95b'],
  });
  await expect(setCoarenaModelPreference({ writer: 'unknown', reviewer: 'claude-opus-5-5' })).rejects.toThrow();
  await expect(setCoarenaModelPreference('auto')).resolves.toMatchObject({ mode: 'auto' });
  expect((await loadCoarenaModelOrder()).writers[0]).toBe(COARENA_WRITER);
});

it('converts ARTICLE_TIME_BUDGET_EXCEEDED from fallback into a CoarenaPause capacity pause', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: { free: true, usd_per_day: 5, today: {
    used_usd: 0, left_usd: 5, resets_at: Date.now() + 60_000, requests_left: null,
  } } })));
  vi.spyOn(AIModelRouter.prototype, 'generate').mockRejectedValueOnce(new RoutingError([{ model: COARENA_WRITER,
    provider: 'coarena', attempt: 1, elapsedMs: 1, outcome: 'MODEL_NOT_FOUND', httpStatus: 404 }]));
  const fallback = vi.fn(async () => ({
    generate: vi.fn(async () => {
      throw new RoutingError([{ model: 'discovery', attempt: 1, outcome: 'ARTICLE_TIME_BUDGET_EXCEEDED', elapsedMs: 1 }], 'ARTICLE_TIME_BUDGET_EXCEEDED');
    }),
  } as unknown as AIModelRouter));
  const router = new CoarenaRouter('coa_fallback_budget', fallback);
  await expect(router.generate(request, validate)).rejects.toMatchObject({
    code: 'COARENA_CAPACITY',
  });
  expect(fallback).toHaveBeenCalledOnce();
});
