import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ accounts: [] as any[], runs: new Map<string, any>(), daily: vi.fn(), generate: vi.fn(),
  submit: vi.fn(), approve: vi.fn(), publish: vi.fn(), preferences: [] as any[], locks: new Map<string, string>(), calls: [] as any[],
  timers: [] as Array<() => void> }));
vi.mock('node-cron', () => ({ default: { schedule: vi.fn((_expr, callback) => {
  h.timers.push(callback); return { stop: vi.fn() };
}) } }));
vi.mock('../src/database/prisma', () => {
  const tx = {
    account: { findMany: vi.fn(async () => h.accounts), count: vi.fn(async () => h.accounts.length) },
    dailyRun: { findUnique: vi.fn(async ({ where }: any) => h.runs.get(where.accountId_date.accountId) ?? null) },
    solutionPost: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    solutionPostPreference: {
      updateMany: vi.fn(async () => { h.preferences = []; }),
      upsert: vi.fn(async ({ create }: any) => { h.preferences.push(create); }),
      findMany: vi.fn(async () => h.preferences),
    },
    systemState: {
      create: vi.fn(async ({ data }: any) => { h.locks.set(data.key, data.value); }),
      findUnique: vi.fn(async ({ where }: any) => h.locks.has(where.key) ? { key: where.key, value: h.locks.get(where.key) } : null),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (h.locks.get(where.key) !== where.value) return { count: 0 };
        h.locks.set(where.key, data.value); return { count: 1 };
      }),
      deleteMany: vi.fn(async ({ where }: any) => { if (h.locks.get(where.key) === where.value) h.locks.delete(where.key); }),
    },
  };
  return { prisma: { ...tx, $transaction: vi.fn(async action => action(tx)) } };
});
vi.mock('../src/solutionPosts/service', () => ({ PostError: class extends Error { code: string; constructor(code: string) { super(code); this.code = code; } },
  generateForRun: h.generate, resolveCurrentDaily: h.daily, retryPost: vi.fn() }));
vi.mock('../src/solutionPosts/store', () => ({ recoverGeneration: vi.fn(), approvePost: h.approve }));
vi.mock('../src/solutionPosts/publisher', () => ({ publishPost: h.publish }));
vi.mock('../src/scheduler/dailyWorker', () => ({ runSubmissionNow: h.submit }));
import { afterPostSchedule, POST_CRON, POST_TIMEZONE, runCombined, setSelectedAccounts, startSolutionPostScheduler } from '../src/solutionPosts/scheduler';
beforeEach(() => {
  vi.clearAllMocks(); h.locks.clear(); h.preferences = []; h.runs.clear(); h.calls = []; h.timers = [];
  h.accounts = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, status: 'ACTIVE' }));
  for (const a of h.accounts) h.runs.set(a.id, { id: 'run-' + a.id, problemSlug: 'today', state: 'SUCCESS', submissionId: '123', submissionStatus: 'Accepted' });
  h.daily.mockResolvedValue({ date: '2026-10-15', slug: 'today' });
  h.generate.mockImplementation(async (id: string) => ({ id: 'post-' + id, status: 'AWAITING_APPROVAL', contentHash: 'a'.repeat(64) }));
  h.approve.mockImplementation(async (id: string) => ({ id, status: 'DRAFT_READY', contentHash: 'a'.repeat(64) }));
  h.publish.mockImplementation(async (id: string) => ({ id, status: 'PUBLISHED', contentHash: 'a'.repeat(64) }));
  h.submit.mockImplementation(async (_reason, options) => {
    h.calls.push(options); const id = options.accountIds[0]; h.runs.set(id,
      { id: 'run-' + id, problemSlug: 'today', state: 'SUCCESS', submissionId: '124', submissionStatus: 'Accepted' });
    return {};
  });
});
describe('daily AI drafts', () => {
  it('uses 06:00 in Asia/Kolkata regardless of host timezone', () => {
    expect(POST_CRON).toBe('0 6 * * *'); expect(POST_TIMEZONE).toBe('Asia/Kolkata');
    expect(afterPostSchedule(new Date('2026-10-15T00:29:59Z'))).toBe(false);
    expect(afterPostSchedule(new Date('2026-10-15T00:30:00Z'))).toBe(true);
  });
  it('reuses accepted submissions and automatically publishes five generated articles', async () => {
    const results = await runCombined(h.accounts.map(a => a.id), new Date('2026-10-15T00:30:00Z'));
    expect(results.every(r => r.status === 'PUBLISHED')).toBe(true);
    expect(h.submit).not.toHaveBeenCalled(); expect(h.locks.size).toBe(0);
    expect(h.approve).toHaveBeenCalledTimes(5); expect(h.publish).toHaveBeenCalledTimes(5);
  });
  it('runs the existing submission workflow only for a missing accepted submission', async () => {
    h.runs.delete('c'); await runCombined(h.accounts.map(a => a.id), new Date('2026-10-15T00:30:00Z'));
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.calls[0]).toEqual({ accountIds: ['c'], expectedChallengeDate: '2026-10-15' });
  });
  it('continues the other four accounts after one account fails', async () => {
    h.generate.mockImplementation(async (id: string) => { if (id === 'b') throw new Error('failure'); return { id, status: 'AWAITING_APPROVAL', contentHash: 'a'.repeat(64) }; });
    const results = await runCombined(h.accounts.map(a => a.id), new Date('2026-10-15T00:30:00Z'));
    expect(results.filter(r => r.status === 'PUBLISHED')).toHaveLength(4);
    expect(results.filter(r => r.status === 'FAILED')).toHaveLength(1); expect(h.locks.size).toBe(0);
  });
  it('does not submit if challenge discovery fails or the pointer is stale', async () => {
    h.daily.mockRejectedValue(new Error('DAILY_CHALLENGE_NOT_REFRESHED'));
    const results = await runCombined(h.accounts.map(a => a.id), new Date('2026-10-15T00:30:00Z'));
    expect(results.every(r => r.status === 'FAILED')).toBe(true); expect(h.submit).not.toHaveBeenCalled();
  });
  it('requires an explicit nonempty one-time selection', async () => {
    await expect(runCombined([])).rejects.toThrow('SELECT_ACCOUNTS_REQUIRED');
    await expect(runCombined(['a', 'a'])).rejects.toThrow('SELECT_ACCOUNTS_REQUIRED');
  });
  it('sets per-account schedule preferences explicitly, without starting a job', async () => {
    const result = await setSelectedAccounts(h.accounts.map(a => a.id));
    expect(result.timezone).toBe('Asia/Kolkata'); expect(h.preferences).toHaveLength(5);
    expect(h.submit).not.toHaveBeenCalled(); expect(h.generate).not.toHaveBeenCalled();
  });
  it('bounds restart/recovery retries per account and day in durable state', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-15T00:30:00Z'));
    h.accounts = [h.accounts[0]]; h.preferences = [{ accountId: 'a', enabled: true }];
    const stop = startSolutionPostScheduler();
    try {
      await vi.waitFor(() => expect(h.generate).toHaveBeenCalledTimes(1));
      for (let n = 2; n <= 4; n++) {
        h.timers[1]!(); await vi.waitFor(() => expect(h.generate).toHaveBeenCalledTimes(n));
      }
      h.timers[1]!(); await new Promise(r => setTimeout(r, 30));
      expect(h.generate).toHaveBeenCalledTimes(4);
      expect(h.locks.get('solution-post-schedule-budget:a:2026-10-15')).toBe('4');
    } finally { stop(); vi.useRealTimers(); }
  });
});
