import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type Page, type Response } from 'playwright';
import { config } from '../config';
import { StorageStateShape } from '../browser/cookiePayload';
import { logger } from '../logger';
import { toPlaywrightProxy } from '../codeforces/proxyRotator';

export interface LeetCodeLoginResult {
  ok: boolean;
  username?: string;
  storageState?: StorageStateShape;
  error?: string;
  code?: string;
}

export interface LeetCodeLoginOptions {
  proxyUrl?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (status: string) => Promise<void> | void;
}

const LOGIN_URL = 'https://leetcode.com/accounts/login/';
const USERNAME = 'input#id_login, input[name="username"], input[name="login"], input[autocomplete="username"], input[placeholder*="Username" i], input[placeholder*="E-mail" i]';
const PASSWORD = 'input#id_password, input[name="password"], input[type="password"]';
const VERIFICATION_MESSAGE = 'Verification is required on LeetCode. Sign in in your browser, then use /renew to import the authenticated session.';

class LoginFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** Read-only inspection: no fabricated tokens, clearance cookies, or button overrides. */
async function verificationState(page: Page): Promise<'none' | 'required'> {
  return page.evaluate(() => {
    if (/just a moment|checking your browser|security verification/i.test(document.title) ||
      document.querySelector('#challenge-running, #challenge-form, #cf-challenge-running')) return 'required';
    const widgets = document.querySelector('.cf-turnstile, .g-recaptcha, .h-captcha, iframe[src*="challenges.cloudflare.com"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"]');
    const responses = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      '[name="cf-turnstile-response"], [name="turnstileToken"], [name="g-recaptcha-response"], [name="h-captcha-response"]'));
    if (widgets && !responses.some(input => input.value.trim().length > 0)) return 'required';
    return 'none';
  });
}

/** A verified server identity is mandatory; a cookie or homepage redirect is insufficient. */
async function signedInUser(page: Page, timeoutMs: number): Promise<string | null> {
  return page.evaluate(async timeout => {
    try {
      const response = await fetch('/graphql/', {
        method: 'POST', credentials: 'include', signal: AbortSignal.timeout(timeout),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'query { userStatus { isSignedIn username } }', variables: {} }),
      });
      if (!response.ok) return null;
      const body = await response.json();
      const user = body?.data?.userStatus;
      return user?.isSignedIn === true && typeof user.username === 'string' && user.username.trim() ? user.username : null;
    } catch { return null; }
  }, Math.max(1, Math.min(timeoutMs, 3000))).catch(() => null);
}

