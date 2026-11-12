import { RecoveryStatus } from '@prisma/client';

export { RecoveryStatus };

/** Persistent recovery row. Never contains a password, cookie or raw token. */
export interface RecoveryRecord {
  id: string;
  accountId: string;
  status: RecoveryStatus;
  reason: string;
  telegramChatId: string;
  tokenHash: string | null;
  tokenExpiresAt: Date | null;
  tokenUsedAt: Date | null;
  lastNotifiedAt: Date | null;
  nextReminderAt: Date | null;
  attemptCount: number;
  lastErrorCategory: string | null;
  lastError: string | null;
  recoveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Statuses in which an account still needs (or is undergoing) recovery. */
export const OPEN_STATUSES: readonly RecoveryStatus[] = [
  RecoveryStatus.RECOVERY_PENDING,
  RecoveryStatus.AWAITING_VERIFICATION,
  RecoveryStatus.VERIFYING,
  RecoveryStatus.RECOVERY_FAILED,
];

/** Statuses for which an hourly reminder (with a fresh link) may be sent. */
export const REMINDABLE_STATUSES: readonly RecoveryStatus[] = [
  RecoveryStatus.RECOVERY_PENDING,
  RecoveryStatus.RECOVERY_FAILED,
];

/** Statuses meaning a human/browser session is (supposed to be) live. */
export const IN_SESSION_STATUSES: readonly RecoveryStatus[] = [
  RecoveryStatus.AWAITING_VERIFICATION,
  RecoveryStatus.VERIFYING,
];

export type ConsumeFailure = 'invalid' | 'expired' | 'used' | 'cancelled' | 'wrong_state';
export type ConsumeResult =
  | { ok: true; recovery: RecoveryRecord }
  | { ok: false; reason: ConsumeFailure };

export interface CommitRecoveredInput {
  recoveryId: string;
  accountId: string;
  /** Serialized Playwright storageState of the verified session. */
  storageState: string;
  username: string;
  now: Date;
}

export class RecoveryCommitError extends Error {
  constructor(
    readonly code: 'recovery_not_verifying' | 'account_missing' | 'account_disabled',
    message: string,
  ) {
    super(message);
    this.name = 'RecoveryCommitError';
  }
}

/**
 * Persistence contract for the recovery state machine. The Prisma implementation
 * performs every transition with compare-and-set updates so concurrent workers
 * (or two Render instances during a deploy overlap) can never double-claim a
 * reminder, double-consume a token, or half-commit a session.
 */
export interface RecoveryStore {
  getById(id: string): Promise<RecoveryRecord | null>;
  findByTokenHash(tokenHash: string): Promise<RecoveryRecord | null>;
  findOpenByAccount(accountId: string): Promise<RecoveryRecord | null>;
  listOpen(): Promise<RecoveryRecord[]>;
  /** Creates the single open recovery for an account, or returns the existing one. */
  create(input: {
    accountId: string;
    reason: string;
    telegramChatId: string;
    now: Date;
    nextReminderAt: Date;
  }): Promise<{ recovery: RecoveryRecord; created: boolean }>;
  /** Atomically claims due reminders: advances nextReminderAt BEFORE returning them. */
  claimDueReminders(now: Date, intervalMs: number, limit: number): Promise<RecoveryRecord[]>;
  /** Installs a fresh one-time token (re-arms RECOVERY_FAILED -> RECOVERY_PENDING). */
  issueToken(id: string, tokenHash: string, expiresAt: Date): Promise<RecoveryRecord | null>;
  /** Single-use consume: PENDING -> AWAITING_VERIFICATION, attemptCount + 1. */
  consumeToken(tokenHash: string, now: Date): Promise<ConsumeResult>;
  setStatus(
    id: string,
    from: readonly RecoveryStatus[],
    to: RecoveryStatus,
  ): Promise<RecoveryRecord | null>;
  markFailed(
    id: string,
    category: string,
    message: string,
    nextReminderAt: Date,
  ): Promise<RecoveryRecord | null>;
  cancel(id: string, category: string): Promise<RecoveryRecord | null>;
  rescheduleReminder(id: string, at: Date): Promise<void>;
  /** Clears any prior error category/message and schedules an immediate reminder when an operator explicitly requests recovery. */
  resetForOperatorRequest?(id: string, now: Date): Promise<void>;
  /**
   * ATOMIC: replaces the account's session AND marks the recovery RECOVERED in
   * one transaction, only while the recovery is still VERIFYING. Throws
   * RecoveryCommitError or the underlying DB error; nothing is written then.
   */
  commitRecovered(input: CommitRecoveredInput): Promise<RecoveryRecord>;
}
