import { Browser, chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { AccountStatus } from '@prisma/client';
import { config } from '../config';
import { logger } from '../logger';
import { saveStorageStateToDb, setSystemState, SystemKeys } from '../database/models';
import { listAccounts, saveAccount } from '../database/accounts';
import { LeetCodeApi, looksLikeChallenge } from '../leetcode/apiClient';
import { buildLaunchArgs } from './playwright';
import { checkSession } from './sessionCheck';
import { parseCookiePayload, StorageStateShape } from './cookiePayload';

/**
 * Session renewal — the apply half of the /renew flow.
 *
 *   parse → VALIDATE against LeetCode → only then save.
 *
 * The ordering matters: an invalid paste must never overwrite the credential
 * that is currently stored, so nothing touches Postgres or the filesystem
 * until LeetCode itself has confirmed the new cookies sign in.
 *
 * Two save targets:
 *   - default (no label): the legacy single-session store (SystemState) plus
 *     the 'default'/sole account, so the phone-only /renew flow keeps working.
 *   - labeled (/renew <label> or POST /admin/accounts): that account only.
 *
 * Cookie values are never logged.
 */

export type RenewalOutcome =
  | { ok: true; username: string; cookieCount: number; format: string }
  | { ok: false; error: string };

/** Outcome of validating a storageState against LeetCode — no side effects. */
export type ValidationOutcome =
  | { ok: true; username: string }
  | {
      ok: false;
      error: string;
      /** 'signed-out' = LeetCode answered "not signed in"; 'blocked'/'error' = the check itself failed. */
      reason: 'signed-out' | 'blocked' | 'error';
    };

const NOT_SIGNED_IN_ERROR =
  'LeetCode did NOT recognize these cookies (session signed out). Copy them from a browser where leetcode.com actually shows you logged in, and make sure the LEETCODE_SESSION value was copied in full.';

/**
 * Launches a throwaway browser context with these cookies and asks LeetCode
 * who they belong to. Nothing is saved. Used by the /renew flow, the
 * accounts API (validate-then-store) and never logs cookie values.
 */
export async function validateCookiesAgainstLeetcode(
  storageState: StorageStateShape,
): Promise<ValidationOutcome> {
  let browser: Browser | undefined;
  try {
    const isHeadless = config.browser.headless;
    browser = await chromium.launch({
      headless: isHeadless ? false : false,
      args: buildLaunchArgs(isHeadless),
    });
    const context = await browser.newContext({
      storageState: {
        cookies: storageState.cookies,
        origins: storageState.origins,
      },
      viewport: { width: 1366, height: 900 },
      locale: 'en-US',
    });

    const check = await checkSession(new LeetCodeApi(context));
    await context.close().catch(() => undefined);

    if (!check.authenticated || !check.username) {
      if (check.cause === 'query-failed') {
        return {
          ok: false,
          reason: 'blocked',
          error: 'the LeetCode check request failed (network or bot protection)',
        };
      }
      return { ok: false, reason: 'signed-out', error: NOT_SIGNED_IN_ERROR };
    }
    return { ok: true, username: check.username };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (looksLikeChallenge(err)) {
      return {
        ok: false,
        reason: 'blocked',
        error: `LeetCode served a bot challenge while validating (${msg}). The cookies may still be fine — wait a few minutes and send them again.`,
      };
    }
    logger.warn({ err: msg }, 'cookie validation failed');
    return { ok: false, reason: 'error', error: `validation failed: ${msg}` };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

/**
 * Renewal entry point. With `label` the cookies are stored under that
 * account (created on the spot); without, the legacy single-session store
 * is refreshed.
 */
export async function applySessionRenewal(raw: string, label?: string): Promise<RenewalOutcome> {
  const parsed = parseCookiePayload(raw);
  if (!parsed.ok) return parsed;
  if (label) return validateAndSaveAccount(label, parsed.storageState, parsed.format);
  return validateAndSave(parsed.storageState, parsed.format);
}

/**
 * Direct path for scripts/capture-session.ts: the caller already holds a
 * Playwright storageState object — no parsing needed, same validate-then-save.
 */
export async function applyStorageStateDirect(
  storageState: StorageStateShape,
): Promise<RenewalOutcome> {
  return validateAndSave(storageState, 'storageState upload');
}

/** Multi-account renewal: validate, then store under this account label only. */
async function validateAndSaveAccount(
  label: string,
  storageState: StorageStateShape,
  format: string,
): Promise<RenewalOutcome> {
  const validation = await validateCookiesAgainstLeetcode(storageState);
  if (!validation.ok) return validation;

  await saveAccount(label, JSON.stringify(storageState), {
    username: validation.username,
    status: AccountStatus.ACTIVE,
  });
  logger.info(
    { label, username: validation.username, cookies: storageState.cookies.length, format },
    'account session renewed from user-supplied cookies',
  );
  return {
    ok: true,
    username: validation.username,
    cookieCount: storageState.cookies.length,
    format,
  };
}

/**
 * Legacy single-session save: SystemState store, filesystem mirror, and a
 * best-effort sync into the 'default' account (or the sole account) so the
 * old /renew flow keeps multi-account state consistent.
 */
async function validateAndSave(
  storageState: StorageStateShape,
  format: string,
): Promise<RenewalOutcome> {
  const validation = await validateCookiesAgainstLeetcode(storageState);
  if (!validation.ok) return validation;

  // Validated — now persist (Postgres is the durable store on free tier).
  const json = JSON.stringify(storageState);
  await saveStorageStateToDb(json);
  try {
    const target = config.browser.storageStatePath;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, json);
  } catch {
    // Ephemeral / read-only filesystem is fine — the DB copy is authoritative.
  }

  await setSystemState(SystemKeys.authStatus, 'ok');
  await setSystemState(SystemKeys.authUsername, validation.username);
  // A fresh session re-arms the once-a-day expiry alert.
  await setSystemState(SystemKeys.authNotifiedAt, '');

  try {
    const accounts = await listAccounts();
    const target =
      accounts.find((a) => a.label === 'default') ??
      (accounts.length === 1 ? accounts[0] : undefined);
    if (target) {
      await saveAccount(target.label, json, {
        username: validation.username,
        status: AccountStatus.ACTIVE,
      });
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'could not sync the renewed session into an account row',
    );
  }

  logger.info(
    { username: validation.username, cookies: storageState.cookies.length, format: format },
    'session renewed from user-supplied cookies',
  );
  return {
    ok: true,
    username: validation.username,
    cookieCount: storageState.cookies.length,
    format: format,
  };
}
