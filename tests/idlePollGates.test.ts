import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountStatus, CodeChefAccountStatus, CodeforcesAccountStatus, RecoveryStatus } from '@prisma/client';

const h = vi.hoisted(() => ({
  systemStateFindMany: vi.fn(),
  systemStateFindUnique: vi.fn(),
  systemStateUpsert: vi.fn(),
  systemStateUpdateMany: vi.fn(),
  systemStateDeleteMany: vi.fn(),
  solutionPostFindMany: vi.fn(),
  solutionPostUpdateMany: vi.fn(),
  preferenceFindMany: vi.fn(),
  preferenceUpdateMany: vi.fn(),
  preferenceUpsert: vi.fn(),
  accountFindMany: vi.fn(),
  accountFindUnique: vi.fn(),
  accountFindFirst: vi.fn(),
  accountCount: vi.fn(),
  accountUpsert: vi.fn(),
  accountUpdate: vi.fn(),
  accountDelete: vi.fn(),
  accountDeleteMany: vi.fn(),
  dailyRunFindMany: vi.fn(),
  dailyRunFindFirst: vi.fn(),
  cfAccountFindMany: vi.fn(),
  cfAccountFindUnique: vi.fn(),
  cfAccountUpsert: vi.fn(),
  cfAccountUpdate: vi.fn(),
  cfProgressUpsert: vi.fn(),
  ccAccountFindMany: vi.fn(),
  ccAccountFindUnique: vi.fn(),
  ccAccountCreate: vi.fn(),
  ccAccountUpdate: vi.fn(),
  queryRaw: vi.fn(),
  loginToLeetCode: vi.fn(),
  loginToCodeforces: vi.fn(),
  checkSession: vi.fn(),
  openLightweightSession: vi.fn(),
}));

vi.mock('../src/config', async (orig) => {
  const real = (await orig()) as { config: Record<string, unknown> };
  return {
    config: {
      ...real.config,
      api: { ...(real.config.api as object), port: 0 },
      telegram: { ...(real.config.telegram as object), chatId: '1', enabled: false },
    },
  };
});

vi.mock('../src/database/prisma', () => {
  const tx = {
    systemState: {
      findMany: (...args: unknown[]) => h.systemStateFindMany(...args),
      findUnique: (...args: unknown[]) => h.systemStateFindUnique(...args),
      upsert: (...args: unknown[]) => h.systemStateUpsert(...args),
      updateMany: (...args: unknown[]) => h.systemStateUpdateMany(...args),
      deleteMany: (...args: unknown[]) => h.systemStateDeleteMany(...args),
    },
    solutionPost: {
      findMany: (...args: unknown[]) => h.solutionPostFindMany(...args),
      updateMany: (...args: unknown[]) => h.solutionPostUpdateMany(...args),
    },
    solutionPostPreference: {
      findMany: (...args: unknown[]) => h.preferenceFindMany(...args),
      updateMany: (...args: unknown[]) => h.preferenceUpdateMany(...args),
      upsert: (...args: unknown[]) => h.preferenceUpsert(...args),
    },
    account: {
      findMany: (...args: unknown[]) => h.accountFindMany(...args),
      findUnique: (...args: unknown[]) => h.accountFindUnique(...args),
      findFirst: (...args: unknown[]) => h.accountFindFirst(...args),
      count: (...args: unknown[]) => h.accountCount(...args),
      upsert: (...args: unknown[]) => h.accountUpsert(...args),
      update: (...args: unknown[]) => h.accountUpdate(...args),
      delete: (...args: unknown[]) => h.accountDelete(...args),
      deleteMany: (...args: unknown[]) => h.accountDeleteMany(...args),
    },
    dailyRun: {
      findMany: (...args: unknown[]) => h.dailyRunFindMany(...args),
      findFirst: (...args: unknown[]) => h.dailyRunFindFirst(...args),
    },
    codeforcesAccount: {
      findMany: (...args: unknown[]) => h.cfAccountFindMany(...args),
      findUnique: (...args: unknown[]) => h.cfAccountFindUnique(...args),
      upsert: (...args: unknown[]) => h.cfAccountUpsert(...args),
      update: (...args: unknown[]) => h.cfAccountUpdate(...args),
    },
    codeforcesProgress: {
      upsert: (...args: unknown[]) => h.cfProgressUpsert(...args),
    },
    codeChefAccount: {
      findMany: (...args: unknown[]) => h.ccAccountFindMany(...args),
      findUnique: (...args: unknown[]) => h.ccAccountFindUnique(...args),
      create: (...args: unknown[]) => h.ccAccountCreate(...args),
      update: (...args: unknown[]) => h.ccAccountUpdate(...args),
    },
    $queryRaw: (...args: unknown[]) => h.queryRaw(...args),
  };
  return {
    prisma: {
      ...tx,
      $transaction: vi.fn(async (action: (client: typeof tx) => Promise<unknown>) => action(tx)),
    },
  };
});

