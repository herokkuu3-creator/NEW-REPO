import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let server: Server;
let origin: string;
const headers = { authorization: 'Bearer test-broker-token', 'content-type': 'application/json' };

beforeAll(async () => {
  vi.stubEnv('CODEFORCES_RUNNER_REPOSITORY', 'owner/repo');
  vi.stubEnv('CODEFORCES_SUBMITTER_TOKEN', 'test-broker-token');
  vi.stubEnv('GITHUB_DISPATCH_TOKEN', ''); // Scheduled runner, no PAT needed.
  ({ server } = await import('../src/codeforces/submitterService'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
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

    const result = { ok: true, status: 302, finalUrl: 'https://codeforces.com/contest/1/my', clicked: true, turnstile: true, interactive: false };
    expect((await fetch(`${origin}/jobs/${jobId}/result`, { method: 'POST', headers, body: JSON.stringify(result) })).status).toBe(200);
    expect(await (await fetch(`${origin}/jobs/${jobId}`, { headers })).json()).toEqual({ pending: false, result });
  });
});
