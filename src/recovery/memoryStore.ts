import { randomUUID } from 'node:crypto';
import { AccountStatus } from '@prisma/client';
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

export interface MemoryAccountRow {
  id: string;
  label: string;
  username: string | null;
  status: AccountStatus;
  storageState: string;
}

/**
 * In-memory RecoveryStore with the SAME compare-and-set semantics and the same
 * "one open recovery per account" invariant as the PostgreSQL implementation.
 * Used by the integration tests (no database is reachable in CI) and shares the
 * account rows so atomic-commit behaviour can be asserted end to end.
 *
 * `failNextCommit` injects a transaction failure: nothing is written, exactly
 * like a rolled-back Prisma transaction.
 */
export class MemoryRecoveryStore implements RecoveryStore {
  readonly rows = new Map<string, RecoveryRecord>();
  failNextCommit: Error | null = null;
  commits = 0;

  constructor(readonly accounts: Map<string, MemoryAccountRow>) {}

  private clone(r: RecoveryRecord | undefined | null): RecoveryRecord | null {
    return r ? { ...r } : null;
  }

  async getById(id: string) {
    return this.clone(this.rows.get(id));
  }

  async findByTokenHash(tokenHash: string) {
    for (const r of this.rows.values()) if (r.tokenHash === tokenHash) return this.clone(r);
    return null;
  }

  async findOpenByAccount(accountId: string) {
    for (const r of this.rows.values()) {
      if (r.accountId === accountId && OPEN_STATUSES.includes(r.status)) return this.clone(r);
    }
    return null;
  }

  async listOpen() {
    return [...this.rows.values()].filter((r) => OPEN_STATUSES.includes(r.status)).map((r) => ({ ...r }));
  }

  async create(input: { accountId: string; reason: string; telegramChatId: string; now: Date; nextReminderAt: Date }) {
    const existing = await this.findOpenByAccount(input.accountId);
    if (existing) return { recovery: existing, created: false };
    const row: RecoveryRecord = {
      id: randomUUID(),
      accountId: input.accountId,
      status: RecoveryStatus.RECOVERY_PENDING,
      reason: input.reason,
      telegramChatId: input.telegramChatId,
      tokenHash: null,
      tokenExpiresAt: null,
      tokenUsedAt: null,
      lastNotifiedAt: null,
      nextReminderAt: input.nextReminderAt,
      attemptCount: 0,
      lastErrorCategory: null,
      lastError: null,
      recoveredAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.rows.set(row.id, row);
    return { recovery: { ...row }, created: true };
  }

  async claimDueReminders(now: Date, intervalMs: number, limit: number) {
    const due = [...this.rows.values()]
      .filter((r) => REMINDABLE_STATUSES.includes(r.status) && r.nextReminderAt && r.nextReminderAt <= now)
      .sort((a, b) => a.nextReminderAt!.getTime() - b.nextReminderAt!.getTime())
      .slice(0, limit);
    const next = new Date(now.getTime() + intervalMs);
    return due.map((r) => {
      r.nextReminderAt = next;
      r.lastNotifiedAt = now;
      return { ...r };
    });
  }

  async issueToken(id: string, tokenHash: string, expiresAt: Date) {
    const r = this.rows.get(id);
    if (!r || !REMINDABLE_STATUSES.includes(r.status)) return null;
    r.tokenHash = tokenHash;
    r.tokenExpiresAt = expiresAt;
    r.tokenUsedAt = null;
    r.status = RecoveryStatus.RECOVERY_PENDING;
    return { ...r };
  }

  async consumeToken(tokenHash: string, now: Date): Promise<ConsumeResult> {
    const r = [...this.rows.values()].find((x) => x.tokenHash === tokenHash);
    if (!r) return { ok: false, reason: 'invalid' };
    if (r.status === RecoveryStatus.CANCELLED) return { ok: false, reason: 'cancelled' };
    if (r.tokenUsedAt) return { ok: false, reason: 'used' };
    if (!r.tokenExpiresAt || r.tokenExpiresAt <= now) return { ok: false, reason: 'expired' };
    if (r.status !== RecoveryStatus.RECOVERY_PENDING) return { ok: false, reason: 'wrong_state' };
    r.tokenUsedAt = now;
    r.status = RecoveryStatus.AWAITING_VERIFICATION;
    r.attemptCount += 1;
    r.nextReminderAt = null;
    return { ok: true, recovery: { ...r } };
  }

  async setStatus(id: string, from: readonly RecoveryStatus[], to: RecoveryStatus) {
    const r = this.rows.get(id);
    if (!r || !from.includes(r.status)) return null;
    r.status = to;
    return { ...r };
  }

  async markFailed(id: string, category: string, message: string, nextReminderAt: Date) {
    const r = this.rows.get(id);
    if (!r || ![...IN_SESSION_STATUSES, RecoveryStatus.RECOVERY_PENDING].includes(r.status)) return null;
    r.status = RecoveryStatus.RECOVERY_FAILED;
    r.lastErrorCategory = category;
    r.lastError = message.slice(0, 500);
    r.nextReminderAt = nextReminderAt;
    return { ...r };
  }

  async cancel(id: string, category: string) {
    const r = this.rows.get(id);
    if (!r || !OPEN_STATUSES.includes(r.status)) return null;
    r.status = RecoveryStatus.CANCELLED;
    r.lastErrorCategory = category;
    r.nextReminderAt = null;
    return { ...r };
  }

  async rescheduleReminder(id: string, at: Date) {
    const r = this.rows.get(id);
    if (r && REMINDABLE_STATUSES.includes(r.status)) r.nextReminderAt = at;
  }

  async resetForOperatorRequest(id: string, now: Date) {
    const r = this.rows.get(id);
    if (r && REMINDABLE_STATUSES.includes(r.status)) {
      r.status = RecoveryStatus.RECOVERY_PENDING;
      r.lastErrorCategory = null;
      r.lastError = null;
      r.nextReminderAt = now;
    }
  }

  async commitRecovered(input: CommitRecoveredInput): Promise<RecoveryRecord> {
    if (this.failNextCommit) {
      const err = this.failNextCommit;
      this.failNextCommit = null;
      throw err; // rolled back: no account or recovery write happened
    }
    const r = this.rows.get(input.recoveryId);
    if (!r || r.accountId !== input.accountId || r.status !== RecoveryStatus.VERIFYING) {
      throw new RecoveryCommitError('recovery_not_verifying', 'recovery is no longer awaiting commit');
    }
    const account = this.accounts.get(input.accountId);
    if (!account) throw new RecoveryCommitError('account_missing', 'account no longer exists');
    if (account.status === AccountStatus.DISABLED) {
      throw new RecoveryCommitError('account_disabled', 'account is disabled');
    }
    account.storageState = input.storageState;
    account.username = input.username;
    account.status = AccountStatus.ACTIVE;
    r.status = RecoveryStatus.RECOVERED;
    r.recoveredAt = input.now;
    r.nextReminderAt = null;
    r.lastErrorCategory = null;
    r.lastError = null;
    this.commits += 1;
    return { ...r };
  }
}
