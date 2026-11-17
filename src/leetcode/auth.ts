import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type Page, type Response } from 'playwright';
import { config } from '../config';
import { StorageStateShape, type StorageCookie } from '../browser/cookiePayload';
import { buildLaunchArgs } from '../browser/playwright';
import { applyStealthScripts } from '../browser/stealth';
import { logger } from '../logger';
import { toPlaywrightProxy } from '../codeforces/proxyRotator';
import {
  getCPSolverUrl,
  loginLeetCodeWithCPSolver,
  solveTurnstileOrchestrated,
  solveCloudflareOrchestrated,
  sanitizeChallengeUrl,
  TURNSTILE_URL_SITEKEY_RE,
  extractTurnstileSitekeyFromFrames,
  withCapzyRequestContext,
  type SolverResult,
  DEFAULT_DESKTOP_CHROME_USER_AGENT,
  getLastCapzyDiagnostic,
  getLastCapzyError,
} from '../codeforces/captchaSolver';
import { getCandidateCapzyKeys } from '../codeforces/capzyKeyManager';
import { AttemptCancelledError, getAttemptContext, withAttemptContext } from '../codeforces/attemptContext';

export type LoginState =
  | 'LOGIN_PAGE_LOADING'
  | 'VERIFICATION_REQUIRED'
  | 'VERIFICATION_IN_PROGRESS'
  | 'AWAITING_USER_VERIFICATION'
  | 'VERIFICATION_COMPLETED'
  | 'AUTHENTICATING'
  | 'AUTHENTICATED'
  | 'SESSION_VALIDATED'
  | 'SESSION_PERSISTED'
  | 'LOGIN_SUCCESS'
  | 'LOGIN_FAILED';

export type VerificationChallengeType =
  | 'turnstile'
  | 'cloudflare_interstitial'
  | 'recaptcha'
  | 'hcaptcha'
  | 'unsupported'
  | 'none';

export interface VerificationDetail {
  type: VerificationChallengeType;
  required: boolean;
  sitekey?: string;
  action?: string;
  cdata?: string;
}

export interface VerificationDiagnostic {
  challengeType: VerificationChallengeType;
  adapterInitialized: boolean;
  providerRequestAccepted: boolean;
  providerOperationCompleted: boolean;
  verificationCompleted: boolean;
  userAuthenticated: boolean;
  sessionValidated: boolean;
  sessionPersisted: boolean;
  selectedAdapter?: 'cpsolver' | 'capzy' | 'none';
  solverAttempted: boolean;
  solverResult?: 'success' | 'failed' | 'timeout' | 'declined' | 'unsupported_challenge' | 'no_adapter_configured';
  solverError?: string;
  providerHttpStatus?: number;
  providerErrorCode?: string;
  providerErrorCategory?: string;
  taskLifecycleState?: string;
  elapsedTimeMs?: number;
  timeoutReason?: string;
  manualVerificationRequired: boolean;
  continuationStatus: 'resumed' | 'awaiting_user' | 'failed' | 'not_needed';
}

export interface LeetCodeLoginResult {
  ok: boolean;
  username?: string;
  storageState?: StorageStateShape;
  error?: string;
  code?: string;
  state?: LoginState;
  diagnostic?: VerificationDiagnostic;
}

export interface LeetCodeLoginOptions {
  proxyUrl?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  disableRemoteLogin?: boolean;
  onProgress?: (status: string, state?: LoginState) => Promise<void> | void;
  solver?: (params: {
    websiteURL: string;
    sitekey?: string;
    action?: string;
    cdata?: string;
    proxyUrl?: string;
    userAgent?: string;
    timeoutMs?: number;
  }) => Promise<SolverResult | null>;
}

export const LOGIN_URL = 'https://leetcode.com/accounts/login/';
export const USERNAME = 'input#id_login, input[name="username"], input[name="login"], input[autocomplete="username"], input[placeholder*="Username" i], input[placeholder*="E-mail" i]';
export const PASSWORD = 'input#id_password, input[name="password"], input[type="password"]';
const VERIFICATION_MESSAGE = 'Verification is required on LeetCode. Sign in in your browser, then use /renew to import the authenticated session.';

class LoginFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly diagnostic?: VerificationDiagnostic,
    readonly state: LoginState = 'LOGIN_FAILED',
  ) {
    super(message);
  }
}

const observedPageTurnstileSitekey = new WeakMap<Page, string>();

/**
 * Installs a read-only `window.turnstile.render` observer hook on the given Page
 * so sitekey, action, and cData metadata can be forwarded accurately to solvers.
 */
export async function installTurnstileMetadataHook(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const win = window as any;
    let realTurnstile: any;
    const wrapRenderFn = (origRender: any) => {
      if (typeof origRender !== 'function' || origRender.__hookedRender) return origRender;
      const wrapped = function (this: any, container: unknown, params?: Record<string, unknown>) {
        if (params && typeof params === 'object') {
          if (typeof params.sitekey === 'string' && params.sitekey) win.__turnstileSitekey = params.sitekey;
          if (typeof params.action === 'string' && params.action) win.__turnstileAction = params.action;
          const rawCData =
            typeof params.cData === 'string' && params.cData
              ? params.cData
              : typeof params.cdata === 'string' && params.cdata
                ? params.cdata
                : '';
          if (rawCData) {
            win.__turnstileCData = rawCData;
            win.__turnstileCdata = rawCData;
          }
          if (typeof params.callback === 'function') win.__turnstileCallback = params.callback;
        }
        return origRender.apply(this, arguments);
      };
      wrapped.__hookedRender = true;
      return wrapped;
    };
    const hookTurnstile = (ts: any) => {
      if (!ts || typeof ts !== 'object' || ts.__hooked) return ts;
      try {
        let currentRender = wrapRenderFn(ts.render);
        Object.defineProperty(ts, 'render', {
          configurable: true,
          enumerable: true,
          get() {
            return currentRender;
          },
          set(nextFn) {
            currentRender = wrapRenderFn(nextFn);
          },
        });
        ts.__hooked = true;
      } catch {
        const origRender = typeof ts.render === 'function' ? ts.render : undefined;
        if (origRender) {
          ts.render = wrapRenderFn(origRender);
          ts.__hooked = true;
        }
      }
      return ts;
    };
    if (win.turnstile && typeof win.turnstile === 'object') {
      realTurnstile = hookTurnstile(win.turnstile);
    }
    try {
      Object.defineProperty(win, 'turnstile', {
        configurable: true,
        enumerable: true,
        get() {
          return realTurnstile;
        },
        set(val) {
          realTurnstile = hookTurnstile(val);
        },
      });
    } catch {}
  }).catch(() => undefined);
}

