import { AccountStatus, Prisma } from '@prisma/client';
import { prisma } from '../database/prisma';
import {
  CommitRecoveredInput,
  ConsumeResult,
  IN_SESSION_STATUSES,
  OPEN_STATUSES,
  RecoveryCommitError,
  RecoveryRecord,
  RecoveryStatus,
  RecoveryStore,
  REMINDABLE_STATUSES,
} from './types';

const open = [...OPEN_STATUSES];
const remindable = [...REMINDABLE_STATUSES];

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * PostgreSQL-backed recovery store. Every state transition is a compare-and-set
 * `updateMany` (count === 1 means "I won"), which is what makes reminders,
 * token consumption and session commits safe across restarts and instances.
 */
export class PrismaRecoveryStore implements RecoveryStore {
  getById(id: string): Promise<RecoveryRecord | null> {
    return prisma.accountRecovery.findUnique({ where: { id } });
  }

  findByTokenHash(tokenHash: string): Promise<RecoveryRecord | null> {
    return prisma.accountRecovery.findUnique({ where: { tokenHash } });
  }

  findOpenByAccount(accountId: string): Promise<RecoveryRecord | null> {
    return prisma.accountRecovery.findFirst({ where: { accountId, status: { in: open } } });
  }

  listOpen(): Promise<RecoveryRecord[]> {
    return prisma.accountRecovery.findMany({
      where: { status: { in: open } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(input: {
    accountId: string;
    reason: string;
    telegramChatId: string;
    now: Date;
    nextReminderAt: Date;
  }): Promise<{ recovery: RecoveryRecord; created: boolean }> {
    try {
      const recovery = await prisma.accountRecovery.create({
        data: {
          accountId: input.accountId,
          reason: input.reason,
          telegramChatId: input.telegramChatId,
          status: RecoveryStatus.RECOVERY_PENDING,
          nextReminderAt: input.nextReminderAt,
        },
      });
      return { recovery, created: true };
    } catch (err) {
      // The partial unique index "one open recovery per account" fired.
      if (!isUniqueViolation(err)) throw err;
      const existing = await this.findOpenByAccount(input.accountId);
      if (!existing) throw err;
      return { recovery: existing, created: false };
    }
  }

  async claimDueReminders(now: Date, intervalMs: number, limit: number): Promise<RecoveryRecord[]> {
    const candidates = await prisma.accountRecovery.findMany({
      where: { status: { in: remindable }, nextReminderAt: { lte: now } },
      orderBy: { nextReminderAt: 'asc' },
      take: limit,
    });
    const next = new Date(now.getTime() + intervalMs);
    const claimed: RecoveryRecord[] = [];
    for (const candidate of candidates) {
      const won = await prisma.accountRecovery.updateMany({
        where: { id: candidate.id, status: { in: remindable }, nextReminderAt: { lte: now } },
        data: { nextReminderAt: next, lastNotifiedAt: now },
      });
      if (won.count === 1) claimed.push({ ...candidate, nextReminderAt: next, lastNotifiedAt: now });
    }
    return claimed;
  }

  async issueToken(id: string, tokenHash: string, expiresAt: Date): Promise<RecoveryRecord | null> {
    const won = await prisma.accountRecovery.updateMany({
      where: { id, status: { in: remindable } },
      data: {
        tokenHash,
        tokenExpiresAt: expiresAt,
        tokenUsedAt: null,
        status: RecoveryStatus.RECOVERY_PENDING,
      },
    });
    return won.count === 1 ? this.getById(id) : null;
  }

  async consumeToken(tokenHash: string, now: Date): Promise<ConsumeResult> {
    const won = await prisma.accountRecovery.updateMany({
      where: {
        tokenHash,
        tokenUsedAt: null,
        tokenExpiresAt: { gt: now },
        status: RecoveryStatus.RECOVERY_PENDING,
      },
      data: {
        tokenUsedAt: now,
        status: RecoveryStatus.AWAITING_VERIFICATION,
        attemptCount: { increment: 1 },
        nextReminderAt: null,
      },
    });
    const row = await this.findByTokenHash(tokenHash);
    if (won.count === 1 && row) return { ok: true, recovery: row };
    if (!row) return { ok: false, reason: 'invalid' };
    if (row.status === RecoveryStatus.CANCELLED) return { ok: false, reason: 'cancelled' };
    if (row.tokenUsedAt) return { ok: false, reason: 'used' };
    if (!row.tokenExpiresAt || row.tokenExpiresAt <= now) return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'wrong_state' };
  }

  async setStatus(
    id: string,
    from: readonly RecoveryStatus[],
    to: RecoveryStatus,
  ): Promise<RecoveryRecord | null> {
    const won = await prisma.accountRecovery.updateMany({
      where: { id, status: { in: [...from] } },
      data: { status: to },
    });
    return won.count === 1 ? this.getById(id) : null;
  }

  async markFailed(
    id: string,
    category: string,
    message: string,
    nextReminderAt: Date,
  ): Promise<RecoveryRecord | null> {
    const won = await prisma.accountRecovery.updateMany({
      where: { id, status: { in: [...IN_SESSION_STATUSES, RecoveryStatus.RECOVERY_PENDING] } },
      data: {
        status: RecoveryStatus.RECOVERY_FAILED,
        lastErrorCategory: category,
        lastError: message.slice(0, 500),
        nextReminderAt,
      },
    });
    return won.count === 1 ? this.getById(id) : null;
  }

  async cancel(id: string, category: string): Promise<RecoveryRecord | null> {
    const won = await prisma.accountRecovery.updateMany({
      where: { id, status: { in: open } },
      data: { status: RecoveryStatus.CANCELLED, lastErrorCategory: category, nextReminderAt: null },
    });
    return won.count === 1 ? this.getById(id) : null;
  }

  async rescheduleReminder(id: string, at: Date): Promise<void> {
    await prisma.accountRecovery.updateMany({
      where: { id, status: { in: remindable } },
      data: { nextReminderAt: at },
    });
  }

  commitRecovered(input: CommitRecoveredInput): Promise<RecoveryRecord> {
    return prisma.$transaction(async (tx) => {
      const recovery = await tx.accountRecovery.findUnique({ where: { id: input.recoveryId } });
      if (
        !recovery ||
        recovery.accountId !== input.accountId ||
        recovery.status !== RecoveryStatus.VERIFYING
      ) {
        throw new RecoveryCommitError('recovery_not_verifying', 'recovery is no longer awaiting commit');
      }
      const account = await tx.account.findUnique({ where: { id: input.accountId } });
      if (!account) throw new RecoveryCommitError('account_missing', 'account no longer exists');
      if (account.status === AccountStatus.DISABLED) {
        throw new RecoveryCommitError('account_disabled', 'account is disabled');
      }
      // Exactly one account row, selected by the recovery's own accountId.
      await tx.account.update({
        where: { id: input.accountId },
        data: {
          storageState: input.storageState,
          username: input.username,
          status: AccountStatus.ACTIVE,
          lastError: null,
          lastCheckedAt: input.now,
        },
      });
      return tx.accountRecovery.update({
        where: { id: input.recoveryId },
        data: {
          status: RecoveryStatus.RECOVERED,
          recoveredAt: input.now,
          nextReminderAt: null,
          lastErrorCategory: null,
          lastError: null,
        },
      });
    });
  }
}
