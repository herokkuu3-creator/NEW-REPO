import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  states: new Map<string, { value: string; updatedAt: number }>(),
  posts: new Map<string, { id: string; status: string; contentHash: string; approvedHash: string | null; publishedUrl: string | null; lastError: string | null }>(),
  runs: new Map<string, { id: string; problemSlug: string; state: string; submissionId: string; submissionStatus: string }>(),
  forecast: vi.fn(), submit: vi.fn(), generate: vi.fn(), publish: vi.fn(), approve: vi.fn(),
}));

vi.mock('../src/database/prisma', () => {
  const runKey = ({ accountId, date }: { accountId: string; date: string }) => `${accountId}:${date}`;
  const write = (key: string, value: string) => store.states.set(key, { value, updatedAt: Date.now() });
  const db = {
    account: { findUnique: async ({ where }: any) => ({ id: where.id, label: where.id, status: 'ACTIVE' }) },
    systemState: {
      findUnique: async ({ where }: any) => store.states.get(where.key) ?? null,
      findMany: async ({ where }: any) => [...store.states].filter(([key]) => where.key.in.includes(key)).map(([key, row]) => ({ key, ...row })),
      create: async ({ data }: any) => {
        if (store.states.has(data.key)) throw Object.assign(new Error('duplicate'), { code: 'P2002' });
        write(data.key, data.value);
      },
      updateMany: async ({ where, data }: any) => {
        const row = store.states.get(where.key);
        if (!row || (where.value && row.value !== where.value) || (where.updatedAt && row.updatedAt >= +where.updatedAt.lt)) return { count: 0 };
        write(where.key, data.value ?? row.value);
        return { count: 1 };
      },
      upsert: async ({ create }: any) => { write(create.key, create.value); },
      deleteMany: async ({ where }: any) => { if (store.states.get(where.key)?.value === where.value) store.states.delete(where.key); },
    },
    dailyRun: {
      findUnique: async ({ where }: any) => store.runs.get(runKey(where.accountId_date)) ?? null,
      create: async ({ data }: any) => {
        const run = { id: runKey(data), ...data };
        store.runs.set(run.id, run);
        return run;
      },
    },
    solutionPost: {
      findUnique: async ({ where }: any) => store.posts.get(where.accountId_problemSlug_intent.problemSlug) ?? null,
      findUniqueOrThrow: async ({ where }: any) => store.posts.get(where.accountId_problemSlug_intent.problemSlug),
    },
  };
  return { prisma: { ...db, $transaction: async (callback: (tx: typeof db) => unknown) => callback(db) } };
});

vi.mock('../src/solutionPosts/dailyForecast', async importOriginal => ({ ...await importOriginal<object>(), predictNextDaily: store.forecast }));
vi.mock('../src/solutionPosts/service', () => ({
  generateForRun: store.generate, retryPost: vi.fn(),
  PostError: class extends Error { constructor(public readonly code: string) { super(code); } },
}));
vi.mock('../src/solutionPosts/store', () => ({ approvePost: store.approve }));
vi.mock('../src/solutionPosts/publisher', () => ({ publishPost: store.publish }));
vi.mock('../src/scheduler/rangeSubmission', () => ({ submitSingleQuestionDirectly: store.submit }));

import { disableForecastSchedule, forecastWindow, getForecastScheduleStatus, runForecastTick, saveForecastSchedule } from '../src/solutionPosts/forecastScheduler';

const setTime = (value: string) => vi.setSystemTime(new Date(value));
const picks = ['alpha', 'beta'].map((slug, i) => ({ slug, title: slug, number: i + 1, difficulty: 'Medium', createdAt: '2026-11-18T00:00:00Z' }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  setTime('2026-11-19T15:00:00Z');
  store.states.clear();
  store.posts.clear();
  store.runs.clear();
  store.forecast.mockResolvedValue({ target: '2026-11-20', method: 'editorials', picks });
  store.submit.mockImplementation(async (_account, number, _deps, { slug, beforeSubmit }) => {
    await beforeSubmit();
    return { outcome: { status: 'accepted', submissionId: String(number), number },
      capture: { slug, title: slug, difficulty: 'Medium', language: 'cpp', code: 'class Solution {}' } };
  });
  store.generate.mockImplementation(async (_account, runId) => {
    const slug = store.runs.get(runId)!.problemSlug;
    const post = { id: slug, status: 'AWAITING_APPROVAL', contentHash: 'hash', approvedHash: null, publishedUrl: null, lastError: null };
    store.posts.set(slug, post);
    return post;
  });
  store.approve.mockImplementation(async id => Object.assign(store.posts.get(id)!, { status: 'DRAFT_READY', approvedHash: 'hash' }));
  store.publish.mockImplementation(async (id, options) => {
    await options.beforePublish();
    return Object.assign(store.posts.get(id)!, { status: 'PUBLISHED', publishedUrl: `https://leetcode.com/${id}` });
  });
});

