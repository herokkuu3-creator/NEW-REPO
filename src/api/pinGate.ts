import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * PIN gate for the pages that used to be open to anyone (GET /health).
 *
 * Configured with the PIN_CODE env var (PIN-CODE is accepted too). Without a
 * valid PIN a caller only ever sees `{"status":"ok"}` (enough for Render's
 * health check) or, in a browser, a PIN entry page — never account names,
 * usernames, errors or run details.
 *
 * Ways to unlock:
 *   - browser: enter the PIN on the form → an HttpOnly, SameSite=Strict
 *     cookie (HMAC-signed, expires after 12h, invalidated when the PIN changes)
 *   - scripts: send the header `X-PIN-Code: <pin>`
 *
 * Brute force: 5 wrong PINs from one IP locks that IP out for 15 minutes.
 * If PIN_CODE is not set at all, the details stay locked (fail closed).
 */

export const PIN_COOKIE = 'lda_pin';
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

export function readPinFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return (env.PIN_CODE ?? env['PIN-CODE'] ?? '').trim();
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export class PinGate {
  private readonly fails = new Map<string, { count: number; until: number }>();

  constructor(
    private readonly pin: string,
    private readonly secret: string,
    private readonly now: () => number = Date.now,
  ) {}

  get configured(): boolean {
    return this.pin.length > 0;
  }

  private sign(expiry: number): string {
    return createHmac('sha256', `${this.secret}|${this.pin}`).update(`pin-session:${expiry}`).digest('hex');
  }

  /** Cookie value for a fresh unlocked session. */
  issueToken(): { value: string; maxAgeS: number } {
    const expiry = this.now() + SESSION_MS;
    return { value: `${expiry}.${this.sign(expiry)}`, maxAgeS: Math.floor(SESSION_MS / 1000) };
  }

  verifyToken(token: string | undefined): boolean {
    if (!this.configured || !token) return false;
    const [expStr, sig] = token.split('.');
    const expiry = Number(expStr);
    if (!Number.isFinite(expiry) || !sig || expiry < this.now()) return false;
    return safeEqual(sig, this.sign(expiry));
  }

  isLockedOut(ip: string): boolean {
    const f = this.fails.get(ip);
    return !!f && f.count >= MAX_FAILS && f.until > this.now();
  }

  /**
   * Checks a submitted PIN, applying the per-IP lockout.
   * 'locked' = too many wrong attempts; the PIN is not even compared.
   */
  checkPin(ip: string, candidate: string | undefined): 'ok' | 'wrong' | 'locked' | 'not-configured' {
    if (!this.configured) return 'not-configured';
    if (this.isLockedOut(ip)) return 'locked';
    if (candidate !== undefined && safeEqual(String(candidate).trim(), this.pin)) {
      this.fails.delete(ip);
      return 'ok';
    }
    const f = this.fails.get(ip);
    const expired = !f || f.until <= this.now();
    const count = (expired ? 0 : f.count) + 1;
    this.fails.set(ip, { count, until: this.now() + LOCK_MS });
    return count >= MAX_FAILS ? 'locked' : 'wrong';
  }

  /** True when the request carries a valid session cookie or a correct X-PIN-Code header. */
  isUnlocked(ip: string, headers: Record<string, string | string[] | undefined>): boolean {
    const cookie = parseCookies(headers.cookie as string | undefined)[PIN_COOKIE];
    if (this.verifyToken(cookie)) return true;
    const headerPin = headers['x-pin-code'];
    if (typeof headerPin === 'string' && headerPin.length > 0) {
      return this.checkPin(ip, headerPin) === 'ok';
    }
    return false;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Minimal self-contained PIN entry page (no external assets, nothing sensitive). */
export function pinPage(opts: { next: string; message?: string; disabled?: boolean }): string {
  const msg = opts.message ? `<p class="msg">${escapeHtml(opts.message)}</p>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Locked</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e8e8e8;font:16px system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  form{background:#181b22;padding:28px 26px;border-radius:14px;width:min(320px,86vw);box-shadow:0 10px 30px #0008}
  h1{font-size:18px;margin:0 0 14px}
  input{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #333;background:#0f1115;color:#fff;font-size:20px;letter-spacing:6px;text-align:center}
  button{margin-top:14px;width:100%;padding:11px;border:0;border-radius:8px;background:#ffa116;color:#111;font-weight:600;font-size:15px;cursor:pointer}
  button:disabled{opacity:.5;cursor:not-allowed}
  .msg{color:#ff8080;font-size:14px;margin:0 0 12px}
</style></head><body>
<form method="post" action="/unlock" autocomplete="off">
  <h1>Enter PIN</h1>${msg}
  <input type="password" name="pin" inputmode="numeric" autofocus required ${opts.disabled ? 'disabled' : ''}>
  <input type="hidden" name="next" value="${escapeHtml(opts.next)}">
  <button type="submit" ${opts.disabled ? 'disabled' : ''}>Unlock</button>
</form></body></html>`;
}

/** Only allow redirecting back to a local path (no open redirect). */
export function safeNext(next: unknown): string {
  return typeof next === 'string' && /^\/(?!\/)[\w\-./?=&%]*$/.test(next) ? next : '/health';
}
