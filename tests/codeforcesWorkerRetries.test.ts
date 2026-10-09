import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  post: vi.fn(), poll: vi.fn(), complete: vi.fn(), patch: vi.fn(), outcomes: vi.fn(), progress: vi.fn(),
}));
vi.mock('../src/database/models', () => ({
  getSystemState: vi.fn(async () => 'proxy'), setSystemState: vi.fn(async () => {}), SystemKeys: { codeforcesNetworkMode: 'route' },
}));
vi.mock('../src/codeforces/storage', () => ({
  listCodeforcesAccounts: vi.fn(async () => [
    { id: 'a1', label: 'first', username: 'first', storageState: '{}' },
    { id: 'a2', label: 'second', username: 'second', storageState: '{}' },
  ]),
  parseStoredCodeforcesState: vi.fn(() => ({ ok: true, state: { cookies: [], origins: [] } })),
  getCodeforcesProgress: vi.fn(async () => ({ nextKey: '8B', lastCompletedKey: null })),
  claimDailyAttempt: vi.fn(async () => true), releaseDailyAttempt: vi.fn(async () => {}), recordAttempt: vi.fn(async () => {}),
  completeCurrentProblem: mocks.complete, patchCodeforcesAccount: mocks.patch,
}));
vi.mock('../src/codeforces/sourceRepo', () => ({
  loadRuntimeSourceIndex: vi.fn(async () => ({ queue: [
    { key: '8B', contestId: 8, problemIndex: 'B', language: 'cpp', problemUrl: 'https://codeforces.com/contest/8/problem/B' },
    { key: '9A', contestId: 9, problemIndex: 'A' },
  ] })),
  fetchSourceCode: vi.fn(async () => 'int main() {return 0;}'),
}));
vi.mock('../src/codeforces/api', () => ({ fetchSolvedProblemKeys: vi.fn(async () => new Set()) }));
vi.mock('../src/codeforces/submission', () => ({
  captureBefore: vi.fn(async () => new Set()), pollForVerdict: mocks.poll,
}));
vi.mock('../src/codeforces/remoteSubmitter', () => ({
  isRemoteSubmitterConfigured: () => true, submitViaRemoteSubmitter: mocks.post,
}));
vi.mock('../src/notifications/telegram', () => ({
  sendTelegramMessage: vi.fn(async () => true),
}));
import { runCodeforcesNow, isAfterCodeforcesSchedule } from '../src/codeforces/worker';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.poll.mockResolvedValue({ id: 101, verdict: 'OK' });
  mocks.post.mockReset();
});
afterEach(() => vi.useRealTimers());
const blocked = { ok: false, kind: 'blocked', clicked: false, safeToRetry: true, error: 'Runner unavailable before opening browser', submittedAt: 1, transport: 'GitHub browser' };
const posted = { ok: true, clicked: true, submittedAt: 1, transport: 'GitHub browser' };

it('preserves the successful account and retries only the failing account with the same source', async () => {
  mocks.post.mockResolvedValueOnce(posted).mockResolvedValueOnce(blocked).mockResolvedValueOnce(blocked).mockResolvedValueOnce(posted);
  const report = await runCodeforcesNow('manual', { forceDailyAttempt: true, onAccountOutcome: mocks.outcomes, onAccountProgress: mocks.progress });
  expect(report?.totals).toMatchObject({ solved: 2, failed: 0 });
  expect(mocks.post.mock.calls.map(call => call[1])).toEqual(['first', 'second', 'second', 'second']);
  expect(mocks.post.mock.calls.map(call => call[3].key)).toEqual(['8B', '8B', '8B', '8B']);
  expect(mocks.complete).toHaveBeenCalledTimes(2);
  expect(mocks.complete.mock.calls[0]).toEqual(['a1', expect.objectContaining({ completedKey: '8B', nextKey: '9A' })]);
  expect(mocks.outcomes).toHaveBeenCalledTimes(2);
  expect(mocks.progress.mock.calls.filter(([event]) => event.label === 'second' && event.phase === 'attempt').map(([event]) => event.attempt)).toEqual([1, 2, 3]);
});

it('ends after three failed attempts, reports the final failure and preserves the failing cursor', async () => {
  mocks.post.mockResolvedValueOnce(posted).mockResolvedValue(blocked);
  const report = await runCodeforcesNow('manual', { forceDailyAttempt: true, onAccountOutcome: mocks.outcomes });
  expect(report?.totals).toMatchObject({ solved: 1, failed: 1 });
  expect(mocks.post).toHaveBeenCalledTimes(4);
  expect(mocks.complete).toHaveBeenCalledTimes(1);
  expect(mocks.outcomes.mock.calls[1][0]).toMatchObject({ label: 'second', kind: 'failed', performed: false, error: 'Runner unavailable before opening browser (GitHub browser)' });
});

