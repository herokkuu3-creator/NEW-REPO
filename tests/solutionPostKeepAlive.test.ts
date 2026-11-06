import { afterEach, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { startArticleWorkKeepAlive } from '../src/solutionPosts/keepAlive';

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it('keeps long article waits alive only while work owns the heartbeat', async () => {
  vi.useFakeTimers(); vi.stubEnv('RENDER_INSTANCE_ID', 'render');
  const previous = config.api.publicUrl; config.api.publicUrl = 'https://bot.example.test';
  const fetch = vi.fn(async () => ({})); vi.stubGlobal('fetch', fetch);
  const stopOne = startArticleWorkKeepAlive(); const stopTwo = startArticleWorkKeepAlive();
  try {
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(16 * 60 * 1000);
    expect(fetch).toHaveBeenCalledTimes(3);
    stopOne(); stopOne();
    await vi.advanceTimersByTimeAsync(8 * 60 * 1000);
    expect(fetch).toHaveBeenCalledTimes(4);
    stopTwo(); await vi.advanceTimersByTimeAsync(16 * 60 * 1000);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(String(fetch.mock.calls[0]![0])).toBe('https://bot.example.test/health');
  } finally { stopOne(); stopTwo(); config.api.publicUrl = previous; }
});
it('does not make requests during local article tests', () => {
  vi.stubEnv('RENDER_INSTANCE_ID', ''); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  startArticleWorkKeepAlive()(); expect(fetch).not.toHaveBeenCalled();
});
