import { describe, expect, it } from 'vitest';
import { parseCookiePayload } from '../src/browser/cookiePayload';

/**
 * Parser tests for the /renew flow. Pure functions — no browser, no network.
 * The fixtures use fake cookie values; the rules under test are the format
 * detection, the leetcode.com filtering, and the required-cookie guards.
 */

const SESSION = 'eyJfake.session.value.1234567890';
const CSRF = 'fakecsrftoken123';

describe('parseCookiePayload — cookie header string', () => {
  it('parses LEETCODE_SESSION + csrftoken into a storageState', () => {
    const result = parseCookiePayload(`LEETCODE_SESSION=${SESSION}; csrftoken=${CSRF}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.format).toBe('cookie string');
    const byName = new Map(result.storageState.cookies.map((c) => [c.name, c]));
    const session = byName.get('LEETCODE_SESSION');
    expect(session?.value).toBe(SESSION);
    expect(session?.domain).toBe('.leetcode.com');
    expect(session?.httpOnly).toBe(true);
    expect(session?.secure).toBe(true);
    expect(byName.get('csrftoken')?.value).toBe(CSRF);
  });

  it('rejects a header string without LEETCODE_SESSION', () => {
    const result = parseCookiePayload(`csrftoken=${CSRF}; other=1`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/LEETCODE_SESSION/);
  });

  it('rejects when csrftoken is missing (needed for submissions)', () => {
    const result = parseCookiePayload(`LEETCODE_SESSION=${SESSION}`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/csrftoken/);
  });
});

describe('parseCookiePayload — Cookie-Editor JSON export', () => {
  it('maps expirationDate and sameSite variants, drops other sites', () => {
    const exportJson = JSON.stringify([
      {
        name: 'LEETCODE_SESSION',
        value: SESSION,
        domain: '.leetcode.com',
        path: '/',
        expirationDate: 1893456000,
        httpOnly: true,
        secure: true,
        sameSite: 'no_restriction',
      },
      {
        name: 'csrftoken',
        value: CSRF,
        domain: 'leetcode.com',
        path: '/',
        session: true,
        sameSite: 'lax',
      },
      { name: 'NID', value: 'google-cookie', domain: '.google.com', path: '/' },
    ]);
    const result = parseCookiePayload(exportJson);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.format).toBe('Cookie-Editor export');
    expect(result.storageState.cookies).toHaveLength(2); // google.com filtered out
    const session = result.storageState.cookies.find((c) => c.name === 'LEETCODE_SESSION');
    expect(session?.expires).toBe(1893456000);
    expect(session?.sameSite).toBe('None');
    expect(session?.httpOnly).toBe(true);
  });

  it('rejects an export containing only foreign domains', () => {
    const result = parseCookiePayload(
      JSON.stringify([{ name: 'LEETCODE_SESSION', value: SESSION, domain: '.google.com' }]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/leetcode\.com/);
  });
});

describe('parseCookiePayload — Playwright storageState JSON', () => {
  it('passes cookies through and preserves origins', () => {
    const storageState = JSON.stringify({
      cookies: [
        {
          name: 'LEETCODE_SESSION',
          value: SESSION,
          domain: '.leetcode.com',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
        {
          name: 'csrftoken',
          value: CSRF,
          domain: '.leetcode.com',
          path: '/',
          expires: 1893456000,
          httpOnly: false,
          secure: true,
          sameSite: 'Lax',
        },
      ],
      origins: [
        {
          origin: 'https://leetcode.com',
          localStorage: [{ name: 'lc-theme', value: 'dark' }],
        },
      ],
    });
    const result = parseCookiePayload(storageState);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.format).toBe('storageState JSON');
    expect(result.storageState.cookies).toHaveLength(2);
    expect(result.storageState.origins).toHaveLength(1);
    expect(result.storageState.origins[0]?.localStorage[0]?.name).toBe('lc-theme');
  });

  it('rejects truncated JSON with a file-upload hint (Telegram splits long pastes)', () => {
    const result = parseCookiePayload('{"cookies":[{"name":"LEETCODE_SESSION","value":"abc');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/FILE/);
  });
});

describe('parseCookiePayload — garbage input', () => {
  it('rejects empty and unrecognized text', () => {
    expect(parseCookiePayload('   ').ok).toBe(false);
    const result = parseCookiePayload('hello, is this thing on?');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/format/);
  });
});