/** Exposed for local browser fixtures; all navigation remains in the caller's context. */
export async function loginOnLeetCodePage(page: Page, username: string, password: string,
  options: LeetCodeLoginOptions = {}): Promise<LeetCodeLoginResult> {
  const attemptId = randomUUID();
  const started = Date.now();
  const deadline = started + (options.timeoutMs ?? 60_000);
  const remaining = () => {
    if (options.signal?.aborted) throw new LoginFailure('LOGIN_CANCELLED', 'Login cancelled.');
    if (Date.now() >= deadline) throw new LoginFailure('LOGIN_TIMEOUT', 'Login timed out before the session could be verified.');
    return Math.max(1, deadline - Date.now());
  };
  let stage = 'navigation';
  let loginStatus: number | undefined;
  const responseListener = (response: Response) => {
    const url = new URL(response.url());
    if (url.hostname !== 'leetcode.com' || !url.pathname.startsWith('/accounts/login') || response.request().method() !== 'POST') return;
    loginStatus = response.status();
    logger.info({ attemptId, stage: 'login_response', status: loginStatus, elapsedMs: Date.now() - started }, 'LeetCode login response');
  };
  page.on('response', responseListener);
  const report = async (next: string, message: string, status?: number) => {
    stage = next;
    logger.info({ attemptId, stage, elapsedMs: Date.now() - started, status }, 'LeetCode login progress');
    // A slow/broken notification must not extend the authentication deadline.
    void Promise.resolve().then(() => options.onProgress?.(message)).catch(() => undefined);
  };
  try {
    await report('navigation', '🌐 Opening LeetCode login page…');
    const response = await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: remaining() });
    const status = response?.status();
    await report('page_loaded', '🔎 Checking login page…', status);
    if (await verificationState(page) === 'required') throw new LoginFailure('VERIFICATION_REQUIRED', VERIFICATION_MESSAGE);
    if (status && status >= 400) throw new LoginFailure('LOGIN_PAGE_HTTP_ERROR', `LeetCode login page returned HTTP ${status}.`);
    const usernameInput = page.locator(USERNAME).first();
    try { await usernameInput.waitFor({ state: 'visible', timeout: Math.min(5000, remaining()) }); }
    catch {
      const verified = await signedInUser(page, remaining());
      if (verified) return { ok: true, username: verified, storageState: await page.context().storageState() as StorageStateShape };
      if (await verificationState(page) === 'required') throw new LoginFailure('VERIFICATION_REQUIRED', VERIFICATION_MESSAGE);
      throw new LoginFailure('LOGIN_FORM_UNAVAILABLE', 'LeetCode login form is unavailable. Use /renew after signing in in your browser.');
    }
    const form = page.locator('form').filter({ has: usernameInput }).first();
    // Scope the password and submit control to the username's form; unrelated
    // search/registration forms must never receive credentials or clicks.
    const hasForm = await form.count() > 0;
    const scope = hasForm ? form : page.locator('body');
    const submit = scope.locator(hasForm ?
      'button#signin_btn, button[type="submit"], button:has-text("Sign In"), button:has-text("Log In"), input[type="submit"]' :
      'button#signin_btn, button:has-text("Sign In"), button:has-text("Log In"), input[type="submit"][value="Sign In"]').first();
    await report('credentials', '📝 Filling login form…');
    await usernameInput.fill(username, { timeout: remaining() });
    await scope.locator(PASSWORD).first().fill(password, { timeout: remaining() });
    if (await verificationState(page) === 'required') throw new LoginFailure('VERIFICATION_REQUIRED', VERIFICATION_MESSAGE);
    await submit.waitFor({ state: 'visible', timeout: remaining() });
    if (!await submit.isEnabled()) throw new LoginFailure('LOGIN_FORM_NOT_READY', 'The login button is disabled. Complete the form or verification in your browser and use /renew.');
    await report('submitting', '📤 Submitting login once…');
    // Never force the button, dispatch additional submit events, or retry an
    // ambiguous click. LeetCode's native handlers own the single submission.
    await submit.click({ timeout: remaining() });
    await report('verifying_session', '⏳ Verifying authenticated identity…');
    while (remaining() > 0) {
      if (page.isClosed()) throw new LoginFailure('LOGIN_BROWSER_CLOSED', 'The login browser closed before authentication was verified.');
      if (loginStatus === 400 || loginStatus === 401) throw new LoginFailure('LOGIN_REJECTED', 'LeetCode rejected the sign-in. Check credentials or complete account verification in your browser.');
      if (loginStatus === 403) throw new LoginFailure('VERIFICATION_REQUIRED', VERIFICATION_MESSAGE);
      if (loginStatus === 429) throw new LoginFailure('LOGIN_RATE_LIMITED', 'LeetCode has rate limited sign-in. Wait before retrying.');
      if (loginStatus && loginStatus >= 500) throw new LoginFailure('LOGIN_SERVICE_ERROR', `LeetCode sign-in returned HTTP ${loginStatus}. Retry later.`);
      if (await verificationState(page).catch(() => 'none') === 'required') throw new LoginFailure('VERIFICATION_REQUIRED', VERIFICATION_MESSAGE);
      const verified = await signedInUser(page, remaining());
      if (verified) {
        const storageState = await page.context().storageState() as StorageStateShape;
        await report('authenticated', '✅ Authenticated identity verified.');
        return { ok: true, username: verified, storageState };
      }
      const errorVisible = await page.locator('.error-message, .errorlist, [role="alert"], p.text-red-500, div.text-red-500').first().isVisible().catch(() => false);
      if (errorVisible) throw new LoginFailure('LOGIN_REJECTED', 'LeetCode rejected the sign-in. Check credentials or complete any account verification in your browser.');
      await new Promise(resolve => setTimeout(resolve, Math.min(250, remaining())));
    }
    throw new LoginFailure('LOGIN_TIMEOUT', 'Authentication could not be verified.');
  } catch (error) {
    const failure = options.signal?.aborted ? new LoginFailure('LOGIN_CANCELLED', 'Login cancelled.') :
      Date.now() >= deadline ? new LoginFailure('LOGIN_TIMEOUT', 'Login timed out before the session could be verified.') :
      error instanceof LoginFailure ? error : new LoginFailure('LOGIN_BROWSER_ERROR', 'Login browser or navigation failed. Use /renew after signing in in your browser.');
    // Playwright errors can contain fill values or remote page text. Log safe
    // categories, stage and request ID only; never the raw error/password.
    logger.warn({ attemptId, stage, code: failure.code, elapsedMs: Date.now() - started }, 'LeetCode login failed');
    return { ok: false, code: failure.code, error: failure.message };
  } finally {
    page.off('response', responseListener);
  }
}

/** Ordinary sign-in in an isolated browser, bounded by one total deadline. */
export async function loginToLeetCode(loginInput: string, password: string,
  options: LeetCodeLoginOptions = {}): Promise<LeetCodeLoginResult> {
  if (!loginInput.trim() || !password) return { ok: false, code: 'CREDENTIALS_REQUIRED', error: 'Username/email and password are required.' };
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { ok: false, code: 'INVALID_TIMEOUT', error: 'Login timeout must be a positive number.' };
  if (options.signal?.aborted) return { ok: false, code: 'LOGIN_CANCELLED', error: 'Login cancelled.' };
  const deadline = Date.now() + timeoutMs;
  let browser: Browser | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => { void browser?.close().catch(() => undefined); };
  options.signal?.addEventListener('abort', close, { once: true });
  try {
    browser = await chromium.launch({ headless: config.browser.headless, timeout: timeoutMs,
      args: ['--disable-dev-shm-usage', '--no-sandbox'],
      proxy: options.proxyUrl ? toPlaywrightProxy(options.proxyUrl) : undefined });
    if (options.signal?.aborted) return { ok: false, code: 'LOGIN_CANCELLED', error: 'Login cancelled.' };
    if (Date.now() >= deadline) return { ok: false, code: 'LOGIN_TIMEOUT', error: 'Login timed out while launching the browser.' };
    timer = setTimeout(close, Math.max(1, deadline - Date.now()));
    const context = await browser.newContext();
    const page = await context.newPage();
    return await loginOnLeetCodePage(page, loginInput.trim(), password, { ...options, timeoutMs: Math.max(1, deadline - Date.now()) });
  } catch {
    return { ok: false, code: options.signal?.aborted ? 'LOGIN_CANCELLED' : 'LOGIN_BROWSER_ERROR',
      error: options.signal?.aborted ? 'Login cancelled.' : 'Could not initialize the login browser. Check the browser installation and server resources.' };
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', close);
    await browser?.close().catch(() => undefined);
  }
}
