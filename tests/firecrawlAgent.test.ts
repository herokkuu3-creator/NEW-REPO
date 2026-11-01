import { describe, expect, it, vi } from 'vitest';
import { FirecrawlAgentRouter } from '../src/solutionPosts/firecrawlAgent';
import { RoutingError } from '../src/solutionPosts/router';

const id = '01a19663-cea3-727e-b140-6a404dada528';
const secret = 'fc-test-private-key-1234567890';
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
describe('Firecrawl Agent router', () => {
  it('starts one capped job, polls it, and returns validated output with usage', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ success: true, id }))
      .mockResolvedValueOnce(response({ success: true, status: 'processing' }))
      .mockResolvedValueOnce(response({ success: true, status: 'completed', data: { content: 'Hello' }, creditsUsed: 7 }));
    const attempts: unknown[] = [];
    const router = new FirecrawlAgentRouter(secret, 50, a => attempts.push(a), fetcher, async () => {});
    const result = await router.generate([{ role: 'user', content: 'Say hello' }], text => text);
    expect(result.value).toBe('Hello'); expect(result.model).toBe('firecrawl/spark-2');
    expect(result.attempts[0]).toMatchObject({ outcome: 'SUCCESS', agentCreditsUsed: 7 });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.firecrawl.dev/v2/agent');
    expect(JSON.parse(options.body)).toMatchObject({ maxCredits: 50, strictConstrainToURLs: true });
    expect(JSON.stringify(attempts)).not.toContain(secret);
  });
  it('does not send an overlong prompt or retry a provider rejection', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ error: secret }, 429));
    const router = new FirecrawlAgentRouter(secret, 100, () => {}, fetcher, async () => {});
    await expect(router.generate([{ role: 'user', content: 'x'.repeat(10001) }], x => x)).rejects.toMatchObject({ lastFailure: 'FIRECRAWL_PROMPT_TOO_LONG' });
    expect(fetcher).not.toHaveBeenCalled();
    let error: unknown;
    try { await router.generate([{ role: 'user', content: 'hello' }], x => x); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(RoutingError);
    expect((error as RoutingError).lastFailure).toBe('HTTP_429');
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('cancels its own unfinished job after a timeout', async () => {
    let clock = 0;
    const fetcher = vi.fn().mockResolvedValueOnce(response({ success: true, id }))
      .mockResolvedValueOnce(response({ success: true, status: 'processing' }))
      .mockResolvedValueOnce(response({ success: true }));
    const router = new FirecrawlAgentRouter(secret, 20, () => {}, fetcher, async () => { clock += 4; }, () => clock, 3);
    await expect(router.generate([{ role: 'user', content: 'hello' }], x => x)).rejects.toMatchObject({ lastFailure: 'FIRECRAWL_TIMEOUT' });
    expect(fetcher.mock.calls[2]![1]).toMatchObject({ method: 'DELETE' });
  });
});
