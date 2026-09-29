import { CodeforcesAccountStatus } from '@prisma/client';
import { Browser, chromium } from 'playwright';
import { config } from '../config';
import { logger } from '../logger';
import { launchWithStorageStateObject, BrowserSession, buildLaunchArgs } from '../browser/playwright';
import { StorageStateShape } from '../browser/cookiePayload';
import { ACCOUNT_LABEL_RE } from '../browser/sessionIdentity';
import {
  getCodeforcesAccountById,
  listCodeforcesAccounts,
  saveCodeforcesAccount,
} from './storage';

export type SessionSite = 'leetcode' | 'codeforces' | 'unknown';

export type CodeforcesSessionCheck =
  | { ok: true; username: string }
  | { ok: false; reason: 'signed-out' | 'blocked' | 'unknown'; error: string };

export type CodeforcesIngestResult =
  | { ok: true; label: string; username: string; cookieCount: number; format: string; created: boolean }
  | { ok: false; error: string };

const CF_DOMAIN_RE = /(?:^|\.)codeforces\.com$/i;
const CF_HOST_RE = /(?:^|\.)codeforces\.com$/i;
const CAPTCHA_RE = /just a moment|checking your browser|cf-chl|verify you are human|enable javascript and cookies/i;

export function detectSessionSite(raw: string, fileName?: string): SessionSite {
  const name = (fileName ?? '').toLowerCase();
  if (/(?:^|[._-])(?:cf|codeforces)(?:[._-]|$)/i.test(name)) return 'codeforces';
  if (/(?:^|[._-])(?:lc|leetcode)(?:[._-]|$)/i.test(name)) return 'leetcode';

  const text = raw.toLowerCase();
  if (text.includes('codeforces.com')) return 'codeforces';
  if (text.includes('leetcode.com') || text.includes('leetcode_session') || text.includes('csrftoken')) return 'leetcode';

  try {
    const parsed = JSON.parse(raw) as unknown;
    const sites = new Set<string>();
    collectSiteHints(parsed, sites);
    if ([...sites].some((s) => /codeforces\.com/i.test(s))) return 'codeforces';
    if ([...sites].some((s) => /leetcode\.com/i.test(s))) return 'leetcode';
  } catch {
    // Pasted cookie headers without a host marker are ambiguous by design.
  }

  return 'unknown';
}

export function parseCodeforcesPayload(raw: string):
  | { ok: true; storageState: StorageStateShape; format: string }
  | { ok: false; error: string } {
  const text = raw.trim();
  if (!text) return { ok: false, error: 'the Codeforces session payload is empty' };

  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const array = Array.isArray(parsed) ? parsed : extractCookieArray(parsed);
      if (!array) return { ok: false, error: 'expected a Cookie-Editor array or Playwright storageState JSON' };
      const cookies = array
        .map((item) => toStorageCookie(item))
        .filter((c): c is StorageStateShape['cookies'][number] => !!c)
        .filter((c) => CF_DOMAIN_RE.test(c.domain));

      let origins: StorageStateShape['origins'] = [];
      if (!Array.isArray(parsed)) {
        const root = parsed as Record<string, unknown>;
        if (Array.isArray(root.origins)) {
          origins = root.origins
            .filter((value): value is Record<string, unknown> => !!value && typeof value === 'object')
            .filter((value) => typeof value.origin === 'string' && /codeforces\.com/i.test(value.origin))
            .map((value) => ({
              origin: value.origin as string,
              localStorage: Array.isArray(value.localStorage)
                ? value.localStorage
                    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
                    .filter((entry) => typeof entry.name === 'string' && typeof entry.value === 'string')
                    .map((entry) => ({ name: entry.name as string, value: entry.value as string }))
                : [],
            }));
        }
      }

      if (cookies.length === 0) return { ok: false, error: 'no codeforces.com cookies found in the supplied JSON export' };
      return {
        ok: true,
        storageState: { cookies, origins },
        format: Array.isArray(parsed) ? 'Cookie-Editor export' : 'storageState JSON',
      };
    } catch {
      return { ok: false, error: 'invalid JSON — send the original Codeforces session export as a file' };
    }
  }

  if (text.includes('codeforces.com')) {
    const cookies = text
      .split(';')
      .map((part) => part.trim())
      .map((part) => part.indexOf('=') > 0 ? part.slice(0, part.indexOf('=')) : '')
      .filter(Boolean);
    if (cookies.length === 0) return { ok: false, error: 'could not parse the Codeforces cookie header' };
    return { ok: false, error: 'paste/export a JSON cookie file so the site can be identified safely' };
  }

  return { ok: false, error: 'Codeforces session JSON must contain codeforces.com cookie/domain metadata' };
}

