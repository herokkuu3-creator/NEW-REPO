import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let server: Server;
let origin: string;
const headers = { authorization: 'Bearer test-broker-token', 'content-type': 'application/json' };

beforeAll(async () => {
  vi.stubEnv('CODEFORCES_RUNNER_REPOSITORY', 'owner/repo');
  vi.stubEnv('CODEFORCES_SUBMITTER_TOKEN', 'test-broker-token');
  vi.stubEnv('GITHUB_DISPATCH_TOKEN', 'test-dispatch-token');
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    String(input).startsWith('https://api.github.com/')
      ? Promise.resolve(new Response(null, { status: 204 }))
      : realFetch(input, init),
  ));
  ({ server } = await import('../src/codeforces/submitterService'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('authenticated scheduled runner broker', () => {
  it('hands one job to one runner and returns its result without launching Firefox on Render', async () => {
    const unauthorized = await fetch(`${origin}/jobs/next`);
    expect(unauthorized.status).toBe(401);

    const request = { requestId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', code: 'int main(){}', entry: { contestId: 1, problemIndex: 'A' }, state: { cookies: [] } };
    const queued = await fetch(`${origin}/submit`, { method: 'POST', headers, body: JSON.stringify(request) });
    expect(queued.status).toBe(202);
    const { jobId } = await queued.json() as { jobId: string };
    expect(jobId).toBe(request.requestId);

    const next = await fetch(`${origin}/jobs/next`, { headers });
    expect((await next.json() as { jobId: string }).jobId).toBe(jobId);
    const claim = await fetch(`${origin}/jobs/${jobId}/claim`, { method: 'POST', headers });
    expect(claim.status).toBe(200);
    expect(await claim.json()).toEqual(request);
    expect((await (await fetch(`${origin}/jobs/next`, { headers })).json() as { jobId: null }).jobId).toBeNull();
    expect((await fetch(`${origin}/jobs/${jobId}/claim`, { method: 'POST', headers })).status).toBe(404);

    expect((await fetch(`${origin}/jobs/${jobId}/progress`, { method: 'POST', body: JSON.stringify({ phase: 'verification' }) })).status).toBe(401);
    expect((await fetch(`${origin}/jobs/${jobId}/progress`, { method: 'POST', headers, body: JSON.stringify({ phase: 'verification' }) })).status).toBe(200);
    expect(await (await fetch(`${origin}/jobs/${jobId}`, { headers })).json()).toEqual({ pending: true, progress: 'verification' });
    expect((await fetch(`${origin}/jobs/${jobId}/progress`, { method: 'POST', headers, body: JSON.stringify({ phase: '<invalid>' }) })).status).toBe(400);

    const verificationUrl = `${origin}/jobs/${jobId}/verification`;
    const frame = { image: Buffer.from([0xff, 0xd8, 0xff, 0]).toString('base64'), width: 900, height: 600 };
    expect((await fetch(verificationUrl, { method: 'POST', body: JSON.stringify(frame) })).status).toBe(401);
    const published = await fetch(verificationUrl, { method: 'POST', headers, body: JSON.stringify(frame) });
    expect(published.status).toBe(200);
    const { token } = await published.json() as { token: string };
    const phoneHeaders = { 'x-verification-token': token, 'content-type': 'application/json' };
    expect((await fetch(`${origin}/verification/frame`)).status).toBe(410);
    const phoneFrame = await fetch(`${origin}/verification/frame`, { headers: phoneHeaders });
    expect(phoneFrame.status).toBe(200);
    expect(phoneFrame.headers.get('cache-control')).toBe('no-store');
    expect((await fetch(`${origin}/verification/action`, { method: 'POST', headers: phoneHeaders, body: JSON.stringify({ type: 'click', x: 10, y: 10 }) })).status).toBe(200);
    const refreshed = await fetch(verificationUrl, { method: 'POST', headers, body: JSON.stringify(frame) });
    expect((await refreshed.json() as { actions: unknown[] }).actions).toEqual([{ type: 'click', x: 10, y: 10 }]);
    const ui = await fetch(`${origin}/verify`);
    expect(ui.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");

    const result = { ok: true, status: 302, finalUrl: 'https://codeforces.com/contest/1/my', clicked: true, turnstile: true, interactive: false };
    expect((await fetch(`${origin}/jobs/${jobId}/result`, { method: 'POST', headers, body: JSON.stringify(result) })).status).toBe(200);
    expect(await (await fetch(`${origin}/jobs/${jobId}`, { headers })).json()).toEqual({ pending: false, result });
    expect((await fetch(`${origin}/verification/frame`, { headers: phoneHeaders })).status).toBe(410);
    expect((await fetch(verificationUrl, { method: 'POST', headers, body: JSON.stringify(frame) })).status).toBe(409);
  });
});
