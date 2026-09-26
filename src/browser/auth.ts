import {
  BrowserSession,
  launchWithPersistentProfile,
  launchWithStorageState,
  backupStorageState,
} from './playwright';
import { checkSession } from './sessionCheck';
import { LeetCodeApi, looksLikeChallenge } from '../leetcode/apiClient';
import { setSystemState, SystemKeys } from '../database/models';
import { logger } from '../logger';

/**
 * Authentication orchestration — the startup sequence:
 *
 *   1. Try the persistent Chromium profile, verify the signed-in username.
 *   2. On failure, fall back to the storageState snapshot.
 *   3. On failure of both, report AUTHENTICATION_REQUIRED.
 *
 * Verification is API-only (no page navigation), which is what keeps the run
 * clear of Cloudflare's HTML interstitials. If a challenge does surface as an
 * HTTP error, the run stops with CLOUDFLARE_VERIFICATION_REQUIRED — this
 * module NEVER attempts to solve one, and never attempts password login.
 */

export interface AuthenticatedSession {
  session: BrowserSession;
  api: LeetCodeApi;
  username: string;
}

export type AuthOutcome =
  | ({ ok: true } & AuthenticatedSession)
  | { ok: false; reason: 'AUTHENTICATION_REQUIRED' | 'CLOUDFLARE_VERIFICATION_REQUIRED' };

type TryResult = AuthenticatedSession | 'cf' | null;

async function trySession(session: BrowserSession | null): Promise<TryResult> {
  if (!session) return null;

  const api = new LeetCodeApi(session.context);
  const check = await checkSession(api);
  if (!check.authenticated || !check.username) {
    await session.close().catch(() => undefined);
    return null;
  }

  return { session, api, username: check.username };
}

async function reportChallenge(err: unknown): Promise<'cf'> {
  logger.error(
    { err: err instanceof Error ? err.message : String(err) },
    'LeetCode returned a bot-challenge response — stopping (never solved automatically)',
  );
  await setSystemState(SystemKeys.authStatus, 'cloudflare_verification_required');
  return 'cf';
}

export async function establishAuthenticatedSession(): Promise<AuthOutcome> {
  // 1) Persistent profile (primary; used on paid tiers where a disk exists)
  let primary: TryResult;
  try {
    primary = await trySession(await launchWithPersistentProfile());
  } catch (err) {
    if (looksLikeChallenge(err)) {
      const r = await reportChallenge(err);
      return { ok: false, reason: 'CLOUDFLARE_VERIFICATION_REQUIRED' };
    }
    throw err;
  }
  if (primary === 'cf') {
    return { ok: false, reason: 'CLOUDFLARE_VERIFICATION_REQUIRED' };
  }
  if (primary) {
    await backupStorageState(primary.session.context);
    await setSystemState(SystemKeys.authStatus, 'ok');
    await setSystemState(SystemKeys.authUsername, primary.username);
    await setSystemState(SystemKeys.authNotifiedAt, ''); // re-arm the expiry alert
    return { ok: true, ...primary };
  }

  logger.warn('persistent profile authentication failed — trying storageState fallback');

  // 2) storageState fallback (the normal path on Render's free tier)
  const fallback = await trySession(await launchWithStorageState());
  if (fallback === 'cf') {
    return { ok: false, reason: 'CLOUDFLARE_VERIFICATION_REQUIRED' };
  }
  if (fallback) {
    // Refresh the durable DB copy — on free tier this IS the credential store,
    // and rolling cookies forward keeps the session alive without a re-upload.
    await backupStorageState(fallback.session.context);
    await setSystemState(SystemKeys.authStatus, 'ok');
    await setSystemState(SystemKeys.authUsername, fallback.username);
    await setSystemState(SystemKeys.authNotifiedAt, ''); // re-arm the expiry alert
    logger.warn(
      'authenticated via storageState — re-run `npm run auth:setup` when the session eventually expires',
    );
    return { ok: true, ...fallback };
  }

  // 3) Both failed — human action required. Never attempt password login.
  await setSystemState(SystemKeys.authStatus, 'authentication_required');
  logger.error(
    'authentication required: re-run `npm run auth:setup` locally and re-upload storageState to POST /admin/storage-state',
  );
  return { ok: false, reason: 'AUTHENTICATION_REQUIRED' };
}