import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountStatus, RecoveryStatus } from '@prisma/client';

const h = vi.hoisted(() => ({
  accountFindMany: vi.fn(),
  accountFindUnique: vi.fn(),
  accountUpdate: vi.fn(),
  recoveryFindMany: vi.fn(),
  recoveryFindUnique: vi.fn(),
  recoveryUpdate: vi.fn(),
  recoveryUpdateMany: vi.fn(),
  recoveryFindFirst: vi.fn(),
  systemStateFindUnique: vi.fn(),
  verifyStoredLeetCodeAccount: vi.fn(),
  findCredentialsForAccount: vi.fn(),
  sendTelegramMessage: vi.fn(),
}));

vi.mock('../src/database/prisma', () => ({
  prisma: {
    account: {
      findMany: h.accountFindMany,
      findUnique: h.accountFindUnique,
      update: h.accountUpdate,
    },
    accountRecovery: {
      findMany: h.recoveryFindMany,
      findUnique: h.recoveryFindUnique,
      findFirst: h.recoveryFindFirst,
      update: h.recoveryUpdate,
      updateMany: h.recoveryUpdateMany,
    },
    systemState: {
      findUnique: h.systemStateFindUnique,
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        accountRecovery: {
          findUnique: h.recoveryFindUnique,
          update: h.recoveryUpdate,
        },
        account: {
          findUnique: h.accountFindUnique,
          update: h.accountUpdate,
        },
      }),
    ),
  },
}));

vi.mock('../src/leetcode/sessionManager', () => ({
  clearLeetCodeLoginCooldown: vi.fn(async () => undefined),
  openLightweightLeetCodeSession: vi.fn(),
  verifyStoredLeetCodeAccount: h.verifyStoredLeetCodeAccount,
}));

vi.mock('../src/security/credentialStore', () => ({
  findCredentialsForAccount: h.findCredentialsForAccount,
}));

vi.mock('../src/notifications/telegram', () => ({
  sendTelegramMessage: h.sendTelegramMessage,
}));

import { config } from '../src/config';
import { PrismaRecoveryStore } from '../src/recovery/prismaStore';
import {
  createProductionRecoveryService,
  reportAccountSessionDown,
  setRecoveryServiceForTests,
} from '../src/recovery/runtime';

