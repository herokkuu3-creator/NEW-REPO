import {
  getCandidateCapzyKeys,
  rotateToNextCapzyKey,
  isCapzyKeyError,
  maskApiKey,
} from './capzyKeyManager';
import { attemptFetch as fetch, attemptSleep, getAttemptContext, throwIfAttemptAborted } from './attemptContext';
import { diagnosticLog } from './diagnosticLog';

function log(fields: Record<string, unknown>, msg: string): void {
  diagnosticLog('captcha-solver', 30, fields, msg);
}

function logWarn(fields: Record<string, unknown>, msg: string): void {
  diagnosticLog('captcha-solver', 40, fields, msg);
}

export interface SolverResult {
  token?: string;
  cookies?: Record<string, string>;
  cfClearance?: string;
  source?: 'cpsolver' | 'capsolver';
  durationMs?: number;
}

export const DEFAULT_DESKTOP_CHROME_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const DEFAULT_DESKTOP_FIREFOX_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0';

export const DEFAULT_DESKTOP_USER_AGENT = DEFAULT_DESKTOP_CHROME_USER_AGENT;

export function getDefaultUserAgent(engine: 'chromium' | 'firefox' = 'chromium'): string {
  return engine === 'firefox' ? DEFAULT_DESKTOP_FIREFOX_USER_AGENT : DEFAULT_DESKTOP_CHROME_USER_AGENT;
}

export const CLOUDFLARE_UNIVERSAL_SITEKEY = '0x4AAAAAAADnPIDROrmt1Wwj';
export const LEETCODE_TURNSTILE_SITEKEY = CLOUDFLARE_UNIVERSAL_SITEKEY;

let lastCapzyError: string | null = null;

export function getLastCapzyError(): string | null {
  return lastCapzyError;
}

export function setLastCapzyError(err: string | null): void {
  lastCapzyError = err;
}

let inMemoryCPSolverUrl = '';
let inMemoryTelegramBotToken = '';
let inMemoryTelegramChatId = '';

/**
 * Configure solver overrides in memory (useful when called from isolated worker or tests).
 */
export function initCPSolverConfig(options: {
  url?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
}): void {
  if (options.url) inMemoryCPSolverUrl = options.url.trim().replace(/\/+$/, '');
  if (options.telegramBotToken) inMemoryTelegramBotToken = options.telegramBotToken.trim();
  if (options.telegramChatId) inMemoryTelegramChatId = options.telegramChatId.trim();
}

/**
 * Resolves the configured CPSolver microservice URL.
 * Checks CPSOLVER_URL, then TURNSTILE_SOLVER_URL, then in-memory configuration.
 */
export function getCPSolverUrl(): string {
  const raw =
    process.env.CPSOLVER_URL?.trim() ||
    process.env.TURNSTILE_SOLVER_URL?.trim() ||
    inMemoryCPSolverUrl;
  return raw ? raw.replace(/\/+$/, '') : '';
}

/**
 * Non-blocking, zero-overhead Telegram notification sender.
 * Works across both the main backend (with Prisma/config) and the isolated submitter.
 */
