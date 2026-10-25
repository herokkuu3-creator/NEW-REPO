import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeOxion } from '../src/solutionPosts/oxionProbe';

afterEach(() => vi.unstubAllGlobals());
const secret = 'cc_private_probe_key_1234567890';
describe('Oxion server diagnostic', () => {
  it('uses a fixed HTTPS origin, forbids redirects, and returns only model IDs', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'qwen3.8-27b', secret }] }),
      { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await probeOxion(secret);
    expect(result).toMatchObject({ ok: true, models: ['qwen3.8-27b'], status: 200 });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(fetchMock).toHaveBeenCalledWith('https://oxionai.com/v1/models', expect.objectContaining({ redirect: 'error' }));
  });
  it('separates empty/truncated responses from valid inference and checks JSON structure', async () => {
    const output = { intuition: 'Square the input.', approach: ['Read n', 'Return n*n'], timeComplexity: 'O(1)', code: 'int square(int n) { return n*n; }' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ model: 'gpt-5.6-luna',
      choices: [{ finish_reason: 'length', message: { content: JSON.stringify(output) } }] }))));
    expect(await probeOxion(secret, 'gpt-5.6-luna', true, 512)).toMatchObject({ ok: false, validJson: true, finishReason: 'length' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }))));
    expect(await probeOxion(secret, 'gpt-5.6-luna', true, 512)).toMatchObject({ ok: true, validJson: true });
  });
  it('redacts credentials from upstream failures and hides HTML challenges', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: `Rejected ${secret}` } }), { status: 402 })));
    const result = await probeOxion(secret, 'gpt-5.6-terra');
    expect(result).toMatchObject({ status: 402, category: 'BILLING_OR_ALLOWANCE_REQUIRED' });
    expect(JSON.stringify(result)).not.toContain(secret);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`<html>${secret}</html>`, { status: 403, headers: { 'content-type': 'text/html' } })));
    const blocked = await probeOxion(secret, 'gpt-5.6-terra');
    expect(blocked).toMatchObject({ category: 'PROVIDER_HTML_ACCESS_DENIAL' });
    expect(JSON.stringify(blocked)).not.toContain(secret);
  });
});
