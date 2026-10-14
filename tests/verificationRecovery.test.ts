import { afterEach, expect, it, vi } from 'vitest';
import { solveTurnstileOrchestrated, solveTurnstileWithCPSolver } from '../src/codeforces/captchaSolver';

vi.mock('../src/codeforces/capzyKeyManager', () => ({
  getCandidateCapzyKeys: vi.fn(async () => []),
  rotateToNextCapzyKey: vi.fn(), isCapzyKeyError: vi.fn(), maskApiKey: vi.fn(),
}));

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function setup(status: number, body: string) {
  vi.stubEnv('CPSOLVER_URL', 'https://fixture.invalid');
  vi.stubEnv('CPSOLVER_MAX_TRIES', '3');
  vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
  vi.stubEnv('TELEGRAM_CHAT_ID', '');
  vi.stubEnv('DATABASE_URL', '');
  const request = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal('fetch', request);
  return request;
}

it('falls through from CPSolver 408 to Capzy commercial solver without repeating CPSolver attempts', async () => {
  const request = setup(408, JSON.stringify({ ok: false,
    error: 'Turnstile challenge timed out after 60000ms without token', modeUsed: 'harness' }));
  expect(await solveTurnstileOrchestrated({ siteurl: 'https://fixture.invalid/form', sitekey: 'fixture' })).toBeNull();
  expect(request).toHaveBeenCalledOnce();
});

it('falls through from CPSolver 408 and solves successfully via Capzy when keys configured', async () => {
  const { getCandidateCapzyKeys } = await import('../src/codeforces/capzyKeyManager');
  vi.mocked(getCandidateCapzyKeys).mockResolvedValueOnce(['test-capzy-key']);

  vi.stubEnv('CPSOLVER_URL', 'https://fixture.invalid');
  vi.stubEnv('CPSOLVER_MAX_TRIES', '3');
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const urlStr = String(url);
    if (urlStr.includes('fixture.invalid')) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'Turnstile challenge timed out after 60000ms without token',
        modeUsed: 'harness',
      }), { status: 408 });
    }
    if (urlStr.includes('createTask')) {
      return new Response(JSON.stringify({ errorId: 0, taskId: 'capzy-task-1' }), { status: 200 });
    }
    if (urlStr.includes('getTaskResult')) {
      return new Response(JSON.stringify({
        errorId: 0,
        status: 'ready',
        solution: { token: 'capzy-solved-token-xyz' },
      }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }));

  const res = await solveTurnstileOrchestrated({ siteurl: 'https://fixture.invalid/form', sitekey: 'fixture' });
  expect(res?.token).toBe('capzy-solved-token-xyz');
  expect(res?.source).toBe('capsolver');
});

it.each([
  [408, 'upstream request timeout'],
  [408, JSON.stringify({ ok: false, error: 'Task aborted while waiting in concurrency queue' })],
  [500, JSON.stringify({ ok: false, error: 'Turnstile challenge timed out after 60000ms without token' })],
])('does not misclassify transport or queue failures (%s)', async (status, body) => {
  setup(status as number, body as string);
  const result = await solveTurnstileWithCPSolver({ siteurl: 'https://fixture.invalid/form', sitekey: 'fixture' });
  expect(result.ok).toBe(false);
  expect(result.verificationRequired).toBe(false);
});
