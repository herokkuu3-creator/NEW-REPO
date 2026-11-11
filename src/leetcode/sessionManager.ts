import { request as playwrightRequest, type APIRequestContext } from 'playwright';
import { AccountStatus } from '@prisma/client';
import {
  type AccountRecord,
  getAccountById,
  getAccountByLabel,
  listAccounts,
  parseStoredStorageState,
  patchAccount,
  saveAccount,
} from '../database/accounts';
import { getSystemState, setSystemState } from '../database/models';
import { checkSession, type SessionCheckResult } from '../browser/sessionCheck';
import { extractSessionIdentity, type SessionIdentity } from '../browser/sessionIdentity';
import { type StorageStateShape } from '../browser/cookiePayload';
import { LeetCodeApi } from './apiClient';
import { logger } from '../logger';

const ORIGIN = 'https://leetcode.com';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const LOGIN_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes cooldown after VERIFICATION_REQUIRED / 403

export interface LightweightLeetCodeSession {
  api: LeetCodeApi;
  request: APIRequestContext;
  getStorageState(): Promise<StorageStateShape>;
  persistUpdatedCookiesIfChanged(): Promise<boolean>;
  close(): Promise<void>;
}

function cookieFingerprint(state: StorageStateShape): string {
  const relevant = (state.cookies ?? [])
    .filter((c) => c.name === 'LEETCODE_SESSION' || c.name === 'csrftoken')
    .map((c) => `${c.name}=${c.value}:${c.expires ?? -1}`)
    .sort();
  return relevant.join('|');
}

/**
 * Inspects a Playwright `BrowserContext` or `APIRequestContext` for rotated
 * `LEETCODE_SESSION` or `csrftoken` cookies (issued via `Set-Cookie` headers
 * during GraphQL/REST calls) and persists the updated `storageState` back to
 * PostgreSQL if any session cookies changed.
 */
export async function persistRotatedCookiesFromContext(
  account: Pick<AccountRecord, 'id' | 'label' | 'username' | 'status'>,
  initialState: StorageStateShape,
  contextOrStorage: { storageState?: () => Promise<{ cookies?: unknown[]; origins?: unknown[] }> } | null | undefined,
): Promise<boolean> {
  if (!contextOrStorage || typeof contextOrStorage.storageState !== 'function') {
    return false;
  }
  try {
    const latest = await contextOrStorage.storageState();
    if (!latest || !Array.isArray(latest.cookies)) {
      return false;
    }
    const updatedState: StorageStateShape = {
      cookies: latest.cookies as StorageStateShape['cookies'],
      origins: Array.isArray(initialState.origins) ? initialState.origins : [],
    };
    const prevFp = cookieFingerprint(initialState);
    const nextFp = cookieFingerprint(updatedState);
    if (!nextFp || nextFp === prevFp) {
      return false;
    }
    const identity = extractSessionIdentity(updatedState);
    await saveAccount(account.label, JSON.stringify(updatedState), {
      username: identity.username ?? account.username ?? undefined,
      status: AccountStatus.ACTIVE,
    });
    logger.info(
      {
        label: account.label,
        username: identity.username ?? account.username ?? null,
        refreshedAt: identity.refreshedAt ?? null,
        expiresAt: identity.expiresAt ?? null,
      },
      'persisted rotated LeetCode session cookies from active context to database',
    );
    return true;
  } catch (err) {
    logger.warn(
      { label: account.label, err: err instanceof Error ? err.message : String(err) },
      'failed to persist rotated LeetCode cookies from context',
    );
    return false;
  }
}

/**
 * Opens an API-only HTTP request session using Playwright's `request.newContext`
 * without launching a Chromium/Firefox browser process.
 *
 * - Zero Chromium process overhead (~5 MB vs ~180 MB per account on Render's 512 MB limit).
 * - Never loads an HTML page, avoiding page-level Cloudflare challenges on datacenter IPs.
 * - Captures rotated `Set-Cookie` headers (`LEETCODE_SESSION` / `csrftoken`) and persists
 *   them back to PostgreSQL when `persistUpdatedCookiesIfChanged()` is called.
 */
