import crypto from 'node:crypto';
import { Browser, BrowserContext, chromium, Page } from 'playwright';
import { config } from '../config';
import { logger } from '../logger';
import { buildLaunchArgs } from './playwright';
import { checkSession } from './sessionCheck';
import { LeetCodeApi } from '../leetcode/apiClient';
import {
  getSystemState,
  saveStorageStateToDb,
  setSystemState,
  SystemKeys,
} from '../database/models';

/**
 * Remote-browser session renewal — the human-in-the-loop login surface.
 *
 * The service runs on a headless datacenter box, so a "log in yourself"
 * step needs a browser the user can SEE and DRIVE. This module runs a real
 * Chromium instance inside the service and exposes it to the renewal web
 * page (src/api/renewalRoutes.ts) as:
 *
 *   - frames:   JPEG screenshots, polled by the page (~1 fps)
 *   - input:    taps / typing / keys / scroll, forwarded to the page
 *   - capture:  a watchdog polls LeetCode's userStatus; the moment the
 *               session is signed in, the context's storageState is saved
 *               to Postgres and the session closes itself
 *
 * Nothing here is automated against any bot check: every navigation, click,
 * keystroke — including any "verify you are human" step — is performed by
 * the user through the streamed view. The agent only watches the sign-in
 * state and saves the resulting cookies. Cookie values are never logged.
 */

export type RenewalPhase =
  | 'idle' // no session running
  | 'starting' // browser is launching / navigating
  | 'ready' // live — user can interact
  | 'success' // signed in, storageState saved
  | 'timeout' // user took too long — closed
  | 'error'; // launch/navigation failure

const VIEWPORT = { width: 1280, height: 800 };
const SESSION_TIMEOUT_MS = 10 * 60_000; // close the browser after 10 idle minutes
const SIGNIN_POLL_MS = 4_000;
const START_URL = 'https://leetcode.com/accounts/login/';

interface RemoteSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  phase: RenewalPhase;
  startedAt: number;
  username: string | null;
  error: string | null;
  busy: boolean; // serializes input vs screenshot
}

let current: RemoteSession | null = null;
let starting: Promise<RemoteSession> | null = null;
let onRenewed: ((username: string) => void) | null = null;
/** Outcome of the most recent session — kept after close so its page sees the result. */
let lastOutcome: { phase: RenewalPhase; username: string | null } = { phase: 'idle', username: null };
/** The token that just succeeded stays valid briefly so its page can see 'success'. */
let lastUsedToken: string | null = null;
let lastUsedTokenValidUntil = 0;
const USED_TOKEN_GRACE_MS = 90_000;

/** Called once by the HTTP layer so a successful renewal can kick today's run. */
export function setRenewalCallback(cb: (username: string) => void): void {
  onRenewed = cb;
}

/**
 * The secret that authorizes the renewal page. Generated once, persisted in
 * Postgres, rotated on every successful renewal. Render restarts therefore
 * keep the same link, and an old link dies after each use.
 */
export async function getRenewalToken(): Promise<string> {
  const existing = await getSystemState(SystemKeys.renewalToken);
  if (existing) return existing;
  const token = crypto.randomBytes(18).toString('hex');
  await setSystemState(SystemKeys.renewalToken, token);
  return token;
}

async function rotateRenewalToken(): Promise<void> {
  lastUsedToken = await getSystemState(SystemKeys.renewalToken);
  lastUsedTokenValidUntil = Date.now() + USED_TOKEN_GRACE_MS;
  await setSystemState(SystemKeys.renewalToken, crypto.randomBytes(18).toString('hex'));
}

/** Authorizes /renew page + API calls: the live token, or the just-used one in its grace window. */
export async function isValidRenewalKey(key: unknown): Promise<boolean> {
  if (typeof key !== 'string' || key.length < 16) return false;
  if (lastUsedToken && key === lastUsedToken && Date.now() < lastUsedTokenValidUntil) return true;
  return key === (await getRenewalToken());
}

/** Absolute URL of the renewal page, for alerts and the /renew bot reply. */
export async function renewalUrl(): Promise<string> {
  return `${config.api.publicUrl}/renew?key=${await getRenewalToken()}`;
}

export function currentPhase(): { phase: RenewalPhase; username: string | null } {
  if (current) return { phase: current.phase, username: current.username };
  return lastOutcome;
}

/** Starts the remote browser if needed; returns the live session. */
export async function ensureSession(): Promise<{ phase: RenewalPhase }> {
  if (current && current.phase !== 'error' && current.phase !== 'timeout') {
    return { phase: current.phase };
  }
  if (!starting) {
    lastOutcome = { phase: 'starting', username: null };
    starting = launch().catch((err) => {
      lastOutcome = { phase: 'error', username: null };
      throw err;
    });
    starting.finally(() => {
      starting = null;
    });
  }
  const session = await starting;
  return { phase: session.phase };
}