vi.mock('../src/leetcode/auth', () => ({
  loginToLeetCode: (...args: unknown[]) => h.loginToLeetCode(...args),
}));

vi.mock('../src/codeforces/auth', () => ({
  loginToCodeforces: (...args: unknown[]) => h.loginToCodeforces(...args),
}));

vi.mock('../src/leetcode/sessionManager', async (orig) => ({
  ...((await orig()) as object),
  openLightweightLeetCodeSession: (...args: unknown[]) => h.openLightweightSession(...args),
}));

vi.mock('../src/browser/sessionCheck', () => ({
  checkSession: (...args: unknown[]) => h.checkSession(...args),
}));

vi.mock('../src/codeforces/sourceRepo', async (orig) => ({
  ...((await orig()) as object),
  loadRuntimeSourceIndex: vi.fn(async () => ({ entries: [], queue: [] })),
}));

vi.mock('../src/codechef/sourceRepo', async (orig) => ({
  ...((await orig()) as object),
  loadCodeChefSourceIndex: vi.fn(async () => []),
}));

vi.mock('../src/notifications/telegram', () => ({
  sendTelegramMessage: vi.fn(async () => true),
  sendTelegramDocument: vi.fn(async () => true),
}));

import { startHealthServer } from '../src/api/health';
import { ensureCodeChefAccountsSeeded } from '../src/codechef/storage';
import {
  resetCodeChefRetryPollGate,
  runAutomaticCodeChefDaily,
  runCodeChefNow,
} from '../src/codechef/worker';
import { saveCodeforcesAccount } from '../src/codeforces/storage';
import {
  resetCodeforcesRetryPollGate,
  runAutomaticCodeforcesDaily,
  triggerCodeforcesRun,
} from '../src/codeforces/worker';
import {
  handleCallbackQuery,
  handleExecuteLogin,
  processCookieMessage,
  type RemovalDeps,
} from '../src/notifications/telegramBot';
import { RecoveryService, type RecoveryStore } from '../src/recovery/service';
import {
  resetDailyRetryPollGate,
  triggerDailyRetry,
} from '../src/scheduler/dailyWorker';
import {
  notifyDailyPublicationQueued,
  processDailyPublicationQueue,
} from '../src/solutionPosts/dailyPublication';
import { registerSolutionPostRoutes } from '../src/solutionPosts/routes';
import {
  notifySolutionPostSchedulerWork,
  resumePausedCoarenaArticles,
  runScheduledSolutionPosts,
  setSelectedAccounts,
} from '../src/solutionPosts/scheduler';
import { resetFailedSolutionPostRetries } from '../src/solutionPosts/service';

