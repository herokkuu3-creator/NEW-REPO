import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountStatus, RecoveryStatus } from '@prisma/client';

const findManyMock = vi.fn();
const solutionPostFindManyMock = vi.fn();

vi.mock('../src/database/prisma', () => ({
  prisma: {
    systemState: {
      findMany: (...args: unknown[]) => findManyMock(...args),
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 0 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    solutionPost: {
      findMany: (...args: unknown[]) => solutionPostFindManyMock(...args),
    },
    account: {
      findMany: vi.fn(async () => []),
    },
    dailyRun: {
      findMany: vi.fn(async () => []),
    },
  },
}));

import { RecoveryService, type RecoveryStore } from '../src/recovery/service';
import {
  notifyDailyPublicationQueued,
  processDailyPublicationQueue,
} from '../src/solutionPosts/dailyPublication';
import {
  notifySolutionPostSchedulerWork,
  resumePausedCoarenaArticles,
} from '../src/solutionPosts/scheduler';

describe('Idle poll gates (Neon compute optimization)', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    findManyMock.mockReset();
    solutionPostFindManyMock.mockReset();
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

    findManyMock.mockResolvedValue([]);
    solutionPostFindManyMock.mockResolvedValue([]);

    const t0 = new Date('2026-11-17T10:00:00Z');
    await processDailyPublicationQueue(t0);
    await processDailyPublicationQueue(new Date(t0.getTime() + 60_000));
    expect(findManyMock).toHaveBeenCalledTimes(1);

    notifyDailyPublicationQueued();
    await processDailyPublicationQueue(new Date(t0.getTime() + 120_000));
    expect(findManyMock).toHaveBeenCalledTimes(2);

    await resumePausedCoarenaArticles(t0);
    await resumePausedCoarenaArticles(new Date(t0.getTime() + 60_000));
    expect(solutionPostFindManyMock).toHaveBeenCalledTimes(1);

    notifySolutionPostSchedulerWork();
    await resumePausedCoarenaArticles(new Date(t0.getTime() + 120_000));
    expect(solutionPostFindManyMock).toHaveBeenCalledTimes(2);
  });
});
