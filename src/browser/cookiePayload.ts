/**
 * Cookie payload parser — turns whatever the user could copy out of their
 * OWN logged-in browser into a Playwright storageState object.
 *
 * Accepted formats (in order of convenience on a phone):
 *   1. Cookie header string:   LEETCODE_SESSION=...; csrftoken=...
 *   2. Cookie-Editor / EditThisCookie JSON export (an ARRAY of cookie objects)
 *   3. A full Playwright storageState JSON ({ "cookies": [...], "origins": [...] })
 *
 * This module is pure — no I/O, no config, no Playwright — so the parsing
 * rules are unit-testable in isolation. Cookie VALUES are never logged here
 * or by callers.
 */

export interface StorageCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds; -1 = session cookie */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

export interface StorageOrigin {
  origin: string;
  localStorage: { name: string; value: string }[];
}

export interface StorageStateShape {
  cookies: StorageCookie[];
  origins: StorageOrigin[];
}

export type ParseResult =
  | { ok: true; storageState: StorageStateShape; format: string }
  | { ok: false; error: string };

const LEETCODE_DOMAIN = '.leetcode.com';

const FORMAT_HINT =
  'send `LEETCODE_SESSION=...; csrftoken=...`, a Cookie-Editor JSON export, or a Playwright storageState JSON';

export function parseCookiePayload(raw: string): ParseResult {
  const text = raw.trim();
  if (!text) {
    return { ok: false, error: 'the payload is empty — ' + FORMAT_HINT };
  }
  if (text.startsWith('{')) return parseStorageStateJson(text);
  if (text.startsWith('[')) return parseCookieEditorJson(text);
  if (text.includes('=')) return parseCookieHeader(text);
  return { ok: false, error: 'could not recognize the format — ' + FORMAT_HINT };
}

// ---------------------------------------------------------------------------
// Format 1: "LEETCODE_SESSION=abc; csrftoken=xyz"
// ---------------------------------------------------------------------------

function parseCookieHeader(text: string): ParseResult {
  const cookies = new Map<string, StorageCookie>();
  for (const part of text.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name || !value) continue;
    cookies.set(name, {
      name,
      value,
      domain: LEETCODE_DOMAIN,
      path: '/',
      expires: -1,
      httpOnly: name === 'LEETCODE_SESSION',
      secure: true,
      sameSite: 'Lax',
    });
  }
  return finalize([...cookies.values()], [], 'cookie string');
}

// ---------------------------------------------------------------------------
// Format 2: Cookie-Editor / EditThisCookie export (JSON array)
// ---------------------------------------------------------------------------

function parseCookieEditorJson(text: string): ParseResult {
  const arr = parseJson(text);
  if (!arr.ok) return arr;
  if (!Array.isArray(arr.value)) {
    return { ok: false, error: 'expected a JSON array of cookie objects — ' + FORMAT_HINT };
  }
  const cookies: StorageCookie[] = [];
  for (const item of arr.value) {
    const c = item as Record<string, unknown> | null;
    if (!c || typeof c.name !== 'string' || typeof c.value !== 'string') continue;
    if (!c.name || !c.value) continue;
    cookies.push({
      name: c.name,
      value: c.value,
      domain: stringOr(c.domain, LEETCODE_DOMAIN),
      path: stringOr(c.path, '/'),
      expires: numberOr(c.expirationDate) ?? numberOr(c.expires) ?? -1,
      httpOnly: c.httpOnly === true,
      secure: c.secure !== false,
      sameSite: normalizeSameSite(c.sameSite),
    });
  }
  return finalize(cookies, [], 'Cookie-Editor export');
}

// ---------------------------------------------------------------------------
// Format 3: Playwright storageState JSON
// ---------------------------------------------------------------------------

function parseStorageStateJson(text: string): ParseResult {
  const parsed = parseJson(text);
  if (!parsed.ok) return parsed;
  const obj = parsed.value as Record<string, unknown> | null;
  if (!obj || !Array.isArray(obj.cookies)) {
    return { ok: false, error: 'expected a storageState object with a "cookies" array — ' + FORMAT_HINT };
  }
  const cookies: StorageCookie[] = [];
  for (const item of obj.cookies) {
    const c = item as Record<string, unknown> | null;
    if (!c || typeof c.name !== 'string' || typeof c.value !== 'string') continue;
    if (!c.name || !c.value) continue;
    cookies.push({
      name: c.name,
      value: c.value,
      domain: stringOr(c.domain, LEETCODE_DOMAIN),
      path: stringOr(c.path, '/'),
      expires: numberOr(c.expires) ?? -1,
      httpOnly: c.httpOnly === true,
      secure: c.secure !== false,
      sameSite: normalizeSameSite(c.sameSite),
    });
  }
  const origins: StorageOrigin[] = [];
  if (Array.isArray(obj.origins)) {
    for (const item of obj.origins) {
      const o = item as Record<string, unknown> | null;
      if (!o || typeof o.origin !== 'string' || !Array.isArray(o.localStorage)) continue;
      origins.push({
        origin: o.origin,
        localStorage: o.localStorage
          .filter((e): e is { name: string; value: string } => {
            const entry = e as Record<string, unknown> | null;
            return !!entry && typeof entry.name === 'string' && typeof entry.value === 'string';
          })
          .map((e) => ({ name: e.name, value: e.value })),
      });
    }
  }
  return finalize(cookies, origins, 'storageState JSON');
}

// ---------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------

/**
 * Keeps only leetcode.com cookies (exports routinely contain other sites),
 * dedupes by name+domain (last wins), and requires the two cookies the
 * pipeline actually needs: LEETCODE_SESSION (auth) and csrftoken (submit).
 */
function finalize(cookies: StorageCookie[], origins: StorageOrigin[], format: string): ParseResult {
  const leetcodeOnly = cookies.filter((c) => c.domain.includes('leetcode.com'));
  const deduped = [...new Map(leetcodeOnly.map((c) => [`${c.name}@${c.domain}`, c])).values()];

  if (deduped.length === 0) {
    return {
      ok: false,
      error: 'no leetcode.com cookies found — make sure you export the cookies while ON leetcode.com',
    };
  }
  if (!deduped.some((c) => c.name === 'LEETCODE_SESSION' && c.value.length > 10)) {
    return {
      ok: false,
      error:
        'the payload has no usable LEETCODE_SESSION cookie. That cookie is HttpOnly, so mobile Chrome cannot show it — on Android use Kiwi Browser + the Cookie-Editor extension; on desktop copy it from DevTools → Application → Cookies',
    };
  }
  if (!deduped.some((c) => c.name === 'csrftoken' && c.value.length > 0)) {
    return {
      ok: false,
      error:
        'the csrftoken cookie is missing — it is required for submissions. Copy it together with LEETCODE_SESSION (DevTools → Application → Cookies, or export everything with Cookie-Editor)',
    };
  }
  return { ok: true, storageState: { cookies: deduped, origins }, format };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      error:
        'invalid JSON — the payload looks truncated. Telegram splits pasted messages longer than ~4000 characters; send the export as a .txt / .json FILE instead',
    };
  }
}

function stringOr(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

function numberOr(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function normalizeSameSite(v: unknown): 'Strict' | 'Lax' | 'None' {
  const s = String(v ?? '').toLowerCase();
  if (s === 'strict') return 'Strict';
  if (s === 'none' || s === 'no_restriction') return 'None';
  return 'Lax';
}