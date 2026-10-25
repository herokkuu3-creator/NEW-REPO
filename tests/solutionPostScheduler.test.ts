import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ accounts: [] as any[], runs: new Map<string, any>(), daily: vi.fn(), generate: vi.fn(),
  submit: vi.fn(), approve: vi.fn(), publish: vi.fn(), preferences: [] as any[], locks: new Map<string, string>(), calls: [] as any[],
  timers: [] as Array<() => void>, submitSingle: vi.fn(), retry: vi.fn(), posts: [] as any[] }));
vi.mock('node-cron', () => ({ default: { schedule: vi.fn((_expr, callback) => {
  h.timers.push(callback); return { stop: vi.fn() };
}) } }));
vi.mock('../src/database/prisma', () => {
  const tx = {
    account: { findMany: vi.fn(async ({ where }: any) => h.accounts.filter(a => where.id.in.includes(a.id) && a.status !== 'DISABLED')), count: vi.fn(async () => h.accounts.length) },
    dailyRun: { findUnique: vi.fn(async ({ where }: any) => h.runs.get(where.accountId_date.accountId) ?? null),
      findMany: vi.fn(async ({ where }: any) => [...h.runs.values()].filter(r => where.accountId.in.includes(r.accountId))),
      upsert: vi.fn(async ({ create }: any) => ({ id: `manual-${create.accountId}`, ...create })) },
    solutionPost: { findUnique: vi.fn(async ({ where }: any) => h.posts.find(p => p.accountId === where.accountId_problemSlug_intent.accountId) ?? null), findMany: vi.fn(async () => h.posts) },
    solutionPostPreference: {
      updateMany: vi.fn(async () => { h.preferences = []; }),
      upsert: vi.fn(async ({ create }: any) => { h.preferences.push(create); }),
      findMany: vi.fn(async () => h.preferences),
    },
    systemState: {
      create: vi.fn(async ({ data }: any) => { h.locks.set(data.key, data.value); }),
      upsert: vi.fn(async ({ create }: any) => { h.locks.set(create.key, create.value); }),
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
vi.mock('../src/solutionPosts/service', () => ({ PostError: class extends Error {
  constructor(public readonly code: string, public readonly details?: object) { super(code); }
}, generateForRun: h.generate, resolveCurrentDaily: h.daily, retryPost: h.retry }));
vi.mock('../src/solutionPosts/store', () => ({ recoverGeneration: vi.fn(), approvePost: h.approve }));
vi.mock('../src/solutionPosts/publisher', () => ({ publishPost: h.publish }));
vi.mock('../src/scheduler/dailyWorker', () => ({ runSubmissionNow: h.submit }));
vi.mock('../src/scheduler/rangeSubmission', () => ({ submitSingleQuestionDirectly: h.submitSingle }));
import { afterPostSchedule, POST_CRON, POST_TIMEZONE, runCombined, runManualQuestion, runScheduledSolutionPosts,
  SCHEDULE_STATE_KEY, setSelectedAccounts, startSolutionPostScheduler } from '../src/solutionPosts/scheduler';
import { PostError } from '../src/solutionPosts/service';
beforeEach(() => {
  vi.clearAllMocks(); h.locks.clear(); h.preferences = []; h.runs.clear(); h.calls = []; h.timers = []; h.posts = [];
  h.accounts = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, status: 'ACTIVE' }));
  for (const a of h.accounts) h.runs.set(a.id, { id: 'run-' + a.id, accountId: a.id, problemSlug: 'today', state: 'SUCCESS', submissionId: '123', submissionStatus: 'Accepted' });
  h.daily.mockResolvedValue({ date: '2026-10-15', slug: 'today' });
  h.generate.mockImplementation(async (id: string) => ({ id: 'post-' + id, status: 'AWAITING_APPROVAL', contentHash: 'a'.repeat(64) }));
  h.retry.mockImplementation(async (id: string) => ({ id, status: 'AWAITING_APPROVAL', contentHash: 'a'.repeat(64) }));
  h.approve.mockImplementation(async (id: string) => ({ id, status: 'DRAFT_READY', contentHash: 'a'.repeat(64) }));
  h.publish.mockImplementation(async (id: string) => ({ id, status: 'PUBLISHED', contentHash: 'a'.repeat(64) }));
  h.submitSingle.mockResolvedValue({
    outcome: { status: 'accepted', submissionId: '456', number: 3820 },
    capture: { slug: 'manual-question', title: 'Manual question', difficulty: 'Easy', language: 'cpp', code: 'class Solution {}' },
  });
  h.submit.mockImplementation(async (_reason, options) => {
    h.calls.push(options); const id = options.accountIds[0]; h.runs.set(id,
      { id: 'run-' + id, accountId: id, problemSlug: 'today', state: 'SUCCESS', submissionId: '124', submissionStatus: 'Accepted' });
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
  it('submits every selected daily before the first AI article request', async () => {
    h.runs.clear();
    h.generate.mockImplementation(async id => {
      expect(h.submit).toHaveBeenCalledTimes(5);
      return { id, status: 'FAILED', lastError: 'AI_ERROR: HTTP_402_BILLING_REQUIRED' };
    });
    const results = await runCombined(h.accounts.map(a => a.id), new Date('2026-10-15T00:30:00Z'));
    expect(results).toHaveLength(5); expect(h.submit).toHaveBeenCalledTimes(5);
    expect([...h.runs.values()].every(r => r.state === 'SUCCESS')).toBe(true);
  });
  it('never reports acceptance or generates an article for a rejected code submission', async () => {
    h.accounts = [h.accounts[0]]; h.runs.get('a').state = 'SUBMISSION_REJECTED';
    h.submit.mockResolvedValueOnce({});
    const events: any[] = [];
    const results = await runCombined(['a'], new Date('2026-10-15T00:30:00Z'), event => { events.push(event); });
    expect(results[0]).toMatchObject({ status: 'FAILED', error: 'ACCEPTED_SUBMISSION_REQUIRED' });
    expect(h.generate).not.toHaveBeenCalled(); expect(events.some(e => e.stage === 'accepted')).toBe(false);
  });
  it('continues the other four accounts after one account fails', async () => {
    h.generate.mockImplementation(async (id: string) => { if (id === 'b') throw new Error('failure'); return { id, status: 'AWAITING_APPROVAL', contentHash: 'a'.repeat(64) }; });
    const results = await runCombined(h.accounts.map(a => a.id), new Date('2026-10-15T00:30:00Z'));
    expect(results.filter(r => r.status === 'PUBLISHED')).toHaveLength(4);
    expect(results.filter(r => r.status === 'FAILED')).toHaveLength(1); expect(h.locks.size).toBe(0);
  });
  it('preserves an accepted submission and reports the stored article failure reason', async () => {
    h.accounts = [h.accounts[0]];
    h.generate.mockResolvedValue({ id: 'post-a', status: 'FAILED', lastError: 'AI_MODELS_EXHAUSTED' });
    const progress: any[] = [];
    const results = await runCombined(['a'], new Date('2026-10-15T00:30:00Z'), event => { progress.push(event); });
    expect(results).toEqual([{ accountId: 'a', postId: 'post-a', status: 'FAILED', error: 'AI_MODELS_EXHAUSTED' }]);
    expect(h.publish).not.toHaveBeenCalled();
    expect(progress.at(-1)).toMatchObject({ accountId: 'a', stage: 'failed', error: 'AI_MODELS_EXHAUSTED' });
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
  it('turns a selected manual question into an accepted source-backed article post', async () => {
    h.accounts = [h.accounts[0]];
    const results = await runManualQuestion(3820, ['a'], new Date('2026-10-15T00:30:00Z'));
    expect(h.submitSingle).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 3820);
    expect(results).toEqual([{ accountId: 'a', postId: 'post-a', status: 'PUBLISHED' }]);
    expect(h.generate).toHaveBeenCalledWith('a', 'manual-a', true);
  });
  it('retries all four exhausted accounts on an explicit daily run without resubmitting accepted code', async () => {
    h.accounts = h.accounts.slice(0, 4);
    h.posts = h.accounts.map(a => ({ id: 'post-' + a.id, accountId: a.id, status: 'FAILED', retryCount: 4 }));
    h.retry.mockImplementation(async (id, force) => {
      if (!force) throw new PostError('GENERATION_RETRY_LIMIT');
      return { id, status: 'AWAITING_APPROVAL', contentHash: 'a'.repeat(64) };
    });
    const results = await runCombined(h.accounts.map(a => a.id), new Date('2026-10-15T00:30:00Z'), undefined,
      { retryFailedGeneration: true });
    expect(results.filter(r => r.status === 'PUBLISHED')).toHaveLength(4);
    for (const post of h.posts) expect(h.retry).toHaveBeenCalledWith(post.id, true);
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.generate).not.toHaveBeenCalled();
  });
  it('preserves the original failure in progress when an automatic combined run exhausts its budget', async () => {
    h.accounts = [h.accounts[0]];
    h.posts = [{ id: 'post-a', accountId: 'a', status: 'FAILED', retryCount: 4 }];
    h.retry.mockRejectedValue(new PostError('GENERATION_RETRY_LIMIT', {
      postId: 'post-a', retryCount: 4, previousError: 'AI_PROVIDER_ACCESS_BLOCKED',
    }));
    const events: any[] = [];
    const results = await runCombined(['a'], new Date('2026-10-15T00:30:00Z'), event => { events.push(event); });
    expect(h.retry).toHaveBeenCalledWith('post-a', false);
    expect(results[0]).toMatchObject({ postId: 'post-a', error: 'GENERATION_RETRY_LIMIT', previousError: 'AI_PROVIDER_ACCESS_BLOCKED' });
    expect(events.at(-1)).toMatchObject({ stage: 'failed', previousError: 'AI_PROVIDER_ACCESS_BLOCKED' });
    expect(h.publish).not.toHaveBeenCalled();
  });
  it('keeps cron from force-resetting exhausted article records', async () => {
    h.accounts = [h.accounts[0]]; h.preferences = [{ accountId: 'a', enabled: true }];
    h.posts = [{ accountId: 'a', problemSlug: 'today', status: 'FAILED', retryCount: 4 }];
    expect((await runScheduledSolutionPosts(new Date('2026-10-15T00:30:00Z'))).status).toBe('IDLE');
    expect(h.retry).not.toHaveBeenCalled(); expect(h.generate).not.toHaveBeenCalled();
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
  it('recovers a completed draft that has not yet been published', async () => {
    h.accounts = [h.accounts[0]]; h.preferences = [{ accountId: 'a', enabled: true }];
    h.posts = [{ accountId: 'a', problemSlug: 'today', status: 'DRAFT_READY', retryCount: 1 }];
    h.generate.mockResolvedValueOnce({ id: 'post-a', status: 'DRAFT_READY', contentHash: 'a'.repeat(64) });
    const result = await runScheduledSolutionPosts(new Date('2026-10-15T00:30:00Z'));
    expect(result.status).toBe('FINISHED'); expect(h.publish).toHaveBeenCalledWith('post-a');
    expect(h.submit).not.toHaveBeenCalled();
    expect(JSON.parse(h.locks.get(SCHEDULE_STATE_KEY)!)).toMatchObject({ status: 'FINISHED' });
  });
  it('does not let an existing published manual article suppress the daily submission', async () => {
    h.accounts = [h.accounts[0]]; h.preferences = [{ accountId: 'a', enabled: true }]; h.runs.clear();
    h.posts = [{ accountId: 'a', problemSlug: 'today', status: 'PUBLISHED', retryCount: 1 }];
    h.generate.mockResolvedValueOnce({ id: 'post-a', status: 'PUBLISHED' });
    await runScheduledSolutionPosts(new Date('2026-10-15T00:30:00Z'));
    expect(h.submit).toHaveBeenCalledTimes(1);
  });
  it('does not consume scheduled retries while the daily submission worker is busy', async () => {
    h.accounts = [h.accounts[0]]; h.preferences = [{ accountId: 'a', enabled: true }]; h.runs.clear();
    h.submit.mockResolvedValueOnce(null);
    await runScheduledSolutionPosts(new Date('2026-10-15T00:30:00Z'));
    expect(h.locks.get('solution-post-schedule-budget:a:2026-10-15')).toBe('0');
    expect(h.generate).not.toHaveBeenCalled();
  });
  it('does not republish a completed article or replay an uncertain Post click', async () => {
    h.accounts = h.accounts.slice(0, 2); h.preferences = h.accounts.map(a => ({ accountId: a.id, enabled: true }));
    h.posts = h.accounts.map((a, index) => ({ accountId: a.id, problemSlug: 'today', status: index ? 'PUBLISHING' : 'PUBLISHED' }));
    expect((await runScheduledSolutionPosts(new Date('2026-10-15T00:30:00Z'))).status).toBe('IDLE');
    expect(h.publish).not.toHaveBeenCalled(); expect(h.generate).not.toHaveBeenCalled();
  });
});
