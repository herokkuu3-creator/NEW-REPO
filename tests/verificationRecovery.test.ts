import { afterEach, expect, it, vi } from 'vitest';
import { solveTurnstileOrchestrated, solveTurnstileWithCPSolver } from '../src/codeforces/captchaSolver';

vi.mock('../src/codeforces/capzyKeyManager', () => ({
  getCandidateCapzyKeys: vi.fn(() => { throw new Error('Must not try another provider'); }),
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

it('stops after the observed no-token 408 without retries or provider fallback', async () => {
  const request = setup(408, JSON.stringify({ ok: false,
    error: 'Turnstile challenge timed out after 60000ms without token', modeUsed: 'harness' }));
  expect(await solveTurnstileOrchestrated({ siteurl: 'https://fixture.invalid/form', sitekey: 'fixture' })).toBeNull();
  expect(request).toHaveBeenCalledOnce();
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