export async function sendSolverTelegramNotification(text: string): Promise<boolean> {
  const token =
    process.env.TELEGRAM_BOT_TOKEN?.trim() ||
    inMemoryTelegramBotToken;
  const chatId =
    process.env.TELEGRAM_CHAT_ID?.trim() ||
    inMemoryTelegramChatId;

  // 1. Direct Telegram API call (zero dependencies, works in isolated container)
  if (token && chatId) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(8_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // 2. Fall back to main telegram module if available in main app
  if (process.env.DATABASE_URL) {
    try {
      const { sendTelegramMessage } = await import('../notifications/telegram');
      return await sendTelegramMessage(text, { parseMode: 'HTML' });
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Query health and proxy status of the CPSolver microservice.
 */
export async function checkCPSolverHealth(): Promise<{
  ok: boolean;
  url: string;
  status?: string;
  uptimeSeconds?: number;
  totalProxies?: number;
  activeIndex?: number;
  activeProxy?: string | null;
  error?: string;
}> {
  const url = getCPSolverUrl();
  if (!url) return { ok: false, url: '', error: 'CPSolver URL is not configured' };

  try {
    const res = await fetch(`${url}/health`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      return { ok: false, url, error: `HTTP ${res.status}: ${res.statusText}` };
    }
    const data = (await res.json()) as any;
    return {
      ok: true,
      url,
      status: data.status || 'ok',
      uptimeSeconds: data.uptimeSeconds,
      totalProxies: data.proxyPool?.total ?? 0,
      activeIndex: data.proxyPool?.activeIndex ?? 0,
      activeProxy: data.proxyPool?.activeProxy ?? null,
    };
  } catch (err) {
    return {
      ok: false,
      url,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Executes a single Turnstile solve request against the CPSolver microservice.
 */
export async function solveTurnstileWithCPSolver(params: {
  siteurl: string;
  sitekey: string;
  action?: string;
  cdata?: string;
  proxy?: string;
  userAgent?: string;
  timeoutMs?: number;
  mode?: 'harness' | 'navigate';
  cookies?: Array<{ name: string; value: string; domain?: string; path?: string }> | Record<string, string>;
}): Promise<{
  ok: boolean;
  token?: string;
  cookies?: Record<string, string>;
  cfClearance?: string;
  durationMs: number;
  error?: string;
  proxyUsed?: string;
  verificationRequired?: boolean;
}> {
  const solverUrl = getCPSolverUrl();
  if (!solverUrl) {
    return { ok: false, durationMs: 0, error: 'CPSolver URL is not configured' };
  }

  const startTime = Date.now();
  const timeout = params.timeoutMs ?? 90_000;

  try {
    const response = await fetch(`${solverUrl}/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(getAttemptContext() ? { 'x-request-id': getAttemptContext()!.requestId } : {}) },
      body: JSON.stringify({
        siteurl: params.siteurl,
        sitekey: params.sitekey,
        action: params.action,
        cdata: params.cdata,
        proxy: params.proxy,
        timeout,
        mode: params.mode ?? (params.sitekey === '0x4AAAAAAADnPIDROrmt1Wwj' ? 'navigate' : (params.sitekey ? 'harness' : 'navigate')),
        userAgent: params.userAgent,
        cookies: params.cookies,
      }),
      signal: AbortSignal.timeout(timeout + 15_000),
    });

    const durationMs = Date.now() - startTime;
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      // A completed widget attempt with no token requires user verification;
      // it is not a transport failure to retry against another provider.
      let verificationRequired = false;
      try {
        const failure = JSON.parse(errText) as { ok?: boolean; error?: unknown };
        verificationRequired = response.status === 408 && failure.ok === false &&
          typeof failure.error === 'string' &&
          /^Turnstile challenge timed out after \d+ms without token\.?$/.test(failure.error);
      } catch { /* Non-JSON transport errors keep their existing classification. */ }
      return {
        ok: false,
        durationMs,
        verificationRequired,
        error: `CPSolver HTTP ${response.status}: ${errText.slice(0, 200)}`,
      };
    }

    const data = (await response.json()) as {
      ok?: boolean;
      token?: string;
      cookies?: Record<string, string>;
      cfClearance?: string;
      durationMs?: number;
      error?: string;
      proxyUsed?: string;
    };

    const hasToken = typeof data.token === 'string' && data.token.trim().length > 10;
    const hasClearance = typeof data.cfClearance === 'string' && data.cfClearance.trim().length > 0;
    const hasCookies = !!(data.cookies && Object.keys(data.cookies).some((k) => k.toLowerCase().startsWith('cf_')));

    // Interstitial challenge key (0x4AAAAAAADnPIDROrmt1Wwj) succeeds via clearance cookies.
    // Form widget keys (e.g. 0x4AAAAAACDz1ltMYNJCAQZS) strictly require a real Turnstile token.
    const isInterstitialKey = params.sitekey === '0x4AAAAAAADnPIDROrmt1Wwj';
    const isSuccess = data.ok !== false && (hasToken || (isInterstitialKey ? (hasClearance || hasCookies) : false));

    if (isSuccess) {
      return {
        ok: true,
        token: data.token,
        cookies: data.cookies,
        cfClearance: data.cfClearance,
        durationMs: data.durationMs ?? durationMs,
        proxyUsed: data.proxyUsed,
      };
    }

    return {
      ok: false,
      durationMs: data.durationMs ?? durationMs,
      error: data.error || (data.ok ? 'CPSolver completed without issuing a Turnstile token or clearance' : 'CPSolver failed to solve Turnstile'),
      proxyUsed: data.proxyUsed,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    return {
      ok: false,
      durationMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Executes a Cloudflare interstitial / clearance solve against the CPSolver microservice.
 */
export async function solveCloudflareWithCPSolver(params: {
  siteurl: string;
  proxy?: string;
  userAgent?: string;
  timeoutMs?: number;
  cookies?: Array<{ name: string; value: string; domain?: string; path?: string }> | Record<string, string>;
}): Promise<{
  ok: boolean;
  token?: string;
  cookies?: Record<string, string>;
  cfClearance?: string;
  durationMs: number;
  error?: string;
  proxyUsed?: string;
}> {
  const solverUrl = getCPSolverUrl();
  if (!solverUrl) {
    return { ok: false, durationMs: 0, error: 'CPSolver URL is not configured' };
  }

  const startTime = Date.now();
  const timeout = params.timeoutMs ?? 65_000;

  try {
    const response = await fetch(`${solverUrl}/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(getAttemptContext() ? { 'x-request-id': getAttemptContext()!.requestId } : {}) },
      body: JSON.stringify({
        siteurl: params.siteurl,
        proxy: params.proxy,
        timeout,
        mode: 'navigate',
        userAgent: params.userAgent,
        cookies: params.cookies,
      }),
      signal: AbortSignal.timeout(timeout + 5_000),
    });

    const durationMs = Date.now() - startTime;
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return {
        ok: false,
        durationMs,
        error: `CPSolver HTTP ${response.status}: ${errText.slice(0, 200)}`,
      };
    }

    const data = (await response.json()) as {
      ok?: boolean;
      token?: string;
      cookies?: Record<string, string>;
      cfClearance?: string;
      durationMs?: number;
      error?: string;
      proxyUsed?: string;
    };

    const hasToken = typeof data.token === 'string' && data.token.trim().length > 0;
    const hasClearance = typeof data.cfClearance === 'string' && data.cfClearance.trim().length > 0;
    const hasCookies = !!(data.cookies && Object.keys(data.cookies).length > 0);
    const isSuccess = data.ok === true || (data.ok !== false && (hasToken || hasClearance || hasCookies));

    if (isSuccess && (hasToken || hasClearance || hasCookies)) {
      return {
        ok: true,
        token: data.token,
        cookies: data.cookies,
        cfClearance: data.cfClearance,
        durationMs: data.durationMs ?? durationMs,
        proxyUsed: data.proxyUsed,
      };
    }

    return {
      ok: false,
      durationMs: data.durationMs ?? durationMs,
      error: data.error || 'CPSolver returned ok=false without clearance',
      proxyUsed: data.proxyUsed,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    return {
      ok: false,
      durationMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Solve Turnstile with Capzy / CapSolver API (commercial fallback).
 */
export async function solveTurnstileWithCapzy(
  websiteURL: string,
  sitekey: string,
  proxyUrl?: string,
  userAgent?: string,
  timeoutMs = 35_000,
  action?: string,
  cdata?: string,
  overrideKeys?: string[],
): Promise<SolverResult | null> {
  // Avoid network calls for synthetic test keys
  if (sitekey === 'fixture-key' || sitekey === 'test-key') return null;

  const candidateKeys = await getCandidateCapzyKeys(overrideKeys);
  if (candidateKeys.length === 0) {
    setLastCapzyError('No Capzy/CapSolver API keys configured');
    logWarn({}, 'Capzy solver skipped: no Capzy/CapSolver API keys configured');
    return null;
  }

  const proxy =
    proxyUrl ||
    (websiteURL.includes('codeforces.com') ? process.env.CODEFORCES_PROXY?.trim() : undefined) ||
    undefined;
  const ua = userAgent || DEFAULT_DESKTOP_CHROME_USER_AGENT;

  // Retain the full target URL (stripping only hash) so Capzy loads the exact page hosting the widget
  const targetUrl = websiteURL.split('#')[0];

  const isRefusingProxy = !!proxy && (proxy.includes('joyproxy.com') || proxy.includes('busyip.com'));

  // Attempt 1: AntiTurnstileTask with residential proxy
  let proxyTask: Record<string, unknown> | null = null;
  try {
    if (proxy && !isRefusingProxy) {
      const parsed = new URL(proxy);
      const parsedPort = parseInt(parsed.port, 10);
      proxyTask = {
        type: 'AntiTurnstileTask',
        websiteURL: targetUrl,
        websiteKey: sitekey,
        proxyType: parsed.protocol.replace(':', '') || 'http',
        proxyAddress: parsed.hostname,
        proxyPort: !isNaN(parsedPort) && parsedPort > 0 ? parsedPort : (parsed.protocol === 'https:' ? 443 : 80),
        ...(parsed.username ? { proxyLogin: decodeURIComponent(parsed.username) } : {}),
        ...(parsed.password ? { proxyPassword: decodeURIComponent(parsed.password) } : {}),
        userAgent: ua,
        ...(action ? { action } : {}),
        ...(cdata ? { cdata } : {}),
        ...(action || cdata ? { metadata: { ...(action ? { action } : {}), ...(cdata ? { cdata } : {}) } } : {}),
      };
    }
  } catch {
    proxyTask = null;
  }

  // Attempt 2: AntiTurnstileTaskProxyLess
  const proxylessTask: Record<string, unknown> = {
    type: 'AntiTurnstileTaskProxyLess',
    websiteURL: targetUrl,
    websiteKey: sitekey,
    userAgent: ua,
    ...(action ? { action } : {}),
    ...(cdata ? { cdata } : {}),
    ...(action || cdata ? { metadata: { ...(action ? { action } : {}), ...(cdata ? { cdata } : {}) } } : {}),
  };

  const runCapzyTask = async (
    apiKey: string,
    task: Record<string, unknown>,
    taskTimeoutMs = timeoutMs,
  ): Promise<{ result: SolverResult | null; isKeyError: boolean }> => {
    try {
      const init = await fetch('https://api.capzy.ai/createTask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: apiKey, task }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!init.ok && (init.status === 401 || init.status === 402 || init.status === 403)) {
        const desc = `HTTP ${init.status} (${init.status === 402 ? 'Insufficient balance / payment required' : 'Unauthorized key'})`;
        setLastCapzyError(desc);
        logWarn({ status: init.status, key: maskApiKey(apiKey) }, 'Capzy createTask returned unauthorized/unfunded HTTP status');
        return { result: null, isKeyError: true };
      }

      const data = (await init.json()) as { errorId?: number; errorCode?: string; taskId?: string; errorDescription?: string };
      if (data?.errorId && data.errorId !== 0) {
        const desc = data.errorDescription || data.errorCode || 'createTask rejected';
        setLastCapzyError(desc);
        const keyError = isCapzyKeyError(data.errorId, data.errorCode, data.errorDescription);
        logWarn({ errorId: data.errorId, desc: data.errorDescription, code: data.errorCode, keyError, key: maskApiKey(apiKey) }, 'Capzy createTask failed');
        return { result: null, isKeyError: keyError };
      }
      if (!data?.taskId) {
        return { result: null, isKeyError: false };
      }

      const deadline = Date.now() + taskTimeoutMs;
      while (Date.now() < deadline) {
        await attemptSleep(2000);
        const poll = await fetch('https://api.capzy.ai/getTaskResult', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientKey: apiKey, taskId: data.taskId }),
          signal: AbortSignal.timeout(10_000),
        });
        const res = (await poll.json()) as {
          errorId?: number;
          errorCode?: string;
          errorDescription?: string;
          status?: string;
          solution?: {
            token?: string;
            turnstileToken?: string;
            cookies?: Record<string, string>;
          };
        };
        const token = res?.solution?.token || res?.solution?.turnstileToken || (res?.solution as Record<string, unknown> | undefined)?.['cf-turnstile-response'];
        if (res?.status === 'ready' && token && typeof token === 'string') {
          return {
            result: {
              token,
              cookies: res.solution?.cookies,
            },
            isKeyError: false,
          };
        }
        if (res?.errorId && res.errorId !== 0) {
          const desc = res.errorDescription || res.errorCode || 'getTaskResult reported error';
          setLastCapzyError(desc);
          const keyError = isCapzyKeyError(res.errorId, res.errorCode, res.errorDescription);
          logWarn({ taskId: data.taskId, errorId: res.errorId, code: res.errorCode, desc: res.errorDescription, status: res.status, keyError, key: maskApiKey(apiKey) }, 'Capzy getTaskResult reported error');
          return { result: null, isKeyError: keyError };
        }
      }
    } catch (err) {
      throwIfAttemptAborted();
      const msg = err instanceof Error ? err.message : String(err);
      setLastCapzyError(msg);
      logWarn({ err: msg, key: maskApiKey(apiKey) }, 'Capzy task execution threw');
    }
    return { result: null, isKeyError: false };
  };

  for (const apiKey of candidateKeys) {
    throwIfAttemptAborted();
    if (proxyTask) {
      const attempt1Timeout = Math.min(16_000, Math.max(5_000, Math.floor(timeoutMs * 0.45)));
      const { result, isKeyError } = await runCapzyTask(apiKey, proxyTask, attempt1Timeout);
      if (result?.token) return result;
      if (isKeyError) {
        await rotateToNextCapzyKey(apiKey, 'Key invalid or zero balance during proxy task', overrideKeys);
        continue;
      }
    }

    const { result, isKeyError } = await runCapzyTask(apiKey, proxylessTask, timeoutMs);
    if (result?.token) return result;
    if (isKeyError) {
      await rotateToNextCapzyKey(apiKey, 'Key invalid or zero balance during proxyless task', overrideKeys);
      continue;
    }

    // If Capzy reported that the sitekey is not registered for AntiTurnstileTaskProxyLess,
    // immediately retry with the universal Cloudflare Turnstile sitekey using the same API key.
    if (
      sitekey !== CLOUDFLARE_UNIVERSAL_SITEKEY &&
      getLastCapzyError() &&
      /not registered/i.test(getLastCapzyError()!)
    ) {
      log(
        { sitekey, fallbackKey: CLOUDFLARE_UNIVERSAL_SITEKEY },
        'Capzy rejected sitekey as not registered; retrying with universal Cloudflare Turnstile sitekey',
      );
      const fallbackTask = {
        ...proxylessTask,
        websiteKey: CLOUDFLARE_UNIVERSAL_SITEKEY,
      };
      const fallbackRun = await runCapzyTask(apiKey, fallbackTask, timeoutMs);
      if (fallbackRun.result?.token) return fallbackRun.result;
    }
  }

  return null;
}

/**
 * Solve Cloudflare challenge with Capzy / CapSolver API (commercial fallback).
 */
export async function solveCloudflareWithCapzy(
  websiteURL: string,
  proxyUrl?: string,
  userAgent?: string,
  timeoutMs = 35_000,
  sitekey?: string,
  action?: string,
  cdata?: string,
  overrideKeys?: string[],
): Promise<SolverResult | null> {
  const resolvedSitekey = sitekey || (
    websiteURL.includes('leetcode.com') ? LEETCODE_TURNSTILE_SITEKEY : undefined
  );
  if (resolvedSitekey) {
    return solveTurnstileWithCapzy(websiteURL, resolvedSitekey, proxyUrl, userAgent, timeoutMs, action, cdata, overrideKeys);
  }

  const candidateKeys = await getCandidateCapzyKeys(overrideKeys);
  if (candidateKeys.length === 0) {
    setLastCapzyError('No Capzy/CapSolver API keys configured');
    logWarn({}, 'Capzy solver skipped: no Capzy/CapSolver API keys configured');
    return null;
  }

  const proxy =
    proxyUrl ||
    process.env.CODEFORCES_PROXY?.trim() ||
    'http://customer-jp-lmc6hb64r-cc-in-iptype-residential-sessid-ylvk7rom-sesstime-1-backup-1:kdKWYXp9PFrh@gate.joyproxy.com:9001';
  const ua = userAgent || DEFAULT_DESKTOP_CHROME_USER_AGENT;

  for (const apiKey of candidateKeys) {
    throwIfAttemptAborted();
    try {
      const parsed = new URL(proxy);
      const parsedPort = parseInt(parsed.port, 10);
      const init = await fetch('https://api.capzy.ai/createTask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientKey: apiKey,
          task: {
            type: 'AntiCloudflareTask',
            websiteURL,
            proxyType: parsed.protocol.replace(':', '') || 'http',
            proxyAddress: parsed.hostname,
            proxyPort: !isNaN(parsedPort) && parsedPort > 0 ? parsedPort : (parsed.protocol === 'https:' ? 443 : 80),
            ...(parsed.username ? { proxyLogin: decodeURIComponent(parsed.username) } : {}),
            ...(parsed.password ? { proxyPassword: decodeURIComponent(parsed.password) } : {}),
            userAgent: ua,
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!init.ok && (init.status === 401 || init.status === 402 || init.status === 403)) {
        const desc = `HTTP ${init.status} (${init.status === 402 ? 'Insufficient balance / payment required' : 'Unauthorized key'})`;
        setLastCapzyError(desc);
        await rotateToNextCapzyKey(apiKey, `HTTP ${init.status} on createTask`, overrideKeys);
        continue;
      }

      const data = (await init.json()) as { errorId?: number; errorCode?: string; errorDescription?: string; taskId?: string };
      if (data?.errorId && data.errorId !== 0) {
        const desc = data.errorDescription || data.errorCode || 'Key error on createTask';
        setLastCapzyError(desc);
        if (isCapzyKeyError(data.errorId, data.errorCode, data.errorDescription)) {
          await rotateToNextCapzyKey(apiKey, desc, overrideKeys);
          continue;
        }
        return null;
      }
      if (!data?.taskId) continue;

      const deadline = Date.now() + timeoutMs;
      let rotatedDuringPoll = false;
      while (Date.now() < deadline) {
        await attemptSleep(2000);
        const poll = await fetch('https://api.capzy.ai/getTaskResult', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientKey: apiKey, taskId: data.taskId }),
          signal: AbortSignal.timeout(10_000),
        });
        const res = (await poll.json()) as {
          errorId?: number;
          errorCode?: string;
          errorDescription?: string;
          status?: string;
          solution?: {
            token?: string;
            turnstileToken?: string;
            cookies?: Record<string, string>;
          };
        };
        const token = res?.solution?.token || res?.solution?.turnstileToken || (res?.solution as Record<string, unknown> | undefined)?.['cf-turnstile-response'];
        if (res?.status === 'ready' && (token || res?.solution?.cookies)) {
          return {
            token: typeof token === 'string' ? token : undefined,
            cookies: res.solution?.cookies,
          };
        }
        if (res?.errorId && res.errorId !== 0) {
          const desc = res.errorDescription || res.errorCode || 'Key error during poll';
          setLastCapzyError(desc);
          logWarn({ taskId: data.taskId, errorId: res.errorId, status: res.status, raw: res }, 'Capzy solve reported error');
          if (isCapzyKeyError(res.errorId, res.errorCode, res.errorDescription)) {
            await rotateToNextCapzyKey(apiKey, desc, overrideKeys);
            rotatedDuringPoll = true;
          }
          break;
        }
      }
      if (rotatedDuringPoll) continue;
    } catch (err) {
      throwIfAttemptAborted();
      const msg = err instanceof Error ? err.message : String(err);
      setLastCapzyError(msg);
      logWarn({ err: msg, key: maskApiKey(apiKey) }, 'Capzy solveCloudflare threw');
    }
  }

  // If AntiCloudflareTask failed to yield a token or cookies, fall back to solving Turnstile
  // with site-appropriate sitekey
  return solveTurnstileWithCapzy(
    websiteURL,
    websiteURL.includes('leetcode.com') ? LEETCODE_TURNSTILE_SITEKEY : CLOUDFLARE_UNIVERSAL_SITEKEY,
    proxyUrl,
    userAgent,
    timeoutMs,
    action,
    cdata,
    overrideKeys,
  );
}

/**
 * Unified Orchestrated Solver for Turnstile widgets.
 * Flow:
 * 1. Checks if local CPSolver is configured.
 * 2. Attempts up to 3 tries on CPSolver, notifying Telegram of each attempt.
 * 3. If CPSolver succeeds: notifies Telegram and returns result.
 * 4. If CPSolver fails after 3 tries: notifies Telegram of failover to CapSolver / Capzy.
 * 5. Proceeds with CapSolver / Capzy multi-key rotation, notifying Telegram.
 */
export async function solveTurnstileOrchestrated(params: {
  siteurl: string;
  sitekey: string;
  action?: string;
  cdata?: string;
  proxyUrl?: string;
  userAgent?: string;
  cookies?: Array<{ name: string; value: string; domain?: string; path?: string }> | Record<string, string>;
  timeoutMs?: number;
  overrideKeys?: string[];
}): Promise<SolverResult | null> {
  const solverUrl = getCPSolverUrl();
  const timeoutMs = params.timeoutMs ?? 90_000;

  // Phase 1: Local / Render CPSolver. Explicit no-token verification timeouts
  // stop here; only other failures retain the existing retry policy.
  if (solverUrl) {
    let solverHost = solverUrl;
    try {
      solverHost = new URL(solverUrl).host;
    } catch {}

    const maxTries = Math.max(1, parseInt(process.env.CPSOLVER_MAX_TRIES || '3', 10));
    const cpsolverTimeoutMs = Math.min(timeoutMs, parseInt(process.env.CPSOLVER_TIMEOUT_MS || '90000', 10));
    log({ solverUrl, maxTries, siteurl: params.siteurl, cpsolverTimeoutMs }, 'Starting Turnstile solve with local CPSolver');

    for (let attempt = 1; attempt <= maxTries; attempt++) {
      throwIfAttemptAborted();
      const attemptNotice = `🧩 <b>[Attempt ${attempt}/${maxTries}] Solving Turnstile via CPSolver (${solverHost})...</b>`;
      await sendSolverTelegramNotification(attemptNotice).catch(() => undefined);

      log({ attempt, maxTries }, 'Invoking CPSolver');
      const attemptStartTime = Date.now();
      const proxyForCPSolver = params.proxyUrl || undefined;
      const res = await solveTurnstileWithCPSolver({
        siteurl: params.siteurl,
        sitekey: params.sitekey,
        action: params.action,
        cdata: params.cdata,
        proxy: proxyForCPSolver,
        userAgent: params.userAgent,
        cookies: params.cookies,
        timeoutMs: cpsolverTimeoutMs,
      });
      throwIfAttemptAborted();

      const isConnectionTimeout = res.error ? /aborted due to timeout|TimeoutError/i.test(res.error) : false;
      if (res.verificationRequired || isConnectionTimeout) {
        const reason = res.verificationRequired ? 'verification declined' : 'connection timed out (service unresponsive)';
        logWarn({ attempt, durationMs: res.durationMs, reason }, `CPSolver Turnstile ${reason}; falling back to CapSolver / Capzy`);
        await sendSolverTelegramNotification(
          `⚠️ <b>CPSolver Turnstile ${reason}. Falling back to CapSolver / Capzy...</b>`,
        ).catch(() => undefined);
        break;
      }

      const isInterstitialKey = params.sitekey === '0x4AAAAAAADnPIDROrmt1Wwj';
      const hasValidToken = typeof res.token === 'string' && res.token.trim().length > 10;
      const hasClearanceOrCookies = res.ok && (
        (typeof res.cfClearance === 'string' && res.cfClearance.trim().length > 0) ||
        (res.cookies && Object.keys(res.cookies).some((k) => k.toLowerCase().startsWith('cf_')))
      );

      if (res.ok && (hasValidToken || (isInterstitialKey && hasClearanceOrCookies))) {
        const sec = Math.max(1, Math.round(res.durationMs / 1000));
        const proxyInfo = res.proxyUsed ? `\n🌐 Proxy: <code>${res.proxyUsed}</code>` : '';
        const mode = hasValidToken ? 'token' : 'clearance-cookies';
        const successNotice = `✅ <b>Turnstile solved via CPSolver!</b> <i>(${sec}s, attempt ${attempt}/${maxTries}, mode=${mode})</i>${proxyInfo}`;
        await sendSolverTelegramNotification(successNotice).catch(() => undefined);

        log({ durationMs: res.durationMs, attempt, proxyUsed: res.proxyUsed, mode }, 'CPSolver succeeded');
        return {
          token: res.token,
          cookies: res.cookies,
          cfClearance: res.cfClearance,
          source: 'cpsolver',
          durationMs: res.durationMs,
        };
      }

      // If CPSolver returned clearance cookies without a Turnstile token, preserve them for downstream
      if (res.cookies && Object.keys(res.cookies).length > 0) {
        if (!params.cookies || typeof params.cookies !== 'object') {
          params.cookies = res.cookies;
        }
      }

      const errBrief = res.error ? ` (${res.error.slice(0, 100)})` : '';
      logWarn({ attempt, error: res.error, durationMs: Date.now() - attemptStartTime }, 'CPSolver attempt failed');
      const failNotice = `⚠️ <b>[Attempt ${attempt}/${maxTries} failed]</b><i>${errBrief}</i>`;
      await sendSolverTelegramNotification(failNotice).catch(() => undefined);

      if (attempt < maxTries) {
        await attemptSleep(2000);
      }
    }

    // All tries finished without a widget token — fall back to commercial CapSolver / Capzy
    const fallbackNotice = `⚠️ <b>CPSolver failed after ${maxTries} attempts. Falling back to CapSolver / Capzy...</b>`;
    await sendSolverTelegramNotification(fallbackNotice).catch(() => undefined);
    logWarn({}, 'CPSolver exhausted attempts without valid token. Falling back to CapSolver/Capzy');
  } else {
    log({}, 'CPSolver URL not configured, proceeding directly with CapSolver / Capzy');
  }

  // Phase 2: CapSolver / Capzy commercial fallback
  throwIfAttemptAborted();
  const capzyNotice = `🧩 <b>Solving Turnstile via CapSolver / Capzy (multi-key rotation)...</b>`;
  await sendSolverTelegramNotification(capzyNotice).catch(() => undefined);

  const capzySol = await solveTurnstileWithCapzy(
    params.siteurl,
    params.sitekey,
    params.proxyUrl,
    params.userAgent,
    timeoutMs,
    params.action,
    params.cdata,
    params.overrideKeys,
  );
  throwIfAttemptAborted();

  if (capzySol && (capzySol.token || capzySol.cookies || capzySol.cfClearance)) {
    setLastCapzyError(null);
    const successNotice = `✅ <b>Turnstile solved via CapSolver / Capzy!</b>`;
    await sendSolverTelegramNotification(successNotice).catch(() => undefined);
    return {
      ...capzySol,
      source: 'capsolver',
    };
  }

  const capzyErrDetail = getLastCapzyError() ? `: <i>${getLastCapzyError()}</i>` : '';
  const tip = getLastCapzyError() && /balance|credit|unauthorized|exist|invalid/i.test(getLastCapzyError()!)
    ? `\n💡 <i>Please update your API key using <code>/addcapzy &lt;key&gt;</code> or <code>/capsolver &lt;key&gt;</code></i>`
    : '';
  const failNotice = `❌ <b>CapSolver / Capzy also failed to solve Turnstile${capzyErrDetail}.</b>${tip}`;
  await sendSolverTelegramNotification(failNotice).catch(() => undefined);
  return null;
}

/**
 * Unified Orchestrated Solver for Cloudflare Interstitial / Clearance challenges.
 * Flow:
 * 1. Checks if local CPSolver is configured.
 * 2. Attempts up to 3 tries on CPSolver in navigate mode.
 * 3. If CPSolver succeeds: notifies Telegram and returns result.
 * 4. If CPSolver fails after 3 tries: notifies Telegram of failover to CapSolver / Capzy.
 * 5. Proceeds with CapSolver / Capzy.
 */
export async function solveCloudflareOrchestrated(params: {
  websiteURL: string;
  proxyUrl?: string;
  userAgent?: string;
  cookies?: Array<{ name: string; value: string; domain?: string; path?: string }> | Record<string, string>;
  timeoutMs?: number;
  sitekey?: string;
  action?: string;
  cdata?: string;
  overrideKeys?: string[];
}): Promise<SolverResult | null> {
  const resolvedSitekey = params.sitekey || (
    params.websiteURL.includes('leetcode.com') ? LEETCODE_TURNSTILE_SITEKEY : undefined
  );
  if (resolvedSitekey) {
    return solveTurnstileOrchestrated({
      siteurl: params.websiteURL,
      sitekey: resolvedSitekey,
      action: params.action,
      cdata: params.cdata,
      proxyUrl: params.proxyUrl,
      userAgent: params.userAgent,
      cookies: params.cookies,
      timeoutMs: params.timeoutMs,
      overrideKeys: params.overrideKeys,
    });
  }

  const solverUrl = getCPSolverUrl();
  const timeoutMs = params.timeoutMs ?? 65_000;

  // Phase 1: Local / Render CPSolver (up to 3 tries)
  if (solverUrl) {
    let solverHost = solverUrl;
    try {
      solverHost = new URL(solverUrl).host;
    } catch {}

    const maxTries = Math.max(1, parseInt(process.env.CPSOLVER_MAX_TRIES || '3', 10));
    log({ solverUrl, maxTries, url: params.websiteURL }, 'Starting Cloudflare clearance solve with local CPSolver');

    for (let attempt = 1; attempt <= maxTries; attempt++) {
      throwIfAttemptAborted();
      const attemptNotice = `🧩 <b>[Attempt ${attempt}/${maxTries}] Solving Cloudflare Challenge via CPSolver (${solverHost})...</b>`;
      await sendSolverTelegramNotification(attemptNotice).catch(() => undefined);

      const proxyForCPSolver = process.env.CPSOLVER_FORWARD_PROXY === 'true' ? params.proxyUrl : undefined;
      const res = await solveCloudflareWithCPSolver({
        siteurl: params.websiteURL,
        proxy: proxyForCPSolver,
        userAgent: params.userAgent,
        cookies: params.cookies,
        timeoutMs,
      });
      throwIfAttemptAborted();

      if (res.ok && (res.token || res.cfClearance || (res.cookies && Object.keys(res.cookies).length > 0))) {
        const sec = Math.max(1, Math.round(res.durationMs / 1000));
        const proxyInfo = res.proxyUsed ? `\n🌐 Proxy: <code>${res.proxyUsed}</code>` : '';
        const successNotice = `✅ <b>Cloudflare Challenge cleared via CPSolver!</b> <i>(${sec}s, attempt ${attempt}/${maxTries})</i>${proxyInfo}`;
        await sendSolverTelegramNotification(successNotice).catch(() => undefined);

        return {
          token: res.token,
          cookies: res.cookies,
          cfClearance: res.cfClearance,
          source: 'cpsolver',
          durationMs: res.durationMs,
        };
      }

      const isDeclined = Boolean((res as { verificationRequired?: boolean }).verificationRequired);
      const isConnectionTimeout = res.error ? /aborted due to timeout|TimeoutError/i.test(res.error) : false;
      if (isDeclined || isConnectionTimeout) {
        const reason = isDeclined ? 'challenge declined' : 'connection timed out (service unresponsive)';
        logWarn({ attempt, error: res.error, reason }, `CPSolver ${reason}; falling back to CapSolver / Capzy`);
        await sendSolverTelegramNotification(
          `⚠️ <b>CPSolver ${reason}. Falling back to CapSolver / Capzy...</b>`,
        ).catch(() => undefined);
        break;
      }

      const errBrief = res.error ? ` (${res.error.slice(0, 100)})` : '';
      logWarn({ attempt, error: res.error }, 'CPSolver challenge attempt failed');
      const failNotice = `⚠️ <b>[Attempt ${attempt}/${maxTries} failed]</b><i>${errBrief}</i>`;
      await sendSolverTelegramNotification(failNotice).catch(() => undefined);

      if (attempt < maxTries) {
        await attemptSleep(2000);
      }
    }

    const fallbackNotice = `⚠️ <b>CPSolver failed after ${maxTries} attempts. Falling back to CapSolver / Capzy...</b>`;
    await sendSolverTelegramNotification(fallbackNotice).catch(() => undefined);
  }

  // Phase 2: CapSolver / Capzy commercial fallback
  throwIfAttemptAborted();
  const capzyNotice = `🧩 <b>Solving Cloudflare Challenge via CapSolver / Capzy...</b>`;
  await sendSolverTelegramNotification(capzyNotice).catch(() => undefined);

  const capzySol = await solveCloudflareWithCapzy(
    params.websiteURL,
    params.proxyUrl,
    params.userAgent,
    timeoutMs,
    params.sitekey,
    params.action,
    params.cdata,
    params.overrideKeys,
  );
  throwIfAttemptAborted();

  if (capzySol && (capzySol.token || capzySol.cookies)) {
    setLastCapzyError(null);
    const successNotice = `✅ <b>Cloudflare Challenge cleared via CapSolver / Capzy!</b>`;
    await sendSolverTelegramNotification(successNotice).catch(() => undefined);
    return {
      ...capzySol,
      source: 'capsolver',
    };
  }

  const capzyErrDetail = getLastCapzyError() ? `: <i>${getLastCapzyError()}</i>` : '';
  const tip = getLastCapzyError() && /balance|credit|unauthorized|exist|invalid/i.test(getLastCapzyError()!)
    ? `\n💡 <i>Please update your API key using <code>/addcapzy &lt;key&gt;</code> or <code>/capsolver &lt;key&gt;</code></i>`
    : '';
  const failNotice = `❌ <b>CapSolver / Capzy also failed to clear Cloudflare Challenge${capzyErrDetail}.</b>${tip}`;
  await sendSolverTelegramNotification(failNotice).catch(() => undefined);
  return null;
}
