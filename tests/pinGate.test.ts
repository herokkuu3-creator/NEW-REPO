import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PinGate, readPinFromEnv, safeNext } from '../src/api/pinGate';

/**
 * PIN gate: unit tests + HTTP tests against the real Fastify server with the
 * database reads mocked. Proves the public /health no longer leaks account data.
 */

vi.mock('../src/config', async (orig) => {
  const real = (await orig()) as { config: Record<string, unknown> };
  return { config: { ...real.config, api: { ...(real.config.api as object), port: 0 } } };
});

vi.mock('../src/database/models', async (orig) => ({
  ...((await orig()) as object),
  getAllSystemState: vi.fn(async () => ({ authStatus: 'ok', lastError: 'secret-error' })),
  latestRun: vi.fn(async () => null),
}));
vi.mock('../src/database/accounts', async (orig) => ({
  ...((await orig()) as object),
  listAccounts: vi.fn(async () => [
    {
      id: 'x', label: 'broZEdex', username: 'broZEdex', status: 'ACTIVE', storageState: '{"cookies":[],"origins":[]}',
      lastCheckedAt: null, lastRunAt: new Date('2026-09-27T07:33:10.439Z'), lastResult: 'SUCCESS', lastError: null,
      createdAt: new Date('2026-09-26T00:00:00Z'),
    },
  ]),
}));

describe('PinGate (unit)', () => {
  it('reads PIN_CODE, and PIN-CODE as an alias', () => {
    expect(readPinFromEnv({ PIN_CODE: ' 4821 ' } as never)).toBe('4821');
    expect(readPinFromEnv({ 'PIN-CODE': '9999' } as never)).toBe('9999');
    expect(readPinFromEnv({} as never)).toBe('');
  });

  it('accepts the right PIN, rejects wrong ones, locks out after 5', () => {
    const g = new PinGate('4821', 'secret');
    expect(g.checkPin('1.1.1.1', '4821')).toBe('ok');
    for (let i = 0; i < 4; i++) expect(g.checkPin('2.2.2.2', '0000')).toBe('wrong');
    expect(g.checkPin('2.2.2.2', '0000')).toBe('locked');
    expect(g.checkPin('2.2.2.2', '4821')).toBe('locked'); // even the right PIN, while locked
    expect(g.checkPin('3.3.3.3', '4821')).toBe('ok'); // other IPs unaffected
  });

  it('lockout expires after 15 minutes', () => {
    let now = 1_000_000;
    const g = new PinGate('4821', 's', () => now);
    for (let i = 0; i < 5; i++) g.checkPin('ip', 'bad');
    expect(g.checkPin('ip', '4821')).toBe('locked');
    now += 15 * 60 * 1000 + 1;
    expect(g.checkPin('ip', '4821')).toBe('ok');
  });

  it('session tokens verify, expire, and die when the PIN changes', () => {
    let now = 1_000_000;
    const g = new PinGate('4821', 's', () => now);
    const t = g.issueToken().value;
    expect(g.verifyToken(t)).toBe(true);
    expect(g.verifyToken(t.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')))).toBe(false);
    expect(new PinGate('1111', 's', () => now).verifyToken(t)).toBe(false);
    now += 12 * 60 * 60 * 1000 + 1;
    expect(g.verifyToken(t)).toBe(false);
  });

  it('fails closed when no PIN is configured', () => {
    const g = new PinGate('', 's');
    expect(g.checkPin('ip', '')).toBe('not-configured');
    expect(g.isUnlocked('ip', { 'x-pin-code': '' })).toBe(false);
  });

  it('only redirects to local paths', () => {
    expect(safeNext('/health')).toBe('/health');
    expect(safeNext('https://evil.com')).toBe('/health');
    expect(safeNext('//evil.com')).toBe('/health');
  });
});

describe('GET /health behind the PIN (HTTP)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    const { startHealthServer } = await import('../src/api/health');
    app = await startHealthServer(
      {
        triggerRun: async () => ({ started: true, message: 'x' }),
        isRunInProgress: () => false,
        runSubmission: async () => null,
      },
      { pinCode: '4821' },
    );
  });
  afterAll(async () => app?.close());

  it('without the PIN: only {"status":"ok"} (Render health check still passes)', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.body).not.toMatch(/broZEdex|secret-error|accounts/);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('in a browser without the PIN: a PIN form, no data', async () => {
    const res = await app.inject({ method: 'GET', url: '/health', headers: { accept: 'text/html' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toMatch(/Enter PIN/);
    expect(res.body).not.toMatch(/broZEdex/);
  });

  it('wrong PIN header: still locked', async () => {
    const res = await app.inject({ method: 'GET', url: '/health', headers: { 'x-pin-code': '0000' } });
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('correct PIN header: full details, timestamps in IST', async () => {
    const res = await app.inject({ method: 'GET', url: '/health', headers: { 'x-pin-code': '4821' } });
    const body = res.json();
    expect(body.accounts.items[0].label).toBe('broZEdex');
    expect(body.accounts.items[0].lastRunAt).toBe('2026-09-27T13:03:10.439+05:30');
    expect(body.now).toMatch(/\+05:30$/);
  });

  it('browser flow: wrong PIN → 401 form; right PIN → cookie → details', async () => {
    const bad = await app.inject({
      method: 'POST', url: '/unlock',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'pin=1234&next=%2Fhealth', remoteAddress: '9.9.9.9',
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.body).toMatch(/Wrong PIN/);
    expect(bad.headers['set-cookie']).toBeUndefined();

    const ok = await app.inject({
      method: 'POST', url: '/unlock',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'pin=4821&next=%2Fhealth',
    });
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toBe('/health');
    const cookie = String(ok.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);

    const res = await app.inject({
      method: 'GET', url: '/health',
      headers: { cookie: cookie.split(';')[0]!, accept: 'text/html' },
    });
    expect(res.json().accounts.total).toBe(1);
  });

  it('open redirect is blocked', async () => {
    const ok = await app.inject({
      method: 'POST', url: '/unlock',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'pin=4821&next=https%3A%2F%2Fevil.com',
    });
    expect(ok.headers.location).toBe('/health');
  });

  it('brute force: 5 wrong attempts → 429 lockout', async () => {
    let last = 0;
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({
        method: 'POST', url: '/unlock',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'pin=0000', remoteAddress: '7.7.7.7',
      });
      last = r.statusCode;
    }
    expect(last).toBe(429);
  });

  it('/admin/* endpoints still require SETUP_TOKEN (unchanged)', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/accounts', headers: { 'x-pin-code': '4821' } });
    expect(res.statusCode).toBe(401);
  });
});
