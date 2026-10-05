import { afterEach, describe, expect, it, vi } from 'vitest';
import { submitViaRemoteSubmitter } from '../src/codeforces/remoteSubmitter';
import { sendTelegramMessage } from '../src/notifications/telegram';
import type { SourceIndexEntry } from '../src/codeforces/sourceRepo';

vi.mock('../src/notifications/telegram', () => ({ sendTelegramMessage: vi.fn(async () => true) }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('Codeforces phone link notifications', () => {
  async function run(challenged: boolean) {
    vi.useFakeTimers();
    vi.stubEnv('CODEFORCES_SUBMITTER_URL', 'https://broker.example');
    vi.stubEnv('CODEFORCES_SUBMITTER_TOKEN', 'broker-token');
    const token = 'a'.repeat(64);
    const expiresAt = Date.now() + 240000;
    let polls = 0;
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/health')) return new Response('{}', { status: 200 });
      if (input.endsWith('/submit')) return new Response(JSON.stringify({ jobId: 'job-id' }), { status: 202 });
      expect(init?.headers).toEqual({ authorization: 'Bearer broker-token' });
      polls++;
      return new Response(JSON.stringify(polls <= 2 ? {
        pending: true, progress: challenged ? 'verification-required' : 'opening',
        ...(challenged ? { verification: { token, expiresAt } } : {}),
      } : { pending: false, result: { ok: true, clicked: true, finalUrl: 'https://codeforces.com/contest/1/my', status: 200 } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const progress = vi.fn(async () => undefined);
    const pending = submitViaRemoteSubmitter({ cookies: [], origins: [] }, '<my account>', 'handle',
      { contestId: 1, problemIndex: 'A' } as SourceIndexEntry, 'code', 'proxy', progress);
    await vi.advanceTimersByTimeAsync(10000);
    const result = await pending;
    expect(result?.ok).toBe(true);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/submit'))).toHaveLength(1);
    return { token, progress };
  }

  it('sends one private phone link for repeated pending frames, including daily runs', async () => {
    const { token, progress } = await run(true);
    expect(sendTelegramMessage).toHaveBeenCalledOnce();
    expect(vi.mocked(sendTelegramMessage).mock.calls[0]?.[0]).toContain(`https://broker.example/verify#${token}`);
    expect(vi.mocked(sendTelegramMessage).mock.calls[0]?.[0]).toContain('&lt;my account&gt;');
    expect(progress).toHaveBeenCalledWith('verification-required');
  });

  it('does not send a phone link for existing working account flows', async () => {
    await run(false);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });
});
