import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ schedule: vi.fn(async ids => ({ accountIds: ids, timezone: 'Asia/Kolkata' })),
  scheduled: vi.fn(async () => ({ status: 'IDLE' })), reset: vi.fn(async () => 1) }));
const keys = vi.hoisted(() => ({
  append: vi.fn(async () => ({ added: 2, duplicates: 1 })),
  test: vi.fn(async () => ({ ok: false, executionHost: 'render', chatStatus: 402, failureCategory: 'PROVIDER_BILLING_REQUIRED' })),
  status: vi.fn(async () => ({ total: 3, active: 2, source: 'database', keys: [
    { position: 1, masked: 'cc_old…0001', active: false }, { position: 2, masked: 'cc_new…0002', active: true },
    { position: 3, masked: 'cc_last…0003', active: false },
  ] })),
}));
vi.mock('../src/database/prisma', () => ({ prisma: { solutionPost: { findMany: vi.fn(async () => []) },
  solutionPostPreference: { findMany: vi.fn(async () => [{ accountId: 'a', enabled: true }]) },
  systemState: { findUnique: vi.fn(async () => ({ value: '{"status":"FINISHED"}' })) },
} }));
vi.mock('../src/solutionPosts/service', () => ({ generateForRun: vi.fn(), retryPost: vi.fn(), resetFailedSolutionPostRetries: h.reset, PostError: class extends Error {} }));
vi.mock('../src/solutionPosts/store', () => ({ approvePost: vi.fn() }));
vi.mock('../src/solutionPosts/publisher', () => ({ publishPost: vi.fn(), reconcilePost: vi.fn() }));
vi.mock('../src/solutionPosts/scheduler', () => ({ setSelectedAccounts: h.schedule, runCombined: vi.fn(),
  runScheduledSolutionPosts: h.scheduled, isScheduledSolutionRunInProgress: () => false,
  SCHEDULE_STATE_KEY: 'solution-post-scheduler:last-tick', POST_CRON: '0 6 * * *', POST_TIMEZONE: 'Asia/Kolkata' }));