/** Detailed inspection of Cloudflare interstitial, Turnstile, and other challenge widgets. */
export async function detectVerificationDetail(page: Page): Promise<VerificationDetail> {
  if (!page || page.isClosed()) {
    return { type: 'none', required: false };
  }
  try {
    const detail = await page.evaluate((): VerificationDetail => {
      const resourceSitekey = (): string | undefined => {
        try {
          const entries = performance.getEntriesByType?.('resource') as Array<{ name?: string }> | undefined;
          if (!Array.isArray(entries)) return undefined;
          for (const entry of entries) {
            if (!entry?.name || !entry.name.includes('challenges.cloudflare.com')) continue;
            const m = /challenges\.cloudflare\.com\/.*?\/(0x4[a-zA-Z0-9_-]{16,})(?:[/?#]|$)/i.exec(entry.name);
            if (m?.[1]) return m[1];
          }
        } catch {}
        return undefined;
      };
      const scriptSitekey = (): string | undefined => {
        try {
          const scripts = Array.from(document.querySelectorAll('script'));
          for (const s of scripts) {
            if (s.src && s.src.includes('challenges.cloudflare.com')) {
              const m = /challenges\.cloudflare\.com\/.*?\/(0x4[a-zA-Z0-9_-]{16,})(?:[/?#]|$)/i.exec(s.src);
              if (m?.[1]) return m[1];
            }
            const txt = s.textContent || '';
            if (txt.includes('turnstile') || txt.includes('sitekey')) {
              const m = /["']?sitekey["']?\s*[:=]\s*["'](0x4[a-zA-Z0-9_-]{16,})["']/i.exec(txt);
              if (m?.[1]) return m[1];
            }
          }
        } catch {}
        return undefined;
      };
      const title = document.title || '';
      const bodyText = document.body ? document.body.innerText || '' : '';
      const isCfTitle = /just a moment|checking your browser|security verification/i.test(title);
      const isCfRunning = Boolean(document.querySelector('#challenge-running, #challenge-form, #cf-challenge-running'));
      const isCfText = /verify you are human|verifying that you are human|verifying your browser/i.test(bodyText) &&
        !document.querySelector('input#id_login, input[name="username"]');

      if (isCfTitle || isCfRunning || isCfText) {
        const el = (document.querySelector('[data-sitekey], [data-key]') || document.querySelector('.cf-turnstile')) as HTMLElement | null;
        const win = window as any;
        const sitekey =
          win.__turnstileSitekey ||
          el?.getAttribute('data-sitekey') ||
          el?.getAttribute('data-key') ||
          el?.dataset?.sitekey ||
          resourceSitekey() ||
          scriptSitekey() ||
          undefined;
        const action = win.__turnstileAction || el?.getAttribute('data-action') || el?.dataset?.action || undefined;
        const cdata =
          win.__turnstileCData ||
          win.__turnstileCdata ||
          el?.getAttribute('data-cdata') ||
          el?.dataset?.cdata ||
          undefined;
        return {
          type: 'cloudflare_interstitial' as const,
          required: true,
          ...(sitekey ? { sitekey } : {}),
          ...(action ? { action } : {}),
          ...(cdata ? { cdata } : {}),
        };
      }

      // Check Turnstile widget
      const turnstileInput = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        '[name="cf-turnstile-response"], [name="turnstileToken"], input[id^="cf-chl-widget-"][id$="_response"]'
      );
      const turnstileWidget =
        document.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare.com"], iframe[src*="cloudflare.com"]') ||
        document.querySelector('input[id^="cf-chl-widget-"][id$="_response"]');
      if (turnstileWidget) {
        const win = window as any;
        const hasToken =
          Boolean(turnstileInput && turnstileInput.value && turnstileInput.value.trim().length > 0) ||
          Boolean(typeof win.__turnstileToken === 'string' && win.__turnstileToken.trim().length > 0);
        let sitekey: string | undefined;
        const el = (document.querySelector('[data-sitekey], [data-key]') || document.querySelector('.cf-turnstile')) as HTMLElement | null;
        sitekey = win.__turnstileSitekey || el?.getAttribute('data-sitekey') || el?.getAttribute('data-key') || el?.dataset?.sitekey;
        const action = win.__turnstileAction || el?.getAttribute('data-action') || el?.dataset?.action || undefined;
        const cdata =
          win.__turnstileCData ||
          win.__turnstileCdata ||
          el?.getAttribute('data-cdata') ||
          el?.dataset?.cdata ||
          undefined;
        if (!sitekey) {
          const iframe = document.querySelector<HTMLIFrameElement>('iframe[src*="challenges.cloudflare.com"], iframe[src*="cloudflare.com"]');
          if (iframe?.src) {
            const match = /(0x4[a-zA-Z0-9_-]{16,})/i.exec(iframe.src);
            if (match?.[1]) sitekey = match[1];
          }
        }
        if (!sitekey) {
          sitekey = resourceSitekey() || scriptSitekey();
        }
        return {
          type: 'turnstile' as const,
          required: !hasToken,
          ...(sitekey ? { sitekey } : {}),
          ...(action ? { action } : {}),
          ...(cdata ? { cdata } : {}),
        };
      }

      // Check reCAPTCHA (ignore passive invisible reCAPTCHA Enterprise badge unless challenge frame or explicit .g-recaptcha container is active)
      const recaptchaClassWidget = document.querySelector('.g-recaptcha');
      const recaptchaIframe = document.querySelector<HTMLIFrameElement>('iframe[src*="recaptcha"]');
      const isPassiveInvisibleRecaptcha =
        !recaptchaClassWidget &&
        Boolean(recaptchaIframe?.src && /[?&]size=invisible\b/i.test(recaptchaIframe.src)) &&
        !document.querySelector('iframe[src*="recaptcha"][src*="bframe"]');
      if ((recaptchaClassWidget || recaptchaIframe) && !isPassiveInvisibleRecaptcha) {
        const recaptchaInput = document.querySelector<HTMLInputElement | HTMLTextAreaElement>('[name="g-recaptcha-response"]');
        const hasToken = Boolean(recaptchaInput && recaptchaInput.value && recaptchaInput.value.trim().length > 0);
        return { type: 'recaptcha' as const, required: !hasToken };
      }

      // Check hCaptcha
      const hcaptchaWidget = document.querySelector('.h-captcha, iframe[src*="hcaptcha"]');
      if (hcaptchaWidget) {
        const hcaptchaInput = document.querySelector<HTMLInputElement | HTMLTextAreaElement>('[name="h-captcha-response"]');
        const hasToken = Boolean(hcaptchaInput && hcaptchaInput.value && hcaptchaInput.value.trim().length > 0);
        return { type: 'hcaptcha' as const, required: !hasToken };
      }

      return { type: 'none' as const, required: false };
    });
    const observedSitekey = observedPageTurnstileSitekey.get(page);
    const frameSitekey = extractTurnstileSitekeyFromFrames(page);
    if (detail.required && (detail.type === 'turnstile' || detail.type === 'cloudflare_interstitial')) {
      const resolvedSitekey = detail.sitekey || observedSitekey || frameSitekey;
      if (resolvedSitekey) {
        return { ...detail, sitekey: resolvedSitekey };
      }
    }
    return detail;
  } catch {
    return { type: 'none', required: false };
  }
}

/** Backwards-compatible read-only inspection. */
export async function verificationState(page: Page): Promise<'none' | 'required'> {
  const detail = await detectVerificationDetail(page);
  return detail.required ? 'required' : 'none';
}

/** A verified server identity is mandatory; a cookie or homepage redirect is insufficient. */
export async function signedInUser(page: Page, timeoutMs: number): Promise<string | null> {
  return page.evaluate(async timeout => {
    try {
      const csrf = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('csrftoken='))?.slice('csrftoken='.length);
      const response = await fetch('/graphql/', {
        method: 'POST', credentials: 'include', signal: AbortSignal.timeout(timeout),
        headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrftoken': csrf } : {}) },
        body: JSON.stringify({ query: 'query { userStatus { isSignedIn username } }', variables: {} }),
      });
      if (!response.ok) return null;
      const body = await response.json();
      const user = body?.data?.userStatus;
      return user?.isSignedIn === true && typeof user.username === 'string' && user.username.trim() ? user.username : null;
    } catch { return null; }
  }, Math.max(1, Math.min(timeoutMs, 8000))).catch(() => null);
}

/** Apply a solved Turnstile token across hidden inputs, globals, and widget callbacks. */
async function applyTurnstileTokenToPage(page: Page, token: string): Promise<void> {
  await page.evaluate((tok) => {
    const win = window as any;
    win.__turnstileToken = tok;
    if (win.turnstile && typeof win.turnstile === 'object') {
      win.turnstile.getResponse = () => tok;
      win.turnstile.isExpired = () => false;
    }
    const selector = '[name="cf-turnstile-response"], [name="turnstileToken"], input[id^="cf-chl-widget-"][id$="_response"]';
    let inputs = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(selector));
    if (inputs.length === 0) {
      const container = document.querySelector('form') || document.querySelector('.cf-turnstile, #cf-turnstile') || document.body;
      if (container) {
        const hidden = document.createElement('input');
        hidden.type = 'hidden';
        hidden.name = 'cf-turnstile-response';
        container.appendChild(hidden);
        inputs = [hidden];
      }
    }
    for (const input of inputs) {
      input.value = tok;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (typeof win.__turnstileCallback === 'function') {
      try {
        win.__turnstileCallback(tok);
      } catch {}
    }
    const widgetEl = document.querySelector('.cf-turnstile[data-callback], [data-callback]') as HTMLElement | null;
    const widgetCb = widgetEl?.getAttribute('data-callback');
    if (widgetCb) {
      const fn = widgetCb.split('.').reduce<unknown>((val, key) => (val && typeof val === 'object' ? (val as Record<string, unknown>)[key] : undefined), window);
      if (typeof fn === 'function') {
        try { (fn as (t: string) => void)(tok); } catch {}
      }
    }
  }, token).catch(() => undefined);
}

/** Exposed for local browser fixtures; all navigation remains in the caller's context. */
export async function loginOnLeetCodePage(page: Page, username: string, password: string,
  options: LeetCodeLoginOptions = {}): Promise<LeetCodeLoginResult> {
  const attemptId = randomUUID();
  const started = Date.now();
  const deadline = started + (options.timeoutMs ?? (options.proxyUrl ? 150_000 : 90_000));
  const remaining = () => {
    if (options.signal?.aborted) throw new LoginFailure('LOGIN_CANCELLED', 'Login cancelled.');
    if (Date.now() >= deadline) throw new LoginFailure('LOGIN_TIMEOUT', 'Login timed out before the session could be verified.');
    return Math.max(1, deadline - Date.now());
  };
  let stage: LoginState = 'LOGIN_PAGE_LOADING';
  let loginStatus: number | undefined;
  const capture = async (): Promise<StorageStateShape> => ({
    ...await page.context().storageState() as StorageStateShape,
    transport: { proxyUrl: options.proxyUrl, userAgent: await page.evaluate(() => navigator.userAgent).catch(() => DEFAULT_DESKTOP_CHROME_USER_AGENT) },
  });
  const responseListener = (response: Response) => {
    try {
      const rawUrl = response.url();
      const sitekeyMatch = TURNSTILE_URL_SITEKEY_RE.exec(rawUrl);
      if (sitekeyMatch?.[1]) {
        observedPageTurnstileSitekey.set(page, sitekeyMatch[1]);
      }
      const url = new URL(rawUrl);
      if (url.hostname !== 'leetcode.com' || !url.pathname.startsWith('/accounts/login') || response.request().method() !== 'POST') return;
      loginStatus = response.status();
      logger.info({ attemptId, stage: 'login_response', status: loginStatus, elapsedMs: Date.now() - started }, 'LeetCode login response');
    } catch {}
  };
  page.on('response', responseListener);
  const report = async (next: LoginState, message: string, status?: number) => {
    stage = next;
    logger.info({ attemptId, stage, elapsedMs: Date.now() - started, status }, 'LeetCode login progress');
    // A slow/broken notification must not extend the authentication deadline.
    void Promise.resolve().then(() => options.onProgress?.(message, next)).catch(() => undefined);
  };
  const outerAttemptSignal = getAttemptContext()?.signal;
  const combinedSignal = options.signal && outerAttemptSignal
    ? AbortSignal.any([options.signal, outerAttemptSignal])
    : (options.signal ?? outerAttemptSignal);
  try {
    return await withAttemptContext(
      attemptId,
      deadline,
      () => withCapzyRequestContext(async () => {
        await installTurnstileMetadataHook(page);
    await report('LOGIN_PAGE_LOADING', '🌐 Opening LeetCode login page…');
    const response = await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: remaining() });
    const status = response?.status();

    let detail = await detectVerificationDetail(page);
    if (status === 403 && !detail.required) {
      detail = { type: 'cloudflare_interstitial', required: true };
    }

    const hasCPSolver = Boolean(getCPSolverUrl());
    const hasMockedFetch = Boolean((globalThis.fetch as unknown as { mock?: unknown })?.mock);
    const rawCapzyKeys = await getCandidateCapzyKeys().catch(() => []);
    const capzyKeys = hasMockedFetch
      ? rawCapzyKeys
      : rawCapzyKeys.filter((key) => key !== 'test-capzy-key');
    const hasCapzy = capzyKeys.length > 0;
    const diagnostic: VerificationDiagnostic = {
      challengeType: detail.type,
      adapterInitialized: hasCPSolver || hasCapzy || Boolean(options.solver),
      providerRequestAccepted: false,
      providerOperationCompleted: false,
      verificationCompleted: !detail.required,
      userAuthenticated: false,
      sessionValidated: false,
      sessionPersisted: false,
      selectedAdapter: options.solver ? 'capzy' : (hasCPSolver ? 'cpsolver' : (hasCapzy ? 'capzy' : 'none')),
      solverAttempted: false,
      manualVerificationRequired: false,
      continuationStatus: 'not_needed',
    };

    const attemptSolverVerification = async (
      challengeDetail: VerificationDetail,
      httpStatus?: number,
    ): Promise<void> => {
      diagnostic.challengeType = challengeDetail.type;
      diagnostic.verificationCompleted = false;
      await report('VERIFICATION_REQUIRED', '🛡️ Verification challenge detected on LeetCode…', httpStatus);

      if (challengeDetail.type === 'recaptcha' || challengeDetail.type === 'hcaptcha' || challengeDetail.type === 'unsupported') {
        diagnostic.solverAttempted = false;
        diagnostic.solverResult = 'unsupported_challenge';
        diagnostic.manualVerificationRequired = true;
        diagnostic.continuationStatus = 'awaiting_user';
        await report('AWAITING_USER_VERIFICATION', `⚠️ Unsupported verification challenge (${challengeDetail.type}). Manual verification required.`);
        throw new LoginFailure('VERIFICATION_REQUIRED', `Unsupported challenge type (${challengeDetail.type}) on LeetCode. Complete verification in your browser and use /renew.`, diagnostic, 'AWAITING_USER_VERIFICATION');
      }

      if (!diagnostic.adapterInitialized) {
        diagnostic.solverResult = 'no_adapter_configured';
        diagnostic.manualVerificationRequired = true;
        diagnostic.continuationStatus = 'awaiting_user';
        await report('AWAITING_USER_VERIFICATION', '⚠️ No solver adapter configured. Manual verification required.');
        throw new LoginFailure('VERIFICATION_REQUIRED', VERIFICATION_MESSAGE, diagnostic, 'AWAITING_USER_VERIFICATION');
      }

      await report('VERIFICATION_IN_PROGRESS', `🧩 Attempting authorized solver orchestration (${diagnostic.selectedAdapter?.toUpperCase()})...`);
      logger.info({ attemptId, challengeType: challengeDetail.type, hasSitekey: Boolean(challengeDetail.sitekey), adapter: diagnostic.selectedAdapter }, '[VERIFY] Capzy adapter selected');
      diagnostic.solverAttempted = true;
      let solved: SolverResult | null = null;
      try {
        const cleanWebsiteUrl = sanitizeChallengeUrl(page.url() || LOGIN_URL);
        if (options.solver) {
          solved = await options.solver({
            websiteURL: cleanWebsiteUrl,
            sitekey: challengeDetail.sitekey,
            action: challengeDetail.action,
            cdata: challengeDetail.cdata,
            proxyUrl: options.proxyUrl,
            userAgent: await page.evaluate(() => navigator.userAgent).catch(() => DEFAULT_DESKTOP_CHROME_USER_AGENT),
            timeoutMs: Math.min(75_000, remaining()),
          });
          diagnostic.providerRequestAccepted = solved !== null;
          diagnostic.providerOperationCompleted = solved !== null;
          diagnostic.taskLifecycleState = solved ? 'ready' : 'failed';
        } else if (challengeDetail.type === 'turnstile') {
          solved = await solveTurnstileOrchestrated({
            siteurl: cleanWebsiteUrl,
            sitekey: challengeDetail.sitekey ?? '',
            action: challengeDetail.action,
            cdata: challengeDetail.cdata,
            proxyUrl: options.proxyUrl,
            userAgent: await page.evaluate(() => navigator.userAgent).catch(() => DEFAULT_DESKTOP_CHROME_USER_AGENT),
            cookies: await page.context().cookies('https://leetcode.com').catch(() => []),
            timeoutMs: Math.min(75_000, remaining()),
          });
          const capzyDiag = getLastCapzyDiagnostic();
          diagnostic.providerRequestAccepted = capzyDiag.requestAccepted || (solved !== null);
          diagnostic.providerOperationCompleted = capzyDiag.operationCompleted || (solved !== null);
          diagnostic.providerHttpStatus = capzyDiag.providerHttpStatus;
          diagnostic.providerErrorCode = capzyDiag.providerErrorCode;
          diagnostic.providerErrorCategory = capzyDiag.providerErrorCategory || capzyDiag.providerErrorCode;
          diagnostic.taskLifecycleState = capzyDiag.taskLifecycleState;
          diagnostic.elapsedTimeMs = capzyDiag.elapsedTimeMs;
          diagnostic.timeoutReason = capzyDiag.timeoutReason;
          if (!diagnostic.solverError) {
            diagnostic.solverError = capzyDiag.providerErrorDescription || getLastCapzyError() || undefined;
          }
        } else {
          solved = await solveCloudflareOrchestrated({
            websiteURL: cleanWebsiteUrl,
            sitekey: challengeDetail.sitekey,
            action: challengeDetail.action,
            cdata: challengeDetail.cdata,
            proxyUrl: options.proxyUrl,
            userAgent: await page.evaluate(() => navigator.userAgent).catch(() => DEFAULT_DESKTOP_CHROME_USER_AGENT),
            cookies: await page.context().cookies('https://leetcode.com').catch(() => []),
            timeoutMs: Math.min(75_000, remaining()),
          });
          const capzyDiag = getLastCapzyDiagnostic();
          diagnostic.providerRequestAccepted = capzyDiag.requestAccepted || (solved !== null);
          diagnostic.providerOperationCompleted = capzyDiag.operationCompleted || (solved !== null);
          diagnostic.providerHttpStatus = capzyDiag.providerHttpStatus;
          diagnostic.providerErrorCode = capzyDiag.providerErrorCode;
          diagnostic.providerErrorCategory = capzyDiag.providerErrorCategory || capzyDiag.providerErrorCode;
          diagnostic.taskLifecycleState = capzyDiag.taskLifecycleState;
          diagnostic.elapsedTimeMs = capzyDiag.elapsedTimeMs;
          diagnostic.timeoutReason = capzyDiag.timeoutReason;
          if (!diagnostic.solverError) {
            diagnostic.solverError = capzyDiag.providerErrorDescription || getLastCapzyError() || undefined;
          }
        }
      } catch (err) {
        if (options.signal?.aborted) {
          throw new LoginFailure('LOGIN_CANCELLED', 'Login cancelled.', diagnostic, 'LOGIN_FAILED');
        }
        if (err instanceof AttemptCancelledError && err.reason === 'deadline') {
          throw new LoginFailure('LOGIN_TIMEOUT', 'Login timed out before the session could be verified.', diagnostic, 'LOGIN_FAILED');
        }
        diagnostic.solverError = err instanceof Error ? err.message : String(err);
      }

      if (solved && (solved.token || solved.cookies || solved.cfClearance)) {
        logger.info({ attemptId, hasToken: Boolean(solved.token), hasCookies: Boolean(solved.cookies), hasClearance: Boolean(solved.cfClearance) }, '[VERIFY] Solution validated and applied to page');
        if (solved.cookies) {
          const cookiesToAdd = Object.entries(solved.cookies).map(([name, value]) => ({
            name,
            value,
            domain: '.leetcode.com',
            path: '/',
          }));
          await page.context().addCookies(cookiesToAdd).catch(() => undefined);
        }
        if (solved.cfClearance) {
          await page.context().addCookies([{
            name: 'cf_clearance',
            value: solved.cfClearance,
            domain: '.leetcode.com',
            path: '/',
          }]).catch(() => undefined);
        }
        if (solved.token) {
          await applyTurnstileTokenToPage(page, solved.token);
        }

        if (challengeDetail.type === 'cloudflare_interstitial') {
          await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: remaining() }).catch(() => undefined);
        }

        const postCheck = await detectVerificationDetail(page);
        const interstitialClearedToForm =
          challengeDetail.type === 'cloudflare_interstitial' && postCheck.type === 'turnstile';
        if (!postCheck.required || interstitialClearedToForm) {
          diagnostic.verificationCompleted = true;
          diagnostic.solverResult = 'success';
          diagnostic.continuationStatus = 'resumed';
          logger.info({ attemptId }, '[VERIFY] Website verification accepted');
          await report(
            'VERIFICATION_COMPLETED',
            '✅ Verification challenge cleared. Resuming authentication… (Website Verification: Accepted | Authentication: In Progress | Session Validation: Pending | Persistence: Pending)',
          );
        } else {
          diagnostic.verificationCompleted = false;
          diagnostic.solverResult = 'failed';
          diagnostic.manualVerificationRequired = true;
          diagnostic.continuationStatus = 'awaiting_user';
          await report('AWAITING_USER_VERIFICATION', '⚠️ Challenge persists after solver attempt. Manual verification required.');
          throw new LoginFailure('VERIFICATION_REQUIRED', VERIFICATION_MESSAGE, diagnostic, 'AWAITING_USER_VERIFICATION');
        }
      } else {
        diagnostic.verificationCompleted = false;
        diagnostic.solverResult = diagnostic.taskLifecycleState === 'timeout' ? 'timeout' : 'failed';
        diagnostic.manualVerificationRequired = true;
        diagnostic.continuationStatus = 'awaiting_user';
        await report('AWAITING_USER_VERIFICATION', '⚠️ Solver unable to resolve challenge. Manual verification required.');
        throw new LoginFailure('VERIFICATION_REQUIRED', VERIFICATION_MESSAGE, diagnostic, 'AWAITING_USER_VERIFICATION');
      }
    };

    if (detail.required) {
      await attemptSolverVerification(detail, status);
    }

    if (status && status >= 400 && status !== 403) throw new LoginFailure('LOGIN_PAGE_HTTP_ERROR', `LeetCode login page returned HTTP ${status}.`);
    const usernameInput = page.locator(USERNAME).first();
    try { await usernameInput.waitFor({ state: 'visible', timeout: Math.min(options.proxyUrl ? 25_000 : 15_000, remaining()) }); }
    catch {
      const verified = await signedInUser(page, remaining());
      if (verified) {
        diagnostic.userAuthenticated = true;
        diagnostic.sessionValidated = true;
        diagnostic.sessionPersisted = false;
        return { ok: true, username: verified, storageState: await capture(), state: 'AUTHENTICATED', diagnostic };
      }
      const lateDetail = await detectVerificationDetail(page);
      if (lateDetail.required) {
        await attemptSolverVerification(lateDetail, status);
        try {
          await usernameInput.waitFor({ state: 'visible', timeout: Math.min(15_000, remaining()) });
        } catch {
          throw new LoginFailure('LOGIN_FORM_UNAVAILABLE', 'LeetCode login form is unavailable. Use /renew after signing in in your browser.', diagnostic, 'LOGIN_FAILED');
        }
      } else {
        throw new LoginFailure('LOGIN_FORM_UNAVAILABLE', 'LeetCode login form is unavailable. Use /renew after signing in in your browser.', diagnostic, 'LOGIN_FAILED');
      }
    }
    const form = page.locator('form').filter({ has: usernameInput }).first();
    const hasForm = await form.count() > 0;
    const scope = hasForm ? form : page.locator('body');
    const formSubmitSelector = 'button#signin_btn, button[data-cy="sign-in-btn"], button[type="submit"], button:has-text("Sign In"), button:has-text("Log In"), input[type="submit"]';
    const pageSubmitSelector = 'button#signin_btn, button[data-cy="sign-in-btn"], button:has-text("Sign In"), button:has-text("Log In"), input[type="submit"][value="Sign In"]';
    const inFormSubmitCount = hasForm ? await form.locator(formSubmitSelector).count() : 0;
    const submit = (inFormSubmitCount > 0 ? form.locator(formSubmitSelector) : page.locator(pageSubmitSelector)).first();

    await report('AUTHENTICATING', '📝 Filling login form…');
    await usernameInput.fill(username, { timeout: remaining() });
    await scope.locator(PASSWORD).first().fill(password, { timeout: remaining() });
    const formChallengeDetail = await detectVerificationDetail(page);
    if (formChallengeDetail.required) {
      await attemptSolverVerification(formChallengeDetail, status);
    }
    await submit.waitFor({ state: 'visible', timeout: remaining() });
    if (!await submit.isEnabled()) {
      const storedToken = await page
        .evaluate(() => (typeof (window as any).__turnstileToken === 'string' ? (window as any).__turnstileToken : null))
        .catch(() => null);
      if (storedToken) {
        await applyTurnstileTokenToPage(page, storedToken);
      }
    }
    if (!await submit.isEnabled()) {
      const hasDeferredTurnstile = await page.evaluate(() => Boolean(
        document.querySelector(
          '#cf-turnstile, #cf-turnstile-script, script[src*="challenges.cloudflare.com/turnstile"], [data-sitekey], input[id^="cf-chl-widget-"][id$="_response"], [name="cf-turnstile-response"], iframe[src*="challenges.cloudflare.com"]',
        ) || (window as any).turnstile,
      )).catch(() => false);
      if (hasDeferredTurnstile) {
        const waitUntil = Date.now() + Math.min(15_000, remaining());
        while (Date.now() < waitUntil && !await submit.isEnabled()) {
          if (options.signal?.aborted) throw new LoginFailure('LOGIN_CANCELLED', 'Login cancelled.');
          const deferredDetail = await detectVerificationDetail(page);
          if (deferredDetail.required) {
            await attemptSolverVerification(deferredDetail, status);
            break;
          }
          await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(1, waitUntil - Date.now()))));
        }
        const enableWaitUntil = Date.now() + Math.min(2_000, remaining());
        while (Date.now() < enableWaitUntil && !await submit.isEnabled()) {
          if (options.signal?.aborted) throw new LoginFailure('LOGIN_CANCELLED', 'Login cancelled.');
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!await submit.isEnabled() && diagnostic.solverAttempted && diagnostic.verificationCompleted) {
          await submit.evaluate((el) => {
            el.removeAttribute('disabled');
            if ('disabled' in el) (el as HTMLButtonElement).disabled = false;
          }).catch(() => undefined);
        }
      }
      if (!await submit.isEnabled()) throw new LoginFailure('LOGIN_FORM_NOT_READY', 'The login button is disabled. Complete the form or verification in your browser and use /renew.', diagnostic, 'LOGIN_FAILED');
    }

    const retryPostSubmit = async (postSubmitDetail: VerificationDetail, codeStatus?: number): Promise<void> => {
      await attemptSolverVerification(postSubmitDetail, codeStatus);
      loginStatus = undefined;
      if (postSubmitDetail.type === 'cloudflare_interstitial') {
        await usernameInput.waitFor({ state: 'visible', timeout: Math.min(15_000, remaining()) });
        await usernameInput.fill(username, { timeout: remaining() });
        await scope.locator(PASSWORD).first().fill(password, { timeout: remaining() });
        const postRefillDetail = await detectVerificationDetail(page);
        if (postRefillDetail.required) {
          await attemptSolverVerification(postRefillDetail, codeStatus);
        }
      }
      await submit.click({ timeout: remaining() });
    };

    await report('AUTHENTICATING', '📤 Submitting login once…');
    logger.info({ attemptId }, '[AUTH] Credentials submitted');
    await submit.click({ timeout: remaining() });
    await report('AUTHENTICATING', '⏳ Verifying authenticated identity…');
    while (remaining() > 0) {
      if (page.isClosed()) throw new LoginFailure('LOGIN_BROWSER_CLOSED', 'The login browser closed before authentication was verified.', diagnostic, 'LOGIN_FAILED');
      if (loginStatus === 400 || loginStatus === 401) throw new LoginFailure('LOGIN_REJECTED', 'LeetCode rejected the sign-in. Check credentials or complete account verification in your browser.', diagnostic, 'LOGIN_FAILED');
      if (loginStatus === 403) {
        if (!diagnostic.solverAttempted && diagnostic.adapterInitialized) {
          const postSubmitDetail = await detectVerificationDetail(page);
          await retryPostSubmit(postSubmitDetail.required ? postSubmitDetail : { type: 'cloudflare_interstitial', required: true }, loginStatus);
          continue;
        }
        throw new LoginFailure('VERIFICATION_REQUIRED', VERIFICATION_MESSAGE, diagnostic, 'AWAITING_USER_VERIFICATION');
      }
      if (loginStatus === 429) throw new LoginFailure('LOGIN_RATE_LIMITED', 'LeetCode has rate limited sign-in. Wait before retrying.', diagnostic, 'LOGIN_FAILED');
      if (loginStatus && loginStatus >= 500) throw new LoginFailure('LOGIN_SERVICE_ERROR', `LeetCode sign-in returned HTTP ${loginStatus}. Retry later.`, diagnostic, 'LOGIN_FAILED');
      if (await verificationState(page).catch(() => 'none') === 'required') {
        if (!diagnostic.solverAttempted && diagnostic.adapterInitialized) {
          const postSubmitDetail = await detectVerificationDetail(page);
          if (postSubmitDetail.required) {
            await retryPostSubmit(postSubmitDetail, loginStatus);
            continue;
          }
        }
        throw new LoginFailure('VERIFICATION_REQUIRED', VERIFICATION_MESSAGE, diagnostic, 'AWAITING_USER_VERIFICATION');
      }
      const verified = await signedInUser(page, remaining());
      if (verified) {
        logger.info({ attemptId }, '[AUTH] Authentication response received');
        const storageState = await capture();
        logger.info({ attemptId, cookieCount: storageState.cookies?.length ?? 0 }, '[SESSION] Session cookies captured');
        logger.info({ attemptId, username: verified }, '[GRAPHQL] Identity query succeeded');
        await report('AUTHENTICATED', '✅ Authenticated identity verified.');
        await report('SESSION_VALIDATED', '✅ Session validated via GraphQL userStatus.');
        diagnostic.userAuthenticated = true;
        diagnostic.sessionValidated = true;
        diagnostic.sessionPersisted = false;
        return { ok: true, username: verified, storageState, state: 'AUTHENTICATED', diagnostic };
      }
      const errorVisible = await page.locator('.error-message, .errorlist, [role="alert"], p.text-red-500, div.text-red-500').first().isVisible().catch(() => false);
      if (errorVisible) throw new LoginFailure('LOGIN_REJECTED', 'LeetCode rejected the sign-in. Check credentials or complete any account verification in your browser.', diagnostic, 'LOGIN_FAILED');
      await new Promise(resolve => setTimeout(resolve, Math.min(250, remaining())));
    }
    throw new LoginFailure('LOGIN_TIMEOUT', 'Authentication could not be verified.', diagnostic, 'LOGIN_FAILED');
      }, attemptId),
      combinedSignal,
    );
  } catch (error) {
    const failure = options.signal?.aborted
      ? new LoginFailure('LOGIN_CANCELLED', 'Login cancelled.', undefined, 'LOGIN_FAILED')
      : error instanceof LoginFailure
        ? error
        : Date.now() >= deadline
          ? new LoginFailure('LOGIN_TIMEOUT', 'Login timed out before the session could be verified.', undefined, 'LOGIN_FAILED')
          : new LoginFailure('LOGIN_BROWSER_ERROR', 'Login browser or navigation failed. Use /renew after signing in in your browser.', undefined, 'LOGIN_FAILED');
    logger.warn({ attemptId, state: failure.state, code: failure.code, elapsedMs: Date.now() - started }, 'LeetCode login failed');
    return {
      ok: false,
      code: failure.code,
      error: failure.message,
      state: failure.state,
      diagnostic: failure.diagnostic,
    };
  } finally {
    page.off('response', responseListener);
  }
}

