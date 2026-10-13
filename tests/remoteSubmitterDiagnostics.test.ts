import { afterEach, beforeAll, expect, it, vi } from 'vitest';
const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('../src/logger', () => ({ logger: logs }));
vi.mock('../src/memory', () => ({ logMemory: () => {} }));
vi.mock('../src/codeforces/proxyManager', () => ({ getRemovedProxyHashes: async () => [], resolveActiveProxy: async () => null }));
vi.mock('../src/notifications/telegram', () => ({ sendTelegramMessage: async () => true }));
vi.mock('../src/codeforces/capzyKeyManager', () => ({ getCapzyApiKeys: async () => [], getActiveCapzyKeyIndex: async () => 0, setActiveCapzyKeyIndex: async () => {} }));
vi.mock('../src/codeforces/captchaSolver', () => ({ getCPSolverUrl: () => '' }));

let submit: typeof import('../src/codeforces/remoteSubmitter').submitViaRemoteSubmitter;
beforeAll(async () => {
  vi.stubEnv('CODEFORCES_SUBMITTER_TIMEOUT_MS', '300000');
  ({ submitViaRemoteSubmitter: submit } = await import('../src/codeforces/remoteSubmitter'));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function setup() {
  vi.stubEnv('CODEFORCES_SUBMITTER_URL', 'https://submitter.example.test');
  vi.stubEnv('CODEFORCES_SUBMITTER_TOKEN', 'PRIVATE_FIXTURE_TOKEN');
  return [{ cookies: [] }, 'fixture-account', 'fixture-account', { contestId: 1, problemIndex: 'A' }, 'PRIVATE_FIXTURE_SOURCE'] as const;
}

it('records the selected request budget and correlates completion without logging credentials or source', async () => {
  const args = setup();
  const request = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/health')
    ? { busy: false } : { ok: false, kind: 'blocked', clicked: false, error: 'Controlled fixture verification required' }), { status: 200 }));
  vi.stubGlobal('fetch', request);
  await submit(...args, 'proxy', { activeProxy: null, deadline: Date.now() + 1000 });
  const start = logs.info.mock.calls.find(call => call[1] === 'isolated submitter HTTP request started')![0];
  const end = logs.info.mock.calls.find(call => call[1] === 'isolated Codeforces browser submitter finished')![0];
  expect(start.requestTimeoutMs).toBeGreaterThan(0);
  expect(start.requestTimeoutMs).toBeLessThanOrEqual(1000);
  expect(end.requestId).toBe(start.requestId);
  expect(new Headers(request.mock.calls.find(call => call[0].endsWith('/submit'))![1]?.headers).get('x-request-id')).toBe(start.requestId);
  expect(JSON.stringify(logs.info.mock.calls)).not.toContain('PRIVATE_FIXTURE');
});

it('distinguishes a connection failure from a local timer abort and does not repeat the POST', async () => {
  vi.useFakeTimers();
  const args = setup();
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/health')) return new Response(JSON.stringify({ busy: false }), { status: 200 });
    if (url.endsWith('/submit')) throw new TypeError('Controlled connection reset');
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const result = submit(...args, 'proxy', { activeProxy: null });
  await vi.advanceTimersByTimeAsync(3100);
  expect(await result).toMatchObject({ ok: false, safeToRetry: false });
  expect(fetchMock.mock.calls.filter(call => call[0].endsWith('/submit'))).toHaveLength(1);
  expect(logs.warn.mock.calls[0]![0]).toMatchObject({ locallyAborted: false, abortReason: null, errorType: 'TypeError', requestTimeoutMs: 300000 });
  expect(JSON.stringify(logs.warn.mock.calls)).not.toContain('PRIVATE_FIXTURE');
});