function resetPrismaMocks(): void {
  h.systemStateFindMany.mockReset().mockResolvedValue([]);
  h.systemStateFindUnique.mockReset().mockResolvedValue(null);
  h.systemStateUpsert.mockReset().mockResolvedValue({});
  h.systemStateUpdateMany.mockReset().mockResolvedValue({ count: 0 });
  h.systemStateDeleteMany.mockReset().mockResolvedValue({ count: 0 });
  h.solutionPostFindMany.mockReset().mockResolvedValue([]);
  h.solutionPostUpdateMany.mockReset().mockResolvedValue({ count: 0 });
  h.preferenceFindMany.mockReset().mockResolvedValue([]);
  h.preferenceUpdateMany.mockReset().mockResolvedValue({ count: 0 });
  h.preferenceUpsert.mockReset().mockResolvedValue({ accountId: 'acc-1' });
  h.accountFindMany.mockReset().mockResolvedValue([]);
  h.accountFindUnique.mockReset().mockResolvedValue(null);
  h.accountFindFirst.mockReset().mockResolvedValue(null);
  h.accountCount.mockReset().mockResolvedValue(0);
  h.accountUpsert.mockReset().mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({
    id: 'acc-1',
    ...create,
  }));
  h.accountUpdate.mockReset().mockResolvedValue({});
  h.accountDelete.mockReset().mockResolvedValue({});
  h.accountDeleteMany.mockReset().mockResolvedValue({ count: 0 });
  h.dailyRunFindMany.mockReset().mockResolvedValue([]);
  h.dailyRunFindFirst.mockReset().mockResolvedValue(null);
  h.cfAccountFindMany.mockReset().mockResolvedValue([]);
  h.cfAccountFindUnique.mockReset().mockResolvedValue(null);
  h.cfAccountUpsert.mockReset().mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({
    id: 'cf-1',
    ...create,
  }));
  h.cfAccountUpdate.mockReset().mockResolvedValue({});
  h.cfProgressUpsert.mockReset().mockResolvedValue({});
  h.ccAccountFindMany.mockReset().mockResolvedValue([]);
  h.ccAccountFindUnique.mockReset().mockResolvedValue(null);
  h.ccAccountCreate.mockReset().mockResolvedValue({ id: 'cc-1' });
  h.ccAccountUpdate.mockReset().mockResolvedValue({});
  h.queryRaw.mockReset().mockResolvedValue([]);
  h.loginToLeetCode.mockReset();
  h.loginToCodeforces.mockReset();
  h.checkSession.mockReset();
  h.openLightweightSession.mockReset();
}