describe('Recovery Postgres egress optimizations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRecoveryServiceForTests(null);
    h.recoveryFindMany.mockResolvedValue([]);
    h.accountFindMany.mockResolvedValue([]);
    h.accountFindUnique.mockResolvedValue(null);
    h.recoveryFindFirst.mockResolvedValue(null);
    h.systemStateFindUnique.mockResolvedValue(null);
    h.sendTelegramMessage.mockResolvedValue(true);
  });

  it('PrismaRecoveryStore.listOpenMeta selects only id, status, and nextReminderAt', async () => {
    const store = new PrismaRecoveryStore();
    await store.listOpenMeta();

    expect(h.recoveryFindMany).toHaveBeenCalledTimes(1);
    expect(h.recoveryFindMany).toHaveBeenCalledWith({
      where: { status: { in: expect.any(Array) } },
      select: { id: true, status: true, nextReminderAt: true },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('PrismaRecoveryStore.commitRecovered avoids reading Account.storageState before updating', async () => {
    const now = new Date('2026-11-17T10:00:00Z');
    h.recoveryFindUnique.mockResolvedValue({ accountId: 'acc-1', status: RecoveryStatus.VERIFYING });
    h.accountFindUnique.mockResolvedValue({ status: AccountStatus.EXPIRED });
    h.accountUpdate.mockResolvedValue({ id: 'acc-1' });
    h.recoveryUpdate.mockResolvedValue({ id: 'rec-1', status: RecoveryStatus.RECOVERED });

    const store = new PrismaRecoveryStore();
    const res = await store.commitRecovered({
      recoveryId: 'rec-1',
      accountId: 'acc-1',
      storageState: '{"cookies":[{"name":"LEETCODE_SESSION","value":"new"}],"origins":[]}',
      username: 'alice',
      now,
    });

    expect(res.status).toBe(RecoveryStatus.RECOVERED);
    expect(h.recoveryFindUnique).toHaveBeenCalledWith({
      where: { id: 'rec-1' },
      select: { accountId: true, status: true },
    });
    expect(h.accountFindUnique).toHaveBeenCalledWith({
      where: { id: 'acc-1' },
      select: { status: true },
    });
  });

  it('idle service.tick() in production runtime runs a single minimal listOpenMeta query', async () => {
    const svc = createProductionRecoveryService();
    const res = await svc.tick();

    expect(res).toEqual({ notified: 0 });
    expect(h.recoveryFindMany).toHaveBeenCalledTimes(1);
    expect(h.recoveryFindMany).toHaveBeenCalledWith({
      where: { status: { in: expect.any(Array) } },
      select: { id: true, status: true, nextReminderAt: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(h.accountFindMany).not.toHaveBeenCalled();
    expect(h.accountFindUnique).not.toHaveBeenCalled();
  });

  it('monitorAccounts() omits storageState on listAccounts and only fetches full account for verified non-disabled accounts', async () => {
    h.accountFindMany.mockResolvedValue([
      { id: 'acc-disabled', label: 'disabled_acc', username: 'd', status: AccountStatus.DISABLED },
      { id: 'acc-active', label: 'active_acc', username: 'alice', status: AccountStatus.ACTIVE },
    ]);
    h.accountFindUnique.mockResolvedValue({
      id: 'acc-active',
      label: 'active_acc',
      username: 'alice',
      status: AccountStatus.ACTIVE,
      storageState: '{"cookies":[{"name":"LEETCODE_SESSION","value":"secret"}],"origins":[]}',
      lastCheckedAt: null,
      lastRunAt: null,
      lastResult: null,
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    h.verifyStoredLeetCodeAccount.mockResolvedValue({
      authenticated: true,
      username: 'alice',
      cause: 'valid',
    });

    const svc = createProductionRecoveryService();
    const summary = await svc.monitorAccounts();

    expect(summary.active).toEqual(['active_acc']);
    expect(summary.checked).toBe(1);
    expect(h.accountFindMany).toHaveBeenCalledWith({
      orderBy: { label: 'asc' },
      select: { id: true, label: true, username: true, status: true },
    });
    // Full account (including storageState) fetched ONLY once for the active account being verified.
    expect(h.accountFindUnique).toHaveBeenCalledTimes(1);
    expect(h.accountFindUnique).toHaveBeenCalledWith({ where: { id: 'acc-active' } });
  });

  it('describeOpen() and reportAccountSessionDown() never fetch Account.storageState', async () => {
    h.recoveryFindMany.mockResolvedValue([
      {
        id: 'rec-1',
        accountId: 'acc-1',
        status: RecoveryStatus.RECOVERY_PENDING,
        reason: 'EXPIRED',
        telegramChatId: '123',
        tokenHash: null,
        tokenExpiresAt: null,
        tokenUsedAt: null,
        lastNotifiedAt: null,
        nextReminderAt: new Date('2026-11-17T10:00:00Z'),
        attemptCount: 0,
        lastErrorCategory: null,
        lastError: null,
        recoveredAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    h.accountFindMany.mockResolvedValue([
      { id: 'acc-1', label: 'main', username: 'alice', status: AccountStatus.EXPIRED },
    ]);

    const svc = createProductionRecoveryService();
    const lines = await svc.describeOpen();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('main: RECOVERY_PENDING');
    expect(h.accountFindMany).toHaveBeenCalledWith({
      where: { id: { in: ['acc-1'] } },
      select: { id: true, label: true, username: true, status: true },
    });
    expect(h.accountFindUnique).not.toHaveBeenCalled();

    // reportAccountSessionDown fetches only identity fields
    h.accountFindUnique.mockResolvedValueOnce({
      id: 'acc-1',
      label: 'main',
      username: 'alice',
      status: AccountStatus.ACTIVE,
    });
    setRecoveryServiceForTests({
      openRecovery: vi.fn(async () => ({ recovery: {} as any, created: true })),
    } as any);
    await reportAccountSessionDown('acc-1');
    expect(h.accountFindUnique).toHaveBeenCalledWith({
      where: { id: 'acc-1' },
      select: { id: true, label: true, username: true, status: true },
    });
  });

  it('bootstrapLocalRecovery() passes identity directly to findCredentialsForAccount without re-fetching storageState', async () => {
    const token = 'A'.repeat(43);
    h.recoveryFindUnique.mockResolvedValue({
      id: 'rec-1',
      accountId: 'acc-1',
      status: RecoveryStatus.RECOVERY_PENDING,
      reason: 'EXPIRED',
      telegramChatId: config.telegram.chatId,
      tokenHash: 'hash',
      tokenExpiresAt: new Date(Date.now() + 60_000),
      tokenUsedAt: null,
      lastNotifiedAt: null,
      nextReminderAt: null,
      attemptCount: 0,
      lastErrorCategory: null,
      lastError: null,
      recoveredAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    h.accountFindUnique.mockResolvedValue({
      id: 'acc-1',
      label: 'main',
      username: 'alice',
      status: AccountStatus.EXPIRED,
    });
    h.findCredentialsForAccount.mockResolvedValue({ username: 'alice', password: 'pw' });

    const svc = createProductionRecoveryService();
    const res = await svc.bootstrapLocalRecovery(token);

    expect(res).toEqual({
      ok: true,
      label: 'main',
      expectedUsername: 'alice',
      credentials: { identifier: 'alice', password: 'pw' },
    });
    expect(h.accountFindUnique).toHaveBeenCalledTimes(1);
    expect(h.accountFindUnique).toHaveBeenCalledWith({
      where: { id: 'acc-1' },
      select: { id: true, label: true, username: true, status: true },
    });
  });
});
