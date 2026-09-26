import {
  BrowserSession,
  launchWithPersistentProfile,
  launchWithStorageState,
  backupStorageState,
} from './playwright';
import { checkSession } from './sessionCheck';
import { detectVerificationPage } from './cloudflareDetector';
import { captureDiagnostics } from './diagnostics';
import { setSystemState, SystemKeys } from '../database/models';
import { logger } from '../logger';

/**
 * Authentication orchestration — the exact startup sequence:
 *
 *   1. Try the persistent Chromium profile, verify the logged-in username.
 *   2. On failure, fall back to the storageState snapshot.
 *   3. On failure of both, report AUTHENTICATION_REQUIRED.
 *
 * If a Cloudflare verification interstitial is detected at any point, the
 * run stops gracefully with CLOUDFLARE_VERIFICATION_REQUIRED and a
 * diagnostics bundle. This module NEVER attempts password login.
 */

export type AuthOutcome =
  | { ok: true; session: BrowserSession; username: string }
  | { ok: false; reason: 'AUTHENTICATION_REQUIRED' | 'CLOUDFLARE_VERIFICATION_REQUIRED' };

async function trySession(
  session: BrowserSession | null,
): Promise<{ session: BrowserSession; username: string } | 'cf' | null> {
  if (!session) return null;

  const cfKind = await detectVerificationPage(session.page);
  if (cfKind) {
    await captureDiagnostics(session.page, `cloudflare-${cfKind}`, session.browserLogs);
    return 'cf';
  }

  const check = await checkSession(session.page);
  if (!check.authenticated || !check.username) {
    await session.close().catch(() => undefined);
    return null;
  }

  // A verification page may appear after navigation; check once more.
  const cfAfter = await detectVerificationPage(session.page);
  if (cfAfter) {
    await captureDiagnostics(session.page, `cloudflare-${cfAfter}`, session.browserLogs);
    return 'cf';
  }

  return { session, username: check.username };
}

export async function establishAuthenticatedSession(): Promise<AuthOutcome> {
  // 1) Persistent profile (primary)
  const primary = await trySession(await launchWithPersistentProfile());
  if (primary === 'cf') {
    await setSystemState(SystemKeys.authStatus, 'cloudflare_verification_required');
    return { ok: false, reason: 'CLOUDFLARE_VERIFICATION_REQUIRED' };
  }
  if (primary) {
    // Keep the JSON fallback fresh for disaster recovery.
    await backupStorageState(primary.session.context);
    await setSystemState(SystemKeys.authStatus, 'ok');
    await setSystemState(SystemKeys.authUsername, primary.username);
    return { ok: true, session: primary.session, username: primary.username };
  }

  logger.warn('persistent profile authentication failed — trying storageState fallback');

  // 2) storageState fallback
  const fallback = await trySession(await launchWithStorageState());
  if (fallback === 'cf') {
    await setSystemState(SystemKeys.authStatus, 'cloudflare_verification_required');
    return { ok: false, reason: 'CLOUDFLARE_VERIFICATION_REQUIRED' };
  }
  if (fallback) {
    // Refresh the durable DB copy too — on free tier (no disk) this IS the
    // primary credential store, and cookies rolling forward matter.
    await backupStorageState(fallback.session.context);
    await setSystemState(SystemKeys.authStatus, 'ok');
    await setSystemState(SystemKeys.authUsername, fallback.username);
    logger.warn('authenticated via storageState fallback — re-run `npm run auth:setup` to repair the primary profile');
    return { ok: true, session: fallback.session, username: fallback.username };
  }

  // 3) Both failed — human action required. Never attempt password login.
  await setSystemState(SystemKeys.authStatus, 'authentication_required');
  logger.error(
    'authentication required: re-run `npm run auth:setup` locally and re-upload the profile to the Render disk',
  );
  return { ok: false, reason: 'AUTHENTICATION_REQUIRED' };
}
