import { afterEach, describe, expect, it, vi } from 'vitest';
import { FirecrawlAgentRouter } from '../src/solutionPosts/firecrawlAgent';
import { RoutingError } from '../src/solutionPosts/router';
import { FirecrawlRateGate } from '../src/solutionPosts/firecrawlRateGate';

const id = '01a19663-cea3-727e-b140-6a404dada528';
const secret = 'fc-test-private-key-1234567890';
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const timing = () => {
  let clock = 0;
  const now = () => clock;
  const sleep = async (ms: number) => { clock += ms; };
  return { now, sleep, gate: new FirecrawlRateGate(0, now, sleep) };
};
afterEach(() => vi.useRealTimers());
describe('Firecrawl Agent router', () => {
  it('shares Agent pacing across independently constructed account routers', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const gate = new FirecrawlRateGate();
    const starts: number[] = [];
    const fetcher = vi.fn(async (_url: any, init: any) => {
      if (init.method === 'POST') { starts.push(Date.now()); return response({ success: true, id }); }
      return response({ success: true, status: 'completed', data: { content: 'OK' } });
    });
    const make = () => new FirecrawlAgentRouter(secret, 20, () => {}, fetcher, undefined, undefined, undefined, gate);
    const jobs = [make(), make(), make()].map(r => r.generate([{ role: 'user', content: 'hello' }], x => x));
    await vi.advanceTimersByTimeAsync(65000);
    await Promise.all(jobs);
    expect(starts).toEqual([1000, 32000, 63000]);
  });
  it('retains safe rate-limit evidence and honors the response-body delay', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ success: false, error: 'Rate limit exceeded. Consumed (req/min): 3, Remaining (req/min): 0 ' + secret,
      retry_after_seconds: 42 }, 429)).mockResolvedValueOnce(response({ success: true, id }))
      .mockResolvedValueOnce(response({ success: true, status: 'completed', data: { content: 'OK' } }));
    const t = timing();
    const router = new FirecrawlAgentRouter(secret, 20, () => {}, fetcher, t.sleep, t.now, 180000, t.gate);
    const result = await router.generate([{ role: 'user', content: 'hello' }], x => x);
    expect(result.attempts[0]).toMatchObject({ providerLimit: 'requests_per_minute', retryAfterMs: 43000, outcome: 'SUCCESS' });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(t.now()).toBeGreaterThanOrEqual(43000);
  });
  it('starts one capped job, polls it, and returns validated output with usage', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ success: true, id }))
      .mockResolvedValueOnce(response({ success: true, status: 'processing' }))
      .mockResolvedValueOnce(response({ success: true, status: 'completed', data: { content: 'Hello' }, creditsUsed: 7 }));
    const attempts: unknown[] = [];
    const t = timing();
    const router = new FirecrawlAgentRouter(secret, 50, a => attempts.push(a), fetcher, t.sleep, t.now, 180000, t.gate);
    const result = await router.generate([{ role: 'user', content: 'Say hello' }], text => text);
    expect(result.value).toBe('Hello'); expect(result.model).toBe('firecrawl/spark-2');
    expect(result.attempts[0]).toMatchObject({ outcome: 'SUCCESS', agentCreditsUsed: 7 });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.firecrawl.dev/v2/agent');
    expect(JSON.parse(options.body)).toMatchObject({ maxCredits: 50, strictConstrainToURLs: true });
    expect(JSON.stringify(attempts)).not.toContain(secret);
  });
  it('does not send an overlong prompt and bounds rate-limit retries', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ error: secret }, 429));
    const t = timing();
    const router = new FirecrawlAgentRouter(secret, 100, () => {}, fetcher, t.sleep, t.now, 180000, t.gate);
    await expect(router.generate([{ role: 'user', content: 'x'.repeat(10001) }], x => x)).rejects.toMatchObject({ lastFailure: 'FIRECRAWL_PROMPT_TOO_LONG' });
    expect(fetcher).not.toHaveBeenCalled();
    let error: unknown;
    try { await router.generate([{ role: 'user', content: 'hello' }], x => x); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(RoutingError);
    expect((error as RoutingError).lastFailure).toBe('HTTP_429');
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('waits on a rate-limited poll and resumes the same job', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ success: true, id }))
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(response({ success: true, status: 'completed', data: { content: 'done' } }));
    const t = timing();
    const sleep = vi.fn(t.sleep);
    const router = new FirecrawlAgentRouter(secret, 20, () => {}, fetcher, sleep, t.now, 180000, t.gate);
    expect((await router.generate([{ role: 'user', content: 'hello' }], x => x)).value).toBe('done');
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(fetcher.mock.calls.filter(c => c[1]?.method === 'POST')).toHaveLength(1);
    expect(fetcher.mock.calls[1]![0]).toBe(fetcher.mock.calls[2]![0]);
  });
  it('cancels its own unfinished job after a timeout', async () => {
    let clock = 0;
    const fetcher = vi.fn().mockResolvedValueOnce(response({ success: true, id }))
      .mockResolvedValueOnce(response({ success: true, status: 'processing' }))
      .mockResolvedValueOnce(response({ success: true }));
    const router = new FirecrawlAgentRouter(secret, 20, () => {}, fetcher, async () => { clock += 4; }, () => clock, 3,
      new FirecrawlRateGate(0, () => clock, async ms => { clock += ms; }));
    await expect(router.generate([{ role: 'user', content: 'hello' }], x => x)).rejects.toMatchObject({ lastFailure: 'FIRECRAWL_TIMEOUT' });
    expect(fetcher.mock.calls[2]![1]).toMatchObject({ method: 'DELETE' });
  });
});
