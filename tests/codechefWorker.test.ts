import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCodeChefNow, codeChefSchedule, nextCodeChefSource, isAfterCodeChefSchedule } from '../src/codechef/worker';
import * as storage from '../src/codechef/storage';
import { submitDirectlyViaCodeChefApi, submitToCodeChef } from '../src/codechef/api';
import { loginToCodeChef } from '../src/codechef/auth';
import { isRunInProgress } from '../src/scheduler/dailyWorker';
import type { CodeChefSourceEntry } from '../src/codechef/sourceRepo';

vi.mock('../src/codechef/storage', () => ({
  ensureCodeChefAccountsSeeded: vi.fn(), listCodeChefAccounts: vi.fn(), patchCodeChefAccount: vi.fn(),
  getCodeChefProgress: vi.fn(), completeCurrentProblem: vi.fn(), claimDailyAttempt: vi.fn(), releaseDailyAttempt: vi.fn(), recordAttempt: vi.fn(),
}));
vi.mock('../src/codechef/sourceRepo', () => ({ loadCodeChefSourceIndex: vi.fn(async () => [
  { problemCode: 'AAA', problemUrl: 'https://www.codechef.com/problems/AAA', language: 'cpp' },
  { problemCode: 'BBB', problemUrl: 'https://www.codechef.com/problems/BBB', language: 'cpp' },
]), fetchSourceCode: vi.fn(async () => 'code') }));
vi.mock('../src/codechef/browser', () => ({ withCodeChefPage: vi.fn(async (_state, action) => action({})) }));
vi.mock('../src/codechef/auth', () => ({ loginToCodeChef: vi.fn(), loginOnCodeChefPage: vi.fn() }));
vi.mock('../src/codechef/api', () => ({
  submitDirectlyViaCodeChefApi: vi.fn(),
  submitToCodeChef: vi.fn(),
  submitOnCodeChefPage: vi.fn(),
}));
vi.mock('../src/scheduler/dailyWorker', () => ({ isRunInProgress: vi.fn(() => false) }));
vi.mock('../src/notifications/telegram', () => ({ sendTelegramMessage: vi.fn(async () => true) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isRunInProgress).mockReturnValue(false);
  vi.mocked(storage.patchCodeChefAccount).mockResolvedValue({} as never);
  vi.mocked(storage.releaseDailyAttempt).mockResolvedValue(undefined);
  vi.mocked(storage.listCodeChefAccounts).mockResolvedValue([{ id: 'account', label: 'tester', username: 'tester', storageState: JSON.stringify({ cookies: [{ name: 'session' }], origins: [] }) }] as never);
  vi.mocked(storage.getCodeChefProgress).mockResolvedValue({ nextKey: 'AAA', lastCompletedKey: null, lastAttemptDate: null } as never);
  vi.mocked(storage.claimDailyAttempt).mockResolvedValue(true);
});

describe('CodeChef daily progress', () => {
  it('advances after any confirmed terminal verdict, preserving the submission ID', async () => {
    vi.mocked(submitDirectlyViaCodeChefApi).mockResolvedValue({ ok: false, performed: true, clicked: true, submissionId: '123', verdict: 'Wrong Answer' });
    const report = await runCodeChefNow();
    expect(storage.completeCurrentProblem).toHaveBeenCalledWith('account', { completedKey: 'AAA', nextKey: 'BBB', submissionId: '123', verdict: 'Wrong Answer' });
    expect(report?.outcomes[0]?.performed).toBe(true);
    expect(storage.releaseDailyAttempt).not.toHaveBeenCalled();
  });
  it('never submits when another worker already owns today’s attempt', async () => {
    vi.mocked(storage.claimDailyAttempt).mockResolvedValue(false);
    const report = await runCodeChefNow();
    expect(submitDirectlyViaCodeChefApi).not.toHaveBeenCalled();
    expect(report?.outcomes[0]?.skipped).toBe(true);
  });
  it('retains an ambiguous click claim without advancing or claiming a submission date', async () => {
    vi.mocked(submitDirectlyViaCodeChefApi).mockResolvedValue({ ok: false, clicked: true, verdict: 'UNKNOWN', error: 'No confirmed ID' });
    await runCodeChefNow();
    expect(storage.completeCurrentProblem).not.toHaveBeenCalled();
    expect(storage.releaseDailyAttempt).not.toHaveBeenCalled();
    expect(storage.patchCodeChefAccount).not.toHaveBeenCalledWith('account', expect.objectContaining({ lastSubmissionDate: expect.any(String) }));
  });
  it('releases a claim if preparation failed before Submit', async () => {
    vi.mocked(submitDirectlyViaCodeChefApi).mockResolvedValue({ ok: false, clicked: false, kind: 'error', error: 'Editor not ready' });
    vi.mocked(submitToCodeChef).mockResolvedValue({ ok: false, clicked: false, error: 'Editor not ready' });
    await runCodeChefNow();
    expect(storage.releaseDailyAttempt).toHaveBeenCalledOnce();
    expect(storage.completeCurrentProblem).not.toHaveBeenCalled();
  });
  it('releases failed login claims and reports failure instead of saving false success', async () => {
    vi.mocked(storage.listCodeChefAccounts).mockResolvedValue([{ id: 'account', label: 'tester', storageState: JSON.stringify({ username: 'tester', password: 'fixture', cookies: [] }) }] as never);
    vi.mocked(loginToCodeChef).mockRejectedValue(new Error('Login not verified'));
    const report = await runCodeChefNow();
    expect(report?.outcomes[0]?.error).toBe('Login not verified');
    expect(storage.releaseDailyAttempt).toHaveBeenCalledOnce();
    expect(submitDirectlyViaCodeChefApi).not.toHaveBeenCalled();
  });
  it('defers to an active LeetCode run before taking a daily claim', async () => {
    vi.mocked(isRunInProgress).mockReturnValue(true);
    const report = await runCodeChefNow();
    expect(report?.outcomes[0]?.error).toContain('deferred');
    expect(storage.claimDailyAttempt).not.toHaveBeenCalled();
  });
  it('wraps the scheduler across midnight and never restarts a missing progress key', () => {
    expect(codeChefSchedule(23, 55)).toBe('5 0 * * *');
    expect(codeChefSchedule(9, 0)).toBe('10 9 * * *');
    const queue = [{ problemCode: 'AAA' }] as CodeChefSourceEntry[];
    expect(nextCodeChefSource(queue, { nextKey: null, lastCompletedKey: 'AAA' })).toBe(1);
    expect(() => nextCodeChefSource(queue, { nextKey: 'MISSING', lastCompletedKey: null })).toThrow('missing');
  });
  it('correctly determines whether the current time is after the scheduled CodeChef time', () => {
    // 08:15 IST is 02:45 UTC
    expect(isAfterCodeChefSchedule(new Date('2026-10-06T02:44:00.000Z'), 8, 15, 'Asia/Kolkata')).toBe(false); // 08:14 IST
    expect(isAfterCodeChefSchedule(new Date('2026-10-06T02:45:00.000Z'), 8, 15, 'Asia/Kolkata')).toBe(false); // 08:15 IST
    expect(isAfterCodeChefSchedule(new Date('2026-10-06T02:46:00.000Z'), 8, 15, 'Asia/Kolkata')).toBe(true);  // 08:16 IST
  });
});
