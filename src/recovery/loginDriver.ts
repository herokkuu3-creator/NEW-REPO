import type { Page, Response } from 'playwright';
import { LOGIN_URL, PASSWORD, USERNAME, signedInUser, verificationState } from '../leetcode/auth';

export type DriverPhase = 'awaiting_verification' | 'filling' | 'submitting' | 'verifying';

export interface DriverCredentials {
  /** Username or e-mail. Used server-side only; never rendered, logged or sent to the portal. */
  identifier: string;
  password: string;
}

export interface DriverOptions {
  deadline: number;
  signal: AbortSignal;
  pollMs?: number;
  onPhase?: (phase: DriverPhase) => void | Promise<void>;
  loginUrl?: string;
  /** Proof-of-concept mode: stop as soon as the real login form is usable. Nothing is filled or submitted. */
  dryRun?: boolean;
}

export type DriverResult =
  | { ok: true; username: string }
  | { ok: false; category: string; message: string };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class Stop extends Error {
  constructor(
    readonly category: string,
    message: string,
  ) {
    super(message);
  }
}

/** Never lets a password-bearing input be revealed in the screencast (even via a "show password" toggle). */
const MASK_CSS =
  'input#id_password, input[name="password"], input[type="password"] { -webkit-text-security: disc !important; }';

/**
 * Drives the LEGITIMATE LeetCode login page for one recovery:
 *
 *   1. open the real login page and WAIT while the human completes any
 *      Cloudflare/CAPTCHA verification (this code never solves or fakes one);
 *   2. once the form is usable and no verification is pending, fill the stored
 *      credentials server-side and submit exactly once;
 *   3. confirm the authenticated identity through LeetCode's GraphQL userStatus.
 *
 * Error details from Playwright are never propagated (they may embed page text
 * or fill values) — only fixed, safe categories.
 */
export async function driveLeetCodeLogin(
  page: Page,
  creds: DriverCredentials,
  opts: DriverOptions,
): Promise<DriverResult> {
  const poll = opts.pollMs ?? 400;
  let loginStatus: number | undefined;
  const onResponse = (res: Response) => {
    try {
      const u = new URL(res.url());
      if (u.hostname === 'leetcode.com' && u.pathname.startsWith('/accounts/login') && res.request().method() === 'POST') {
        loginStatus = res.status();
      }
    } catch {
      /* ignore */
    }
  };
  page.on('response', onResponse);

  const remaining = (): number => {
    if (opts.signal.aborted) throw new Stop('CANCELLED', 'Recovery was cancelled.');
    if (page.isClosed()) throw new Stop('BROWSER_CLOSED', 'The recovery browser closed unexpectedly.');
    const left = opts.deadline - Date.now();
    if (left <= 0) throw new Stop('VERIFICATION_TIMEOUT', 'Verification was not completed in time.');
    return left;
  };
  const phase = async (p: DriverPhase) => {
    await opts.onPhase?.(p);
  };

  try {
    await phase('awaiting_verification');
    try {
      await page.goto(opts.loginUrl ?? LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: Math.min(30_000, remaining()) });
    } catch {
      if (opts.signal.aborted) throw new Stop('CANCELLED', 'Recovery was cancelled.');
      if (page.isClosed()) throw new Stop('BROWSER_CLOSED', 'The recovery browser closed unexpectedly.');
      throw new Stop('NAVIGATION_FAILED', 'Could not open the LeetCode login page from the server.');
    }

    const usernameInput = page.locator(USERNAME).first();

    // 1) The human completes verification; we only observe. No clicks, no tokens.
    for (;;) {
      remaining();
      const state = await verificationState(page).catch(() => 'required' as const);
      const visible = await usernameInput.isVisible().catch(() => false);
      if (visible && state === 'none') break;
      await sleep(poll);
    }

    // 2) Fill the stored credentials on the server.
    if (opts.dryRun) {
      return { ok: false, category: 'DRY_RUN_FORM_REACHED', message: 'The real login form is usable; dry run stops before filling.' };
    }
    await phase('filling');
    await page.addStyleTag({ content: MASK_CSS }).catch(() => undefined);
    const form = page.locator('form').filter({ has: usernameInput }).first();
    const hasForm = (await form.count().catch(() => 0)) > 0;
    const scope = hasForm ? form : page.locator('body');
    try {
      await usernameInput.fill(creds.identifier, { timeout: remaining() });
      await scope.locator(PASSWORD).first().fill(creds.password, { timeout: remaining() });
    } catch {
      if (opts.signal.aborted) throw new Stop('CANCELLED', 'Recovery was cancelled.');
      throw new Stop('FORM_FILL_FAILED', 'The login form could not be filled.');
    }

    const submit = scope
      .locator(
        hasForm
          ? 'button#signin_btn, button[type="submit"], button:has-text("Sign In"), button:has-text("Log In"), input[type="submit"]'
          : 'button#signin_btn, button:has-text("Sign In"), button:has-text("Log In"), input[type="submit"][value="Sign In"]',
      )
      .first();

    // A form-level widget may appear/still be pending: wait for the human again.
    for (;;) {
      remaining();
      const state = await verificationState(page).catch(() => 'required' as const);
      const ready = (await submit.isVisible().catch(() => false)) && (await submit.isEnabled().catch(() => false));
      if (state === 'none' && ready) break;
      await sleep(poll);
    }

    // 3) Submit exactly once; LeetCode's own handlers perform the authentication.
    await phase('submitting');
    try {
      await submit.click({ timeout: remaining() });
    } catch {
      throw new Stop('SUBMIT_FAILED', 'The login button could not be clicked.');
    }

    await phase('verifying');
    for (;;) {
      remaining();
      if (loginStatus === 400 || loginStatus === 401) {
        throw new Stop('LOGIN_REJECTED', 'LeetCode rejected the stored credentials.');
      }
      if (loginStatus === 403) {
        throw new Stop('VERIFICATION_REJECTED', 'LeetCode asked for verification again after sign-in.');
      }
      if (loginStatus === 429) throw new Stop('RATE_LIMITED', 'LeetCode rate limited the sign-in.');
      if (loginStatus && loginStatus >= 500) throw new Stop('SERVICE_ERROR', `LeetCode sign-in returned HTTP ${loginStatus}.`);
      const username = await signedInUser(page, Math.min(3000, remaining()));
      if (username) return { ok: true, username };
      const errorVisible = await page
        .locator('.error-message, .errorlist, [role="alert"], p.text-red-500, div.text-red-500')
        .first()
        .isVisible()
        .catch(() => false);
      if (errorVisible) throw new Stop('LOGIN_REJECTED', 'LeetCode rejected the stored credentials.');
      await sleep(poll);
    }
  } catch (err) {
    if (err instanceof Stop) return { ok: false, category: err.category, message: err.message };
    return { ok: false, category: 'BROWSER_ERROR', message: 'The recovery browser failed unexpectedly.' };
  } finally {
    page.off('response', onResponse);
  }
}