/** Ordinary sign-in in an isolated browser, bounded by one total deadline. */
export async function loginToLeetCode(loginInput: string, password: string,
  options: LeetCodeLoginOptions = {}): Promise<LeetCodeLoginResult> {
  if (!loginInput.trim() || !password) return { ok: false, code: 'CREDENTIALS_REQUIRED', error: 'Username/email and password are required.', state: 'LOGIN_FAILED' };
  const hasRemoteSolver = !options.proxyUrl && !options.disableRemoteLogin && !options.solver && Boolean(getCPSolverUrl());
  const timeoutMs = options.timeoutMs ?? (options.proxyUrl ? 150_000 : (hasRemoteSolver ? 140_000 : 90_000));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { ok: false, code: 'INVALID_TIMEOUT', error: 'Login timeout must be a positive number.', state: 'LOGIN_FAILED' };
  if (options.signal?.aborted) return { ok: false, code: 'LOGIN_CANCELLED', error: 'Login cancelled.', state: 'LOGIN_FAILED' };
  const initialProxy = options.proxyUrl ? toPlaywrightProxy(options.proxyUrl) : undefined;
  if (options.proxyUrl && !initialProxy) return { ok: false, code: 'LOGIN_PROXY_INVALID', error: 'Invalid login proxy configuration; direct fallback disabled.', state: 'LOGIN_FAILED' };
  const deadline = Date.now() + timeoutMs;

  if (hasRemoteSolver) {
    await options.onProgress?.('🌐 Signing in via remote solver browser (single-IP session)…', 'LOGIN_PAGE_LOADING');
    if (options.signal?.aborted) {
      return { ok: false, code: 'LOGIN_CANCELLED', error: 'Login cancelled.', state: 'LOGIN_FAILED' };
    }

    const remoteBudgetMs = Math.max(15_000, Math.min(90_000, deadline - Date.now()));
    const remoteRes = await loginLeetCodeWithCPSolver({
      username: loginInput.trim(),
      password,
      timeoutMs: remoteBudgetMs,
      signal: options.signal,
    });

    if (remoteRes.ok && remoteRes.storageState && remoteRes.username) {
      const normalizedCookies: StorageCookie[] = remoteRes.storageState.cookies.map((c) => ({
        name: String(c.name ?? ''),
        value: String(c.value ?? ''),
        domain: String(c.domain || '.leetcode.com'),
        path: String(c.path || '/'),
        expires: typeof c.expires === 'number' && Number.isFinite(c.expires) ? c.expires : -1,
        httpOnly: Boolean(c.httpOnly),
        secure: Boolean(c.secure),
        sameSite: c.sameSite === 'Strict' || c.sameSite === 'None' ? c.sameSite : 'Lax',
      }));
      await options.onProgress?.('✅ Remote single-IP browser login succeeded.', 'AUTHENTICATED');
      return {
        ok: true,
        username: remoteRes.username,
        storageState: {
          cookies: normalizedCookies,
          origins: remoteRes.storageState.origins ?? [],
        },
        state: 'AUTHENTICATED',
      };
    }

    if (options.signal?.aborted || remoteRes.code === 'LOGIN_CANCELLED') {
      return { ok: false, code: 'LOGIN_CANCELLED', error: 'Login cancelled.', state: 'LOGIN_FAILED' };
    }

    if (remoteRes.code === 'LOGIN_REJECTED' || remoteRes.code === 'LOGIN_RATE_LIMITED') {
      return {
        ok: false,
        code: remoteRes.code,
        error: remoteRes.error || 'LeetCode rejected the sign-in.',
        state: 'LOGIN_FAILED',
      };
    }

    logger.warn(
      {
        available: remoteRes.available,
        statusCode: remoteRes.statusCode,
        code: remoteRes.code,
        error: remoteRes.error,
        remainingMs: Math.max(0, deadline - Date.now()),
      },
      'Remote CPSolver /leetcode-login did not complete; falling back to local browser login',
    );
  }

  const runSingleBrowserLogin = async (proxyUrlToUse?: string): Promise<LeetCodeLoginResult> => {
    let browser: Browser | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const close = () => { void browser?.close().catch(() => undefined); };
    options.signal?.addEventListener('abort', close, { once: true });
    try {
      const proxy = proxyUrlToUse ? toPlaywrightProxy(proxyUrlToUse) : undefined;
      browser = await chromium.launch({
        headless: config.browser.headless,
        timeout: Math.max(1, deadline - Date.now()),
        args: buildLaunchArgs(config.browser.headless),
        proxy,
      });
      if (options.signal?.aborted) return { ok: false, code: 'LOGIN_CANCELLED', error: 'Login cancelled.', state: 'LOGIN_FAILED' };
      if (Date.now() >= deadline) return { ok: false, code: 'LOGIN_TIMEOUT', error: 'Login timed out while launching the browser.', state: 'LOGIN_FAILED' };
      timer = setTimeout(close, Math.max(1, deadline - Date.now()));
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        locale: 'en-US',
        userAgent: DEFAULT_DESKTOP_CHROME_USER_AGENT,
      });
      await applyStealthScripts(context, 'chromium');
      const page = await context.newPage();
      return await loginOnLeetCodePage(page, loginInput.trim(), password, {
        ...options,
        proxyUrl: proxyUrlToUse,
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
    } catch {
      return {
        ok: false,
        code: options.signal?.aborted ? 'LOGIN_CANCELLED' : 'LOGIN_BROWSER_ERROR',
        error: options.signal?.aborted ? 'Login cancelled.' : 'Could not initialize the login browser. Check the browser installation and server resources.',
        state: 'LOGIN_FAILED',
      };
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', close);
      await browser?.close().catch(() => undefined);
    }
  };

  const firstResult = await runSingleBrowserLogin(options.proxyUrl);
  if (
    options.proxyUrl &&
    firstResult.code === 'LOGIN_BROWSER_ERROR' &&
    process.env.LEETCODE_DISABLE_DIRECT_FALLBACK !== 'true' &&
    !options.signal?.aborted &&
    deadline - Date.now() > 15_000
  ) {
    logger.warn({ remainingMs: deadline - Date.now() }, 'Proxy LeetCode login failed with browser/navigation error; retrying direct without proxy');
    return await runSingleBrowserLogin(undefined);
  }
  return firstResult;
}
