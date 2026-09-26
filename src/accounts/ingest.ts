import { AccountStatus } from '@prisma/client';
import { logger } from '../logger';
import { listAccounts, patchAccount, saveAccount } from '../database/accounts';
import { parseCookiePayload, StorageStateShape } from '../browser/cookiePayload';
import {
  extractSessionIdentity,
  labelFromFileName,
  resolveAccountLabel,
} from '../browser/sessionIdentity';
import type { ValidationOutcome } from '../browser/sessionRenewal';

/**
 * Cookie ingestion — the ONE path every cookie upload takes (Telegram file,
 * pasted text, POST /admin/accounts):
 *
 *   parse -> read the username from the session token -> pick the account
 *   (explicit label > same username > new) -> STORE (new = add, existing =
 *   override) -> validate against LeetCode -> record the status.
 *
 * Storing happens BEFORE the live check on purpose: a failed or blocked check
 * must never lose the user's cookies. The status tells the truth instead:
 *   ACTIVE  — LeetCode confirmed the session signed in
 *   EXPIRED — the token's own expiry passed, or LeetCode reports signed out
 *   UNKNOWN — the check could not run (network / Cloudflare); the daily run
 *             re-verifies it
 */

export type Validator = (state: StorageStateShape) => Promise<ValidationOutcome>;

export type IngestResult =
  | {
      ok: true;
      label: string;
      /** true = a new account was added; false = an existing one was overridden */
      created: boolean;
      username: string | null;
      status: AccountStatus;
      cookieCount: number;
      format: string;
      /** Human explanation of the status (why EXPIRED / UNKNOWN). */
      detail: string;
    }
  | { ok: false; error: string };

export interface IngestOptions {
  /** /renew <label> or the API "label" — always wins. */
  label?: string;
  /** Uploaded file name — label fallback when no username is readable. */
  fileName?: string;
  /** false = store without the live LeetCode check (status from the token only). */
  validate?: boolean;
  /** Injected in tests; defaults to the real browser-based check. */
  validator?: Validator;
}

export async function ingestCookiePayload(raw: string, opts: IngestOptions = {}): Promise<IngestResult> {
  const parsed = parseCookiePayload(raw);
  if (!parsed.ok) return parsed;
  return ingestStorageState(parsed.storageState, parsed.format, opts);
}

export async function ingestStorageState(
  state: StorageStateShape,
  format: string,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const identity = extractSessionIdentity(state);
  const existing = await listAccounts();
  const { label, isNew } = resolveAccountLabel(
    existing.map((a) => ({ label: a.label, username: a.username })),
    identity,
    opts.label,
    labelFromFileName(opts.fileName),
  );

  // 1) STORE first — new label = add, existing label = override the cookies.
  const account = await saveAccount(label, JSON.stringify(state), {
    username: identity.username,
    status: AccountStatus.UNKNOWN,
  });
  logger.info(
    { label, created: isNew, username: identity.username ?? null, cookies: state.cookies.length, format },
    isNew ? 'account added from cookies' : 'account cookies overridden',
  );

  const base = {
    ok: true as const,
    label,
    created: isNew,
    cookieCount: state.cookies.length,
    format,
  };

  // 2) Offline expiry: the token itself says it is past its lifetime.
  if (identity.expired) {
    const detail = 'the session token is past its expiry date — capture fresh cookies';
    await patchAccount(account.id, { status: AccountStatus.EXPIRED, lastError: detail, checked: true });
    return { ...base, username: identity.username ?? null, status: AccountStatus.EXPIRED, detail };
  }

  if (opts.validate === false) {
    return {
      ...base,
      username: identity.username ?? null,
      status: AccountStatus.UNKNOWN,
      detail: 'stored without a live check — the next daily run verifies it',
    };
  }

  // 3) Live check against LeetCode.
  const validator = opts.validator ?? (await import('../browser/sessionRenewal')).validateCookiesAgainstLeetcode;
  const v = await validator(state);
  if (v.ok) {
    await patchAccount(account.id, {
      username: v.username,
      status: AccountStatus.ACTIVE,
      lastError: null,
      checked: true,
    });
    return { ...base, username: v.username, status: AccountStatus.ACTIVE, detail: 'LeetCode confirmed the session is signed in' };
  }
  if (v.reason === 'signed-out') {
    const detail =
      'LeetCode reports this session signed out — it is expired/logged out, or LeetCode only accepts it from the network (IP) where it was captured';
    await patchAccount(account.id, { status: AccountStatus.EXPIRED, lastError: detail, checked: true });
    return { ...base, username: identity.username ?? null, status: AccountStatus.EXPIRED, detail };
  }
  const detail = `could not verify right now (${v.error}) — stored; the next daily run re-checks it`;
  await patchAccount(account.id, { lastError: detail, checked: true });
  return { ...base, username: identity.username ?? null, status: AccountStatus.UNKNOWN, detail };
}

/** One Telegram-friendly line for an ingest result. */
export function describeIngest(r: IngestResult): string {
  if (!r.ok) return `Could not read these cookies: ${r.error}`;
  const who = r.username ? ` (${r.username})` : '';
  const verb = r.created ? 'Added new account' : 'Updated account (old cookies overridden)';
  const status =
    r.status === AccountStatus.ACTIVE ? 'ACTIVE' : r.status === AccountStatus.EXPIRED ? 'EXPIRED' : 'NOT VERIFIED YET';
  return `${verb}: ${r.label}${who}\nStatus: ${status} — ${r.detail}\nCookies: ${r.cookieCount} (${r.format})`;
}