export async function validateCodeforcesStorageState(state: StorageStateShape): Promise<CodeforcesSessionCheck> {
  let session: BrowserSession | null = null;
  try {
    session = await launchWithStorageStateObject(state, 'codeforces-validation');
    if (!session) return { ok: false, reason: 'unknown', error: 'browser launch failed' };

    await session.page.goto('https://codeforces.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await session.page.waitForTimeout(500);
    return await inspectCodeforcesSessionPage(session.page);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (CAPTCHA_RE.test(msg)) return { ok: false, reason: 'blocked', error: `Codeforces served a verification page: ${msg}` };
    return { ok: false, reason: 'unknown', error: `Codeforces session check failed: ${msg}` };
  } finally {
    await session?.close().catch(() => undefined);
  }
}

export async function inspectCodeforcesSessionPage(page: import('playwright').Page): Promise<CodeforcesSessionCheck> {
  const url = page.url();
  const body = ((await page.locator('body').innerText().catch(() => '')) ?? '').slice(0, 30_000);
  if (CAPTCHA_RE.test(body) || CAPTCHA_RE.test(url)) {
    return { ok: false, reason: 'blocked', error: 'Codeforces is asking for browser verification; renew the session later rather than bypassing the check' };
  }
  if (/\/enter(?:[/?#]|$)/i.test(url) || /you are not logged in|login|sign in/i.test(body.slice(0, 2_000))) {
    return { ok: false, reason: 'signed-out', error: 'Codeforces session is not signed in' };
  }

  let hrefs: Array<{ href: string; text: string }> = [];
  try {
    hrefs = await page.locator('a[href]').evaluateAll((anchors) =>
      anchors.map((a) => ({ href: (a as HTMLAnchorElement).href, text: (a.textContent ?? '').trim() })),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: 'unknown', error: `could not inspect the Codeforces page: ${msg}` };
  }
  const profile = hrefs.find((a) => /codeforces\.com\/profile\/[^/?#]+/i.test(a.href));
  if (!profile) {
    return { ok: false, reason: 'unknown', error: 'could not determine the signed-in Codeforces handle from the page' };
  }
  const match = /codeforces\.com\/profile\/([^/?#]+)/i.exec(profile.href);
  if (!match?.[1]) return { ok: false, reason: 'unknown', error: 'could not parse the signed-in Codeforces handle' };
  return { ok: true, username: decodeURIComponent(match[1]) };
}

export async function ingestCodeforcesSession(
  raw: string,
  opts: { label?: string; fileName?: string } = {},
): Promise<CodeforcesIngestResult> {
  const parsed = parseCodeforcesPayload(raw);
  if (!parsed.ok) return parsed;

  const validation = await validateCodeforcesStorageState(parsed.storageState);
  if (!validation.ok) return validation;

  const existing = await listCodeforcesAccounts(true);
  const explicit = opts.label?.trim();
  if (explicit && !ACCOUNT_LABEL_RE.test(explicit)) {
    return { ok: false, error: 'invalid account label — use letters, digits, dot, dash or underscore (max 32 characters)' };
  }
  const existingByUsername = existing.find((a) => (a.username ?? '').toLowerCase() === validation.username.toLowerCase());
  const label = explicit || existingByUsername?.label || makeLabel(validation.username, existing);
  const created = !existing.some((a) => a.label === label);

  await saveCodeforcesAccount(label, JSON.stringify(parsed.storageState), {
    username: validation.username,
    status: CodeforcesAccountStatus.ACTIVE,
  });

  logger.info(
    { label, username: validation.username, cookies: parsed.storageState.cookies.length, format: parsed.format },
    created ? 'Codeforces account added from session JSON' : 'Codeforces account session renewed',
  );
  return {
    ok: true,
    label,
    username: validation.username,
    cookieCount: parsed.storageState.cookies.length,
    format: parsed.format,
    created,
  };
}

export function describeCodeforcesIngest(result: CodeforcesIngestResult): string {
  if (!result.ok) return `❌ Could not read Codeforces session: ${result.error}`;
  const action = result.created ? '✅ Added Codeforces account' : '♻️ Updated Codeforces account';
  return `${action}: ${result.label} (${result.username})\nStatus: ACTIVE — session validated on codeforces.com\nCookies: ${result.cookieCount} (${result.format})`;
}

function makeLabel(username: string, existing: Array<{ label: string }>): string {
  const base = username.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 32) || 'codeforces';
  if (!existing.some((a) => a.label === base)) return base;
  for (let n = 2; n < 10_000; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    if (!existing.some((a) => a.label === candidate)) return candidate;
  }
  return `cf-${Date.now()}`.slice(0, 32);
}

function collectSiteHints(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectSiteHints(entry, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string' && /domain|origin|url|host|site/i.test(key)) out.add(raw);
    if (typeof raw === 'object') collectSiteHints(raw, out);
  }
}

function extractCookieArray(value: unknown): unknown[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.cookies)) return obj.cookies;
  if (obj.storageState && typeof obj.storageState === 'object') {
    const nested = obj.storageState as Record<string, unknown>;
    if (Array.isArray(nested.cookies)) return nested.cookies;
  }
  return null;
}

function toStorageCookie(value: unknown): StorageStateShape['cookies'][number] | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  if (typeof c.name !== 'string' || typeof c.value !== 'string') return null;
  const domain = typeof c.domain === 'string' && c.domain.length > 0 ? c.domain : '.codeforces.com';
  const expires = typeof c.expires === 'number' ? c.expires : typeof c.expirationDate === 'number' ? c.expirationDate : -1;
  return {
    name: c.name,
    value: c.value,
    domain,
    path: typeof c.path === 'string' && c.path ? c.path : '/',
    expires,
    httpOnly: c.httpOnly === true,
    secure: c.secure !== false,
    sameSite: normalizeSameSite(c.sameSite),
  };
}

function normalizeSameSite(value: unknown): 'Strict' | 'Lax' | 'None' {
  const text = String(value ?? '').toLowerCase();
  if (text === 'strict') return 'Strict';
  if (text === 'none' || text === 'no_restriction') return 'None';
  return 'Lax';
}
