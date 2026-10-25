import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeBazaarLink } from '../src/solutionPosts/bazaarlinkProbe';

afterEach(() => vi.unstubAllGlobals());
const secret = `sk-bl-${'a'.repeat(40)}`;

describe('BazaarLink free-model server diagnostic', () => {
  it('uses only the documented free model, disables paid fallback, and redacts the key', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('x-free-fallback')).toBe('false');
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'qwen/qwen3.7-flash:free', max_tokens: 16 });
      return new Response(JSON.stringify({ model: 'qwen/qwen3.7-flash:free', choices: [{ finish_reason: 'stop',
        message: { content: 'BAZAARLINK_RENDER_OK' } }], usage: { total_tokens: 8 } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await probeBazaarLink(secret);
    expect(result).toMatchObject({ ok: true, status: 200, requestedModel: 'qwen/qwen3.7-flash:free',
      markerMatched: true, executionHost: 'local' });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(fetchMock).toHaveBeenCalledWith('https://api.bazaarlink.ai/v1/chat/completions', expect.objectContaining({ redirect: 'error' }));
  });

  it('classifies free-quota limits and does not expose provider response secrets', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'free_quota_exceeded',
      message: `No free requests remain for ${secret}` } }), { status: 429 })));
    const result = await probeBazaarLink(secret);
    expect(result).toMatchObject({ ok: false, status: 429, category: 'FREE_QUOTA_OR_RATE_LIMIT' });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
