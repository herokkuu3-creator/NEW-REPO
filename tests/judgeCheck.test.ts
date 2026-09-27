import { describe, expect, it } from 'vitest';
import type { BrowserContext } from 'playwright';
import { LeetCodeApi, parseJudgeCheck } from '../src/leetcode/apiClient';

type Reply = { status: number; body: unknown };

/** Minimal fake of BrowserContext.request that serves scripted replies. */
function fakeContext(opts: {
  check?: Reply[];
  graphql?: (query: string) => Reply;
}) {
  const calls = { check: 0, graphql: 0, urls: [] as string[] };
  const checkReplies = [...(opts.check ?? [])];
  const mk = (r: Reply) => ({
    status: () => r.status,
    text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
  });
  const request = {
    get: async (url: string) => {
      calls.urls.push(url);
      if (url.includes('/v2/check/')) {
        calls.check++;
        const r = checkReplies.length > 1 ? checkReplies.shift()! : checkReplies[0];
        return mk(r ?? { status: 404, body: '' });
      }
      return mk({ status: 404, body: '' });
    },
    post: async (_url: string, init: { data: { query: string } }) => {
      calls.graphql++;
      return mk(opts.graphql ? opts.graphql(init.data.query) : { status: 500, body: '' });
    },
  };
  const ctx = { request, cookies: async () => [] } as unknown as BrowserContext;
  return { ctx, calls };
}

const FAST = { firstPollDelayMs: 1, pollIntervalMs: 1 };

describe('parseJudgeCheck', () => {
  it('treats PENDING / STARTED as pending', () => {
    expect(parseJudgeCheck({ state: 'PENDING' })).toEqual({ kind: 'pending', state: 'PENDING' });
    expect(parseJudgeCheck({ state: 'STARTED' })).toEqual({ kind: 'pending', state: 'STARTED' });
  });

  it('parses an accepted SUCCESS body', () => {
    expect(
      parseJudgeCheck({
        state: 'SUCCESS',
        status_code: 10,
        status_msg: 'Accepted',
        status_runtime: '0 ms',
        status_memory: '8.8 MB',
      }),
    ).toEqual({
      kind: 'final',
      classification: 'ACCEPTED',
      statusDisplay: 'Accepted',
      runtime: '0 ms',
      memory: '8.8 MB',
    });
  });

  it('parses rejections by text or code', () => {
    const wa = parseJudgeCheck({ state: 'SUCCESS', status_code: 11, status_msg: 'Wrong Answer' });
    expect(wa?.kind === 'final' && wa.classification).toBe('WRONG_ANSWER');
    const ce = parseJudgeCheck({ state: 'SUCCESS', status_code: 20 });
    expect(ce?.kind === 'final' && ce.classification).toBe('COMPILE_ERROR');
  });

  it('returns null for garbage', () => {
    expect(parseJudgeCheck(null)).toBeNull();
    expect(parseJudgeCheck('x')).toBeNull();
    expect(parseJudgeCheck({})).toBeNull();
  });
});

describe('LeetCodeApi.awaitSubmission', () => {
  it('keeps polling the check endpoint through PENDING until SUCCESS (the reported bug)', async () => {
    const { ctx, calls } = fakeContext({
      check: [
        { status: 200, body: { state: 'PENDING' } },
        { status: 200, body: { state: 'PENDING' } },
        { status: 200, body: { state: 'STARTED' } },
        {
          status: 200,
          body: { state: 'SUCCESS', status_code: 10, status_msg: 'Accepted', status_runtime: '0 ms', status_memory: '8.78 MB' },
        },
      ],
    });
    const out = await new LeetCodeApi(ctx).awaitSubmission('2154709465', 'slug', 5_000, FAST);
    expect(out.classification).toBe('ACCEPTED');
    expect(out.runtime).toBe('0 ms');
    expect(out.memory).toBe('8.78 MB');
    expect(calls.check).toBe(4);
    expect(calls.urls[0]).toBe('https://leetcode.com/submissions/detail/2154709465/v2/check/');
    expect(calls.graphql).toBe(0);
  });

  it('reports a genuine rejection from the check endpoint', async () => {
    const { ctx } = fakeContext({
      check: [{ status: 200, body: { state: 'SUCCESS', status_code: 11, status_msg: 'Wrong Answer' } }],
    });
    const out = await new LeetCodeApi(ctx).awaitSubmission('1', 'slug', 5_000, FAST);
    expect(out.classification).toBe('WRONG_ANSWER');
    expect(out.rawStatusMsg).toBe('Wrong Answer');
  });

  it('falls back to GraphQL submissionDetails when the check endpoint is unavailable', async () => {
    const { ctx } = fakeContext({
      check: [{ status: 403, body: '<html>' }],
      graphql: () => ({
        status: 200,
        body: { data: { submissionDetails: { statusCode: 10, statusDisplay: 'Accepted', runtime: '3', memory: '9' } } },
      }),
    });
    const out = await new LeetCodeApi(ctx).awaitSubmission('1', 'slug', 5_000, FAST);
    expect(out.classification).toBe('ACCEPTED');
  });

  it('recovers the verdict from submission history when polling never finalises', async () => {
    const { ctx } = fakeContext({
      check: [{ status: 200, body: { state: 'PENDING' } }],
      graphql: (q) =>
        q.includes('submissionList')
          ? {
              status: 200,
              body: { data: { submissionList: { submissions: [{ id: 42, statusDisplay: 'Accepted', runtime: '0', memory: '8.7' }] } } },
            }
          : { status: 200, body: { data: { submissionDetails: null } } },
    });
    const out = await new LeetCodeApi(ctx).awaitSubmission('42', 'slug', 50, FAST);
    expect(out.classification).toBe('ACCEPTED');
    expect(out.runtime).toBe('0 ms');
  });

  it('still times out as UNKNOWN when nothing ever resolves', async () => {
    const { ctx } = fakeContext({
      check: [{ status: 200, body: { state: 'PENDING' } }],
      graphql: () => ({ status: 200, body: { data: { submissionDetails: null, submissionList: null } } }),
    });
    const out = await new LeetCodeApi(ctx).awaitSubmission('7', 'slug', 30, FAST);
    expect(out.classification).toBe('UNKNOWN');
    expect(out.rawStatusMsg).toMatch(/timed out/);
  });
});