describe('Idle poll gates (Neon compute optimization)', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.useRealTimers();
    delete process.env.CODECHEF_1;
    resetPrismaMocks();
    resetDailyRetryPollGate();
    resetCodeforcesRetryPollGate();
    resetCodeChefRetryPollGate();
    notifySolutionPostSchedulerWork();
  });

  it('RecoveryService.tick skips idle listOpenMeta queries in production mode until invalidated or opened', async () => {
    process.env.NODE_ENV = 'production';
    let nowMs = 1_700_000_000_000;
    const listOpenMeta = vi.fn(async () => []);
    const store: RecoveryStore & { listOpenMeta: typeof listOpenMeta } = {
      listOpenMeta,
      listOpen: vi.fn(async () => []),
      findOpenByAccount: vi.fn(async () => null),
      findByTokenHash: vi.fn(async () => null),
      create: vi.fn(async () => ({
        created: true,
        recovery: {
          id: 'rec-1',
          accountId: 'acc-1',
          status: RecoveryStatus.RECOVERY_PENDING,
          reason: 'EXPIRED',
          telegramChatId: '1',
          tokenHash: null,
          tokenExpiresAt: null,
          tokenUsedAt: null,
          lastNotifiedAt: null,
          nextReminderAt: new Date(nowMs),
          attemptCount: 0,
          lastErrorCategory: null,
          lastError: null,
          recoveredAt: null,
        },
      })),
      claimDueReminders: vi.fn(async () => []),
      rescheduleReminder: vi.fn(async () => undefined),
      consumeToken: vi.fn(async () => ({ ok: false as const, reason: 'invalid' as const })),
      setStatus: vi.fn(async () => true),
      markFailed: vi.fn(async () => undefined),
      commitRecovered: vi.fn(async () => undefined),
      cancel: vi.fn(async () => null),
    };

    const svc = new RecoveryService({
      store,
      now: () => new Date(nowMs),
      chatId: () => '1',
      baseUrl: () => 'https://example.com',
      listAccounts: async () => [],
      getAccount: async () => null,
      markAccount: async () => undefined,
      verifyStoredSession: async () => ({ authenticated: true }),
      verifyCapturedSession: async () => ({ authenticated: true }),
      getCredentials: async () => null,
      openBrowser: async () => {
        throw new Error('unused');
      },
      sendTelegram: async () => true,
      limits: {
        tokenTtlMs: 3600_000,
        reminderIntervalMs: 3600_000,
        sessionTimeoutMs: 120_000,
        maxConcurrency: 1,
        maxPendingPerDay: 5,
        pollMs: 1000,
        finalStatusRetentionMs: 5000,
      },
    });

    await svc.tick();
    await svc.tick();
    await svc.tick();
    expect(listOpenMeta).toHaveBeenCalledTimes(1);

    await svc.openRecovery(
      { id: 'acc-1', label: 'main', username: 'u', status: AccountStatus.EXPIRED },
      'EXPIRED',
    );
    await svc.tick();
    expect(listOpenMeta).toHaveBeenCalledTimes(2);
  });

  it('processDailyPublicationQueue and resumePausedCoarenaArticles skip idle DB polls until notified', async () => {
    process.env.NODE_ENV = 'production';
    notifyDailyPublicationQueued();
    notifySolutionPostSchedulerWork();

    h.systemStateFindMany.mockResolvedValue([]);
    h.solutionPostFindMany.mockResolvedValue([]);

    const t0 = new Date('2026-11-17T10:00:00Z');
    await processDailyPublicationQueue(t0);
    await processDailyPublicationQueue(new Date(t0.getTime() + 60_000));
    expect(h.systemStateFindMany).toHaveBeenCalledTimes(1);

    notifyDailyPublicationQueued();
    await processDailyPublicationQueue(new Date(t0.getTime() + 120_000));
    expect(h.systemStateFindMany).toHaveBeenCalledTimes(2);

    await resumePausedCoarenaArticles(t0);
    await resumePausedCoarenaArticles(new Date(t0.getTime() + 60_000));
    expect(h.solutionPostFindMany).toHaveBeenCalledTimes(1);

    notifySolutionPostSchedulerWork();
    await resumePausedCoarenaArticles(new Date(t0.getTime() + 120_000));
    expect(h.solutionPostFindMany).toHaveBeenCalledTimes(2);
  });

  it('triggerDailyRetry keeps 60m cooldown on 0 accounts without latching the whole day, and resets on account/session mutations', async () => {
    process.env.NODE_ENV = 'production';
    resetPrismaMocks();
    resetDailyRetryPollGate();
    vi.useFakeTimers({ toFake: ['Date'] });
    const baseMs = Date.parse('2026-11-17T04:00:00.000Z'); // 09:30 IST (past 09:00 IST schedule)
    vi.setSystemTime(baseMs);

    const AUTH = { authorization: 'Bearer test-token-for-vitest' };
    const triggerRun = vi.fn(async () => ({ started: false, message: 'stubbed' }));
    const app = await startHealthServer(
      {
        triggerRun,
        isRunInProgress: () => false,
        runSubmission: async () => null,
      },
      { pinCode: '4821', healthCacheTtlMs: 0 },
    );

    try {
      // 1) 0 accounts: sleeps 60m without latching dailyRetryCompletedDate for the whole day
      await triggerDailyRetry();
      await triggerDailyRetry();
      expect(h.accountFindMany).toHaveBeenCalledTimes(1);

      vi.setSystemTime(baseMs + 30 * 60_000);
      await triggerDailyRetry();
      expect(h.accountFindMany).toHaveBeenCalledTimes(1);

      vi.setSystemTime(baseMs + 60 * 60_000 + 1);
      await triggerDailyRetry();
      expect(h.accountFindMany).toHaveBeenCalledTimes(2);

      // 2) POST /admin/accounts with an EXPIRED token (skips triggerRun) still wakes triggerDailyRetry inside 60m
      const expiredToken = `hdr.${Buffer.from(JSON.stringify({ username: 'alice', refreshed_at: 1000, _session_expiry: 100 })).toString('base64url')}.sig`;
      h.accountFindMany.mockResolvedValueOnce([]); // ingestCookiePayload existing check
      const addRes = await app.inject({
        method: 'POST',
        url: '/admin/accounts',
        headers: AUTH,
        payload: { label: 'main', cookies: `LEETCODE_SESSION=${expiredToken}; csrftoken=csrf123` },
      });
      expect(addRes.statusCode).toBe(200);
      expect(addRes.json().status).toBe(AccountStatus.EXPIRED);
      expect(triggerRun).not.toHaveBeenCalled();

      // Now triggerDailyRetry wakes immediately and marks today complete when the run is already accepted
      h.accountFindMany.mockResolvedValueOnce([{ id: 'acc-1' }]);
      h.dailyRunFindMany.mockResolvedValueOnce([
        { accountId: 'acc-1', state: 'SUCCESS', submissionStatus: 'Accepted' },
      ]);
      await triggerDailyRetry();
      expect(h.accountFindMany).toHaveBeenCalledTimes(4);
      expect(h.dailyRunFindMany).toHaveBeenCalledTimes(1);

      // Completed day normally stays suppressed even past 60m
      vi.setSystemTime(baseMs + 125 * 60_000);
      await triggerDailyRetry();
      expect(h.accountFindMany).toHaveBeenCalledTimes(4);

      // 3) POST /admin/storage-state resets the gate
      const storageRes = await app.inject({
        method: 'POST',
        url: '/admin/storage-state',
        headers: AUTH,
        payload: { cookies: [{ name: 'LEETCODE_SESSION', value: 'x' }], origins: [] },
      });
      expect(storageRes.statusCode).toBe(200);
      h.accountFindMany.mockResolvedValueOnce([{ id: 'acc-1' }]);
      h.dailyRunFindMany.mockResolvedValueOnce([
        { accountId: 'acc-1', state: 'SUCCESS', submissionStatus: 'Accepted' },
      ]);
      await triggerDailyRetry();
      expect(h.accountFindMany).toHaveBeenCalledTimes(5);

      // 4) POST /admin/renew-session resets the gate
      h.openLightweightSession.mockResolvedValue({ api: {}, close: vi.fn(async () => undefined) });
      h.checkSession.mockResolvedValue({ authenticated: true, username: 'alice' });
      const renewRes = await app.inject({
        method: 'POST',
        url: '/admin/renew-session',
        headers: AUTH,
        payload: { cookies: 'LEETCODE_SESSION=fresh_1234567890abcdef; csrftoken=csrf123' },
      });
      expect(renewRes.statusCode).toBe(200);
      const beforeRenewRetry = h.accountFindMany.mock.calls.length;
      h.accountFindMany.mockResolvedValueOnce([{ id: 'acc-1' }]);
      h.dailyRunFindMany.mockResolvedValueOnce([
        { accountId: 'acc-1', state: 'SUCCESS', submissionStatus: 'Accepted' },
      ]);
      await triggerDailyRetry();
      expect(h.accountFindMany).toHaveBeenCalledTimes(beforeRenewRetry + 1);

      // 5) Telegram /lclogin direct login resets the gate
      h.loginToLeetCode.mockResolvedValue({
        ok: true,
        username: 'alice',
        storageState: { cookies: [{ name: 'LEETCODE_SESSION', value: 'lc_1234567890abcdef' }], origins: [] },
      });
      await handleExecuteLogin('leetcode', 'main', 'alice', 'secret', async () => undefined);
      const beforeLoginRetry = h.accountFindMany.mock.calls.length;
      h.accountFindMany.mockResolvedValueOnce([{ id: 'acc-1' }]);
      h.dailyRunFindMany.mockResolvedValueOnce([
        { accountId: 'acc-1', state: 'SUCCESS', submissionStatus: 'Accepted' },
      ]);
      await triggerDailyRetry();
      expect(h.accountFindMany).toHaveBeenCalledTimes(beforeLoginRetry + 1);

      // 6) Telegram /renew cookie upload resets the gate
      h.accountFindMany.mockResolvedValueOnce([]); // ingestCookiePayload existing check
      const tgRenew = await processCookieMessage('LEETCODE_SESSION=tok_1234567890abcdef; csrftoken=csrf12345');
      expect(tgRenew.stored).toBe(true);
      const beforeTgRenewRetry = h.accountFindMany.mock.calls.length;
      h.accountFindMany.mockResolvedValueOnce([{ id: 'acc-1' }]);
      h.dailyRunFindMany.mockResolvedValueOnce([
        { accountId: 'acc-1', state: 'SUCCESS', submissionStatus: 'Accepted' },
      ]);
      await triggerDailyRetry();
      expect(h.accountFindMany).toHaveBeenCalledTimes(beforeTgRenewRetry + 1);
    } finally {
      await app.close();
    }
  });

  it('solution post scheduler stays idle for 60m on 0 preferences and wakes on setSelectedAccounts, resetFailedSolutionPostRetries, and POST /admin/solutions/scheduled', async () => {
    process.env.NODE_ENV = 'production';
    resetPrismaMocks();
    notifySolutionPostSchedulerWork();

    const t0 = new Date('2026-11-17T01:00:00Z'); // 06:30 IST (after 06:00 IST)
    h.preferenceFindMany.mockResolvedValue([]);

    // 1) Initial 0-preference run arms 60m cooldown; repeat inside 60m skips DB
    expect((await runScheduledSolutionPosts(t0)).status).toBe('IDLE');
    expect((await runScheduledSolutionPosts(new Date(t0.getTime() + 5 * 60_000))).status).toBe('IDLE');
    expect(h.preferenceFindMany).toHaveBeenCalledTimes(1);

    // 2) setSelectedAccounts wakes immediately inside the 60m window
    h.accountCount.mockResolvedValueOnce(1);
    await setSelectedAccounts(['acc-1']);
    await runScheduledSolutionPosts(new Date(t0.getTime() + 6 * 60_000));
    expect(h.preferenceFindMany).toHaveBeenCalledTimes(2);

    // 3) resetFailedSolutionPostRetries wakes immediately inside the 60m window
    await resetFailedSolutionPostRetries();
    await runScheduledSolutionPosts(new Date(t0.getTime() + 7 * 60_000));
    expect(h.preferenceFindMany).toHaveBeenCalledTimes(3);

    // 4) POST /admin/solutions/scheduled wakes immediately inside the 60m window
    const app = Fastify();
    registerSolutionPostRoutes(app, (header) => header === 'Bearer admin-test');
    try {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(t0.getTime() + 8 * 60_000);
      const res = await app.inject({
        method: 'POST',
        url: '/admin/solutions/scheduled',
        headers: { authorization: 'Bearer admin-test' },
      });
      expect(res.statusCode).toBe(202);
      await vi.waitFor(() => {
        expect(h.preferenceFindMany).toHaveBeenCalledTimes(4);
      });
    } finally {
      await app.close();
    }
  });

  it('Codeforces and CodeChef retry gates keep 60m idle cooldown on 0 accounts without latching the day, and reset on saves and manual/admin triggers', async () => {
    process.env.NODE_ENV = 'production';
    resetPrismaMocks();
    resetCodeforcesRetryPollGate();
    resetCodeChefRetryPollGate();
    vi.useFakeTimers({ toFake: ['Date'] });
    const baseMs = Date.parse('2026-11-17T05:00:00.000Z'); // 10:30 IST (after 08:15 and 09:30 IST)
    vi.setSystemTime(baseMs);

    // --- Codeforces ---
    h.cfAccountFindMany.mockResolvedValue([]);
    await runAutomaticCodeforcesDaily(true, 9, 30, 'Asia/Kolkata');
    await runAutomaticCodeforcesDaily(true, 9, 30, 'Asia/Kolkata');
    expect(h.cfAccountFindMany).toHaveBeenCalledTimes(1);

    // After 60m with still 0 accounts, it checks again (not latched for the day)
    vi.setSystemTime(baseMs + 60 * 60_000 + 1);
    await runAutomaticCodeforcesDaily(true, 9, 30, 'Asia/Kolkata');
    expect(h.cfAccountFindMany).toHaveBeenCalledTimes(2);

    // saveCodeforcesAccount wakes immediately inside the 60m cooldown
    await saveCodeforcesAccount('cf-main', '{"cookies":[{"name":"JSESSIONID","value":"1"}]}', {
      username: 'cfuser',
      status: CodeforcesAccountStatus.ACTIVE,
    });
    h.cfAccountFindMany.mockResolvedValueOnce([{ id: 'cf-1' }]);
    h.systemStateFindUnique.mockResolvedValueOnce({
      value: JSON.stringify({
        date: '2026-11-17',
        retryCount: 0,
        completedAccountIds: ['cf-1'],
        browserAttemptedAccountIds: [],
      }),
    });
    await runAutomaticCodeforcesDaily(true, 9, 30, 'Asia/Kolkata');
    expect(h.cfAccountFindMany).toHaveBeenCalledTimes(3);

    // Completed day latches until reset by triggerCodeforcesRun or /cflogin
    vi.setSystemTime(baseMs + 130 * 60_000);
    await runAutomaticCodeforcesDaily(true, 9, 30, 'Asia/Kolkata');
    expect(h.cfAccountFindMany).toHaveBeenCalledTimes(3);

    h.cfAccountFindMany.mockResolvedValueOnce([]); // background executeCodeforcesRun check
    const cfTrig = await triggerCodeforcesRun('admin-api');
    expect(cfTrig.started).toBe(true);
    await vi.waitFor(() => {
      expect(h.cfAccountFindMany).toHaveBeenCalledTimes(4);
    });
    h.cfAccountFindMany.mockResolvedValueOnce([{ id: 'cf-1' }]);
    h.systemStateFindUnique.mockResolvedValueOnce({
      value: JSON.stringify({
        date: '2026-11-17',
        retryCount: 0,
        completedAccountIds: ['cf-1'],
        browserAttemptedAccountIds: [],
      }),
    });
    await runAutomaticCodeforcesDaily(true, 9, 30, 'Asia/Kolkata');
    expect(h.cfAccountFindMany).toHaveBeenCalledTimes(5);

    // /cflogin resets the latched day gate too
    h.loginToCodeforces.mockResolvedValue({
      ok: true,
      handle: 'cfuser',
      storageState: { cookies: [{ name: 'JSESSIONID', value: '2' }], origins: [] },
    });
    await handleExecuteLogin('codeforces', 'cf-main', 'cfuser', 'pw', async () => undefined);
    h.cfAccountFindMany.mockResolvedValueOnce([{ id: 'cf-1' }]);
    h.systemStateFindUnique.mockResolvedValueOnce({
      value: JSON.stringify({
        date: '2026-11-17',
        retryCount: 0,
        completedAccountIds: ['cf-1'],
        browserAttemptedAccountIds: [],
      }),
    });
    await runAutomaticCodeforcesDaily(true, 9, 30, 'Asia/Kolkata');
    expect(h.cfAccountFindMany).toHaveBeenCalledTimes(6);

    // --- CodeChef ---
    h.ccAccountFindMany.mockResolvedValue([]);
    await runAutomaticCodeChefDaily(true, 8, 15, 'Asia/Kolkata');
    await runAutomaticCodeChefDaily(true, 8, 15, 'Asia/Kolkata');
    expect(h.ccAccountFindMany).toHaveBeenCalledTimes(1);

    // After 60m with still 0 accounts, checks again (not latched for the day)
    vi.setSystemTime(baseMs + 200 * 60_000);
    await runAutomaticCodeChefDaily(true, 8, 15, 'Asia/Kolkata');
    expect(h.ccAccountFindMany).toHaveBeenCalledTimes(2);

    // ensureCodeChefAccountsSeeded wakes immediately inside the 60m cooldown
    process.env.CODECHEF_1 = 'ccuser::ccpass';
    h.ccAccountFindUnique.mockResolvedValueOnce(null);
    await ensureCodeChefAccountsSeeded();
    h.ccAccountFindMany.mockResolvedValueOnce([
      {
        id: 'cc-1',
        label: 'ccuser',
        username: 'ccuser',
        status: CodeChefAccountStatus.ACTIVE,
        lastSubmissionDate: '2026-11-17',
      },
    ]);
    await runAutomaticCodeChefDaily(true, 8, 15, 'Asia/Kolkata');
    expect(h.ccAccountFindMany).toHaveBeenCalledTimes(3);

    // Completed day latches until reset by runCodeChefNow
    vi.setSystemTime(baseMs + 270 * 60_000);
    await runAutomaticCodeChefDaily(true, 8, 15, 'Asia/Kolkata');
    expect(h.ccAccountFindMany).toHaveBeenCalledTimes(3);

    h.ccAccountFindMany.mockResolvedValueOnce([]);
    await runCodeChefNow('manual');
    h.ccAccountFindMany.mockResolvedValueOnce([]);
    await runAutomaticCodeChefDaily(true, 8, 15, 'Asia/Kolkata');
    expect(h.ccAccountFindMany).toHaveBeenCalledTimes(5);
  });

  it('Telegram account add, renew, and remove mutations invalidate /health cache immediately', async () => {
    process.env.NODE_ENV = 'production';
    resetPrismaMocks();

    const app = await startHealthServer(
      {
        triggerRun: async () => ({ started: false, message: 'nope' }),
        isRunInProgress: () => false,
        runSubmission: async () => null,
      },
      { pinCode: '4821', healthCacheTtlMs: 10_000 },
    );

    const createdAt = new Date('2026-11-17T02:00:00Z');
    const makeRow = (label: string, username: string) => ({
      id: 'acc-1',
      label,
      username,
      status: 'ACTIVE',
      lastCheckedAt: null,
      lastRunAt: null,
      lastResult: null,
      lastError: null,
      createdAt,
      updatedAt: createdAt,
      cookieCount: 2,
    });

    try {
      // Populate 10s /health cache with 0 accounts
      h.queryRaw.mockResolvedValueOnce([]);
      const initial = await app.inject({ method: 'GET', url: '/health', headers: { 'x-pin-code': '4821' } });
      expect(initial.json().accounts.total).toBe(0);
      const cached = await app.inject({ method: 'GET', url: '/health', headers: { 'x-pin-code': '4821' } });
      expect(cached.json().accounts.total).toBe(0);
      expect(h.queryRaw).toHaveBeenCalledTimes(1);

      // 1) Telegram /renew cookie upload invalidates cache immediately
      h.accountFindMany.mockResolvedValueOnce([]);
      const renewMsg = await processCookieMessage('LEETCODE_SESSION=tok1_1234567890abcdef; csrftoken=csrf12345');
      expect(renewMsg.stored).toBe(true);
      h.queryRaw.mockResolvedValueOnce([makeRow('main', 'alice')]);
      const afterRenew = await app.inject({ method: 'GET', url: '/health', headers: { 'x-pin-code': '4821' } });
      expect(afterRenew.json().accounts.total).toBe(1);
      expect(h.queryRaw).toHaveBeenCalledTimes(2);

      // 2) Telegram /lclogin invalidates cache immediately
      h.loginToLeetCode.mockResolvedValueOnce({
        ok: true,
        username: 'alice_new',
        storageState: { cookies: [{ name: 'LEETCODE_SESSION', value: 'tok2' }], origins: [] },
      });
      await handleExecuteLogin('leetcode', 'main', 'alice_new', 'pw', async () => undefined);
      h.queryRaw.mockResolvedValueOnce([makeRow('main', 'alice_new')]);
      const afterLogin = await app.inject({ method: 'GET', url: '/health', headers: { 'x-pin-code': '4821' } });
      expect(afterLogin.json().accounts.items[0].username).toBe('alice_new');
      expect(h.queryRaw).toHaveBeenCalledTimes(3);

      // 3) Telegram /removesession & /removeallsessions invalidate cache immediately (even via custom RemovalDeps)
      let store = [{ id: 'acc-1', label: 'main', username: 'alice_new', status: AccountStatus.ACTIVE }] as never[];
      const removalDeps: RemovalDeps = {
        listAccounts: async () => [...store],
        deleteAccountById: async (id) => {
          const before = store.length;
          store = store.filter((a: { id: string }) => a.id !== id);
          return store.length < before;
        },
        deleteAllAccounts: async () => {
          const count = store.length;
          store = [];
          return count;
        },
        clearLegacySession: async () => undefined,
        isRunInProgress: () => false,
        send: async () => undefined,
        edit: async () => undefined,
        answer: async () => undefined,
      };

      await handleCallbackQuery(
        { id: 'cb-rm', data: 'rm:acc-1', message: { message_id: 1, chat: { id: 1 } } },
        removalDeps,
      );
      h.queryRaw.mockResolvedValueOnce([]);
      const afterRemoveOne = await app.inject({ method: 'GET', url: '/health', headers: { 'x-pin-code': '4821' } });
      expect(afterRemoveOne.json().accounts.total).toBe(0);
      expect(h.queryRaw).toHaveBeenCalledTimes(4);

      await handleCallbackQuery(
        { id: 'cb-rmall', data: 'rmall:yes', message: { message_id: 2, chat: { id: 1 } } },
        removalDeps,
      );
      h.queryRaw.mockResolvedValueOnce([]);
      await app.inject({ method: 'GET', url: '/health', headers: { 'x-pin-code': '4821' } });
      expect(h.queryRaw).toHaveBeenCalledTimes(5);
    } finally {
      await app.close();
    }
  });
});
