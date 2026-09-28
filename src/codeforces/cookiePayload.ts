import type { StorageCookie, StorageOrigin, StorageStateShape } from '../browser/cookiePayload';

export function parseCodeforcesStorageState(raw: string):
  | { ok: true; state: StorageStateShape }
  | { ok: false; error: string } {
  const text = raw.trim();
  if (!text) return { ok: false, error: 'empty Codeforces session payload' };

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    if (!text.includes('=')) return { ok: false, error: 'invalid JSON and not a cookie header' };
    const cookies = text.split(';').flatMap((part): StorageCookie[] => {
      const i = part.indexOf('=');
      if (i <= 0) return [];
      const name = part.slice(0, i).trim();
      const cookieValue = part.slice(i + 1).trim();
      return cookieValue
        ? [{ name, value: cookieValue, domain: '.codeforces.com', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' }]
        : [];
    });
    return cookies.length ? { ok: true, state: { cookies, origins: [] } } : { ok: false, error: 'cookie header contained no usable cookies' };
  }

  const cookiesInput =
    Array.isArray(value)
      ? value
      : value && typeof value === 'object'
        ? (value as Record<string, unknown>).cookies
        : undefined;

  if (!Array.isArray(cookiesInput)) return { ok: false, error: 'expected a cookies array' };

  const cookies: StorageCookie[] = [];
  for (const rawCookie of cookiesInput) {
    const c = rawCookie as Record<string, unknown> | null;
    if (!c || typeof c.name !== 'string' || typeof c.value !== 'string' || !c.value) continue;
    const domain = typeof c.domain === 'string' && c.domain ? c.domain : '.codeforces.com';
    if (!domain.includes('codeforces.com')) continue;
    cookies.push({
      name: c.name,
      value: c.value,
      domain,
      path: typeof c.path === 'string' ? c.path : '/',
      expires: typeof c.expires === 'number' ? c.expires : typeof c.expirationDate === 'number' ? c.expirationDate : -1,
      httpOnly: c.httpOnly === true,
      secure: c.secure !== false,
      sameSite: normalizeSameSite(c.sameSite),
    });
  }

  const origins: StorageOrigin[] = [];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const rawOrigins = (value as Record<string, unknown>).origins;
    if (Array.isArray(rawOrigins)) {
      for (const rawOrigin of rawOrigins) {
        const o = rawOrigin as Record<string, unknown> | null;
        if (!o || typeof o.origin !== 'string' || !o.origin.includes('codeforces.com')) continue;
        const localStorage = Array.isArray(o.localStorage)
          ? o.localStorage
              .map((entry) => entry as Record<string, unknown>)
              .filter((entry) => typeof entry.name === 'string' && typeof entry.value === 'string')
              .map((entry) => ({ name: String(entry.name), value: String(entry.value) }))
          : [];
        origins.push({ origin: o.origin, localStorage });
      }
    }
  }

  if (!cookies.length) return { ok: false, error: 'no codeforces.com cookies found' };
  return { ok: true, state: { cookies, origins } };
}

function normalizeSameSite(value: unknown): 'Strict' | 'Lax' | 'None' {
  const s = String(value ?? '').toLowerCase();
  if (s === 'strict') return 'Strict';
  if (s === 'none' || s === 'no_restriction') return 'None';
  return 'Lax';
}
