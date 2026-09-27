import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildReport, RunReport } from '../src/scheduler/report';

/** HTTP tests for POST /triggerSubmission — DB-backed routes are not called. */

vi.mock('../src/config', async (orig) => {
  const real = (await orig()) as { config: Record<string, unknown> };
  return { config: { ...real.config, api: { ...(real.config.api as object), port: 0 } } };
});

const state = vi.hoisted(() => ({
  inProgress: false,
  report: null as RunReport | null,
  calls: 0,
  fail: false,
}));

let app: FastifyInstance;
const AUTH = { authorization: 'Bearer test-token-for-vitest' };

beforeAll(async () => {
  const { startHealthServer } = await import('../src/api/health');
  app = await startHealthServer({
    triggerRun: async () => ({ started: true, message: 'x' }),
    isRunInProgress: () => state.inProgress,
    runSubmission: async () => {
      state.calls++;
      if (state.fail) throw new Error('boom');
      return state.report;
    },
  });
});
afterAll(async () => app?.close());

describe('POST /triggerSubmission', () => {
  it('rejects without the admin token', async () => {
    const res = await app.inject({ method: 'POST', url: '/triggerSubmission' });
    expect(res.statusCode).toBe(401);
    expect(state.calls).toBe(0);
  });

  it('returns a separate result for each account', async () => {
    state.report = buildReport({
      date: '2026-09-27',
      reason: 'trigger-submission',
      startedAt: '2026-09-27T07:00:00.000Z',
      outcomes: [
        { label: 'a1', username: 'a1', kind: 'solved', state: 'SUCCESS', submissionId: '11', submissionStatus: 'Accepted', runtime: '0 ms', memory: '8.6 MB' },
        { label: 'a2', username: 'a2', kind: 'failed', state: 'SUBMISSION_REJECTED', submissionId: '12', submissionStatus: 'Wrong Answer', error: 'judge verdict: Wrong Answer' },
        { label: 'a3', kind: 'rejected', error: 'LeetCode rejected the transferred session' },
      ],
    });
    const res = await app.inject({ method: 'POST', url: '/triggerSubmission', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.summary).toBe('3 account(s): 1 solved, 1 rejected, 1 failed');
    expect(body.accounts).toHaveLength(3);
    expect(body.accounts[0]).toEqual({
      label: 'a1', username: 'a1', status: 'solved', success: true, state: 'SUCCESS',
      submissionId: '11', verdict: 'Accepted', runtime: '0 ms', memory: '8.6 MB', error: null,
    });
    expect(body.accounts[1]).toMatchObject({ label: 'a2', success: false, verdict: 'Wrong Answer', submissionId: '12' });
    expect(body.accounts[2]).toMatchObject({ label: 'a3', status: 'rejected', username: null, submissionId: null });
    expect(JSON.stringify(body)).not.toMatch(/cookie|LEETCODE_SESSION|csrftoken/i);
  });

  it('409 when a run is already in progress', async () => {
    state.inProgress = true;
    const before = state.calls;
    const res = await app.inject({ method: 'POST', url: '/triggerSubmission', headers: AUTH });
    expect(res.statusCode).toBe(409);
    expect(state.calls).toBe(before);
    state.inProgress = false;

    state.report = null; // runner reports "already running" (race)
    const res2 = await app.inject({ method: 'POST', url: '/triggerSubmission', headers: AUTH });
    expect(res2.statusCode).toBe(409);
  });

  it('500 with the error when the run throws', async () => {
    state.fail = true;
    const res = await app.inject({ method: 'POST', url: '/triggerSubmission', headers: AUTH });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ ok: false, error: 'boom' });
    state.fail = false;
  });

  it('existing /admin/run-now is unchanged', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/run-now', headers: AUTH });
    expect(res.statusCode).toBe(202);
  });
});
