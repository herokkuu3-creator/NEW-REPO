import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ value: null as string | null }));
vi.mock('../src/config', () => ({ config: { api: { setupToken: 'test-setup-token' },
  solutionPosts: { apiKeys: ['env_primary_0001', 'env_backup_0002'], baseUrl: 'https://codecraftapi.com/v1', models: ['gpt-5.6-terra'] } } }));
vi.mock('../src/database/models', () => ({
  getSystemState: vi.fn(async () => db.value),
  setSystemState: vi.fn(async (_key: string, value: string) => { db.value = value; }),
}));

import { appendSolutionApiKeys, loadSolutionKeyPool, maskSolutionApiKey, parseSolutionApiKeys,
  replaceSolutionApiKeys, resetSolutionApiKeyPool, rotateSolutionApiKey, solutionKeyPoolStatus, solutionKeyPeriod, testSolutionApiKey } from '../src/solutionPosts/keyPool';
import { config } from '../src/config';

describe('solution article API key pool', () => {
  beforeEach(() => {
    db.value = null; vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));
    Object.assign(config.solutionPosts, { apiKeys: ['env_primary_0001', 'env_backup_0002'],
      baseUrl: 'https://codecraftapi.com/v1', models: ['gpt-5.6-terra'], keyError: undefined });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('accepts comma-separated additions, keeps insertion order, and never persists plaintext', async () => {
    expect(parseSolutionApiKeys(' key_one_0001, key_two_0002, key_one_0001 ')).toEqual(['key_one_0001', 'key_two_0002']);
    const result = await appendSolutionApiKeys('key_three_0003,key_four_0004,key_three_0003');
    expect(result.added).toBe(2); expect(result.duplicates).toBe(0);
    expect(db.value).toMatch(/^v1:/); expect(db.value).not.toContain('key_three_0003');
    const saved = await loadSolutionKeyPool();
    expect(saved.keys).toEqual(['env_primary_0001', 'env_backup_0002', 'key_three_0003', 'key_four_0004']);
    expect(maskSolutionApiKey(saved.keys[2]!)).not.toContain('three');
  });

  it('advances only to the next configured key and reports masked positions', async () => {
    await appendSolutionApiKeys('key_three_0003');
    const rotated = await rotateSolutionApiKey('env_primary_0001');
    expect(rotated.activeIndex).toBe(1);
    expect((await rotateSolutionApiKey('not-in-pool')).activeIndex).toBe(1);
    const status = await solutionKeyPoolStatus();
    expect(status).toMatchObject({ total: 3, active: 2, source: 'database' });
    expect(status.keys[1]).toMatchObject({ position: 2, active: true });
    expect(JSON.stringify(status)).not.toContain('env_backup_0002');
  });
  it('replaces a stale pool and explicitly restores key one as active', async () => {
    await appendSolutionApiKeys('key_three_0003');
    await rotateSolutionApiKey('env_primary_0001');
    const pool = await replaceSolutionApiKeys('fresh_key_0001,fresh_key_0002');
    expect(pool.keys).toEqual(['fresh_key_0001', 'fresh_key_0002']);
    expect(pool.activeIndex).toBe(0);
    expect((await solutionKeyPoolStatus()).active).toBe(1);
  });

  it('resets the active pointer to key one on the existing pool', async () => {
    await appendSolutionApiKeys('key_three_0003');
    await rotateSolutionApiKey('env_primary_0001');
    expect((await solutionKeyPoolStatus()).active).toBe(2);
    const pool = await resetSolutionApiKeyPool();
    expect(pool.activeIndex).toBe(0);
    expect((await solutionKeyPoolStatus()).active).toBe(1);
  });

  it('keeps an exhausted key skipped within its month and restores key one in the next month', async () => {
    await appendSolutionApiKeys('key_three_0003');
    expect((await rotateSolutionApiKey('env_primary_0001')).activeIndex).toBe(1);
    const thisMonth = solutionKeyPeriod(new Date('2026-10-16T00:00:00Z'));
    expect((await loadSolutionKeyPool(new Date('2026-10-16T00:00:00Z'))).activePeriod).toBe(thisMonth);
    const next = await loadSolutionKeyPool(new Date('2026-11-01T00:00:00Z'));
    expect(next.activeIndex).toBe(0);
    expect(next.activePeriod).toBe(solutionKeyPeriod(new Date('2026-11-01T00:00:00Z')));
  });

  it('handles testing an API key gracefully when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network failure')));
    const res = await testSolutionApiKey('invalid_mock_key');
    expect(res.keyMasked).toContain('…');
    expect(res).toMatchObject({ ok: false, failureCategory: 'PROVIDER_NETWORK_ERROR' });
  });
  it('tests inference even when model listing is forbidden and rejects empty completions', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })));
    vi.stubGlobal('fetch', fetcher);
    expect(await testSolutionApiKey('private_key_0001')).toMatchObject({ ok: true, modelsStatus: 403, chatStatus: 200, chatModel: 'gpt-5.6-terra' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetcher.mock.calls[1]![1].body).max_tokens).toBe(64);
  });
  it('distinguishes billing failure from an access block and redacts provider-echoed secrets', async () => {
    const key = 'cc_private_key_0001';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{"data":[]}'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Billing failed ' + key, code: 'insufficient_quota' } }), { status: 402 })));
    const result = await testSolutionApiKey(key, 'gpt-5.6-luna');
    expect(result).toMatchObject({ ok: false, failureCategory: 'PROVIDER_BILLING_REQUIRED', modelsStatus: 200, chatStatus: 402 });
    expect(JSON.stringify(result)).not.toContain(key);
    expect((await testSolutionApiKey(key, 'gpt-6-sol')).error).toBe('MODEL_NOT_ALLOWED');
  });
  it('retains the quota failure reason across restarts', async () => {
    await rotateSolutionApiKey('env_primary_0001', 'HTTP_402_BILLING_REQUIRED');
    expect((await solutionKeyPoolStatus()).lastFailure).toBe('HTTP_402_BILLING_REQUIRED');
    await resetSolutionApiKeyPool();
    expect((await solutionKeyPoolStatus()).lastFailure).toBeUndefined();
  });
  it('classifies the Render-side HTML challenge and captures the provider request ID without logging HTML', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('challenge', { status: 403 }))
      .mockResolvedValueOnce(new Response('<html><title>Just a moment...</title></html>', {
        status: 403, headers: { 'content-type': 'text/html', 'cf-ray': 'example-FRA' },
      })));
    const result = await testSolutionApiKey('cc_private_key_0001', 'gpt-5.6-terra');
    expect(result).toMatchObject({ failureCategory: 'PROVIDER_ACCESS_BLOCKED', providerRequestId: 'example-FRA' });
    expect(JSON.stringify(result)).not.toContain('<html>');
  });
  it('carries saved BazaarLink keys across the default switch and excludes CodeCraft credentials', async () => {
    await appendSolutionApiKeys('cc_old_provider_key,sk-bl-saved_provider_key');
    Object.assign(config.solutionPosts, { baseUrl: 'https://api.bazaarlink.ai/v1',
      apiKeys: ['opaque_environment_key', 'sk-bl-environment_key'] });
    const migrated = await loadSolutionKeyPool();
    expect(migrated.keys).toEqual(['opaque_environment_key', 'sk-bl-environment_key', 'sk-bl-saved_provider_key']);
    expect(migrated.activeIndex).toBe(0);
    await rotateSolutionApiKey('opaque_environment_key', 'HTTP_401');
    expect((await loadSolutionKeyPool()).activeIndex).toBe(1);
    expect(migrated.keys).not.toContain('cc_old_provider_key');
  });
  it('accepts an explicitly supplied opaque key and lets the provider report authentication failure', async () => {
    Object.assign(config.solutionPosts, { baseUrl: 'https://api.bazaarlink.ai/v1',
      apiKeys: [], models: ['qwen/qwen3.7-flash:free'] });
    await replaceSolutionApiKeys('SOLUTION_POST_API_KEYS="opaque_provider_key"');
    expect((await loadSolutionKeyPool()).keys).toEqual(['opaque_provider_key']);
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{"data":[]}'))
      .mockResolvedValueOnce(new Response('{"error":{"message":"invalid key"}}', { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    expect(await testSolutionApiKey()).toMatchObject({ chatStatus: 401, failureCategory: 'INVALID_API_KEY' });
    expect(fetcher.mock.calls[1]![1].headers.Authorization).toBe('Bearer opaque_provider_key');
  });
  it('recovers an empty saved pool from environment keys previously excluded by prefix filtering', async () => {
    Object.assign(config.solutionPosts, { baseUrl: 'https://api.bazaarlink.ai/v1', apiKeys: [] });
    // Create an empty provider-bound record by switching from the old provider.
    Object.assign(config.solutionPosts, { baseUrl: 'https://codecraftapi.com/v1' });
    await replaceSolutionApiKeys('old_provider_key');
    Object.assign(config.solutionPosts, { baseUrl: 'https://api.bazaarlink.ai/v1' });
    expect((await loadSolutionKeyPool()).keys).toEqual([]);
    Object.assign(config.solutionPosts, { apiKeys: ['opaque_recovered_key'] });
    expect((await loadSolutionKeyPool()).keys).toEqual(['opaque_recovered_key']);
    await rotateSolutionApiKey('opaque_recovered_key', 'HTTP_401');
    expect((await loadSolutionKeyPool()).activeIndex).toBe(1);
  });
  it('allows a bot-saved replacement to repair an invalid environment input', async () => {
    Object.assign(config.solutionPosts, { baseUrl: 'https://api.bazaarlink.ai/v1', apiKeys: [],
      models: ['qwen/qwen3.7-flash:free'], keyError: 'AI_KEY_INPUT_INVALID' });
    expect(await testSolutionApiKey()).toMatchObject({ error: 'AI_KEY_INPUT_INVALID' });
    await replaceSolutionApiKeys('opaque_bot_replacement');
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{"data":[]}'))
      .mockResolvedValueOnce(new Response('{"choices":[{"message":{"content":"OK"}}]}'));
    vi.stubGlobal('fetch', fetcher);
    expect(await testSolutionApiKey()).toMatchObject({ ok: true, chatStatus: 200 });
  });
  it('restores the BazaarLink slot wrongly retired for 429 without reviving an earlier invalid credential', async () => {
    Object.assign(config.solutionPosts, { baseUrl: 'https://api.bazaarlink.ai/v1', apiKeys: [] });
    await replaceSolutionApiKeys('invalid_key_0001,sk-bl-valid_key_0002');
    await rotateSolutionApiKey('invalid_key_0001', 'HTTP_401');
    await rotateSolutionApiKey('sk-bl-valid_key_0002', 'KEY_EXHAUSTED');
    expect(await loadSolutionKeyPool()).toMatchObject({ activeIndex: 1, lastFailure: undefined });
    expect((await loadSolutionKeyPool()).activeIndex).toBe(1);
  });
  it('tests the selected BazaarLink model and key pool without enabling paid fallback', async () => {
    Object.assign(config.solutionPosts, { baseUrl: 'https://api.bazaarlink.ai/v1', models: ['qwen/qwen3.7-flash:free'] });
    await replaceSolutionApiKeys('sk-bl-bazaar_test_key');
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{"data":[]}'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })));
    vi.stubGlobal('fetch', fetcher);
    expect(await testSolutionApiKey()).toMatchObject({ ok: true, chatModel: 'qwen/qwen3.7-flash:free' });
    expect(fetcher.mock.calls[1]![0]).toBe('https://api.bazaarlink.ai/v1/chat/completions');
    expect(fetcher.mock.calls[1]![1].headers).toMatchObject({
      Authorization: 'Bearer sk-bl-bazaar_test_key', 'X-Free-Fallback': 'false',
    });
    expect(JSON.parse(fetcher.mock.calls[1]![1].body).model).toBe('qwen/qwen3.7-flash:free');
  });
});
