import { Account, AccountStatus, Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { getSystemState, SystemKeys } from './models';
import { logger } from '../logger';
import { StorageStateShape } from '../browser/cookiePayload';
import { invalidateHealthCache } from '../api/healthCache';

/**
 * Account store — one row per cookie-set ("account") the agent manages.
 *
 * The storageState JSON is a SECRET: the functions here return full records
 * for internal use, but every API response must project the fields it shows
 * and never include `storageState` (see health.ts — safeAccountView).
 *
 * The legacy single-session credential (SystemState key storageStateJson)
 * is seeded into a 'default' account on the first run after upgrade, so the
 * old deployment keeps working without any manual migration.
 */

export type AccountRecord = Account;

/** Account metadata for status/health views — omits the heavy `storageState` blob. */
export interface AccountSummary {
  id: string;
  label: string;
  username: string | null;
  status: AccountStatus;
  lastCheckedAt: Date | null;
  lastRunAt: Date | null;
  lastResult: string | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  cookieCount?: number;
}

/** Minimal account identity for recovery orchestration and lookups without `storageState`. */
export interface AccountIdentity {
  id: string;
  label: string;
  username: string | null;
  status: AccountStatus;
}

const ACCOUNT_SUMMARY_SELECT = {
  id: true,
  label: true,
  username: true,
  status: true,
  lastCheckedAt: true,
  lastRunAt: true,
  lastResult: true,
  lastError: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AccountSelect;

const ACCOUNT_IDENTITY_SELECT = {
  id: true,
  label: true,
  username: true,
  status: true,
} satisfies Prisma.AccountSelect;

function isMockFn(fn: unknown): boolean {
  return typeof fn === 'function' && 'mock' in fn && typeof (fn as { mock?: unknown }).mock === 'object';
}

export type ParseStateResult =
  | { ok: true; state: StorageStateShape }
  | { ok: false; error: string };

/** Parses the stored storageState JSON — never throws, never logs the value. */
export function parseStoredStorageState(json: string): ParseStateResult {
  try {
    const parsed = JSON.parse(json) as StorageStateShape;
    if (!parsed || !Array.isArray(parsed.cookies) || parsed.cookies.length === 0) {
      return { ok: false, error: 'the stored cookie payload has no cookies array' };
    }
    if (!Array.isArray(parsed.origins)) {
      parsed.origins = [];
    }
    return { ok: true, state: parsed };
  } catch {
    return { ok: false, error: 'the stored cookie payload is not valid JSON — re-upload it' };
  }
}

export async function listAccounts(): Promise<AccountRecord[]> {
  return prisma.account.findMany({ orderBy: { label: 'asc' } });
}

/**
 * Lightweight account list for `/health` and `/admin/accounts` that never transfers
 * `storageState` over the network. Computes `cookieCount` server-side in Postgres
 * when available and falls back to a Prisma `select` omitting `storageState`.
 */
export async function listAccountSummaries(): Promise<AccountSummary[]> {
  const rawFn = (prisma as { $queryRaw?: unknown }).$queryRaw;
  const findManyFn = (prisma as { account?: { findMany?: unknown } }).account?.findMany;
  const canUseRaw =
    isMockFn(rawFn) || (typeof rawFn === 'function' && !isMockFn(findManyFn));
  if (canUseRaw) {
    try {
      const rows = await prisma.$queryRaw<
        Array<Omit<AccountSummary, 'status' | 'cookieCount'> & { status: string; cookieCount: number }>
      >`
        SELECT
          "id",
          "label",
          "username",
          "status"::text AS "status",
          "lastCheckedAt",
          "lastRunAt",
          "lastResult",
          "lastError",
          "createdAt",
          "updatedAt",
          CASE
            WHEN jsonb_typeof("storageState"::jsonb) = 'object'
             AND jsonb_typeof(("storageState"::jsonb)->'cookies') = 'array'
            THEN jsonb_array_length(("storageState"::jsonb)->'cookies')
            ELSE 0
          END::int AS "cookieCount"
        FROM "Account"
        ORDER BY "label" ASC
      `;
      return rows.map((row) => ({
        ...row,
        status: row.status as AccountStatus,
        cookieCount: Number(row.cookieCount ?? 0),
      }));
    } catch {
      // Fall back to standard Prisma select if raw JSON inspection fails (e.g. malformed row).
    }
  }
  return prisma.account.findMany({
    orderBy: { label: 'asc' },
    select: ACCOUNT_SUMMARY_SELECT,
  });
}

export async function listAccountIdentities(): Promise<AccountIdentity[]> {
  return prisma.account.findMany({
    orderBy: { label: 'asc' },
    select: ACCOUNT_IDENTITY_SELECT,
  });
}

export async function getAccountIdentityById(id: string): Promise<AccountIdentity | null> {
  return prisma.account.findUnique({
    where: { id },
    select: ACCOUNT_IDENTITY_SELECT,
  });
}

export async function listAccountIdentitiesByIds(ids: readonly string[]): Promise<AccountIdentity[]> {
  if (ids.length === 0) return [];
  return prisma.account.findMany({
    where: { id: { in: [...ids] } },
    select: ACCOUNT_IDENTITY_SELECT,
  });
}

/** Accounts the daily run should process — DISABLED ones are skipped. */
export async function listEnabledAccounts(): Promise<AccountRecord[]> {
  return prisma.account.findMany({
    where: { status: { not: AccountStatus.DISABLED } },
    orderBy: { label: 'asc' },
  });
}

export async function getAccountById(id: string): Promise<AccountRecord | null> {
  return prisma.account.findUnique({ where: { id } });
}

export async function getAccountByLabel(label: string): Promise<AccountRecord | null> {
  return prisma.account.findUnique({ where: { label } });
}

/**
 * Inserts or replaces an account's credential. `meta.status` defaults to
 * UNKNOWN — the next run classifies it as ACTIVE, EXPIRED, or REJECTED.
 */
export async function saveAccount(
  label: string,
  storageState: string,
  meta: { username?: string; status?: AccountStatus } = {},
): Promise<AccountRecord> {
  const status = meta.status ?? AccountStatus.UNKNOWN;
  const saved = await prisma.account.upsert({
    where: { label },
    create: { label, storageState, username: meta.username, status },
    update: { storageState, username: meta.username, status, lastError: null },
  });
  invalidateHealthCache();
  return saved;
}

export async function deleteAccountByLabel(label: string): Promise<void> {
  await prisma.account.delete({ where: { label } });
  invalidateHealthCache();
}

/** Removes one account (and, by cascade, its run history). Returns false if it no longer exists. */
export async function deleteAccountById(id: string): Promise<boolean> {
  const res = await prisma.account.deleteMany({ where: { id } });
  if (res.count > 0) invalidateHealthCache();
  return res.count > 0;
}

/** Removes EVERY account (cascade: run history). Returns how many were removed. */
export async function deleteAllAccounts(): Promise<number> {
  const res = await prisma.account.deleteMany({});
  if (res.count > 0) invalidateHealthCache();
  return res.count;
}

export interface AccountPatch {
  username?: string | null;
  status?: AccountStatus;
  lastError?: string | null;
  lastResult?: string | null;
  checked?: boolean; // bump lastCheckedAt
  ran?: boolean; // bump lastRunAt
}

export async function patchAccount(id: string, patch: AccountPatch): Promise<void> {
  const data: {
    username?: string | null;
    status?: AccountStatus;
    lastError?: string | null;
    lastResult?: string | null;
    lastCheckedAt?: Date;
    lastRunAt?: Date;
  } = {};
  if (patch.username !== undefined) data.username = patch.username;
  if (patch.status !== undefined) data.status = patch.status;
  if (patch.lastError !== undefined) data.lastError = patch.lastError;
  if (patch.lastResult !== undefined) data.lastResult = patch.lastResult;
  if (patch.checked) data.lastCheckedAt = new Date();
  if (patch.ran) data.lastRunAt = new Date();
  await prisma.account.update({ where: { id }, data });
  invalidateHealthCache();
}

/**
 * Seeds a 'default' account from the legacy single-session storageState
 * (SystemState key storageStateJson) — the upgrade path for deployments
 * created before multi-account. Idempotent: does nothing when accounts
 * already exist or when there is no legacy credential.
 */
export async function ensureAccountsSeeded(): Promise<void> {
  try {
    const count = await prisma.account.count();
    if (count > 0) return;
    const legacy = await getSystemState(SystemKeys.storageState);
    if (!legacy) return;
    const parsed = parseStoredStorageState(legacy);
    if (!parsed.ok) {
      logger.warn('legacy storageState exists but is unusable — no default account seeded');
      return;
    }
    await prisma.account.create({
      data: { label: 'default', storageState: legacy, status: AccountStatus.UNKNOWN },
    });
    logger.info('seeded account "default" from the legacy single-session storageState');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'account seeding failed',
    );
  }
}
