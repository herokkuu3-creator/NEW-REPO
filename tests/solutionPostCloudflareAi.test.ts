import Fastify from 'fastify';
import OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCloudflareAiProvider } from '../src/config/solutionPostProvider';
import { redactSecrets } from '../src/security/redact';
import { AIModelRouter, isKeyExhausted, RoutingError } from '../src/solutionPosts/router';
import {
  CLOUDFLARE_REVIEWERS,
  CLOUDFLARE_WRITERS,
  type CloudflareAiConfig,
  CloudflareAiRouter,
  cloudflareAiBaseUrl,
  DEFAULT_CLOUDFLARE_ACCOUNT_ID,
  loadCloudflareAiConfig,
  maskCloudflareToken,
} from '../src/solutionPosts/cloudflareAi';

const TEST_CF_TOKEN = 'cfut_testCloudflareTokenValue1234567890abcd';
const testCfConfig = (): CloudflareAiConfig => ({
  accountId: DEFAULT_CLOUDFLARE_ACCOUNT_ID,
  apiToken: TEST_CF_TOKEN,
  baseUrl: cloudflareAiBaseUrl(DEFAULT_CLOUDFLARE_ACCOUNT_ID),
  source: 'environment',
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

const request = [{ role: 'user' as const, content: 'Write a JSON response.' }];

describe('Cloudflare Workers AI integration', () => {
  it('matches Cloudflare Workers AI OpenAI-compatible URLs strictly', () => {
    expect(isCloudflareAiProvider(cloudflareAiBaseUrl(DEFAULT_CLOUDFLARE_ACCOUNT_ID))).toBe(true);
    expect(isCloudflareAiProvider('https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1/')).toBe(true);
    expect(isCloudflareAiProvider('http://api.cloudflare.com/client/v4/accounts/abc123/ai/v1')).toBe(false);
    expect(isCloudflareAiProvider('https://evil.example/client/v4/accounts/abc123/ai/v1')).toBe(false);
    expect(isCloudflareAiProvider('https://coarena.ai/api/v1')).toBe(false);
  });

  it('uses hardcoded account ID with env token, respects disable flag, and stays off when token is unset', () => {
    vi.stubEnv('CLOUDFLARE_AI_API_TOKEN', '');
    vi.stubEnv('CLOUDFLARE_AI_DISABLED', '');
    expect(loadCloudflareAiConfig()).toBeNull();

    vi.stubEnv('CLOUDFLARE_AI_API_TOKEN', TEST_CF_TOKEN);
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', '');
    expect(loadCloudflareAiConfig()).toEqual({
      accountId: DEFAULT_CLOUDFLARE_ACCOUNT_ID,
      apiToken: TEST_CF_TOKEN,
      baseUrl: `https://api.cloudflare.com/client/v4/accounts/${DEFAULT_CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
      source: 'environment',
    });
    expect(maskCloudflareToken(TEST_CF_TOKEN)).toBe('cfut_…abcd');

    vi.stubEnv('CLOUDFLARE_AI_API_TOKEN', 'cfut_custom_env_token_123456');
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'custom_acct_9999');
    expect(loadCloudflareAiConfig()).toEqual({
      accountId: 'custom_acct_9999',
      apiToken: 'cfut_custom_env_token_123456',
      baseUrl: 'https://api.cloudflare.com/client/v4/accounts/custom_acct_9999/ai/v1',
      source: 'environment',
    });

    vi.stubEnv('CLOUDFLARE_AI_DISABLED', 'true');
    expect(loadCloudflareAiConfig()).toBeNull();
  });

  it('skips GET /models (405), normalizes object content, enforces >=4096 max_tokens, and fails over on 403/410', async () => {
    const cf = testCfConfig();
    const seen: Array<{ url: string; model: string; maxTokens: number }> = [];
    const client = new OpenAI({
      apiKey: cf.apiToken,
      baseURL: cf.baseUrl,
      maxRetries: 0,
      fetch: (async (url: URL, options?: { body?: string }) => {
        if (url.toString().endsWith('/models')) {
          return Response.json({ success: false, errors: [{ code: 7001, message: 'GET not supported' }] }, { status: 405 });
        }
        const body = JSON.parse(options!.body!) as { model: string; max_tokens: number };
        seen.push({ url: url.toString(), model: body.model, maxTokens: body.max_tokens });
        if (body.model === CLOUDFLARE_WRITERS[0]) {
          return Response.json({ errors: [{ code: 5028, message: 'Deprecated' }] }, { status: 410 });
        }
        if (body.model === CLOUDFLARE_WRITERS[1]) {
          return Response.json({ errors: [{ message: 'Not available on free plan' }] }, { status: 403 });
        }
        // Return an already-parsed object as @cf/qwen/qwen2.5-coder-32b-instruct does under json_object mode.
        return Response.json({
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: { ready: true, via: body.model } } }],
        });
      }) as never,
    });

    const fallback = vi.fn(async () => { throw new Error('unexpected fallback'); });
    const router = new CloudflareAiRouter(cf, fallback, undefined, undefined, client);
    const res = await router.generate(request, text => JSON.parse(text) as { ready: boolean; via: string }, 512, true, 'article');

    expect(res.model).toBe(CLOUDFLARE_WRITERS[2]);
    expect(res.value).toEqual({ ready: true, via: CLOUDFLARE_WRITERS[2] });
    expect(seen.every(call => !call.url.endsWith('/models'))).toBe(true);
    expect(seen.every(call => call.maxTokens === 4096)).toBe(true);
    expect(seen.map(call => call.model)).toEqual([CLOUDFLARE_WRITERS[0], CLOUDFLARE_WRITERS[1], CLOUDFLARE_WRITERS[2]]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('uses CLOUDFLARE_REVIEWERS for technical review stages and retries once with doubled max_tokens on INCOMPLETE_OUTPUT', async () => {
    const cf = testCfConfig();
    const seen: Array<{ model: string; maxTokens: number }> = [];
    const client = new OpenAI({
      apiKey: cf.apiToken,
      baseURL: cf.baseUrl,
      maxRetries: 0,
      fetch: (async (_url: URL, options?: { body?: string }) => {
        const body = JSON.parse(options!.body!) as { model: string; max_tokens: number };
        seen.push({ model: body.model, maxTokens: body.max_tokens });
        if (seen.length === 1) {
          return Response.json({ choices: [{ finish_reason: 'length', message: { content: '{"issues":' } }] });
        }
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"issues":[]}' } }] });
      }) as never,
    });

    const router = new CloudflareAiRouter(cf, undefined, undefined, undefined, client);
    const res = await router.generate(request, text => JSON.parse(text) as { issues: string[] }, 1024, true, 'technical review');
    expect(res.model).toBe(CLOUDFLARE_REVIEWERS[0]);
    expect(res.value).toEqual({ issues: [] });
    expect(seen).toEqual([
      { model: CLOUDFLARE_REVIEWERS[0], maxTokens: 4096 },
      { model: CLOUDFLARE_REVIEWERS[0], maxTokens: 8192 },
    ]);
  });

  it('does not retire Cloudflare key on HTTP 429 and falls back to Discovery when all Cloudflare models fail', async () => {
    const cf = testCfConfig();
    expect(isKeyExhausted(new OpenAI.RateLimitError(429, {}, 'daily neurons limit', undefined), cf.baseUrl)).toBe(false);
    expect(isKeyExhausted(new OpenAI.AuthenticationError(401, {}, 'invalid token', undefined), cf.baseUrl)).toBe(true);

    const client = new OpenAI({
      apiKey: cf.apiToken,
      baseURL: cf.baseUrl,
      maxRetries: 0,
      fetch: (async () => Response.json({ errors: [{ message: 'model unavailable' }] }, { status: 403 })) as never,
    });
    const fallbackRouter = {
      generate: vi.fn(async () => ({
        value: 'discovery-ok',
        model: 'deepseek-v4.1-flash-1017',
        attempts: [{ model: 'deepseek-v4.1-flash-1017', provider: 'discovery', attempt: 1, elapsedMs: 5, outcome: 'SUCCESS' }],
      })),
    } as unknown as AIModelRouter;
    const createFallback = vi.fn(async () => fallbackRouter);

    const router = new CloudflareAiRouter(cf, createFallback, undefined, undefined, client);
    const result = await router.generate(request, text => text, 1024, false, 'article');
    expect(result.value).toBe('discovery-ok');
    expect(createFallback).toHaveBeenCalledWith('HTTP_403');
    expect(result.attempts.some(a => a.provider === 'cloudflare' && a.httpStatus === 403)).toBe(true);
    expect(result.attempts.at(-1)).toMatchObject({ provider: 'discovery', outcome: 'SUCCESS' });

    const budgetRouter = new CloudflareAiRouter(
      cf,
      async () => ({
        generate: vi.fn(async () => {
          throw new RoutingError([{ model: 'discovery', attempt: 1, elapsedMs: 1, outcome: 'ARTICLE_TIME_BUDGET_EXCEEDED' }], 'ARTICLE_TIME_BUDGET_EXCEEDED');
        }),
      } as unknown as AIModelRouter),
      undefined,
      undefined,
      client,
    );
    await expect(budgetRouter.generate(request, t => t)).rejects.toMatchObject({ lastFailure: 'ARTICLE_TIME_BUDGET_EXCEEDED' });
  });

  it('redacts cfut_ tokens in redactSecrets and requires auth on Cloudflare admin endpoints without leaking tokens', async () => {
    const sampleToken = 'cfut_exampleSecretTokenValue1234567890';
    expect(redactSecrets(`Authorization: Bearer ${sampleToken} token=${sampleToken}`)).not.toContain(sampleToken);
    expect(redactSecrets(`token=${sampleToken}`)).toContain('cfut_[REDACTED]');

    vi.doMock('../src/database/prisma', () => ({ prisma: {} }));
    vi.doMock('../src/solutionPosts/service', () => ({ generateForRun: vi.fn(), retryPost: vi.fn(), resetFailedSolutionPostRetries: vi.fn(), PostError: class extends Error {} }));
    vi.doMock('../src/solutionPosts/store', () => ({ approvePost: vi.fn() }));
    vi.doMock('../src/solutionPosts/publisher', () => ({ publishPost: vi.fn(), reconcilePost: vi.fn() }));
    vi.doMock('../src/solutionPosts/dailyPublication', () => ({ dailyPublicationStatus: vi.fn() }));
    vi.doMock('../src/solutionPosts/scheduler', () => ({ setSelectedAccounts: vi.fn(), runCombined: vi.fn(), runScheduledSolutionPosts: vi.fn(), isScheduledSolutionRunInProgress: () => false, SCHEDULE_STATE_KEY: 's', POST_CRON: '0 6 * * *', POST_TIMEZONE: 'Asia/Kolkata' }));
    vi.doMock('../src/solutionPosts/keyPool', () => ({ appendSolutionApiKeys: vi.fn(), solutionKeyPoolStatus: vi.fn(), testSolutionApiKey: vi.fn() }));
    vi.doMock('../src/solutionPosts/firecrawlAgentProbe', () => ({ probeFirecrawlAgent: vi.fn() }));

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/ai/models/search')) {
        return Response.json({ success: true, result: [{ name: CLOUDFLARE_WRITERS[0] }] });
      }
      return Response.json({
        choices: [{ finish_reason: 'stop', message: { content: '{"ready":true}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, neurons: 1.5 },
      });
    }));

    vi.stubEnv('CLOUDFLARE_AI_API_TOKEN', TEST_CF_TOKEN);
    const { registerSolutionPostRoutes } = await import('../src/solutionPosts/routes');
    const app = Fastify();
    registerSolutionPostRoutes(app, header => header === 'Bearer admin-test');

    expect((await app.inject({ method: 'GET', url: '/admin/solutions/cloudflare' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/admin/solutions/cloudflare/test' })).statusCode).toBe(401);

    const statusRes = await app.inject({
      method: 'GET',
      url: '/admin/solutions/cloudflare',
      headers: { authorization: 'Bearer admin-test' },
    });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.body).not.toContain(TEST_CF_TOKEN);
    expect(statusRes.json()).toMatchObject({
      enabled: true,
      tokenMasked: 'cfut_…abcd',
      writer: CLOUDFLARE_WRITERS[0],
      reviewer: CLOUDFLARE_REVIEWERS[0],
    });

    const testRes = await app.inject({
      method: 'POST',
      url: '/admin/solutions/cloudflare/test',
      headers: { authorization: 'Bearer admin-test' },
      payload: {},
    });
    expect(testRes.statusCode).toBe(200);
    expect(testRes.body).not.toContain(TEST_CF_TOKEN);
    expect(testRes.json()).toMatchObject({
      ok: true,
      catalogStatus: 200,
      catalogCount: 1,
      writer: { ok: true, model: CLOUDFLARE_WRITERS[0], status: 200 },
      reviewer: { ok: true, model: CLOUDFLARE_REVIEWERS[0], status: 200 },
    });

    await app.close();
  });
});
