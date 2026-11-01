import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeFirecrawl } from '../src/solutionPosts/firecrawlProbe';

const secret = `fc-${'a'.repeat(32)}`;
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('Firecrawl server diagnostic', () => {
  it('makes one bounded fixed-origin scrape and returns safe evidence of real content', async () => {
    vi.stubEnv('RENDER_INSTANCE_ID', 'test-instance'); vi.stubEnv('RENDER_GIT_COMMIT', 'test-revision');
    const mock = vi.fn(async () => new Response(JSON.stringify({ success: true,
      data: { markdown: `# Example Domain\n${secret}`, metadata: { statusCode: 200, secret } } })));
    vi.stubGlobal('fetch', mock);
    const result = await probeFirecrawl(secret);
    expect(result).toMatchObject({ ok: true, status: 200, executionHost: 'render', revision: 'test-revision',
      contentReceived: true, expectedContent: true, targetStatus: 200, category: 'SCRAPE_OK' });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith('https://api.firecrawl.dev/v2/scrape', expect.objectContaining({
      method: 'POST', redirect: 'error', signal: expect.any(AbortSignal),
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', formats: ['markdown'], onlyMainContent: true, timeout: 30000 }),
    }));
  });
  it.each([[401, 'INVALID_API_KEY'], [402, 'CREDITS_OR_BILLING_REQUIRED'],
    [403, 'PERMISSION_DENIED'], [429, 'RATE_OR_QUOTA_LIMIT'], [503, 'PROVIDER_ERROR']])(
    'classifies HTTP %i without exposing upstream credentials', async (status, category) => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(`<html>${secret}</html>`, { status: Number(status) })));
      const result = await probeFirecrawl(secret);
      expect(result).toMatchObject({ ok: false, status, category });
      expect(JSON.stringify(result)).not.toContain(secret);
    });
  it('accepts main content with the page heading removed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true,
      data: { markdown: 'This domain is for use in documentation examples without needing permission.' } }))));
    expect(await probeFirecrawl(secret)).toMatchObject({ ok: true, expectedContent: true });
  });
  it.each([{}, { success: false }, { success: true, data: { markdown: 'Blocked' } },
    { success: true, data: { markdown: 'Example Domain', metadata: { statusCode: 403 } } }, null])(
    'rejects empty, unrelated, blocked and malformed successful responses', async data => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(data))));
      expect(await probeFirecrawl(secret)).toMatchObject({ ok: false, category: 'INVALID_SCRAPE_RESULT' });
    });
  it.each(['TimeoutError', 'TypeError'])('contains %s without leaking exception messages', async name => {
    vi.stubGlobal('fetch', vi.fn(async () => { const error = new Error(secret); error.name = name; throw error; }));
    const result = await probeFirecrawl(secret);
    expect(result).toMatchObject({ ok: false, status: 0, category: name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR' });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('rejects malformed credentials before networking', async () => {
    const mock = vi.fn(); vi.stubGlobal('fetch', mock);
    await expect(probeFirecrawl('invalid')).rejects.toThrow(); expect(mock).not.toHaveBeenCalled();
  });
});
