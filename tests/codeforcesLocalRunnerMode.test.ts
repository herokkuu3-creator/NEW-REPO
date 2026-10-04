import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let server: Server;
let origin: string;
const brokerHeaders = { authorization: 'Bearer broker-token', 'content-type': 'application/json' };
const localHeaders = { authorization: 'Bearer local-token', 'content-type': 'application/json' };

beforeAll(async () => {
  vi.stubEnv('CODEFORCES_RUNNER_MODE', 'local');
  vi.stubEnv('CODEFORCES_SUBMITTER_TOKEN', 'broker-token');
  vi.stubEnv('CODEFORCES_LOCAL_RUNNER_TOKEN', 'local-token');
  vi.stubEnv('CODEFORCES_RUNNER_REPOSITORY', '');
  ({ server } = await import('../src/codeforces/submitterService'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
});

describe('local Codeforces runner mode', () => {
  it('accepts jobs from Render but reserves claim/result access for the local runner', async () => {
    const request = {
      requestId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
      code: 'int main(){}',
      entry: { contestId: 1, problemIndex: 'A' },
      state: { cookies: [] },
    };
    const queued = await fetch(`${origin}/submit`, { method: 'POST', headers: brokerHeaders, body: JSON.stringify(request) });
    expect(queued.status).toBe(202);
    expect((await fetch(`${origin}/jobs/next`, { headers: brokerHeaders })).status).toBe(401);

    const next = await fetch(`${origin}/jobs/next`, { headers: localHeaders });
    expect((await next.json() as { jobId: string }).jobId).toBe(request.requestId);
    const claim = await fetch(`${origin}/jobs/${request.requestId}/claim`, { method: 'POST', headers: localHeaders });
    expect(claim.status).toBe(200);
    expect(await claim.json()).toEqual(request);
  });
});
