import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let server: Server;
let origin: string;
const headers = { authorization: 'Bearer test-broker-token', 'content-type': 'application/json', 'x-codeforces-post-guard': '1' };

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
  it('guards the POST and cancels a claimed runner only before authorization', async () => {
    const request = { requestId: 'cccccccc-cccc-4ccc-cccc-cccccccccccc', requiresPostAuthorization: true,
      code: 'int main(){}', entry: { contestId: 1, problemIndex: 'A' }, state: { cookies: [] } };
    await fetch(`${origin}/submit`, { method: 'POST', headers, body: JSON.stringify(request) });
    await fetch(`${origin}/jobs/${request.requestId}/claim`, { method: 'POST', headers });
    expect(await (await fetch(`${origin}/jobs/${request.requestId}/authorize-post`, { method: 'POST', headers })).json()).toEqual({ authorized: true });
    expect(await (await fetch(`${origin}/jobs/${request.requestId}/cancel`, { method: 'POST', headers })).json()).toEqual({ cancelled: false });
    await fetch(`${origin}/jobs/${request.requestId}/result`, { method: 'POST', headers, body: JSON.stringify({ ok: false, clicked: true }) });
  });
  it('cancels a waiting job before a runner can claim it', async () => {
    const request = { requestId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', code: 'int main(){}', entry: { contestId: 1, problemIndex: 'A' }, state: { cookies: [] } };
    await fetch(`${origin}/submit`, { method: 'POST', headers, body: JSON.stringify(request) });
    expect(await (await fetch(`${origin}/jobs/${request.requestId}`, { headers })).json()).toEqual({ pending: true, claimed: false });
    expect(await (await fetch(`${origin}/jobs/${request.requestId}/cancel`, { method: 'POST', headers })).json()).toEqual({ cancelled: true });
    expect((await fetch(`${origin}/jobs/${request.requestId}/claim`, { method: 'POST', headers })).status).toBe(404);
  });
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

    const result = { ok: true, status: 302, finalUrl: 'https://codeforces.com/contest/1/my', clicked: true, turnstile: true, interactive: false };
    expect((await fetch(`${origin}/jobs/${jobId}/result`, { method: 'POST', headers, body: JSON.stringify(result) })).status).toBe(200);
    expect(await (await fetch(`${origin}/jobs/${jobId}`, { headers })).json()).toEqual({ pending: false, result });
  });
});
