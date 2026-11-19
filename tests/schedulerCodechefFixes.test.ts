import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountStatus, CodeChefAccountStatus, RunState } from '@prisma/client';
import { chromium, request as playwrightRequest } from 'playwright';
import { RangeRequestGate } from '../src/scheduler/rangeRequestGate';
import { LeetCodeHttpError } from '../src/leetcode/apiClient';
import {
  abortableSleep,
  cancelRangeJob,
  currentRangeJob,
  openRequestSession,
  startRangeJob,
  __resetRangeJobForTests,
} from '../src/scheduler/rangeSubmission';

const mockedIds = new Set<string>();
function doMock(id: string, factory: () => unknown): void {
  mockedIds.add(id);
  vi.doMock(id, factory);
}

describe('scheduler & codechef regression fixes', () => {
  afterEach(() => {
    for (const id of mockedIds) vi.doUnmock(id);
    mockedIds.clear();
    vi.restoreAllMocks();
    vi.resetModules();
    vi.useRealTimers();
    __resetRangeJobForTests();
  });

  describe('dailyWorker fixes', () => {
    it('guards auto-refresh against infinite recursion, forwards expectedChallengeDate, and avoids double session.close()', async () => {
      vi.resetModules();
      const closeFn = vi.fn(async () => undefined);
      const refreshFn = vi.fn(async () => ({ status: 'refreshed' as const, site: 'leetcode' as const, label: 'a1' }));
      const checkSessionFn = vi.fn(async () => ({ authenticated: false, cause: 'signed-out' as const }));
      const patchAccountFn = vi.fn(async () => undefined);
      const account = {
        id: 'acc-1',
        label: 'a1',
        username: 'alice',
        status: AccountStatus.ACTIVE,
        storageState: JSON.stringify({ cookies: [{ name: 'LEETCODE_SESSION', value: 'v1' }], origins: [] }),
      };

      doMock('../src/database/accounts', () => ({
        ensureAccountsSeeded: vi.fn(async () => undefined),
        listEnabledAccounts: vi.fn(async () => [account]),
        getAccountById: vi.fn(async () => ({ ...account, storageState: JSON.stringify({ cookies: [{ name: 'LEETCODE_SESSION', value: 'v2' }], origins: [] }) })),
        parseStoredStorageState: (raw: string) => ({ ok: true as const, state: JSON.parse(raw) }),
        patchAccount: patchAccountFn,
      }));
      doMock('../src/security/sessionAutoRefresh', () => ({ refreshLeetCodeAccount: refreshFn }));
      doMock('../src/browser/playwright', () => ({
        launchWithStorageStateObject: vi.fn(async () => ({ context: {}, page: {}, close: closeFn })),
      }));
      doMock('../src/browser/sessionCheck', () => ({ checkSession: checkSessionFn }));
      doMock('../src/browser/diagnostics', () => ({ captureDiagnostics: vi.fn(), pruneDiagnostics: vi.fn() }));
      doMock('../src/recovery/runtime', () => ({ reportAccountSessionDown: vi.fn() }));
      doMock('../src/notifications/notifier', () => ({ notifyMultiRunReport: vi.fn(async () => undefined) }));
      doMock('../src/notifications/telegram', () => ({ sendTelegramMessage: vi.fn(async () => true) }));
      doMock('../src/database/models', async () => ({
        RunState,
        SystemKeys: { lastReport: 'lastReport', dailyRetryState: 'dailyRetryState', lastRunSummary: 'lastRunSummary' },
        getSystemState: vi.fn(async () => null),
        setSystemState: vi.fn(async () => undefined),
      }));

      const { executeDailyRun } = await import('../src/scheduler/dailyWorker');
      const report = await executeDailyRun('manual-cli');

      expect(refreshFn).toHaveBeenCalledTimes(1);
      expect(checkSessionFn).toHaveBeenCalledTimes(2);
      expect(closeFn).toHaveBeenCalledTimes(2);
      expect(report.accounts[0]?.kind).toBe('rejected');
      expect(patchAccountFn).toHaveBeenCalledWith('acc-1', expect.objectContaining({ status: AccountStatus.REJECTED }));

      // Verify expectedChallengeDate is forwarded across auto-refresh
      vi.resetModules();
      let checkCount = 0;
      const submitSpy = vi.fn(async () => 'sub-1');
      doMock('../src/database/accounts', () => ({
        ensureAccountsSeeded: vi.fn(async () => undefined),
        listEnabledAccounts: vi.fn(async () => [account]),
        getAccountById: vi.fn(async () => account),
        parseStoredStorageState: (raw: string) => ({ ok: true as const, state: JSON.parse(raw) }),
        patchAccount: vi.fn(async () => undefined),
      }));
      doMock('../src/security/sessionAutoRefresh', () => ({ refreshLeetCodeAccount: refreshFn }));
      doMock('../src/browser/playwright', () => ({
        launchWithStorageStateObject: vi.fn(async () => ({ context: {}, page: {}, close: async () => undefined })),
      }));
      doMock('../src/browser/sessionCheck', () => ({
        checkSession: vi.fn(async () => (++checkCount === 1 ? { authenticated: false, cause: 'signed-out' } : { authenticated: true, username: 'alice' })),
      }));
      doMock('../src/leetcode/dailyCheckin', () => ({ claimDailyCheckin: vi.fn(async () => ({ checkedIn: false, awarded: false })) }));
      doMock('../src/leetcode/contestReward', () => ({ claimContestReward: vi.fn(async () => ({ claimed: false })) }));
      doMock('../src/leetcode/dailyChallenge', async (orig) => ({
        ...((await orig()) as object),
        fetchDailyChallenge: vi.fn(async () => ({ date: '2026-11-16', slug: 'old-slug', title: 'Old', difficulty: 'Easy' })),
      }));
      doMock('../src/leetcode/apiClient', async (orig) => ({
        ...((await orig()) as object),
        LeetCodeApi: class { submitSolution = submitSpy; },
      }));
      doMock('../src/browser/diagnostics', () => ({ captureDiagnostics: vi.fn(), pruneDiagnostics: vi.fn() }));
      doMock('../src/notifications/notifier', () => ({ notifyMultiRunReport: vi.fn(async () => undefined) }));
      doMock('../src/database/models', async () => ({
        RunState,
        SystemKeys: { lastReport: 'lastReport', dailyRetryState: 'dailyRetryState', lastRunSummary: 'lastRunSummary' },
        getSystemState: vi.fn(async () => null),
        setSystemState: vi.fn(async () => undefined),
      }));

      const { executeDailyRun: executeDailyRun2 } = await import('../src/scheduler/dailyWorker');
      const report2 = await executeDailyRun2('solution-post-combined', {
        accountIds: ['acc-1'],
        expectedChallengeDate: '2026-11-17',
      });
      expect(report2.accounts[0]?.error).toContain('Daily challenge date has not refreshed');
      expect(submitSpy).not.toHaveBeenCalled();
    });

    it('never upgrades HTTP 429 to ghost browser, skips secondary fallback on non-judge errors/timeouts, and preserves ghost-rotated cookies', async () => {
      vi.resetModules();
      const ghostSubmitFn = vi.fn();
      const persistRotatedFn = vi.fn(async () => true);
      const walkcccFn = vi.fn(async () => ({ code: 'class Solution { public: int f() { return 2; } };', sourceUrl: 'walk-url' }));
      const commFn = vi.fn(async () => ({ code: 'class Solution { public: int f() { return 1; } };', sourceUrl: 'comm-url', title: 'Comm', uuid: 'u-1', rankIndex: 1 }));
      const addCookiesFn = vi.fn(async () => undefined);
      const submitFn = vi.fn();
      const awaitFn = vi.fn();

      const account = {
        id: 'acc-1',
        label: 'a1',
        username: 'alice',
        status: AccountStatus.ACTIVE,
        storageState: JSON.stringify({ cookies: [{ name: 'LEETCODE_SESSION', value: 'old' }], origins: [] }),
      };

      doMock('../src/config', async (orig) => {
        const real = (await orig()) as { config: Record<string, unknown> };
        return { config: { ...real.config, transport: 'api', solution: { ...(real.config.solution as object), source: 'community' }, llm: { ...(real.config.llm as object), language: 'cpp' } } };
      });
      doMock('../src/database/accounts', () => ({
        ensureAccountsSeeded: vi.fn(async () => undefined),
        listEnabledAccounts: vi.fn(async () => [account]),
        getAccountById: vi.fn(async () => account),
        parseStoredStorageState: (raw: string) => ({ ok: true as const, state: JSON.parse(raw) }),
        patchAccount: vi.fn(async () => undefined),
      }));
      doMock('../src/browser/playwright', () => ({
        launchWithStorageStateObject: vi.fn(async () => ({ context: { addCookies: addCookiesFn }, page: {}, close: async () => undefined })),
      }));
      doMock('../src/browser/sessionCheck', () => ({ checkSession: vi.fn(async () => ({ authenticated: true, username: 'alice' })) }));
      doMock('../src/browser/diagnostics', () => ({ captureDiagnostics: vi.fn(), pruneDiagnostics: vi.fn() }));
      doMock('../src/leetcode/dailyCheckin', () => ({ claimDailyCheckin: vi.fn(async () => ({ checkedIn: false, awarded: false })) }));
      doMock('../src/leetcode/contestReward', () => ({ claimContestReward: vi.fn(async () => ({ claimed: false })) }));
      doMock('../src/leetcode/dailyChallenge', async (orig) => ({
        ...((await orig()) as object),
        fetchDailyChallenge: vi.fn(async () => ({ date: '2026-11-17', slug: 'daily-q', title: 'Daily Q', difficulty: 'Easy' })),
        fetchQuestionData: vi.fn(async () => ({})),
      }));
      doMock('../src/leetcode/parser', async (orig) => ({
        ...((await orig()) as object),
        parseProblem: () => ({ frontendId: '1', slug: 'daily-q', questionId: '101', starterCode: 'class Solution { public: int f() {} };' }),
      }));
      doMock('../src/solutions/communitySolutions', () => ({ fetchCommunitySolution: commFn }));
      doMock('../src/solutions/walkccc', async (orig) => ({
        ...((await orig()) as object),
        fetchWalkcccSolution: walkcccFn,
        signatureMatchesStarter: () => true,
      }));
      doMock('../src/leetcode/ghostSubmit', () => ({ submitViaGhostBrowser: ghostSubmitFn }));
      doMock('../src/leetcode/sessionManager', () => ({ persistRotatedCookiesFromContext: persistRotatedFn }));
      doMock('../src/notifications/notifier', () => ({ notifyMultiRunReport: vi.fn(async () => undefined) }));
      doMock('../src/database/models', async () => ({
        RunState,
        SystemKeys: { lastReport: 'lastReport', dailyRetryState: 'dailyRetryState', lastRunSummary: 'lastRunSummary' },
        getSystemState: vi.fn(async () => null),
        setSystemState: vi.fn(async () => undefined),
        findRunByDate: vi.fn(async () => null),
        createRun: vi.fn(async (input: Record<string, unknown>) => ({ id: 'run-1', ...input, updatedAt: new Date() })),
        updateRun: vi.fn(async (_id: string, data: Record<string, unknown>) => ({ id: 'run-1', date: '2026-11-17', problemSlug: 'daily-q', ...data, updatedAt: new Date() })),
        finalizeRun: vi.fn(async (_id: string, state: RunState, extra: Record<string, unknown>) => ({
          id: 'run-1', date: '2026-11-17', problemSlug: 'daily-q', state, submissionId: null, submissionStatus: null, runtime: null, memory: null, error: null, updatedAt: new Date(), ...extra,
        })),
      }));
      doMock('../src/leetcode/apiClient', async (orig) => {
        const real = (await orig()) as object;
        return {
          ...real,
          LeetCodeApi: class { submitSolution = submitFn; awaitSubmission = awaitFn; },
        };
      });

      const { LeetCodeHttpError: FreshHttpError } = await import('../src/leetcode/apiClient');
      const { executeDailyRun } = await import('../src/scheduler/dailyWorker');

      // 1a) Transient HTTP 429 HTML backs off, retries in-place, and succeeds without ghost browser or walkccc fallback
      const sleeps: number[] = [];
      submitFn
        .mockRejectedValueOnce(new FreshHttpError('submit HTTP 429: 429 Too Many Requests', 429, 25))
        .mockResolvedValueOnce('sub-after-429');
      awaitFn.mockResolvedValueOnce({
        submissionId: 'sub-after-429',
        classification: 'ACCEPTED',
        statusDisplay: 'Accepted',
        runtime: '2 ms',
        memory: '37 MB',
        rawStatusMsg: 'Accepted',
      });
      const res429Recovered = await executeDailyRun('manual-cli', {
        rateLimitBackoffMs: [10, 20],
        sleep: async (ms) => { sleeps.push(ms); },
      });
      expect(res429Recovered.accounts[0]?.state).toBe(RunState.SUCCESS);
      expect(res429Recovered.accounts[0]?.submissionId).toBe('sub-after-429');
      expect(sleeps).toHaveLength(1);
      expect(sleeps[0]).toBeGreaterThan(0);
      expect(ghostSubmitFn).not.toHaveBeenCalled();
      expect(walkcccFn).not.toHaveBeenCalled();

      // 1b) Exhausted HTTP 429 must NEVER report CLOUDFLARE_VERIFICATION_REQUIRED, never invoke ghost browser, and never trigger secondary fallback
      const exhaustedSleeps: number[] = [];
      submitFn
        .mockRejectedValueOnce(new FreshHttpError('submit HTTP 429: <!DOCTYPE html> <html> <head> <meta charset="utf-8">', 429))
        .mockRejectedValueOnce(new FreshHttpError('submit HTTP 429: <!DOCTYPE html> <html> <head> <meta charset="utf-8">', 429))
        .mockRejectedValueOnce(new FreshHttpError('submit HTTP 429: <!DOCTYPE html> <html> <head> <meta charset="utf-8">', 429));
      const res429 = await executeDailyRun('manual-cli', {
        rateLimitBackoffMs: [10, 20],
        sleep: async (ms) => { exhaustedSleeps.push(ms); },
      });
      expect(res429.accounts[0]?.state).toBe(RunState.SUBMISSION_ERROR);
      expect(res429.accounts[0]?.error).toContain('rate limited');
      expect(res429.accounts[0]?.error).toContain('HTTP 429');
      expect(res429.accounts[0]?.error).not.toContain('<!DOCTYPE');
      expect(exhaustedSleeps).toHaveLength(2);
      expect(ghostSubmitFn).not.toHaveBeenCalled();
      expect(walkcccFn).not.toHaveBeenCalled();

      // 2) Judge polling timeout must NOT trigger secondary fallback
      submitFn.mockResolvedValueOnce('sub-timeout');
      awaitFn.mockResolvedValueOnce({
        submissionId: 'sub-timeout',
        classification: 'UNKNOWN',
        statusDisplay: 'PENDING',
        runtime: null,
        memory: null,
        rawStatusMsg: 'judge polling timed out after 180s',
      });
      const resTimeout = await executeDailyRun('manual-cli');
      expect(resTimeout.accounts[0]?.state).toBe(RunState.SUBMISSION_REJECTED);
      expect(walkcccFn).not.toHaveBeenCalled();

      // 3) Judge rejection (non-timeout) triggers walkccc fallback, and 403 challenge upgrades to ghost without end-of-run clobber
      persistRotatedFn.mockClear();
      submitFn.mockRejectedValueOnce(new FreshHttpError('submit HTTP 403: <!DOCTYPE html><title>Just a moment...</title>', 403));
      const ghostState = { cookies: [{ name: 'cf_clearance', value: 'fresh_cf' }, { name: 'LEETCODE_SESSION', value: 'rotated' }], origins: [] };
      ghostSubmitFn.mockImplementationOnce(async (_state, params) => {
        await params.onStorageState?.(ghostState);
        return { submissionId: 'sub-ghost', storageState: ghostState };
      });
      awaitFn
        .mockResolvedValueOnce({
          submissionId: 'sub-ghost',
          classification: 'WRONG_ANSWER',
          statusDisplay: 'Wrong Answer',
          runtime: null,
          memory: null,
          rawStatusMsg: 'Wrong Answer',
        })
        .mockResolvedValueOnce({
          submissionId: 'sub-fallback',
          classification: 'ACCEPTED',
          statusDisplay: 'Accepted',
          runtime: '1 ms',
          memory: '8 MB',
          rawStatusMsg: 'Accepted',
        });
      submitFn.mockResolvedValueOnce('sub-fallback');

      const resGhost = await executeDailyRun('manual-cli');
      expect(resGhost.accounts[0]?.kind).toBe('solved');
      expect(walkcccFn).toHaveBeenCalledTimes(1);
      expect(addCookiesFn).toHaveBeenCalledWith(ghostState.cookies);
      // Only ghost onStorageState called persistRotatedCookiesFromContext, NOT line ~649
      expect(persistRotatedFn).toHaveBeenCalledTimes(1);
    });

    it('increments dailyRetryState before triggerRun, rolls back on !started, and preserves count on DB read failure', async () => {
      vi.resetModules();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.parse('2026-11-17T04:00:00.000Z')); // 09:30 IST

      const stateStore = new Map<string, string>();
      const getSystemStateFn = vi.fn(async (k: string) => stateStore.get(k) ?? null);
      const setSystemStateFn = vi.fn(async (k: string, v: string) => { stateStore.set(k, v); });
      const account = { id: 'acc-1', label: 'a1', username: 'alice', status: AccountStatus.ACTIVE, storageState: '{}' };

      doMock('../src/database/prisma', () => ({
        prisma: {
          account: { findMany: vi.fn(async () => [{ id: 'acc-1' }]) },
          dailyRun: { findMany: vi.fn(async () => []) },
        },
      }));
      doMock('../src/database/accounts', () => ({
        ensureAccountsSeeded: vi.fn(async () => undefined),
        listEnabledAccounts: vi.fn(async () => [account]),
        getAccountById: vi.fn(async () => account),
        parseStoredStorageState: () => ({ ok: false as const, error: 'bad state' }),
        patchAccount: vi.fn(async () => undefined),
      }));
      doMock('../src/database/models', async () => ({
        RunState,
        SystemKeys: { lastReport: 'lastReport', dailyRetryState: 'dailyRetryState', lastRunSummary: 'lastRunSummary' },
        getSystemState: getSystemStateFn,
        setSystemState: setSystemStateFn,
      }));
      doMock('../src/notifications/notifier', () => ({ notifyMultiRunReport: vi.fn(async () => undefined) }));
      doMock('../src/notifications/telegram', () => ({ sendTelegramMessage: vi.fn(async () => true) }));
      doMock('../src/browser/diagnostics', () => ({ captureDiagnostics: vi.fn(), pruneDiagnostics: vi.fn() }));

      const { executeDailyRun, triggerDailyRetry, resetDailyRetryPollGate } = await import('../src/scheduler/dailyWorker');
      resetDailyRetryPollGate();

      let releaseConcurrent!: () => void;
      const concurrentHold = new Promise<void>((r) => { releaseConcurrent = r; });
      let concurrentPromise: Promise<unknown> | null = null;
      setSystemStateFn.mockImplementationOnce(async (k, v) => {
        stateStore.set(k, v);
        getSystemStateFn.mockImplementationOnce(async () => {
          await concurrentHold;
          return stateStore.get(k) ?? null;
        });
        concurrentPromise = executeDailyRun('manual-cli');
      });

      await triggerDailyRetry();
      expect(JSON.parse(stateStore.get('dailyRetryState')!)).toMatchObject({ date: '2026-11-17', count: 0 });
      releaseConcurrent();
      await concurrentPromise;

      // executeDailyRun DB read failure must not reset count: 3 back to 0
      stateStore.set('dailyRetryState', JSON.stringify({ date: '2026-11-17', count: 3, lastAttemptAt: 1000 }));
      setSystemStateFn.mockClear();
      getSystemStateFn.mockRejectedValueOnce(new Error('DB transient timeout'));
      await executeDailyRun('cron');
      expect(setSystemStateFn).not.toHaveBeenCalledWith('dailyRetryState', expect.anything());
      expect(JSON.parse(stateStore.get('dailyRetryState')!).count).toBe(3);

      // Negative count is sanitized back to 0
      stateStore.set('dailyRetryState', JSON.stringify({ date: '2026-11-17', count: -5, lastAttemptAt: 1000 }));
      getSystemStateFn.mockImplementation(async (k) => stateStore.get(k) ?? null);
      await executeDailyRun('cron');
      expect(JSON.parse(stateStore.get('dailyRetryState')!).count).toBe(0);
    });

    it('paces consecutive multi-account daily submissions and caches daily/question metadata per batch', async () => {
      vi.resetModules();
      const accounts = ['a1', 'a2', 'a3'].map((label) => ({
        id: `acc-${label}`,
        label,
        username: label,
        status: AccountStatus.ACTIVE,
        storageState: JSON.stringify({ cookies: [], origins: [] }),
      }));
      const fetchDailyFn = vi.fn(async () => ({ date: '2026-11-19', slug: 'daily-q', title: 'Daily Q', difficulty: 'Medium' }));
      const fetchQuestionFn = vi.fn(async () => ({}));
      const submitFn = vi.fn(async () => 'sub-ok');
      const awaitFn = vi.fn(async () => ({
        submissionId: 'sub-ok',
        classification: 'ACCEPTED',
        statusDisplay: 'Accepted',
        runtime: '1 ms',
        memory: '37 MB',
        rawStatusMsg: 'Accepted',
      }));

      doMock('../src/database/accounts', () => ({
        ensureAccountsSeeded: vi.fn(async () => undefined),
        listEnabledAccounts: vi.fn(async () => accounts),
        getAccountById: vi.fn(async (id: string) => accounts.find((a) => a.id === id) ?? null),
        parseStoredStorageState: (raw: string) => ({ ok: true as const, state: JSON.parse(raw) }),
        patchAccount: vi.fn(async () => undefined),
      }));
      doMock('../src/browser/playwright', () => ({
        launchWithStorageStateObject: vi.fn(async () => ({ context: { addCookies: vi.fn() }, page: {}, close: async () => undefined })),
      }));
      doMock('../src/browser/sessionCheck', () => ({
        checkSession: vi.fn(async () => ({ authenticated: true, username: 'u' })),
      }));
      doMock('../src/browser/diagnostics', () => ({ captureDiagnostics: vi.fn(), pruneDiagnostics: vi.fn() }));
      doMock('../src/leetcode/dailyCheckin', () => ({ claimDailyCheckin: vi.fn(async () => ({ checkedIn: true, awarded: false })) }));
      doMock('../src/leetcode/contestReward', () => ({ claimContestReward: vi.fn(async () => ({ claimed: false })) }));
      doMock('../src/leetcode/dailyChallenge', async (orig) => ({
        ...((await orig()) as object),
        fetchDailyChallenge: fetchDailyFn,
        fetchQuestionData: fetchQuestionFn,
      }));
      doMock('../src/leetcode/parser', async (orig) => ({
        ...((await orig()) as object),
        parseProblem: () => ({ frontendId: '2567', slug: 'daily-q', questionId: '2567', starterCode: 'class Solution { public: int f() {} };' }),
      }));
      doMock('../src/solutions/communitySolutions', () => ({
        fetchCommunitySolution: vi.fn(async () => ({
          code: 'class Solution { public: int f() { return 0; } };',
          uuid: 'u-1',
          sourceUrl: 'https://leetcode.com/solutions/1',
          title: 'Sol',
          rankIndex: 1,
        })),
      }));
      doMock('../src/leetcode/sessionManager', () => ({ persistRotatedCookiesFromContext: vi.fn(async () => undefined) }));
      doMock('../src/notifications/notifier', () => ({ notifyMultiRunReport: vi.fn(async () => undefined) }));
      doMock('../src/database/models', async () => ({
        RunState,
        SystemKeys: { lastReport: 'lastReport', dailyRetryState: 'dailyRetryState', lastRunSummary: 'lastRunSummary' },
        getSystemState: vi.fn(async () => null),
        setSystemState: vi.fn(async () => undefined),
        findRunByDate: vi.fn(async () => null),
        createRun: vi.fn(async (input: Record<string, unknown>) => ({ id: `run-${input.accountId}`, ...input, updatedAt: new Date() })),
        updateRun: vi.fn(async (id: string, data: Record<string, unknown>) => ({ id, date: '2026-11-19', problemSlug: 'daily-q', ...data, updatedAt: new Date() })),
        finalizeRun: vi.fn(async (id: string, state: RunState, extra: Record<string, unknown>) => ({
          id, date: '2026-11-19', problemSlug: 'daily-q', state, submissionId: null, submissionStatus: null, runtime: null, memory: null, error: null, updatedAt: new Date(), ...extra,
        })),
      }));
      doMock('../src/leetcode/apiClient', async (orig) => {
        const real = (await orig()) as object;
        return {
          ...real,
          LeetCodeApi: class { submitSolution = submitFn; awaitSubmission = awaitFn; },
        };
      });

      const { executeDailyRun } = await import('../src/scheduler/dailyWorker');
      const waits: number[] = [];
      const report = await executeDailyRun('manual-cli', {
        submitGapMs: 15_000,
        sleep: async (ms) => { waits.push(ms); },
      });
      expect(report.totals.solved).toBe(3);
      expect(fetchDailyFn).toHaveBeenCalledTimes(1);
      expect(fetchQuestionFn).toHaveBeenCalledTimes(1);
      expect(submitFn).toHaveBeenCalledTimes(3);
      expect(waits).toHaveLength(2);
      expect(waits[0]).toBeGreaterThan(10_000);
      expect(waits[1]).toBeGreaterThan(10_000);
    });
  });

  describe('codechef fixes', () => {
    it('excludes exhausted & ambiguous accounts on subsequent retries, isolates per-account prep errors, auto-recovers retired shuffled batches, and rejects verdict without submissionId', async () => {
      vi.resetModules();
      const systemMap = new Map<string, string>();
      const submitApiFn = vi.fn();
      const patchAccountFn = vi.fn(async () => undefined);
      const completeFn = vi.fn(async () => undefined);
      const releaseFn = vi.fn(async () => undefined);
      const recordAttemptFn = vi.fn(async () => undefined);
      const accounts = [
        { id: 'cc-1', label: 'chef1', username: 'chef1', status: CodeChefAccountStatus.ACTIVE, lastSubmissionDate: null },
        { id: 'cc-2', label: 'chef2', username: 'chef2', status: CodeChefAccountStatus.ACTIVE, lastSubmissionDate: null },
      ];

      doMock('../src/database/models', () => ({
        SystemKeys: { codechefDailyState: 'codechefDailyState' },
        getSystemState: vi.fn(async (k: string) => systemMap.get(k) ?? null),
        setSystemState: vi.fn(async (k: string, v: string) => { systemMap.set(k, v); }),
        deleteSystemState: vi.fn(async (k: string) => { systemMap.delete(k); }),
      }));
      doMock('../src/codechef/storage', () => ({
        ensureCodeChefAccountsSeeded: vi.fn(async () => undefined),
        listCodeChefAccountSummaries: vi.fn(async () => accounts),
        listCodeChefAccounts: vi.fn(async () => accounts),
        getCodeChefAccountStorageState: vi.fn(async () => JSON.stringify({ cookies: [{ name: 'SESS', value: '1' }], origins: [] })),
        patchCodeChefAccount: patchAccountFn,
        getCodeChefProgress: vi.fn(async (id: string) => {
          if (id === 'cc-1') throw new Error('prep DB error for cc-1');
          return { nextKey: 'AAA', lastCompletedKey: null };
        }),
        completeCurrentProblem: completeFn,
        claimDailyAttempt: vi.fn(async () => true),
        releaseDailyAttempt: releaseFn,
        recordAttempt: recordAttemptFn,
      }));
      doMock('../src/codechef/sourceRepo', () => ({
        loadCodeChefSourceIndex: vi.fn(async () => [
          { path: 'a.cpp', fileName: 'a.cpp', language: 'cpp', kind: 'CODECHEF', problemCode: 'AAA', reason: 'ok' },
          { path: 'b.cpp', fileName: 'b.cpp', language: 'cpp', kind: 'CODECHEF', problemCode: 'BBB', reason: 'ok' },
        ]),
        fetchSourceCode: vi.fn(async () => 'int main(){}'),
        isCodeChefProblemListed: vi.fn(async () => ({ valid: true })),
        RETIRED_OR_INVALID_CODECHEF_PROBLEMS: new Set(['FLOW016']),
      }));
      doMock('../src/codechef/api', () => ({
        submitDirectlyViaCodeChefApi: submitApiFn,
        submitToCodeChef: vi.fn(),
      }));
      doMock('../src/codechef/auth', () => ({ loginToCodeChef: vi.fn() }));
      doMock('../src/scheduler/dailyWorker', () => ({ isRunInProgress: vi.fn(() => false) }));
      doMock('../src/notifications/telegram', () => ({ sendTelegramMessage: vi.fn(async () => true) }));

      const { runCodeChefNow, runAutomaticCodeChefDaily, readCodeChefDailyState, todayInTimezone } = await import('../src/codechef/worker');
      const today = todayInTimezone();

      systemMap.set(
        'question-order:v1:codechef:cc-2',
        JSON.stringify({ version: 1, original: ['AAA', 'FLOW016'], order: ['FLOW016', 'AAA'], initial: { nextKey: 'AAA', lastCompletedKey: null } }),
      );
      submitApiFn.mockResolvedValueOnce({ ok: false, clicked: true, verdict: 'Wrong Answer', error: 'No ID' });

      const report = await runCodeChefNow('manual');
      expect(report?.outcomes).toHaveLength(2);
      expect(report?.outcomes[0]).toMatchObject({ label: 'chef1', performed: false, error: 'prep DB error for cc-1' });
      expect(report?.outcomes[1]).toMatchObject({ label: 'chef2', performed: false, problem: 'AAA' });
      expect(systemMap.has('question-order:v1:codechef:cc-2')).toBe(false);
      expect(submitApiFn).toHaveBeenCalledWith(expect.anything(), 'https://www.codechef.com/problems/AAA', 'int main(){}', 'cpp', 90000);
      expect(completeFn).not.toHaveBeenCalled();

      // Verify runAutomaticCodeChefDaily records both exhausted & ambiguous account IDs and excludes them on retry
      vi.resetModules();
      const dailyMap = new Map<string, string>();
      const submitFn2 = vi.fn().mockResolvedValue({ ok: false, clicked: true, verdict: 'UNKNOWN', error: 'ambiguous' });
      doMock('../src/database/models', () => ({
        SystemKeys: { codechefDailyState: 'codechefDailyState' },
        getSystemState: vi.fn(async (k: string) => dailyMap.get(k) ?? null),
        setSystemState: vi.fn(async (k: string, v: string) => { dailyMap.set(k, v); }),
        deleteSystemState: vi.fn(async (k: string) => { dailyMap.delete(k); }),
      }));
      doMock('../src/codechef/storage', () => ({
        ensureCodeChefAccountsSeeded: vi.fn(async () => undefined),
        listCodeChefAccountSummaries: vi.fn(async () => accounts),
        listCodeChefAccounts: vi.fn(async () => accounts),
        getCodeChefAccountStorageState: vi.fn(async () => JSON.stringify({ cookies: [{ name: 'SESS', value: '1' }], origins: [] })),
        patchCodeChefAccount: patchAccountFn,
        getCodeChefProgress: vi.fn(async (id: string) => (id === 'cc-1' ? { nextKey: null, lastCompletedKey: 'AAA' } : { nextKey: 'AAA', lastCompletedKey: null })),
        completeCurrentProblem: completeFn,
        claimDailyAttempt: vi.fn(async () => true),
        releaseDailyAttempt: releaseFn,
        recordAttempt: recordAttemptFn,
      }));
      doMock('../src/codechef/sourceRepo', () => ({
        loadCodeChefSourceIndex: vi.fn(async () => [
          { path: 'a.cpp', fileName: 'a.cpp', language: 'cpp', kind: 'CODECHEF', problemCode: 'AAA', reason: 'ok' },
        ]),
        fetchSourceCode: vi.fn(async () => 'int main(){}'),
        isCodeChefProblemListed: vi.fn(async () => ({ valid: true })),
        RETIRED_OR_INVALID_CODECHEF_PROBLEMS: new Set(),
      }));
      doMock('../src/codechef/api', () => ({ submitDirectlyViaCodeChefApi: submitFn2, submitToCodeChef: vi.fn() }));
      doMock('../src/codechef/auth', () => ({ loginToCodeChef: vi.fn() }));
      doMock('../src/scheduler/dailyWorker', () => ({ isRunInProgress: vi.fn(() => false) }));
      doMock('../src/notifications/telegram', () => ({ sendTelegramMessage: vi.fn(async () => true) }));

      const ccWorker2 = await import('../src/codechef/worker');
      await ccWorker2.runAutomaticCodeChefDaily(false, 0, 0, 'UTC');
      expect(submitFn2).toHaveBeenCalledTimes(1);
      const savedState = await ccWorker2.readCodeChefDailyState(today);
      expect(savedState.exhaustedAccountIds).toEqual(['cc-1']);
      expect(savedState.ambiguousAccountIds).toEqual(['cc-2']);

      // Subsequent retry skips both excluded accounts
      await ccWorker2.runAutomaticCodeChefDaily(true, 0, 0, 'UTC');
      expect(submitFn2).toHaveBeenCalledTimes(1);
      // Empty optional fields stay omitted on normal state reads
      expect(await readCodeChefDailyState(today)).toEqual({ date: today, retryCount: 0 });
    });

    it('ensureCodeChefAccountsSeeded resets non-DISABLED accounts on password change and claimDailyAttempt ensures progress row exists', async () => {
      vi.resetModules();
      const upsertFn = vi.fn(async () => ({ accountId: 'cc-exp' }));
      const updateManyFn = vi.fn(async () => ({ count: 1 }));
      const updateAccountFn = vi.fn(async () => ({}));
      const findUniqueFn = vi.fn()
        .mockResolvedValueOnce({
          id: 'cc-exp',
          storageState: JSON.stringify({ username: 'u1', password: 'old', cookies: [] }),
          status: CodeChefAccountStatus.EXPIRED,
        })
        .mockResolvedValueOnce({
          id: 'cc-dis',
          storageState: JSON.stringify({ username: 'u2', password: 'old', cookies: [] }),
          status: CodeChefAccountStatus.DISABLED,
        });

      process.env.CODECHEF_1 = 'u1::newpass';
      process.env.CODECHEF_2 = 'u2::newpass';
      try {
        doMock('../src/database/prisma', () => ({
          prisma: {
            codeChefAccount: { findUnique: findUniqueFn, update: updateAccountFn, create: vi.fn() },
            codeChefProgress: { upsert: upsertFn, updateMany: updateManyFn },
          },
        }));
        const { ensureCodeChefAccountsSeeded, claimDailyAttempt } = await import('../src/codechef/storage');
        await ensureCodeChefAccountsSeeded();

        expect(updateAccountFn).toHaveBeenCalledWith(expect.objectContaining({
          where: { id: 'cc-exp' },
          data: expect.objectContaining({ status: CodeChefAccountStatus.ACTIVE, lastError: null }),
        }));
        expect(updateAccountFn).toHaveBeenCalledWith(expect.objectContaining({
          where: { id: 'cc-dis' },
          data: expect.not.objectContaining({ status: CodeChefAccountStatus.ACTIVE }),
        }));

        const ok = await claimDailyAttempt('cc-exp', '2026-11-17', 'AAA', false);
        expect(ok).toBe(true);
        expect(upsertFn).toHaveBeenCalledWith({ where: { accountId: 'cc-exp' }, create: { accountId: 'cc-exp' }, update: {} });
        expect(updateManyFn).toHaveBeenCalled();
      } finally {
        delete process.env.CODECHEF_1;
        delete process.env.CODECHEF_2;
      }
    });

    it('submitViaCodeChefApi returns clicked=true error object instead of null when POST throws', async () => {
      const { submitViaCodeChefApi } = await import('../src/codechef/api');
      const fakeRequest = {
        get: vi.fn(async (url: string) => {
          if (url.includes('/problems/')) {
            return {
              url: () => url,
              ok: () => true,
              text: async () => '<script>window.csrfToken="tok"; var x = {"isLoggedIn": true};</script>',
            };
          }
          return { ok: () => false };
        }),
        post: vi.fn(async () => { throw new Error('ETIMEDOUT after send'); }),
      };

      const res = await submitViaCodeChefApi(fakeRequest as never, 'AAA', 'int main(){}', 'cpp', 5000);
      expect(res).toEqual({
        ok: false,
        clicked: true,
        kind: 'error',
        verdict: 'UNKNOWN',
        error: 'ETIMEDOUT after send',
      });
    });

    it('fixes language selection false-positive, responseDetails empty field short-circuit, /recent/user mismatch, browser unroute, and auth context-destroyed retry', async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const { submitOnCodeChefPage } = await import('../src/codechef/api');
        const { loginOnCodeChefPage } = await import('../src/codechef/auth');
        const { withCodeChefPage } = await import('../src/codechef/browser');

        const page1 = await browser.newPage();
        try {
          const postedBodies: Array<{ language?: string }> = [];
          await page1.route('https://www.codechef.com/**', async (route) => {
            const url = route.request().url();
            if (route.request().method() === 'POST') {
              postedBodies.push(route.request().postDataJSON());
              return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({
                  upid: '999999',
                  result_code: '',
                  status: 'ok',
                  data: {},
                  details: { verdict: 'Accepted' },
                }),
              });
            }
            if (url.includes('/recent/user')) {
              return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({
                  content: '<table><tr><td><a href="/viewsolution/111111">AAA</a></td><td title="Wrong Answer">WA</td></tr></table>',
                }),
              });
            }
            return route.fulfill({
              contentType: 'text/html',
              body: `
                <button type="button">C++17</button>
                <div class="language-tag" style="display:none">C++17</div>
                <select><option value="cpp17">C++17</option><option value="py3" selected>Python 3</option></select>
                <div class="ace_editor">Editor</div>
                <button id="submit_btn">Submit</button>
                <script>
                  window.source=''; window.ace={edit:()=>({setValue:c=>window.source=c,getValue:()=>window.source})};
                  document.querySelector('#submit_btn').onclick=()=>fetch('/api/ide/submit',{
                    method:'POST',
                    headers:{'content-type':'application/json'},
                    body:JSON.stringify({code:window.source,language:document.querySelector('select').value})
                  });
                </script>
              `,
            });
          });
          const res1 = await submitOnCodeChefPage(page1, 'https://www.codechef.com/problems/AAA', 'int main(){}', 'cpp', 2000);
          expect(postedBodies).toEqual([{ code: 'int main(){}', language: 'cpp17' }]);
          expect(res1).toMatchObject({ ok: true, performed: true, submissionId: '999999', verdict: 'Accepted' });
        } finally {
          await page1.close();
        }

        const page2 = await browser.newPage();
        try {
          let evalCalls = 0;
          const origEvaluate = page2.evaluate.bind(page2);
          vi.spyOn(page2, 'evaluate').mockImplementation(async (...args: Parameters<typeof page2.evaluate>) => {
            evalCalls++;
            if (evalCalls === 1) {
              throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation.');
            }
            return origEvaluate(...args);
          });
          await page2.route('https://www.codechef.com/**', async (route) => {
            if (route.request().method() === 'POST') {
              return route.fulfill({ status: 302, headers: { location: 'https://www.codechef.com/dashboard' } });
            }
            if (route.request().url().includes('/dashboard')) {
              return route.fulfill({ contentType: 'text/html', body: '<a href="/logout">Logout</a>' });
            }
            return route.fulfill({
              contentType: 'text/html',
              body: '<div role="alert"></div><div class="error">   </div><form method="post"><input name="name"><input name="pass" type="password"><input type="submit"></form>',
            });
          });
          await expect(loginOnCodeChefPage(page2, 'tester', 'pw', 2000)).resolves.toBeDefined();
          expect(evalCalls).toBe(2);
        } finally {
          await page2.close();
        }

        await expect(withCodeChefPage(undefined, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
      } finally {
        await browser.close();
      }
    }, 30_000);
  });

  describe('scheduler range & store fixes', () => {
    it('RangeRequestGate preserves active 429 rateLimitUntil across clearCooldown', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const gate = new RangeRequestGate(Date.now, 0, 30_000);
      const signal = new AbortController().signal;

      gate.observe(new LeetCodeHttpError('HTTP 429', 429, 90_000));
      gate.clearCooldown();

      await expect(gate.wait(false, abortableSleep, signal, undefined, 60_000)).rejects.toThrow('window expired');
    });

    it('DbQuestionFailureStore merges unpersisted outage failures and never resurrects externally reset counters', async () => {
      vi.resetModules();
      let dbRaw: string | null = null;
      let failReads = false;
      doMock('../src/database/models', () => ({
        SystemKeys: { questionSolutionFailures: 'questionSolutionFailures:v1' },
        getSystemState: vi.fn(async () => {
          if (failReads) throw new Error('DB read down');
          return dbRaw;
        }),
        setSystemState: vi.fn(async (_k: string, val: string) => {
          dbRaw = val;
        }),
      }));

      const { createDbQuestionFailureStore } = await import('../src/scheduler/questionFailureCounter');
      const store = createDbQuestionFailureStore();

      await store.recordFailure(500, { reason: 'WA', communityUuid: 'u1' });
      expect((await store.get(500)).failures).toBe(1);

      failReads = true;
      expect((await store.recordFailure(500, { reason: 'TLE', communityUuid: 'u2' })).failures).toBe(2);
      expect((await store.recordFailure(500, { reason: 'RE', communityUuid: 'u3' })).failures).toBe(3);

      failReads = false;
      expect((await store.get(500)).failures).toBe(3);
      const afterRecover = await store.recordFailure(500, { reason: 'CE' });
      expect(afterRecover.failures).toBe(4);
      expect(afterRecover.failedUuids).toEqual(['u1', 'u2', 'u3']);

      // External reset in DB must NEVER resurrect old count
      dbRaw = JSON.stringify({});
      const afterExternalReset = await store.get(500);
      expect(afterExternalReset.failures).toBe(0);
      expect(afterExternalReset.failedUuids).toEqual([]);
    });

    it('prepareShuffledBatch guards negative startIndex', async () => {
      vi.resetModules();
      doMock('../src/database/models', () => ({
        getSystemState: vi.fn(async () => null),
        setSystemState: vi.fn(async () => undefined),
      }));
      const { prepareShuffledBatch } = await import('../src/scheduler/questionOrder');
      const res = await prepareShuffledBatch(
        'codechef',
        'acc-neg',
        ['A', 'B', 'C'],
        { nextKey: 'A', lastCompletedKey: null },
        -1,
        3,
        (x) => x,
      );
      expect(res.queue).toEqual(['A', 'B', 'C']);
      expect(res.nextKey).toBe('A');
    });

    it('rangeSubmission resets doneInAccount sequentially, skips trailing cooldown when pending is empty, resets pausedReason in finally, stops aborted language probes, and disposes concurrent session resources', async () => {
      const doneSnapshots: number[] = [];
      const activeDoneSnapshots: number[] = [];
      const sleeps: number[] = [];
      const fetchCommCalls: string[] = [];
      const usedUuidsSeen: string[][] = [];

      const accs = [
        { id: 'a1', label: 'a1', username: 'a1', status: AccountStatus.ACTIVE, storageState: '{}' },
        { id: 'a2', label: 'a2', username: 'a2', status: AccountStatus.ACTIVE, storageState: '{}' },
      ] as never[];

      const session = {
        api: {
          checkSession: async () => ({ authenticated: true, username: 'u' }),
          question: async (slug: string) => ({
            questionId: slug.slice(5), isPaidOnly: false, frontendId: slug.slice(5), title: slug, slug, difficulty: 'Easy',
            contentHtml: 'x', exampleTestcases: '', metaData: null, codeSnippets: [{ lang: 'C++', langSlug: 'cpp', code: 'int main(){}' }],
          }),
          submit: async () => { throw new LeetCodeHttpError('GraphQL HTTP 403', 403); },
          awaitResult: async () => ({ submissionId: '1', classification: 'ACCEPTED' as const, statusDisplay: 'Accepted', runtime: null, memory: null, rawStatusMsg: 'Accepted' }),
        },
        close: async () => undefined,
      };

      const run1 = await startRangeJob({ from: 10, to: 10 }, 'all', {
        questionOrder: (nums) => [...nums],
        listAccounts: async () => accs,
        getAccount: async (id) => (accs as Array<{ id: string }>).find((a) => a.id === id) as never,
        openSession: async () => session,
        getPage: async (n) => ({ code: 'class Solution { public: int main() { return 0; } };', sourceUrl: 'u', slug: `slug-${n}`, title: `T${n}` }),
        notify: async () => undefined,
        sleep: async (ms) => { sleeps.push(ms); },
        isDailyRunInProgress: () => false,
        now: Date.now,
        questionGapMs: 0,
        blockedBackoffMs: [],
        blockedStreakLimit: 1,
        blockedCooldownMs: 600_000,
        dailyRunPollMs: 1000,
        progressEvery: 0,
        keepAlive: () => () => undefined,
        onProgress: (ev) => {
          if (ev.phase === 'processing') {
            doneSnapshots.push(ev.stepIndex);
            activeDoneSnapshots.push(currentRangeJob()?.doneInAccount ?? -1);
          }
        },
      });
      const seqResults = await run1.done;
      expect(doneSnapshots).toEqual([1, 1]);
      expect(activeDoneSnapshots).toEqual([0, 0]);
      expect(sleeps).not.toContain(600_000);
      expect(seqResults.every((r) => r.stoppedEarly === undefined)).toBe(true);

      // Verify pre-submit error does not burn communityUuid
      const run2 = await startRangeJob({ from: 20, to: 21 }, 'all', {
        questionOrder: (nums) => [...nums],
        listAccounts: async () => [accs[0]!, accs[1]!],
        getAccount: async (id) => (accs as Array<{ id: string }>).find((a) => a.id === id) as never,
        openSession: async () => ({
          api: {
            checkSession: async () => ({ authenticated: true, username: 'u' }),
            question: async (slug: string) => ({
              questionId: slug.slice(5), isPaidOnly: false, frontendId: slug.slice(5), title: slug, slug, difficulty: 'Easy',
              contentHtml: 'x', exampleTestcases: '', metaData: null,
              codeSnippets: [
                { lang: 'C++', langSlug: 'cpp', code: 'int main(){}' },
                { lang: 'Python3', langSlug: 'python3', code: 'def f(): pass' },
              ],
            }),
            submit: async (p) => {
              if (p.slug === 'slug-20' && fetchCommCalls.length === 1) throw new Error('submit network reset');
              if (p.slug === 'slug-20') return 'sub-20';
              throw new LeetCodeHttpError('GraphQL HTTP 403', 403);
            },
            awaitResult: async (id) => ({ submissionId: id, classification: 'ACCEPTED' as const, statusDisplay: 'Accepted', runtime: null, memory: null, rawStatusMsg: 'Accepted' }),
          },
          close: async () => undefined,
        }),
        getPage: async (n) => ({ code: null, sourceUrl: 'u', slug: `slug-${n}`, title: `T${n}` }),
        fetchCommunity: async (slug, _prob, opts) => {
          if (slug === 'slug-20') {
            usedUuidsSeen.push([...(opts?.excludeUuids ?? [])]);
            fetchCommCalls.push(opts?.language ?? 'cpp');
          }
          return { code: 'class Solution { public: int main() { return 0; } };', sourceUrl: 'u', title: 'S', uuid: 'uuid-valid' };
        },
        notify: async () => undefined,
        sleep: async () => undefined,
        isDailyRunInProgress: () => false,
        now: Date.now,
        questionGapMs: 0,
        blockedBackoffMs: [],
        blockedStreakLimit: 99,
        blockedCooldownMs: 0,
        dailyRunPollMs: 1000,
        progressEvery: 0,
        keepAlive: () => () => undefined,
      });
      await run2.done;
      expect(usedUuidsSeen).toEqual([[], []]);

      // Verify pausedReason resets in finally even when cooldown sleep throws, and signal.aborted stops languagesToTry
      const abortedLangProbes: string[] = [];
      let pausedBeforeThrow: string | null = null;
      let pausedAfterThrow: string | null = 'not-checked';
      const runCooldownFinally = await startRangeJob({ from: 30, to: 31 }, 'a1', {
        questionOrder: (nums) => [...nums],
        listAccounts: async () => [accs[0]!],
        getAccount: async () => accs[0]!,
        openSession: async () => ({
          ...session,
          close: async () => {
            pausedAfterThrow = currentRangeJob()?.pausedReason ?? null;
          },
        }),
        getPage: async (n) => ({ code: 'class Solution { public: int main() { return 0; } };', sourceUrl: 'u', slug: `slug-${n}`, title: `T${n}` }),
        notify: async () => undefined,
        sleep: async (ms) => {
          if (ms === 120_000) {
            pausedBeforeThrow = currentRangeJob()?.pausedReason ?? null;
            throw new Error('sleep boom');
          }
        },
        isDailyRunInProgress: () => false,
        now: Date.now,
        questionGapMs: 0,
        blockedBackoffMs: [],
        blockedStreakLimit: 1,
        blockedCooldownMs: 120_000,
        dailyRunPollMs: 1000,
        progressEvery: 0,
        keepAlive: () => () => undefined,
      });
      await runCooldownFinally.done;
      expect(pausedBeforeThrow).toContain('cooling down');
      expect(pausedAfterThrow).toBeNull();
      expect(currentRangeJob()).toBeNull();

      // Verify signal.aborted stops languagesToTry loop without probing second language
      const runAbortLoop = await startRangeJob({ from: 40, to: 40 }, 'a1', {
        questionOrder: (nums) => [...nums],
        listAccounts: async () => [accs[0]!],
        getAccount: async () => accs[0]!,
        openSession: async () => ({
          api: {
            checkSession: async () => ({ authenticated: true, username: 'u' }),
            question: async (slug: string) => ({
              questionId: '40', isPaidOnly: false, frontendId: '40', title: slug, slug, difficulty: 'Easy',
              contentHtml: 'x', exampleTestcases: '', metaData: null,
              codeSnippets: [
                { lang: 'C++', langSlug: 'cpp', code: 'int main(){}' },
                { lang: 'Python3', langSlug: 'python3', code: 'def f(): pass' },
              ],
            }),
            submit: async () => 'sub-40',
            awaitResult: async (id) => ({ submissionId: id, classification: 'ACCEPTED' as const, statusDisplay: 'Accepted', runtime: null, memory: null, rawStatusMsg: 'Accepted' }),
          },
          close: async () => undefined,
        }),
        getPage: async (n) => ({ code: null, sourceUrl: 'u', slug: `slug-${n}`, title: `T${n}` }),
        fetchCommunity: async (_slug, _prob, opts) => {
          abortedLangProbes.push(opts?.language ?? '');
          cancelRangeJob();
          throw new Error('no cpp');
        },
        notify: async () => undefined,
        sleep: async () => undefined,
        isDailyRunInProgress: () => false,
        now: Date.now,
        questionGapMs: 0,
        blockedBackoffMs: [],
        blockedStreakLimit: 99,
        blockedCooldownMs: 0,
        dailyRunPollMs: 1000,
        progressEvery: 0,
        keepAlive: () => () => undefined,
      });
      await runAbortLoop.done;
      expect(abortedLangProbes).toEqual(['cpp']);

      // Concurrent close during openGhostSession disposes ghostSession and concurrent syncContextFromStorage disposes late APIRequestContext
      let markGhostEntered!: () => void;
      const ghostEntered = new Promise<void>((r) => { markGhostEntered = r; });
      let releaseGhost!: () => void;
      const ghostGate = new Promise<void>((r) => { releaseGhost = r; });
      const lateGhostClose = vi.fn(async () => undefined);
      const persistedTransports: unknown[] = [];
      const createdCtxDisposes: Array<ReturnType<typeof vi.fn>> = [];
      const origNewCtx = playwrightRequest.newContext.bind(playwrightRequest);
      vi.spyOn(playwrightRequest, 'newContext').mockImplementation(async (opts) => {
        const ctx = await origNewCtx(opts);
        const disposeSpy = vi.spyOn(ctx, 'dispose');
        createdCtxDisposes.push(disposeSpy);
        return ctx;
      });

      const reqAccount = {
        id: 'req-1',
        label: 'req-1',
        username: 'u',
        status: AccountStatus.ACTIVE,
        storageState: JSON.stringify({
          cookies: [{ name: 'LEETCODE_SESSION', value: 'tok', domain: '.leetcode.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }],
          origins: [],
        }),
      } as never;

      const reqSession = await openRequestSession(reqAccount, undefined, {
        gate: new RangeRequestGate(Date.now, 0, 0),
        resolveProxy: async () => null,
        persistCookies: async (_acc, baseline) => {
          persistedTransports.push(baseline.transport);
          return true;
        },
        openGhostSession: async (_state, opts) => {
          markGhostEntered();
          await ghostGate;
          await opts.onStorageState?.({
            cookies: [{ name: 'LEETCODE_SESSION', value: 'tok-new', domain: '.leetcode.com', path: '/', expires: -1 }],
            transport: { userAgent: 'GhostUA' },
            origins: [],
          });
          return {
            submit: async () => ({ submissionId: '1', storageState: { cookies: [], origins: [] } }),
            close: lateGhostClose,
          };
        },
      });

      const pendingFallback = reqSession.api.submitWithBrowserFallback!({ slug: 's', questionId: '1', lang: 'cpp', code: 'int main(){}' }).catch((e) => e);
      await ghostEntered;
      await reqSession.close();
      releaseGhost();
      const errResult = await pendingFallback;
      expect(errResult).toBeInstanceOf(Error);
      expect(lateGhostClose).toHaveBeenCalledTimes(1);
      expect(persistedTransports[0]).toBeDefined();
      expect(createdCtxDisposes[0]).toHaveBeenCalledTimes(1);
    });
  });
});
