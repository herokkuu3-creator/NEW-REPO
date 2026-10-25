import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeExperiential } from '../src/solutionPosts/experientialProbe';

afterEach(() => vi.unstubAllGlobals());
const secret = `xpl_${'a'.repeat(40)}`;

describe('Experiential Labs server diagnostic', () => {
  it('discovers models then performs a bounded OpenAI-compatible completion without exposing the key', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'qwen3.8-27b' }] }));
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'qwen3.8-27b', max_tokens: 24 });
      return new Response(JSON.stringify({ model: 'qwen3.8-27b', choices: [{ finish_reason: 'stop',
        message: { content: 'EXPERIENTIAL_RENDER_OK' } }], usage: { total_tokens: 9 } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await probeExperiential(secret);
    expect(result).toMatchObject({ ok: true, stage: 'chat_completion', modelsCount: 1,
      requestedModel: 'qwen3.8-27b', markerMatched: true, executionHost: 'local' });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://api.experientiallabs.ai/v1/models', expect.objectContaining({ redirect: 'error' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://api.experientiallabs.ai/v1/chat/completions', expect.objectContaining({ redirect: 'error' }));
  });

  it('reports authentication, allowance, and inaccessible model failures without returning raw bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: `Rejected ${secret}` } }), { status: 401 })));
    expect(await probeExperiential(secret)).toMatchObject({ ok: false, stage: 'model_discovery', category: 'INVALID_API_KEY' });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => String(input).endsWith('/models') ?
      new Response(JSON.stringify({ data: [{ id: 'known-model' }] })) :
      new Response(JSON.stringify({ error: { message: 'No remaining credit' } }), { status: 402 })));
    const result = await probeExperiential(secret, 'known-model');
    expect(result).toMatchObject({ ok: false, stage: 'chat_completion', category: 'BILLING_OR_ALLOWANCE_REQUIRED' });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('does not request completion for a model missing from the key catalog', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'known-model' }] })));
    vi.stubGlobal('fetch', fetchMock);
    expect(await probeExperiential(secret, 'unavailable')).toMatchObject({ ok: false, category: 'MODEL_NOT_AVAILABLE_TO_KEY' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
