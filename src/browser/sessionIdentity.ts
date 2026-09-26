import { StorageStateShape } from './cookiePayload';

/**
 * Offline identity of a LeetCode cookie set — PURE, no network.
 *
 * LEETCODE_SESSION is a signed JWT-style token whose payload (base64url, not
 * encrypted) carries the username plus the session's refresh timestamp and
 * lifetime. Reading it lets the agent key accounts by the REAL LeetCode
 * username the moment a file arrives — so several files for different users
 * become several accounts, and a second file for a known user overrides it —
 * without depending on a live LeetCode check (which may be blocked).
 *
 * The signature is NOT verified (only LeetCode can do that): this is used
 * for labelling and early expiry detection, never as proof of validity.
 * Only non-secret fields are returned; token values are never logged.
 */

export interface SessionIdentity {
  username?: string;
  /** Unix seconds the session was last refreshed (payload `refreshed_at`). */
  refreshedAt?: number;
  /** Unix seconds the session expires, from the payload or the cookie. */
  expiresAt?: number;
  /** true when expiresAt is known and already in the past. */
  expired: boolean;
}

function decodeBase64Url(part: string): string | null {
  try {
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

export function extractSessionIdentity(
  state: StorageStateShape,
  nowSeconds: number = Date.now() / 1000,
): SessionIdentity {
  const cookie = state.cookies.find((c) => c.name === 'LEETCODE_SESSION');
  if (!cookie) return { expired: false };

  const expiries: number[] = [];
  // Cookie-level expiry (-1 / 0 = session cookie, no information).
  if (typeof cookie.expires === 'number' && cookie.expires > 0) expiries.push(cookie.expires);

  let username: string | undefined;
  let refreshedAt: number | undefined;
  const parts = cookie.value.split('.');
  if (parts.length >= 2) {
    const json = decodeBase64Url(parts[1] ?? '');
    if (json) {
      try {
        const payload = JSON.parse(json) as Record<string, unknown>;
        if (typeof payload.username === 'string' && payload.username.trim()) {
          username = payload.username.trim();
        }
        if (typeof payload.refreshed_at === 'number') refreshedAt = payload.refreshed_at;
        if (refreshedAt !== undefined && typeof payload._session_expiry === 'number') {
          expiries.push(refreshedAt + payload._session_expiry);
        }
      } catch {
        // Not a JSON payload — no identity, no problem.
      }
    }
  }

  const expiresAt = expiries.length > 0 ? Math.min(...expiries) : undefined;
  return {
    username,
    refreshedAt,
    expiresAt,
    expired: expiresAt !== undefined && expiresAt < nowSeconds,
  };
}

/** Account-label rules shared by the API and the Telegram bot. */
export const ACCOUNT_LABEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,31}$/;

/** Turns a LeetCode username into a valid account label. */
export function labelFromUsername(username: string): string {
  const cleaned = username.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '');
  return (cleaned || 'account').slice(0, 32);
}

export interface ExistingAccountRef {
  label: string;
  username: string | null;
}

/**
 * Decides which account a freshly received cookie set belongs to — PURE.
 *
 *   1. an explicit label (/renew <label>, API "label") always wins
 *   2. otherwise an existing account with the SAME LeetCode username is
 *      overridden (whatever its label — e.g. 'default' seeded at upgrade)
 *   3. otherwise a new account named after the username
 *   4. no username readable -> `fallbackLabel` (e.g. derived from the file name)
 */
export function resolveAccountLabel(
  existing: ExistingAccountRef[],
  identity: SessionIdentity,
  explicitLabel?: string,
  fallbackLabel?: string,
): { label: string; isNew: boolean } {
  if (explicitLabel) {
    return { label: explicitLabel, isNew: !existing.some((a) => a.label === explicitLabel) };
  }
  if (identity.username) {
    const wanted = identity.username.toLowerCase();
    const match = existing.find((a) => (a.username ?? '').toLowerCase() === wanted);
    if (match) return { label: match.label, isNew: false };
    const label = labelFromUsername(identity.username);
    return { label, isNew: !existing.some((a) => a.label === label) };
  }
  const label = fallbackLabel && ACCOUNT_LABEL_RE.test(fallbackLabel) ? fallbackLabel : 'account';
  return { label, isNew: !existing.some((a) => a.label === label) };
}

/** Label derived from an uploaded file name: "lc_26Sept_4179.json" -> "lc_26Sept_4179". */
export function labelFromFileName(fileName: string | undefined): string | undefined {
  if (!fileName) return undefined;
  const base = fileName.replace(/\.[a-zA-Z0-9]+$/, '');
  const label = base.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 32);
  return label && ACCOUNT_LABEL_RE.test(label) ? label : undefined;
}
