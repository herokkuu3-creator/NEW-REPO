import { Account, AccountStatus } from '@prisma/client';
import { prisma } from './prisma';
import { getSystemState, SystemKeys } from './models';
import { logger } from '../logger';
import { StorageStateShape } from '../browser/cookiePayload';

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

/** Accounts the daily run should process — DISABLED ones are skipped. */
export async function listEnabledAccounts(): Promise<AccountRecord[]> {
  return prisma.account.findMany({
    where: { status: { not: AccountStatus.DISABLED } },
    orderBy: { label: 'asc' },
  });
}

export async function getAccountByLabel(label: string): Promise<AccountRecord | null> {
  return prisma.account.findUnique({ where: { label } });
}

/**
 * Inserts or replaces an account's credential. `meta.status` defaults to
 * UNKNOWN — the next run classifies it as ACTIVE or EXPIRED.
 */
export async function saveAccount(
  label: string,
  storageState: string,
  meta: { username?: string; status?: AccountStatus } = {},
): Promise<AccountRecord> {
  const status = meta.status ?? AccountStatus.UNKNOWN;
  return prisma.account.upsert({
    where: { label },
    create: { label, storageState, username: meta.username, status },
    update: { storageState, username: meta.username, status, lastError: null },
  });
}

export async function deleteAccountByLabel(label: string): Promise<void> {
  await prisma.account.delete({ where: { label } });
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