afterEach(async () => {
  await disableForecastSchedule();
  vi.useRealTimers();
});

it('maps IST midnight and the UTC challenge rollover to the correct forecast dates', () => {
  const now = Date.parse('2026-12-31T20:00:00Z');
  expect(forecastWindow(now, '00:15')).toMatchObject({ target: '2027-01-01', postingAt: Date.parse('2026-12-31T18:45:00Z') });
  expect(forecastWindow(now, '05:29').postingAt).toBe(Date.parse('2026-12-31T23:59:00Z'));
  expect(forecastWindow(now, '05:30').postingAt).toBe(Date.parse('2026-12-31T00:00:00Z'));
  expect(() => forecastWindow(now, '24:00')).toThrow('INVALID_FORECAST_TIME');
});

it('prepares two candidates once for the chosen account and posts both when due', async () => {
  await saveForecastSchedule('chosen-account', '22:30');
  await runForecastTick();
  expect(store.forecast).not.toHaveBeenCalled();
  setTime('2026-11-19T16:00:00Z');
  await Promise.all([runForecastTick(), runForecastTick()]);
  expect(store.submit).toHaveBeenCalledTimes(2);
  expect(store.submit.mock.calls.map(([account]) => account.id)).toEqual(['chosen-account', 'chosen-account']);
  expect([...store.runs.keys()]).toEqual(['chosen-account:forecast:1:2026-11-20', 'chosen-account:forecast:2:2026-11-20']);
  expect(store.publish).not.toHaveBeenCalled();
  setTime('2026-11-19T17:00:00Z');
  await runForecastTick();
  await runForecastTick();
  expect(store.submit).toHaveBeenCalledTimes(2);
  expect(store.publish.mock.calls.map(([id, options]) => [id, options.automaticEngagement])).toEqual([['alpha', false], ['beta', false]]);
  const result = await getForecastScheduleStatus();
  expect(result?.last?.picks.map(pick => pick.status)).toEqual(['published', 'published']);
  expect(result?.nextTarget).toBe('2026-11-21');
});

it('preserves an uncertain publication without retrying it and publishes the other candidate', async () => {
  await saveForecastSchedule('account', '22:30');
  setTime('2026-11-19T17:00:00Z');
  store.publish.mockImplementationOnce(async id => {
    Object.assign(store.posts.get(id)!, { status: 'PUBLISHING' });
    throw new Error('connection lost after dispatch');
  });
  await runForecastTick();
  setTime('2026-11-19T17:10:00Z');
  await runForecastTick();
  expect(store.publish.mock.calls.map(([id]) => id)).toEqual(['alpha', 'beta']);
  expect((await getForecastScheduleStatus())?.last?.picks.map(pick => pick.status)).toEqual(['uncertain', 'published']);
});

it('checks a schedule change immediately before the publication mutation', async () => {
  await saveForecastSchedule('account', '22:30');
  setTime('2026-11-19T17:00:00Z');
  const externalWrite = vi.fn();
  store.publish.mockImplementationOnce(async (_id, options) => {
    await disableForecastSchedule();
    await options.beforePublish();
    externalWrite();
  });
  await runForecastTick();
  expect(externalWrite).not.toHaveBeenCalled();
  expect(store.publish).toHaveBeenCalledTimes(1);
  expect(await getForecastScheduleStatus()).toBeNull();
});

it('reclaims an expired worker lease without repeating an interrupted submission', async () => {
  await saveForecastSchedule('account', '22:30');
  setTime('2026-11-19T17:00:00Z');
  const key = 'daily-forecast:job:2026-11-20:account';
  store.states.set(`${key}:lease`, { value: 'old-worker', updatedAt: Date.now() });
  store.states.set(key, { value: JSON.stringify({ method: 'editorials', picks: [{ ...picks[0], status: 'submitting' }] }), updatedAt: Date.now() });
  await runForecastTick();
  expect((await getForecastScheduleStatus())?.last?.picks[0]?.status).toBe('submitting');
  setTime('2026-11-19T17:04:00Z');
  await runForecastTick();
  expect((await getForecastScheduleStatus())?.last?.picks[0]?.status).toBe('uncertain');
  expect(store.submit).not.toHaveBeenCalled();
  expect(store.publish).not.toHaveBeenCalled();
});