async function launch(): Promise<RemoteSession> {
  await closeCurrent('idle');

  const browser = await chromium.launch({
    headless: config.browser.headless,
    args: buildLaunchArgs(),
  });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    locale: 'en-US',
  });
  const page = await context.newPage();

  const session: RemoteSession = {
    browser,
    context,
    page,
    phase: 'starting',
    startedAt: Date.now(),
    username: null,
    error: null,
    busy: false,
  };
  current = session;

  try {
    await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    session.phase = 'ready';
    logger.info('remote renewal browser open at the LeetCode sign-in page');
  } catch (err) {
    // Even a failed initial navigation is recoverable — the user sees the
    // error page in the stream and can retry from the LeetCode UI.
    session.phase = 'ready';
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'initial navigation did not complete — session left open for the user',
    );
  }

  void watchSignIn(session);
  return session;
}

/**
 * The watchdog: polls userStatus (API-only, no navigation) until the user
 * has signed in, then captures storageState, persists it, and closes.
 * Also enforces the session timeout.
 */
async function watchSignIn(session: RemoteSession): Promise<void> {
  while (current === session && session.phase === 'ready') {
    await new Promise((r) => setTimeout(r, SIGNIN_POLL_MS));
    if (current !== session || session.phase !== 'ready') return;

    if (Date.now() - session.startedAt > SESSION_TIMEOUT_MS) {
      logger.warn('remote renewal session timed out without sign-in');
      lastOutcome = { phase: 'timeout', username: null };
      await closeCurrent('timeout');
      return;
    }

    try {
      const check = await checkSession(new LeetCodeApi(session.context));
      if (!check.authenticated || !check.username) continue;

      const state = await session.context.storageState();
      await saveStorageStateToDb(JSON.stringify(state));
      await setSystemState(SystemKeys.authStatus, 'ok');
      await setSystemState(SystemKeys.authUsername, check.username);
      await setSystemState(SystemKeys.authNotifiedAt, ''); // re-arm the expiry alert
      session.username = check.username;
      session.phase = 'success';
      await rotateRenewalToken(); // the link that was used is now dead

      logger.info(
        { username: check.username, cookies: state.cookies.length },
        'session renewed via remote browser — storageState saved',
      );
      const cb = onRenewed;
      lastOutcome = { phase: 'success', username: check.username };
      await closeCurrent('success');
      if (cb) cb(check.username);
      return;
    } catch (err) {
      // Transient network/blip while polling — keep the session open.
      logger.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'renewal sign-in poll failed — will retry',
      );
    }
  }
}

export async function closeCurrent(phase: 'timeout' | 'success' | 'error' | 'idle'): Promise<void> {
  const session = current;
  if (!session) return;
  current = null;
  if (session.phase !== 'success') session.phase = phase;
  await session.browser.close().catch(() => undefined);
}

/** Latest viewport as a base64 JPEG. Returns null when no live session. */
export async function captureFrame(): Promise<string | null> {
  const session = current;
  if (!session || session.phase !== 'ready') return null;
  if (session.busy) return null; // an input event is mid-flight — skip this tick
  try {
    const buf = await session.page.screenshot({ type: 'jpeg', quality: 55, timeout: 10_000 });
    return buf.toString('base64');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Input forwarding — every action here was initiated by the user's own tap
// or keystroke on the renewal page.
// ---------------------------------------------------------------------------

export type RemoteInput =
  | { type: 'click'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string }
  | { type: 'scroll'; dy: number };

const ALLOWED_KEYS = new Set([
  'Enter',
  'Tab',
  'Backspace',
  'Escape',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
]);

export async function forwardInput(input: RemoteInput): Promise<void> {
  const session = current;
  if (!session || session.phase !== 'ready') return;
  session.busy = true;
  try {
    switch (input.type) {
      case 'click': {
        const x = clamp(input.x, 0, VIEWPORT.width);
        const y = clamp(input.y, 0, VIEWPORT.height);
        await session.page.mouse.click(x, y);
        break;
      }
      case 'type':
        await session.page.keyboard.insertText(input.text.slice(0, 500));
        break;
      case 'key':
        if (ALLOWED_KEYS.has(input.key)) await session.page.keyboard.press(input.key);
        break;
      case 'scroll':
        await session.page.mouse.wheel(0, clamp(input.dy, -2000, 2000));
        break;
    }
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : String(err) }, 'input forward failed');
  } finally {
    session.busy = false;
  }
}

export function viewportSize(): { width: number; height: number } {
  return VIEWPORT;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)));
}