vi.mock('../src/solutionPosts/keyPool', () => ({ appendSolutionApiKeys: keys.append, solutionKeyPoolStatus: keys.status, testSolutionApiKey: keys.test }));
import { registerSolutionPostRoutes } from '../src/solutionPosts/routes';
describe('solution admin routes', () => {
  it('requires the existing admin bearer token for reads and mutations', async () => {
    const app = Fastify(); registerSolutionPostRoutes(app, h => h === 'Bearer admin-test');
    for (const [method, url] of [['GET', '/admin/solutions'], ['PUT', '/admin/solutions/schedule'], ['POST', '/admin/solutions/generate'],
      ['POST', '/admin/solutions/scheduled'], ['GET', '/admin/solutions/diagnostics'], ['POST', '/admin/solutions/api-keys/test'],
      ['POST', '/admin/solutions/openrouter/free-test'], ['POST', '/admin/solutions/oxion/test'],
      ['POST', '/admin/solutions/experiential/test'], ['POST', '/admin/solutions/bazaarlink/free-test']]) {
      const response = await app.inject({ method: method as any, url }); expect(response.statusCode).toBe(401);
    }
    const history = await app.inject({ method: 'GET', url: '/admin/solutions', headers: { authorization: 'Bearer admin-test' } });
    expect(history.statusCode).toBe(200); expect(history.headers['cache-control']).toBe('no-store');
    await app.close();
  });
  it('validates explicit selections and rejects extra publishing flags', async () => {
    const app = Fastify(); registerSolutionPostRoutes(app, h => h === 'Bearer admin-test');
    const request = (payload: object) => app.inject({ method: 'PUT', url: '/admin/solutions/schedule',
      headers: { authorization: 'Bearer admin-test' }, payload });
    expect((await request({ accountIds: ['a'], publishAutomatically: true })).statusCode).toBe(400);
    expect((await request({ accountIds: ['a'] })).statusCode).toBe(200);
    expect(h.schedule).toHaveBeenCalledWith(['a']); await app.close();
  });
  it('adds article API keys without returning plaintext secrets', async () => {
    const app = Fastify(); registerSolutionPostRoutes(app, h => h === 'Bearer admin-test');
    const headers = { authorization: 'Bearer admin-test' };
    expect((await app.inject({ method: 'POST', url: '/admin/solutions/api-keys', headers,
      payload: { apiKeys: 'cc_secret_one,cc_secret_two' } })).statusCode).toBe(200);
    expect(keys.append).toHaveBeenCalledWith('cc_secret_one,cc_secret_two');
    expect(h.reset).toHaveBeenCalled();
    const status = await app.inject({ method: 'GET', url: '/admin/solutions/api-keys', headers });
    expect(status.statusCode).toBe(200); expect(status.body).toContain('cc_old…0001');
    expect(status.body).not.toContain('cc_secret_one');
    expect((await app.inject({ method: 'POST', url: '/admin/solutions/api-keys', headers,
      payload: { apiKeys: '', extra: true } })).statusCode).toBe(400);
    await app.close();
  });
  it('runs a server-side probe only for approved models and exposes durable schedule diagnostics', async () => {
    const app = Fastify(); registerSolutionPostRoutes(app, h => h === 'Bearer admin-test');
    const headers = { authorization: 'Bearer admin-test' };
    const result = await app.inject({ method: 'POST', url: '/admin/solutions/api-keys/test', headers,
      payload: { apiKey: 'cc_probe_key', model: 'gpt-5.6-luna' } });
    expect(result.json()).toMatchObject({ executionHost: 'render', chatStatus: 402 });
    expect(keys.test).toHaveBeenCalledWith('cc_probe_key', 'gpt-5.6-luna');
    expect((await app.inject({ method: 'POST', url: '/admin/solutions/api-keys/test', headers,
      payload: { model: 'gpt-6-sol' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/admin/solutions/diagnostics', headers })).json()).toMatchObject({ timezone: 'Asia/Kolkata', selected: [{ accountId: 'a' }] });
    expect((await app.inject({ method: 'POST', url: '/admin/solutions/scheduled', headers })).statusCode).toBe(202);
    expect(h.scheduled).toHaveBeenCalled();
    await app.close();
  });
  it('validates Oxion probe requests before making provider calls', async () => {
    const app = Fastify(); registerSolutionPostRoutes(app, h => h === 'Bearer admin-test');
    for (const payload of [{ apiKey: 'short' }, { apiKey: 'cc_valid_key_1234567890', baseUrl: 'https://example.com' },
      { apiKey: 'cc_valid_key_1234567890', model: '../models' }, { apiKey: 'cc_valid_key_1234567890', maxTokens: 9999 }]) {
      expect((await app.inject({ method: 'POST', url: '/admin/solutions/oxion/test',
        headers: { authorization: 'Bearer admin-test' }, payload })).statusCode).toBe(400);
    }
    await app.close();
  });
  it('validates Experiential probe credentials and disallows caller-controlled origins', async () => {
    const app = Fastify(); registerSolutionPostRoutes(app, h => h === 'Bearer admin-test');
    for (const payload of [{ apiKey: 'short' }, { apiKey: `xpl_${'a'.repeat(40)}`, baseUrl: 'https://example.com' },
      { apiKey: `xpl_${'a'.repeat(40)}`, model: '../models' }]) {
      expect((await app.inject({ method: 'POST', url: '/admin/solutions/experiential/test',
        headers: { authorization: 'Bearer admin-test' }, payload })).statusCode).toBe(400);
    }
    await app.close();
  });
  it('validates BazaarLink probe credentials and disallows caller-controlled origins', async () => {
    const app = Fastify(); registerSolutionPostRoutes(app, h => h === 'Bearer admin-test');
    for (const payload of [{ apiKey: 'short' }, { apiKey: `sk-bl-${'a'.repeat(40)}`, baseUrl: 'https://example.com' }]) {
      expect((await app.inject({ method: 'POST', url: '/admin/solutions/bazaarlink/free-test',
        headers: { authorization: 'Bearer admin-test' }, payload })).statusCode).toBe(400);
    }
    await app.close();
  });
  it('probes one fixed OpenRouter free model and never returns the supplied key', async () => {
    const apiKey = `sk-or-v1-${'a'.repeat(64)}`;
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      model: 'nvidia/nemotron-3-ultra-550b-a55b:free', provider: 'Nvidia',
      choices: [{ finish_reason: 'stop', message: { content: 'OPENROUTER_RENDER_OK' } }], usage: { cost: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const app = Fastify(); registerSolutionPostRoutes(app, h => h === 'Bearer admin-test');
    const response = await app.inject({ method: 'POST', url: '/admin/solutions/openrouter/free-test',
      headers: { authorization: 'Bearer admin-test' }, payload: { apiKey } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, requestedModel: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      servedModel: 'nvidia/nemotron-3-ultra-550b-a55b:free', reportedCostUsd: 0, executionHost: 'local' });
    expect(response.body).not.toContain(apiKey);
    expect(fetchMock).toHaveBeenCalledWith('https://openrouter.ai/api/v1/chat/completions', expect.objectContaining({
      method: 'POST', body: expect.stringContaining('nvidia/nemotron-3-ultra-550b-a55b:free'),
    }));
    vi.unstubAllGlobals(); await app.close();
  });
});