it('pauses a challenged account at its first failure without skipping its source or stopping other accounts', async () => {
  vi.useFakeTimers();
  mocks.post.mockResolvedValueOnce({ ...blocked, error: 'Codeforces Turnstile did not issue a token within 35000ms' })
    .mockResolvedValue(posted);
  const run = runCodeforcesNow('manual', { batchCount: 3, forceDailyAttempt: true, onAccountOutcome: mocks.outcomes });
  await vi.runAllTimersAsync();
  const report = await run;
  expect(mocks.post.mock.calls.map(call => call[1])).toEqual(['first', 'second', 'second', 'second']);
  expect(mocks.complete.mock.calls.every(([id]) => id === 'a2')).toBe(true);
  expect(mocks.outcomes.mock.calls[0][0]).toMatchObject({ performed: false, note: expect.stringContaining('batch is paused') });
  expect(mocks.outcomes).toHaveBeenCalledTimes(4);
  expect(report?.totals).toMatchObject({ solved: 3, failed: 1 });
});

it('never marks an unsubmitted source completed after repeated transport failures in a batch', async () => {
  vi.useFakeTimers();
  mocks.post.mockResolvedValue(blocked);
  const run = runCodeforcesNow('manual', { batchCount: 4, forceDailyAttempt: true, onAccountOutcome: mocks.outcomes });
  await vi.runAllTimersAsync();
  const report = await run;
  expect(mocks.post).toHaveBeenCalledTimes(6); // Three bounded transport retries per account, one batch step.
  expect(mocks.complete).not.toHaveBeenCalled();
  expect(mocks.outcomes).toHaveBeenCalledTimes(2);
  expect(report?.totals).toMatchObject({ solved: 0, failed: 2 });
});

it('reconciles an uncertain POST without dispatching another job', async () => {
  mocks.post.mockResolvedValueOnce(posted).mockResolvedValue({ ...blocked, clicked: true, safeToRetry: false, error: 'outcome is uncertain' });
  mocks.poll.mockResolvedValueOnce({ id: 101, verdict: 'OK' }).mockResolvedValueOnce(null);
  const report = await runCodeforcesNow('manual', { forceDailyAttempt: true, onAccountOutcome: mocks.outcomes });
  expect(mocks.post).toHaveBeenCalledTimes(2);
  expect(mocks.poll).toHaveBeenCalledTimes(2);
  expect(mocks.complete).toHaveBeenCalledTimes(1);
  expect(report?.totals).toMatchObject({ solved: 1, failed: 1 });
});

it('marks every Codeforces final verdict as performed and advances its source cursor', async () => {
  for (const verdict of ['WRONG_ANSWER', 'TIME_LIMIT_EXCEEDED', 'RUNTIME_ERROR', 'COMPILATION_ERROR']) {
    vi.clearAllMocks();
    mocks.post.mockResolvedValue(posted);
    mocks.poll.mockResolvedValue({ id: 1000 + verdict.length, verdict });
    const report = await runCodeforcesNow('manual', { forceDailyAttempt: true });
    expect(report?.accounts).toHaveLength(2);
    expect(report?.accounts.every(row => row.performed && row.verdict === verdict)).toBe(true);
    expect(mocks.complete).toHaveBeenCalledTimes(2);
    expect(mocks.complete).toHaveBeenLastCalledWith('a2', expect.objectContaining({ completedKey: '8B', nextKey: '9A', verdict }));
  }
});

it('correctly determines whether the current time is after the scheduled Codeforces time', () => {
  // 09:30 IST is 04:00 UTC
  expect(isAfterCodeforcesSchedule(new Date('2026-10-06T03:59:00.000Z'), 9, 30, 'Asia/Kolkata')).toBe(false); // 09:29 IST
  expect(isAfterCodeforcesSchedule(new Date('2026-10-06T04:00:00.000Z'), 9, 30, 'Asia/Kolkata')).toBe(false); // 09:30 IST
  expect(isAfterCodeforcesSchedule(new Date('2026-10-06T04:01:00.000Z'), 9, 30, 'Asia/Kolkata')).toBe(true);  // 09:31 IST
});

it('sends starting notification and final verdict report when reason is cron', async () => {
  const { sendTelegramMessage } = await import('../src/notifications/telegram');
  vi.mocked(sendTelegramMessage).mockClear();
  mocks.post.mockResolvedValue(posted);
  mocks.poll.mockResolvedValue({ id: 101, verdict: 'OK' });
  const report = await runCodeforcesNow('cron', { forceDailyAttempt: true });
  expect(report?.totals).toMatchObject({ solved: 2, failed: 0 });
  expect(sendTelegramMessage).toHaveBeenCalledTimes(2);
  expect(vi.mocked(sendTelegramMessage).mock.calls[0]?.[0]).toContain('Starting daily submission for Codeforces');
  expect(vi.mocked(sendTelegramMessage).mock.calls[1]?.[0]).toContain('Codeforces Daily');
});
