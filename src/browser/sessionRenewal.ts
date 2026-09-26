import { Browser, chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { logger } from '../logger';
import { saveStorageStateToDb, setSystemState, SystemKeys } from '../database/models';
import { LeetCodeApi, looksLikeChallenge } from '../leetcode/apiClient';
import { buildLaunchArgs } from './playwright';
import { checkSession } from './sessionCheck';
import { parseCookiePayload } from './cookiePayload';

/**
 * Session renewal — the apply half of the /renew flow.
 *
 *   parse → VALIDATE against LeetCode → only then save.
 *
 * The ordering matters: an invalid paste must never overwrite the credential
 * that is currently stored, so nothing touches Postgres or the filesystem
 * until LeetCode itself has confirmed the new cookies sign in.
 *
 * Cookie values are never logged.
 */

export type RenewalOutcome =
  | { ok: true; username: string; cookieCount: number; format: string }
  | { ok: false; error: string };

export async function applySessionRenewal(raw: string): Promise<RenewalOutcome> {
  const parsed = parseCookiePayload(raw);
  if (!parsed.ok) return parsed;

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: config.browser.headless,
      args: buildLaunchArgs(),
    });
    const context = await browser.newContext({
      storageState: {
        cookies: parsed.storageState.cookies,
        origins: parsed.storageState.origins,
      },
      viewport: { width: 1366, height: 900 },
      locale: 'en-US',
    });

    const check = await checkSession(new LeetCodeApi(context));
    await context.close().catch(() => undefined);

    if (!check.authenticated || !check.username) {
      return {
        ok: false,
        error:
          'LeetCode did NOT recognize these cookies (session signed out). Copy them from a browser where leetcode.com actually shows you logged in, and make sure the LEETCODE_SESSION value was copied in full.',
      };
    }

    // Validated — now persist (Postgres is the durable store on free tier).
    const json = JSON.stringify(parsed.storageState);
    await saveStorageStateToDb(json);
    try {
      const target = config.browser.storageStatePath;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, json);
    } catch {
      // Ephemeral / read-only filesystem is fine — the DB copy is authoritative.
    }

    await setSystemState(SystemKeys.authStatus, 'ok');
    await setSystemState(SystemKeys.authUsername, check.username);
    // A fresh session re-arms the once-a-day expiry alert.
    await setSystemState(SystemKeys.authNotifiedAt, '');

    logger.info(
      { username: check.username, cookies: parsed.storageState.cookies.length, format: parsed.format },
      'session renewed from user-supplied cookies',
    );
    return {
      ok: true,
      username: check.username,
      cookieCount: parsed.storageState.cookies.length,
      format: parsed.format,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (looksLikeChallenge(err)) {
      return {
        ok: false,
        error: `LeetCode served a bot challenge while validating (${msg}). The cookies may still be fine — wait a few minutes and send them again.`,
      };
    }
    logger.warn({ err: msg }, 'session renewal validation failed');
    return { ok: false, error: `validation failed: ${msg}` };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}