export async function openLightweightLeetCodeSession(
  state: StorageStateShape,
  account?: Pick<AccountRecord, 'id' | 'label' | 'username' | 'status'>,
): Promise<LightweightLeetCodeSession> {
  const initialFingerprint = cookieFingerprint(state);
  const preservedOrigins = Array.isArray(state.origins) ? state.origins : [];

  const ctx = await playwrightRequest.newContext({
    userAgent: DEFAULT_USER_AGENT,
    storageState: {
      cookies: state.cookies as never,
      origins: [],
    },
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const cookieJar = {
    request: ctx,
    cookies: async (url?: string | readonly string[]) => {
      const current = await ctx.storageState();
      const all = current.cookies ?? [];
      const host = typeof url === 'string' ? new URL(url).hostname : null;
      return host
        ? all.filter((c) => host === c.domain.replace(/^\./, '') || host.endsWith(c.domain))
        : all;
    },
  };

  const api = new LeetCodeApi(cookieJar as never);

  const getStorageState = async (): Promise<StorageStateShape> => {
    const latest = await ctx.storageState();
    return {
      cookies: latest.cookies as unknown as StorageStateShape['cookies'],
      origins: preservedOrigins,
    };
  };

  const persistUpdatedCookiesIfChanged = async (): Promise<boolean> => {
    if (!account) return false;
    try {
      const updatedState = await getStorageState();
      const nextFingerprint = cookieFingerprint(updatedState);
      if (!nextFingerprint || nextFingerprint === initialFingerprint) {
        return false;
      }
      const identity = extractSessionIdentity(updatedState);
      await saveAccount(account.label, JSON.stringify(updatedState), {
        username: identity.username ?? account.username ?? undefined,
        status: AccountStatus.ACTIVE,
      });
      logger.info(
        {
          label: account.label,
          username: identity.username ?? account.username ?? null,
          refreshedAt: identity.refreshedAt ?? null,
          expiresAt: identity.expiresAt ?? null,
        },
        'persisted rotated LeetCode session cookies to database',
      );
      return true;
    } catch (err) {
      logger.warn(
        { label: account.label, err: err instanceof Error ? err.message : String(err) },
        'failed to persist rotated LeetCode cookies',
      );
      return false;
    }
  };

  return {
    api,
    request: ctx,
    getStorageState,
    persistUpdatedCookiesIfChanged,
    close: async () => {
      await ctx.dispose().catch(() => undefined);
    },
  };
}

export interface VerifyStoredAccountOptions {
  maxAttempts?: number;
  baseBackoffMs?: number;
  persistRotatedCookies?: boolean;
  openSession?: typeof openLightweightLeetCodeSession;
}

export interface VerifiedAccountDiagnostic {
  authenticated: boolean;
  label: string;
  username: string | null;
  status: AccountStatus;
  cause?: 'valid' | 'signed-out' | 'query-failed' | 'invalid-storage-state' | 'token-expired';
  identity: SessionIdentity;
  remainingTtlSeconds: number | null;
  cookiesRotated: boolean;
  attempts: number;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Verifies a stored LeetCode account strictly through the lightweight GraphQL
 * API transport (`userStatus`), with bounded exponential backoff on transient
 * `query-failed` errors and automatic persistence of rotated session cookies.
 *
 * Never launches a browser or navigates to `/accounts/login/`.
 */
export async function verifyStoredLeetCodeAccount(
  account: AccountRecord,
  options: VerifyStoredAccountOptions = {},
): Promise<VerifiedAccountDiagnostic> {
  const parsed = parseStoredStorageState(account.storageState);
  if (!parsed.ok) {
    return {
      authenticated: false,
      label: account.label,
      username: account.username,
      status: AccountStatus.UNKNOWN,
      cause: 'invalid-storage-state',
      identity: { expired: false },
      remainingTtlSeconds: null,
      cookiesRotated: false,
      attempts: 0,
      error: parsed.error,
    };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const initialIdentity = extractSessionIdentity(parsed.state, nowSeconds);
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const baseBackoffMs = Math.max(50, options.baseBackoffMs ?? 1_000);
  const openSessionFn = options.openSession ?? openLightweightLeetCodeSession;

  let lastCheck: SessionCheckResult = { authenticated: false, cause: 'query-failed' };
  let attempts = 0;
  let cookiesRotated = false;
  let latestIdentity = initialIdentity;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    let session: LightweightLeetCodeSession | null = null;
    try {
      session = await openSessionFn(parsed.state, account);
      lastCheck = await checkSession(session.api);

      if (lastCheck.authenticated && lastCheck.username) {
        if (options.persistRotatedCookies !== false) {
          cookiesRotated = await session.persistUpdatedCookiesIfChanged();
        }
        const currentState = await session.getStorageState();
        latestIdentity = extractSessionIdentity(currentState, Math.floor(Date.now() / 1000));
        const remainingTtlSeconds =
          latestIdentity.expiresAt !== undefined
            ? Math.max(0, Math.round(latestIdentity.expiresAt - Date.now() / 1000))
            : null;

        await patchAccount(account.id, {
          username: lastCheck.username,
          status: AccountStatus.ACTIVE,
          lastError: null,
          checked: true,
        });

        return {
          authenticated: true,
          label: account.label,
          username: lastCheck.username,
          status: AccountStatus.ACTIVE,
          cause: 'valid',
          identity: latestIdentity,
          remainingTtlSeconds,
          cookiesRotated,
          attempts,
        };
      }

      // Definitive signed-out answer from LeetCode GraphQL — do not retry.
      if (lastCheck.cause === 'signed-out') {
        break;
      }
    } catch (err) {
      lastCheck = {
        authenticated: false,
        cause: 'query-failed',
      };
      logger.warn(
        { label: account.label, attempt, err: err instanceof Error ? err.message : String(err) },
        'lightweight LeetCode session check threw error',
      );
    } finally {
      if (session) {
        await session.close();
      }
    }

    if (attempt < maxAttempts) {
      await sleep(baseBackoffMs * 2 ** (attempt - 1));
    }
  }

  const remainingTtlSeconds =
    latestIdentity.expiresAt !== undefined
      ? Math.max(0, Math.round(latestIdentity.expiresAt - Date.now() / 1000))
      : null;

  if (lastCheck.cause === 'signed-out') {
    return {
      authenticated: false,
      label: account.label,
      username: account.username ?? latestIdentity.username ?? null,
      status: latestIdentity.expired ? AccountStatus.EXPIRED : AccountStatus.REJECTED,
      cause: latestIdentity.expired ? 'token-expired' : 'signed-out',
      identity: latestIdentity,
      remainingTtlSeconds,
      cookiesRotated: false,
      attempts,
      error: latestIdentity.expired
        ? 'LEETCODE_SESSION JWT expiry has passed'
        : 'LeetCode GraphQL reported userStatus.isSignedIn = false',
    };
  }

  // Transient query failure: preserve existing account status!
  return {
    authenticated: false,
    label: account.label,
    username: account.username ?? latestIdentity.username ?? null,
    status: account.status,
    cause: 'query-failed',
    identity: latestIdentity,
    remainingTtlSeconds,
    cookiesRotated: false,
    attempts,
    error: 'Transient network or Cloudflare error querying LeetCode GraphQL; existing session preserved',
  };
}

// ---------------------------------------------------------------------------
// Login Cooldown & De-duplication Guard (prevents hammering /accounts/login/)
// ---------------------------------------------------------------------------

const inFlightLogins = new Map<string, Promise<unknown>>();
const memoryCooldowns = new Map<string, { until: number; code: string; error: string }>();

function cooldownStateKey(label: string): string {
  return `leetcode:login-cooldown:${label.trim().toLowerCase()}`;
}

export interface LoginCooldownStatus {
  coolingDown: boolean;
  until: number | null;
  remainingSeconds: number;
  code?: string;
  error?: string;
}

function isTestEnv(): boolean {
  return process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
}

export async function getLeetCodeLoginCooldown(
  label: string,
  now = Date.now(),
): Promise<LoginCooldownStatus> {
  const norm = label.trim().toLowerCase();
  const mem = memoryCooldowns.get(norm);
  if (mem && mem.until > now) {
    return {
      coolingDown: true,
      until: mem.until,
      remainingSeconds: Math.ceil((mem.until - now) / 1000),
      code: mem.code,
      error: mem.error,
    };
  }

  if (!isTestEnv()) {
    try {
      const raw = await getSystemState(cooldownStateKey(norm));
      if (raw) {
        const parsed = JSON.parse(raw) as { until?: number; code?: string; error?: string };
        if (typeof parsed.until === 'number' && parsed.until > now) {
          memoryCooldowns.set(norm, {
            until: parsed.until,
            code: parsed.code ?? 'VERIFICATION_REQUIRED',
            error: parsed.error ?? 'Cloudflare blocked headless browser login',
          });
          return {
            coolingDown: true,
            until: parsed.until,
            remainingSeconds: Math.ceil((parsed.until - now) / 1000),
            code: parsed.code,
            error: parsed.error,
          };
        }
      }
    } catch {
      // ignore DB lookup error
    }
  }

  memoryCooldowns.delete(norm);
  return { coolingDown: false, until: null, remainingSeconds: 0 };
}

export async function recordLeetCodeLoginCooldown(
  label: string,
  code: string,
  error: string,
  cooldownMs = LOGIN_COOLDOWN_MS,
  now = Date.now(),
): Promise<void> {
  const norm = label.trim().toLowerCase();
  const until = now + cooldownMs;
  memoryCooldowns.set(norm, { until, code, error });
  if (!isTestEnv()) {
    try {
      await setSystemState(cooldownStateKey(norm), JSON.stringify({ until, code, error, recordedAt: now }));
    } catch {
      // best-effort DB persistence
    }
  }
}

export async function clearLeetCodeLoginCooldown(label: string): Promise<void> {
  const norm = label.trim().toLowerCase();
  memoryCooldowns.delete(norm);
  if (!isTestEnv()) {
    try {
      await setSystemState(cooldownStateKey(norm), JSON.stringify({ until: 0 }));
    } catch {
      // best-effort DB clear
    }
  }
}

export function clearLeetCodeLoginCooldownsForTests(): void {
  memoryCooldowns.clear();
  inFlightLogins.clear();
}

export async function withSingleFlightLogin<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const norm = label.trim().toLowerCase();
  const existing = inFlightLogins.get(norm);
  if (existing) {
    return existing as Promise<T>;
  }
  const promise = fn().finally(() => {
    if (inFlightLogins.get(norm) === promise) {
      inFlightLogins.delete(norm);
    }
  });
  inFlightLogins.set(norm, promise);
  return promise;
}

/**
 * Finds a stored LeetCode account by label or username (case-insensitive).
 */
export async function findStoredLeetCodeAccount(
  labelOrUsername?: string,
): Promise<AccountRecord | null> {
  if (!labelOrUsername) return null;
  const trimmed = labelOrUsername.trim();
  if (!trimmed) return null;

  const all = await listAccounts().catch(() => []);
  const lower = trimmed.toLowerCase();
  return (
    all.find(
      (a) =>
        a.label.toLowerCase() === lower ||
        (a.username && a.username.toLowerCase() === lower),
    ) ?? null
  );
}

export function formatRemainingTtl(seconds: number | null): string {
  if (seconds === null) return 'unknown (session cookie)';
  if (seconds <= 0) return 'expired';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((seconds % 3_600) / 60);
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}
