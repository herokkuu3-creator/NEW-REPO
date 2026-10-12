import { afterEach, expect, it, vi } from 'vitest';
import { AttemptCancelledError, attemptFetch, attemptSleep, withAttemptContext } from '../src/codeforces/attemptContext';
import { diagnosticLog, logRingBuffer } from '../src/codeforces/diagnosticLog';
import { solveTurnstileOrchestrated } from '../src/codeforces/captchaSolver';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); logRingBuffer.length = 0; });

function solverEnv() {
  vi.stubEnv('CPSOLVER_URL', 'https://solver.example.test');
  vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
  vi.stubEnv('TELEGRAM_CHAT_ID', '');
  vi.stubEnv('DATABASE_URL', '');
}

it('deadline aborts an outstanding request without retries or commercial fallback', async () => {
  solverEnv();
  const fetchMock = vi.fn((_url: unknown, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = options.signal!;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  vi.stubGlobal('fetch', fetchMock);
  await expect(withAttemptContext('deadline-fixture', Date.now() + 60, () => solveTurnstileOrchestrated({
    siteurl: 'http://localhost/owned-fixture', sitekey: 'fixture-key', timeoutMs: 60_000,
  }))).rejects.toThrow('deadline reached');
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0]![1].signal?.aborted).toBe(true);
  expect(fetchMock.mock.calls[0]![1].headers).toMatchObject({ 'x-request-id': 'deadline-fixture' });
  expect(logRingBuffer.some(e => e.msg.includes('Falling back'))).toBe(false);
});

it('deadline interrupts the two-second retry delay', async () => {
  solverEnv();
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'Controlled timeout' }), { status: 408 }));
  vi.stubGlobal('fetch', fetchMock);
  await expect(withAttemptContext('retry-fixture', Date.now() + 60, () => solveTurnstileOrchestrated({
    siteurl: 'http://localhost/owned-fixture', sitekey: 'fixture-key',
  }))).rejects.toThrow('deadline reached');
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(logRingBuffer.find(e => e.msg === 'CPSolver attempt failed')?.requestId).toBe('retry-fixture');
});

it('disconnect aborts nested work immediately and pre-aborted attempts do not start', async () => {
  const controller = new AbortController();
  const work = withAttemptContext('disconnect-fixture', Date.now() + 10_000, () => attemptSleep(60_000), controller.signal);
  const rejected = expect(work).rejects.toThrow('client disconnected');
  controller.abort(new AttemptCancelledError('disconnect'));
  await rejected;
  const task = vi.fn(async () => undefined);
  await expect(withAttemptContext('already-cancelled', Date.now() + 10_000, task, controller.signal)).rejects.toThrow('client disconnected');
  expect(task).not.toHaveBeenCalled();
});

it('unscoped fetch retains its own signal and completed attempts do not leak context', async () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  const signal = new AbortController().signal;
  await attemptFetch('http://localhost/owned-fixture', { signal });
  expect(fetchMock.mock.calls[0]![1]?.signal).toBe(signal);
  await withAttemptContext('finished-fixture', Date.now() + 10_000, async () => diagnosticLog('browser-form', 30, {}, 'inside'));
  diagnosticLog('browser-form', 30, {}, 'outside');
  expect(logRingBuffer.at(-2)?.requestId).toBe('finished-fixture');
  expect(logRingBuffer.at(-1)?.requestId).toBeUndefined();
});

it('shared diagnostics include helper events without exposing credential fields', async () => {
  await withAttemptContext('log-fixture', Date.now() + 10_000, async () => {
    diagnosticLog('captcha-solver', 40, {
      token: 'PRIVATE_TOKEN', cookies: { session: 'PRIVATE_COOKIE' },
      proxyUrl: 'http://user:PRIVATE_PASSWORD@example.test:3129',
      url: 'https://example.test/form?session=PRIVATE_QUERY',
    }, 'controlled failure');
  });
  expect(logRingBuffer.at(-1)?.requestId).toBe('log-fixture');
  expect(JSON.stringify(logRingBuffer)).not.toMatch(/PRIVATE_/);
});
