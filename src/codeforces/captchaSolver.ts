import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
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

export const MAX_CAPZY_ATTEMPTS = 3;
export const CAPZY_RETRY_DELAY_MS = 10_000;

export function getMaxCapzyAttempts(): number {
  return Math.min(10, positiveInteger(process.env.MAX_CAPZY_ATTEMPTS, MAX_CAPZY_ATTEMPTS));
}

export function getCapzyRetryDelayMs(): number {
  const raw = process.env.CAPZY_RETRY_DELAY_MS;
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }
  return CAPZY_RETRY_DELAY_MS;
}

export interface CapzyTaskDiagnostic {
  adapterName: 'capzy' | 'cpsolver' | 'none';
  providerHttpStatus?: number;
  providerErrorCode?: string;
  providerErrorCategory?: string;
  providerErrorDescription?: string;
  taskLifecycleState: 'idle' | 'task_creating' | 'task_created' | 'polling' | 'ready' | 'failed' | 'timeout';
  taskId?: string;
  elapsedTimeMs: number;
  timeoutReason?: string;
  requestAccepted: boolean;
  operationCompleted: boolean;
  attemptsMade?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  permanentError?: boolean;
  sanitizedRequest?: Record<string, unknown>;
}

interface CapzyExecutionStore {
  requestId: string;
  lastError: string | null;
  diagnostic: CapzyTaskDiagnostic;
  inFlightTask: boolean;
  attemptsUsed: number;
}

const capzyExecutionStorage = new AsyncLocalStorage<CapzyExecutionStore>();
const activeRequestLocks = new Set<string>();

function createInitialDiagnostic(): CapzyTaskDiagnostic {
  return {
    adapterName: 'none',
    taskLifecycleState: 'idle',
    elapsedTimeMs: 0,
    requestAccepted: false,
    operationCompleted: false,
  };
}

let lastCapzyError: string | null = null;
let lastCapzyDiagnostic: CapzyTaskDiagnostic = createInitialDiagnostic();

export function withCapzyRequestContext<T>(fn: () => Promise<T>, requestId?: string): Promise<T> {
  const existing = capzyExecutionStorage.getStore();
  if (existing && (!requestId || existing.requestId === requestId)) {
    return fn();
  }
  const store: CapzyExecutionStore = {
    requestId: requestId || randomUUID(),
    lastError: null,
    diagnostic: createInitialDiagnostic(),
    inFlightTask: false,
    attemptsUsed: 0,
  };
  return capzyExecutionStorage.run(store, fn);
}

export function getLastCapzyError(): string | null {
  const store = capzyExecutionStorage.getStore();
  return store ? store.lastError : lastCapzyError;
}

export function setLastCapzyError(err: string | null): void {
  const store = capzyExecutionStorage.getStore();
  if (store) {
    store.lastError = err;
  }
  lastCapzyError = err;
}

export function getLastCapzyDiagnostic(): CapzyTaskDiagnostic {
  const store = capzyExecutionStorage.getStore();
  const target = store ? store.diagnostic : lastCapzyDiagnostic;
  return {
    ...target,
    ...(target.sanitizedRequest ? { sanitizedRequest: { ...target.sanitizedRequest } } : {}),
  };
}

export function setLastCapzyDiagnostic(diag: Partial<CapzyTaskDiagnostic>): void {
  const store = capzyExecutionStorage.getStore();
  if (store) {
    store.diagnostic = { ...store.diagnostic, ...diag };
    lastCapzyDiagnostic = { ...store.diagnostic };
  } else {
    lastCapzyDiagnostic = { ...lastCapzyDiagnostic, ...diag };
  }
}

export function sanitizeCapzyRequestPayload(payload: {
  clientKey?: unknown;
  task?: Record<string, unknown>;
}): Record<string, unknown> {
  const rawTask = payload.task && typeof payload.task === 'object' ? payload.task : {};
  const sanitizedTask: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawTask)) {
    const lower = k.toLowerCase();
    if (
      lower.includes('password') ||
      lower.includes('login') ||
      lower.includes('secret') ||
      lower.includes('token') ||
      lower.includes('cookie') ||
      lower.includes('key') && lower !== 'websitekey'
    ) {
      sanitizedTask[k] = '[REDACTED]';
    } else if (k === 'websiteURL' && typeof v === 'string') {
      try {
        const parsed = new URL(v);
        sanitizedTask[k] = `${parsed.origin}${parsed.pathname}`;
      } catch {
        sanitizedTask[k] = v;
      }
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      const subObj: Record<string, unknown> = {};
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
        const sLower = sk.toLowerCase();
        if (sLower.includes('password') || sLower.includes('token') || sLower.includes('cookie') || sLower.includes('secret')) {
          subObj[sk] = '[REDACTED]';
        } else {
          subObj[sk] = sv;
        }
      }
      sanitizedTask[k] = subObj;
    } else {
      sanitizedTask[k] = v;
    }
  }

  return {
    endpoint: 'https://api.capzy.ai/createTask',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      clientKey: typeof payload.clientKey === 'string' ? maskApiKey(payload.clientKey) : '[INVALID_KEY]',
      task: sanitizedTask,
    },
  };
}

export function validateCapzyTaskPayload(payload: {
  clientKey?: unknown;
  task?: Record<string, unknown>;
}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!payload || typeof payload !== 'object') {
    return { valid: false, errors: ['Payload must be an object'] };
  }

  const clientKey = typeof payload.clientKey === 'string' ? payload.clientKey.trim() : '';
  if (!clientKey || /^(none|null|undefined|fixture)$/i.test(clientKey)) {
    errors.push('clientKey must be a non-empty valid API key string');
  }

  const task = payload.task;
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    errors.push('task must be a non-null plain object');
    return { valid: false, errors };
  }

  const validTypes = new Set(['AntiTurnstileTaskProxyLess', 'AntiTurnstileTask', 'AntiCloudflareTask']);
  const taskType = typeof task.type === 'string' ? task.type : '';
  if (!validTypes.has(taskType)) {
    errors.push(`task.type must be one of AntiTurnstileTaskProxyLess, AntiTurnstileTask, AntiCloudflareTask (got "${taskType}")`);
  }

  const websiteURL = typeof task.websiteURL === 'string' ? task.websiteURL.trim() : '';
  if (!websiteURL) {
    errors.push('task.websiteURL is required');
  } else {
    try {
      const parsedUrl = new URL(websiteURL);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        errors.push('task.websiteURL must use http or https protocol');
      }
      if (websiteURL.includes('#')) {
        errors.push('task.websiteURL must not contain a URL hash fragment');
      }
    } catch {
      errors.push('task.websiteURL must be a valid URL');
    }
  }

  if (taskType === 'AntiTurnstileTaskProxyLess' || taskType === 'AntiTurnstileTask') {
    const websiteKey = typeof task.websiteKey === 'string' ? task.websiteKey.trim() : '';
    if (!websiteKey || websiteKey.length < 3 || /^(none|null|undefined|fixture-key|test-key)$/i.test(websiteKey)) {
      errors.push('task.websiteKey is required for Turnstile tasks and must be a non-empty sitekey');
    }
  }

  if (taskType === 'AntiTurnstileTask' || taskType === 'AntiCloudflareTask') {
    const validProxyTypes = new Set(['http', 'https', 'socks4', 'socks5']);
    const proxyType = typeof task.proxyType === 'string' ? task.proxyType.toLowerCase() : '';
    if (!validProxyTypes.has(proxyType)) {
      errors.push('task.proxyType must be one of http, https, socks4, socks5');
    }
    const proxyAddress = typeof task.proxyAddress === 'string' ? task.proxyAddress.trim() : '';
    if (!proxyAddress) {
      errors.push('task.proxyAddress is required for proxied tasks');
    }
    const proxyPort = task.proxyPort;
    if (typeof proxyPort !== 'number' || !Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
      errors.push('task.proxyPort must be an integer between 1 and 65535');
    }
  }

  if (task.metadata !== undefined) {
    if (!task.metadata || typeof task.metadata !== 'object' || Array.isArray(task.metadata)) {
      errors.push('task.metadata must be a plain object when provided');
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateCapzySolution(
  solution: unknown,
  taskType: string,
): {
  valid: boolean;
  token?: string;
  cookies?: Record<string, string>;
  cfClearance?: string;
  reason?: string;
} {
  if (!solution || typeof solution !== 'object' || Array.isArray(solution)) {
    return { valid: false, reason: 'Provider solution is missing or not an object' };
  }
  const sol = solution as Record<string, unknown>;
  const rawToken =
    sol.token ||
    sol.turnstileToken ||
    sol['cf-turnstile-response'] ||
    sol.cf_turnstile_response;
  const token = typeof rawToken === 'string' && rawToken.trim().length > 10 ? rawToken.trim() : undefined;
  const cookies =
    sol.cookies && typeof sol.cookies === 'object' && !Array.isArray(sol.cookies)
      ? (sol.cookies as Record<string, string>)
      : undefined;
  const cfClearance =
    typeof sol.cfClearance === 'string' && sol.cfClearance.trim().length > 0
      ? sol.cfClearance.trim()
      : hasClearanceCookie(cookies)
        ? cookies!.cf_clearance
        : undefined;

  if (taskType === 'AntiTurnstileTaskProxyLess' || taskType === 'AntiTurnstileTask') {
    if (!token) {
      return { valid: false, reason: 'Turnstile solution missing valid token string (>10 chars)' };
    }
    return { valid: true, token, cookies, cfClearance };
  }

  if (!token && !cfClearance) {
    return { valid: false, reason: 'Cloudflare solution missing both valid token and cf_clearance cookie' };
  }

  return { valid: true, token, cookies, cfClearance };
}

export function isPermanentCapzyError(params: {
  httpStatus?: number;
  errorId?: number;
  errorCode?: string | null;
  errorDescription?: string | null;
  errorCategory?: string | null;
}): boolean {
  const { httpStatus, errorId, errorCode, errorDescription, errorCategory } = params;
  if (isCapzyKeyError(errorId, errorCode, errorDescription)) {
    return true;
  }
  if (httpStatus === 400 || httpStatus === 401 || httpStatus === 402 || httpStatus === 403 || httpStatus === 422) {
    return true;
  }
  const code = (errorCode || '').toUpperCase();
  const cat = (errorCategory || '').toUpperCase();
  const desc = (errorDescription || '').toLowerCase();
  return (
    cat === 'INVALID_REQUEST_CONFIGURATION' ||
    cat === 'INSUFFICIENT_BALANCE' ||
    cat === 'AUTHENTICATION_FAILED' ||
    cat === 'DUPLICATE_TASK_PREVENTED' ||
    code.includes('KEY_DOES_NOT_EXIST') ||
    code.includes('WRONG_USER_KEY') ||
    code.includes('ZERO_BALANCE') ||
    code.includes('INSUFFICIENT_BALANCE') ||
    code.includes('TASK_ABSENT') ||
    code.includes('TASK_NOT_SUPPORTED') ||
    code.includes('WRONG_TASK_TYPE') ||
    code.includes('INVALID_TASK_DATA') ||
    code.includes('BAD_PARAMETERS') ||
    code.includes('DOMAIN_NOT_ALLOWED') ||
    code.includes('INVALID_SITEKEY') ||
    code.includes('ACCOUNT_SUSPENDED') ||
    desc.includes('invalid api key') ||
    desc.includes('zero balance') ||
    desc.includes('insufficient balance') ||
    desc.includes('not registered') ||
    desc.includes('invalid sitekey') ||
    desc.includes('bad parameters') ||
    desc.includes('domain not allowed')
  );
}

let inMemoryCPSolverUrl = '';
let inMemoryCPSolverApiToken = '';
let inMemoryTelegramBotToken = '';
let inMemoryTelegramChatId = '';

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const PLACEHOLDER_CLEARANCE_VALUES = new Set(['cleared', 'ok', 'true', 'success', 'solved', 'null', 'undefined']);

/** A clearance value is real only if it is not a known placeholder sentinel and has plausible length. */
export function isRealClearanceValue(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  return v.length > 5 && !PLACEHOLDER_CLEARANCE_VALUES.has(v.toLowerCase());
}

function hasClearanceCookie(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return isRealClearanceValue((value as Record<string, unknown>).cf_clearance);
}

/**
 * Configure solver overrides in memory (useful when called from isolated worker or tests).
 */
export function initCPSolverConfig(options: {
  url?: string;
  apiToken?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
}): void {
  if (options.url !== undefined) inMemoryCPSolverUrl = options.url.trim().replace(/\/+$/, '');
  if (options.apiToken !== undefined) inMemoryCPSolverApiToken = options.apiToken.trim();
  if (options.telegramBotToken !== undefined) inMemoryTelegramBotToken = options.telegramBotToken.trim();
  if (options.telegramChatId !== undefined) inMemoryTelegramChatId = options.telegramChatId.trim();
}

/**
 * Resolves the configured CPSolver microservice API token.
 */
export function getCPSolverApiToken(): string {
  return (
    process.env.CPSOLVER_API_TOKEN?.trim() ||
    process.env.CPSOLVER_AUTH_TOKEN?.trim() ||
    inMemoryCPSolverApiToken
  );
}

function buildCPSolverHeaders(base: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...base };
  const token = getCPSolverApiToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers['x-api-key'] = token;
  }
  const attempt = getAttemptContext();
  if (attempt) {
    headers['x-request-id'] = attempt.requestId;
  }
  return headers;
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
      headers: buildCPSolverHeaders({ accept: 'application/json' }),
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
      headers: buildCPSolverHeaders({ 'Content-Type': 'application/json' }),
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
    const hasClearance = isRealClearanceValue(data.cfClearance);
    const hasCookies = hasClearanceCookie(data.cookies);

    // Interstitial challenge key (0x4AAAAAAADnPIDROrmt1Wwj) succeeds via clearance cookies.
    // Form widget keys (e.g. 0x4AAAAAACDz1ltMYNJCAQZS) strictly require a real Turnstile token.
    const isInterstitialKey = params.sitekey === '0x4AAAAAAADnPIDROrmt1Wwj';
    const isSuccess = data.ok !== false && (hasToken || (isInterstitialKey ? (hasClearance || hasCookies) : false));

    if (isSuccess) {
      return {
        ok: true,
        token: data.token,
        cookies: data.cookies,
        cfClearance: hasClearance ? data.cfClearance : undefined,
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
  verificationRequired?: boolean;
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
      headers: buildCPSolverHeaders({ 'Content-Type': 'application/json' }),
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
      let verificationRequired = false;
      try {
        const failure = JSON.parse(errText) as { ok?: boolean; error?: unknown };
        verificationRequired =
          response.status === 408 &&
          failure.ok === false &&
          typeof failure.error === 'string' &&
          /^(Turnstile|Cloudflare) challenge timed out after \d+ms/i.test(failure.error);
      } catch {
        verificationRequired =
          response.status === 408 &&
          /(Turnstile|Cloudflare|Challenge)\s+(challenge\s+)?time(d\s*out|out)/i.test(errText);
      }
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
    const hasClearance = isRealClearanceValue(data.cfClearance);
    const hasCookies = hasClearanceCookie(data.cookies);
    const isSuccess = data.ok === true || (data.ok !== false && (hasToken || hasClearance || hasCookies));

    if (isSuccess && (hasToken || hasClearance || hasCookies)) {
      return {
        ok: true,
        token: data.token,
        cookies: data.cookies,
        cfClearance: hasClearance ? data.cfClearance : undefined,
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
 * Execute a single Capzy task (createTask + getTaskResult polling) to completion, terminal failure, or timeout.
 * Enforces pre-flight schema validation, sanitized request recording, duplicate-task prevention,
 * and strict post-poll solution schema validation.
 */
async function executeSingleCapzyTask(params: {
  apiKey: string;
  task: Record<string, unknown>;
  taskTimeoutMs: number;
  attemptNumber: number;
  maxAttempts: number;
  retryDelayMs: number;
}): Promise<{
  result: SolverResult | null;
  isKeyError: boolean;
  isPermanentError: boolean;
}> {
  const { apiKey, task, taskTimeoutMs, attemptNumber, maxAttempts, retryDelayMs } = params;
  throwIfAttemptAborted();

  const store = capzyExecutionStorage.getStore();
  if (store?.inFlightTask) {
    const desc = 'Duplicate simultaneous Capzy task prevented for the same request context';
    setLastCapzyError(desc);
    setLastCapzyDiagnostic({
      adapterName: 'capzy',
      taskLifecycleState: 'failed',
      providerErrorCategory: 'DUPLICATE_TASK_PREVENTED',
      providerErrorDescription: desc,
      permanentError: true,
      requestAccepted: false,
      operationCompleted: false,
      attemptsMade: attemptNumber,
      maxAttempts,
      retryDelayMs,
    });
    logWarn({ key: maskApiKey(apiKey) }, desc);
    return { result: null, isKeyError: false, isPermanentError: true };
  }

  const sanitizedRequest = sanitizeCapzyRequestPayload({ clientKey: apiKey, task });
  const validation = validateCapzyTaskPayload({ clientKey: apiKey, task });
  if (!validation.valid) {
    const desc = `Invalid Capzy request payload: ${validation.errors.join('; ')}`;
    setLastCapzyError(desc);
    setLastCapzyDiagnostic({
      adapterName: 'capzy',
      taskLifecycleState: 'failed',
      providerErrorCategory: 'INVALID_REQUEST_CONFIGURATION',
      providerErrorDescription: desc,
      permanentError: true,
      requestAccepted: false,
      operationCompleted: false,
      elapsedTimeMs: 0,
      attemptsMade: 0,
      maxAttempts,
      retryDelayMs,
      sanitizedRequest,
    });
    logWarn({ errors: validation.errors, sanitizedRequest }, 'Capzy payload failed pre-flight schema validation');
    return { result: null, isKeyError: false, isPermanentError: true };
  }

  // Avoid unmocked external HTTP calls when running with the synthetic 'test-capzy-key' placeholder
  if (apiKey === 'test-capzy-key' && !(globalThis.fetch as unknown as { mock?: unknown })?.mock) {
    const desc = 'Synthetic test-capzy-key cannot be sent to live Capzy API without a fetch mock';
    setLastCapzyError(desc);
    setLastCapzyDiagnostic({
      adapterName: 'capzy',
      taskLifecycleState: 'failed',
      providerErrorCode: 'ERROR_KEY_DOES_NOT_EXIST',
      providerErrorCategory: 'AUTHENTICATION_FAILED',
      providerErrorDescription: desc,
      permanentError: true,
      requestAccepted: false,
      operationCompleted: false,
      elapsedTimeMs: 0,
      attemptsMade: attemptNumber,
      maxAttempts,
      retryDelayMs,
      sanitizedRequest,
    });
    return { result: null, isKeyError: true, isPermanentError: true };
  }

  if (process.env.CAPZY_DEBUG === 'true' || process.env.CAPZY_DEBUG === '1') {
    log({ attemptNumber, maxAttempts, sanitizedRequest }, 'Capzy safe debug mode: validated outgoing request');
  }

  if (store) {
    store.inFlightTask = true;
  }

  const taskStart = Date.now();
  setLastCapzyDiagnostic({
    adapterName: 'capzy',
    taskLifecycleState: 'task_creating',
    requestAccepted: false,
    operationCompleted: false,
    elapsedTimeMs: 0,
    providerHttpStatus: undefined,
    providerErrorCode: undefined,
    providerErrorCategory: undefined,
    providerErrorDescription: undefined,
    timeoutReason: undefined,
    permanentError: false,
    attemptsMade: attemptNumber,
    maxAttempts,
    retryDelayMs,
    sanitizedRequest,
  });

  try {
    const init = await fetch('https://api.capzy.ai/createTask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, task }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!init.ok) {
      if (init.status === 401 || init.status === 402 || init.status === 403) {
        const desc = `HTTP ${init.status} (${init.status === 402 ? 'Insufficient balance / payment required' : 'Unauthorized key'})`;
        setLastCapzyError(desc);
        setLastCapzyDiagnostic({
          providerHttpStatus: init.status,
          providerErrorCategory: init.status === 402 ? 'INSUFFICIENT_BALANCE' : 'AUTHENTICATION_FAILED',
          providerErrorDescription: desc,
          taskLifecycleState: 'failed',
          permanentError: true,
          elapsedTimeMs: Date.now() - taskStart,
        });
        logWarn({ status: init.status, key: maskApiKey(apiKey) }, 'Capzy createTask returned unauthorized/unfunded HTTP status');
        return { result: null, isKeyError: true, isPermanentError: true };
      }
      const rawErr = typeof init.text === 'function' ? await init.text().catch(() => '') : '';
      let parsedErr: { errorId?: number; errorCode?: string; errorDescription?: string } | null = null;
      try {
        parsedErr = rawErr ? JSON.parse(rawErr) : null;
      } catch {}
      const desc = parsedErr?.errorDescription || parsedErr?.errorCode || `Capzy HTTP ${init.status}${rawErr ? `: ${rawErr.slice(0, 120)}` : ''}`;
      const keyError = parsedErr ? isCapzyKeyError(parsedErr.errorId, parsedErr.errorCode, parsedErr.errorDescription) : false;
      const permError = isPermanentCapzyError({
        httpStatus: init.status,
        errorId: parsedErr?.errorId,
        errorCode: parsedErr?.errorCode,
        errorDescription: desc,
        errorCategory: parsedErr?.errorCode || `HTTP_${init.status}`,
      });
      setLastCapzyError(desc);
      setLastCapzyDiagnostic({
        providerHttpStatus: init.status,
        providerErrorCode: parsedErr?.errorCode,
        providerErrorCategory: parsedErr?.errorCode || `HTTP_${init.status}`,
        providerErrorDescription: desc,
        taskLifecycleState: 'failed',
        permanentError: permError,
        elapsedTimeMs: Date.now() - taskStart,
      });
      logWarn({ status: init.status, desc, keyError, permError, key: maskApiKey(apiKey) }, 'Capzy createTask returned non-OK HTTP status');
      return { result: null, isKeyError: keyError, isPermanentError: permError };
    }

    let data: { errorId?: number; errorCode?: string; taskId?: string; errorDescription?: string } | null = null;
    try {
      data = (await init.json()) as { errorId?: number; errorCode?: string; taskId?: string; errorDescription?: string };
    } catch (jsonErr) {
      const desc = `Malformed JSON in createTask response: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`;
      setLastCapzyError(desc);
      setLastCapzyDiagnostic({
        providerHttpStatus: init.status || 200,
        providerErrorCategory: 'MALFORMED_PROVIDER_RESPONSE',
        providerErrorDescription: desc,
        taskLifecycleState: 'failed',
        permanentError: false,
        elapsedTimeMs: Date.now() - taskStart,
      });
      return { result: null, isKeyError: false, isPermanentError: false };
    }

    if (data?.errorId && data.errorId !== 0) {
      const desc = data.errorDescription || data.errorCode || 'createTask rejected';
      const keyError = isCapzyKeyError(data.errorId, data.errorCode, data.errorDescription);
      const permError = isPermanentCapzyError({
        httpStatus: 200,
        errorId: data.errorId,
        errorCode: data.errorCode,
        errorDescription: desc,
        errorCategory: data.errorCode || 'CREATE_TASK_REJECTED',
      });
      setLastCapzyError(desc);
      setLastCapzyDiagnostic({
        providerHttpStatus: 200,
        providerErrorCode: data.errorCode,
        providerErrorCategory: data.errorCode || 'CREATE_TASK_REJECTED',
        providerErrorDescription: desc,
        taskLifecycleState: 'failed',
        permanentError: permError,
        elapsedTimeMs: Date.now() - taskStart,
      });
      logWarn({ errorId: data.errorId, desc: data.errorDescription, code: data.errorCode, keyError, permError, key: maskApiKey(apiKey) }, 'Capzy createTask failed');
      return { result: null, isKeyError: keyError, isPermanentError: permError };
    }

    const taskId = typeof data?.taskId === 'string' ? data.taskId.trim() : typeof data?.taskId === 'number' ? String(data.taskId) : '';
    if (!taskId) {
      setLastCapzyError('Capzy createTask response missing taskId');
      setLastCapzyDiagnostic({
        providerHttpStatus: 200,
        providerErrorCategory: 'MISSING_TASK_ID',
        providerErrorDescription: 'Capzy createTask response missing taskId',
        taskLifecycleState: 'failed',
        permanentError: false,
        elapsedTimeMs: Date.now() - taskStart,
      });
      return { result: null, isKeyError: false, isPermanentError: false };
    }

    setLastCapzyDiagnostic({
      requestAccepted: true,
      taskId,
      taskLifecycleState: 'task_created',
      elapsedTimeMs: Date.now() - taskStart,
    });

    const deadline = Date.now() + taskTimeoutMs;
    const pollIntervalMs = Math.min(2000, Math.max(25, Math.floor(taskTimeoutMs / 4)));
    while (Date.now() < deadline) {
      await attemptSleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
      throwIfAttemptAborted();
      if (Date.now() >= deadline) break;
      setLastCapzyDiagnostic({ taskLifecycleState: 'polling' });
      const poll = await fetch('https://api.capzy.ai/getTaskResult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!poll.ok) {
        if (poll.status === 401 || poll.status === 402 || poll.status === 403) {
          const desc = `HTTP ${poll.status} on getTaskResult`;
          setLastCapzyError(desc);
          setLastCapzyDiagnostic({
            providerHttpStatus: poll.status,
            providerErrorCategory: poll.status === 402 ? 'INSUFFICIENT_BALANCE' : 'AUTHENTICATION_FAILED',
            providerErrorDescription: desc,
            taskLifecycleState: 'failed',
            permanentError: true,
            elapsedTimeMs: Date.now() - taskStart,
          });
          return { result: null, isKeyError: true, isPermanentError: true };
        }
        const pollErr = typeof poll.text === 'function' ? await poll.text().catch(() => '') : '';
        setLastCapzyDiagnostic({
          providerHttpStatus: poll.status,
          providerErrorCategory: `POLL_HTTP_${poll.status}`,
          providerErrorDescription: pollErr.slice(0, 120),
        });
        logWarn({ taskId, status: poll.status, pollErr: pollErr.slice(0, 120) }, 'Capzy getTaskResult returned non-OK HTTP status');
        continue;
      }

      interface CapzyPollResponse {
        errorId?: number;
        errorCode?: string;
        errorDescription?: string;
        status?: string;
        solution?: {
          token?: string;
          turnstileToken?: string;
          cookies?: Record<string, string>;
          cfClearance?: string;
        };
      }
      let res: CapzyPollResponse | null = null;
      try {
        res = (await poll.json()) as CapzyPollResponse;
      } catch (jsonErr) {
        const desc = `Malformed JSON in getTaskResult response: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`;
        setLastCapzyError(desc);
        setLastCapzyDiagnostic({
          providerHttpStatus: poll.status || 200,
          providerErrorCategory: 'MALFORMED_PROVIDER_RESPONSE',
          providerErrorDescription: desc,
          taskLifecycleState: 'failed',
          permanentError: false,
          elapsedTimeMs: Date.now() - taskStart,
        });
        return { result: null, isKeyError: false, isPermanentError: false };
      }

      if (res?.errorId && res.errorId !== 0) {
        const desc = res.errorDescription || res.errorCode || 'getTaskResult reported error';
        const keyError = isCapzyKeyError(res.errorId, res.errorCode, res.errorDescription);
        const permError = isPermanentCapzyError({
          httpStatus: 200,
          errorId: res.errorId,
          errorCode: res.errorCode,
          errorDescription: desc,
          errorCategory: res.errorCode || 'SOLVE_FAILED',
        });
        setLastCapzyError(desc);
        setLastCapzyDiagnostic({
          providerHttpStatus: 200,
          providerErrorCode: res.errorCode,
          providerErrorCategory: res.errorCode || 'SOLVE_FAILED',
          providerErrorDescription: desc,
          taskLifecycleState: 'failed',
          permanentError: permError,
          elapsedTimeMs: Date.now() - taskStart,
        });
        logWarn({ taskId, errorId: res.errorId, code: res.errorCode, desc: res.errorDescription, status: res.status, keyError, permError, key: maskApiKey(apiKey) }, 'Capzy getTaskResult reported error');
        return { result: null, isKeyError: keyError, isPermanentError: permError };
      }

      const normalizedStatus = typeof res?.status === 'string' ? res.status.toLowerCase() : '';
      if (normalizedStatus === 'ready') {
        const solutionCheck = validateCapzySolution(res?.solution, String(task.type || ''));
        if (!solutionCheck.valid) {
          const desc = solutionCheck.reason || 'Capzy returned ready status with invalid solution payload';
          setLastCapzyError(desc);
          setLastCapzyDiagnostic({
            providerHttpStatus: 200,
            providerErrorCategory: 'INVALID_SOLUTION_PAYLOAD',
            providerErrorDescription: desc,
            taskLifecycleState: 'failed',
            permanentError: false,
            elapsedTimeMs: Date.now() - taskStart,
          });
          logWarn({ taskId, reason: desc, key: maskApiKey(apiKey) }, 'Capzy ready response failed solution validation');
          return { result: null, isKeyError: false, isPermanentError: false };
        }

        setLastCapzyDiagnostic({
          providerHttpStatus: 200,
          taskLifecycleState: 'ready',
          operationCompleted: true,
          elapsedTimeMs: Date.now() - taskStart,
        });
        return {
          result: {
            token: solutionCheck.token,
            cookies: solutionCheck.cookies,
            ...(solutionCheck.cfClearance ? { cfClearance: solutionCheck.cfClearance } : {}),
          },
          isKeyError: false,
          isPermanentError: false,
        };
      }

      if (normalizedStatus === 'failed' || normalizedStatus === 'error') {
        const desc = res?.errorDescription || res?.errorCode || `Capzy task ended with status "${res?.status}"`;
        setLastCapzyError(desc);
        setLastCapzyDiagnostic({
          providerHttpStatus: 200,
          providerErrorCode: res?.errorCode,
          providerErrorCategory: res?.errorCode || 'SOLVE_FAILED',
          providerErrorDescription: desc,
          taskLifecycleState: 'failed',
          permanentError: false,
          elapsedTimeMs: Date.now() - taskStart,
        });
        return { result: null, isKeyError: false, isPermanentError: false };
      }
    }

    setLastCapzyError('Capzy task polling timed out waiting for ready status');
    setLastCapzyDiagnostic({
      taskLifecycleState: 'timeout',
      providerErrorCategory: 'POLLING_TIMEOUT',
      providerErrorDescription: 'Capzy task polling timed out waiting for ready status',
      timeoutReason: 'Capzy task polling deadline exceeded',
      permanentError: false,
      elapsedTimeMs: Date.now() - taskStart,
    });
  } catch (err) {
    throwIfAttemptAborted();
    const msg = err instanceof Error ? err.message : String(err);
    setLastCapzyError(msg);
    setLastCapzyDiagnostic({
      providerErrorCategory: 'NETWORK_OR_TIMEOUT',
      providerErrorDescription: msg,
      taskLifecycleState: 'failed',
      timeoutReason: /timeout/i.test(msg) ? msg : undefined,
      permanentError: false,
      elapsedTimeMs: Date.now() - taskStart,
    });
    logWarn({ err: msg, key: maskApiKey(apiKey) }, 'Capzy task execution threw');
  } finally {
    if (store) {
      store.inFlightTask = false;
    }
  }
  return { result: null, isKeyError: false, isPermanentError: false };
}

/**
 * Execute a Capzy task with up to MAX_CAPZY_ATTEMPTS (3) total sequential attempts across the
 * current request context and CAPZY_RETRY_DELAY_MS (10,000ms) delay between retryable failures.
 * Never retries permanent errors (invalid key, zero balance, malformed payload, unsupported sitekey).
 */
async function executeCapzyTaskWithRetries(
  apiKey: string,
  task: Record<string, unknown>,
  taskTimeoutMs: number,
  startingAttemptOffset = 0,
): Promise<{
  result: SolverResult | null;
  isKeyError: boolean;
  isPermanentError: boolean;
  attemptsMade: number;
}> {
  const maxAttempts = getMaxCapzyAttempts();
  const retryDelayMs = getCapzyRetryDelayMs();
  const store = capzyExecutionStorage.getStore();
  let currentAttempt = Math.max(startingAttemptOffset, store?.attemptsUsed ?? 0);

  if (currentAttempt >= maxAttempts) {
    return {
      result: null,
      isKeyError: false,
      isPermanentError: false,
      attemptsMade: currentAttempt,
    };
  }

  if (currentAttempt > 0) {
    const prevErr = getLastCapzyError() || 'previous attempt failed';
    logWarn(
      {
        attempt: currentAttempt,
        maxAttempts,
        retryDelayMs,
        taskType: task.type,
        lastError: prevErr,
        key: maskApiKey(apiKey),
      },
      `Capzy attempt ${currentAttempt}/${maxAttempts} failed (${prevErr}); waiting ${retryDelayMs}ms before next attempt`,
    );
    if (retryDelayMs > 0) {
      await attemptSleep(retryDelayMs);
    }
    throwIfAttemptAborted();
  }

  while (currentAttempt < maxAttempts) {
    throwIfAttemptAborted();
    currentAttempt += 1;
    if (store) {
      store.attemptsUsed = currentAttempt;
    }

    const outcome = await executeSingleCapzyTask({
      apiKey,
      task,
      taskTimeoutMs,
      attemptNumber: currentAttempt,
      maxAttempts,
      retryDelayMs,
    });

    if (outcome.result) {
      return {
        result: outcome.result,
        isKeyError: false,
        isPermanentError: false,
        attemptsMade: currentAttempt,
      };
    }

    if (outcome.isKeyError) {
      // Do not charge a retryable attempt against the next healthy API key when rotating away from an invalid/exhausted key
      currentAttempt = Math.max(0, currentAttempt - 1);
      if (store) {
        store.attemptsUsed = currentAttempt;
      }
      return {
        result: null,
        isKeyError: true,
        isPermanentError: outcome.isPermanentError,
        attemptsMade: currentAttempt,
      };
    }

    if (outcome.isPermanentError) {
      return {
        result: null,
        isKeyError: false,
        isPermanentError: true,
        attemptsMade: getLastCapzyDiagnostic().providerErrorCategory === 'INVALID_REQUEST_CONFIGURATION' ? 0 : currentAttempt,
      };
    }

    if (currentAttempt < maxAttempts) {
      const lastErr = getLastCapzyError() || 'retryable failure';
      logWarn(
        {
          attempt: currentAttempt,
          maxAttempts,
          retryDelayMs,
          taskType: task.type,
          lastError: lastErr,
          key: maskApiKey(apiKey),
        },
        `Capzy attempt ${currentAttempt}/${maxAttempts} failed (${lastErr}); waiting ${retryDelayMs}ms before next attempt`,
      );
      if (retryDelayMs > 0) {
        await attemptSleep(retryDelayMs);
      }
      throwIfAttemptAborted();
    }
  }

  return {
    result: null,
    isKeyError: false,
    isPermanentError: false,
    attemptsMade: currentAttempt,
  };
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

  return withCapzyRequestContext(async () => {
    const maxAttempts = getMaxCapzyAttempts();
    const retryDelayMs = getCapzyRetryDelayMs();

    const targetUrl = typeof websiteURL === 'string' ? websiteURL.split('#')[0] : '';
    const sanitizedUa =
      userAgent && !/HeadlessChrome/i.test(userAgent)
        ? userAgent
        : DEFAULT_DESKTOP_CHROME_USER_AGENT;
    const ua = sanitizedUa;
    const trimmedSitekey = typeof sitekey === 'string' ? sitekey.trim() : '';
    const preflightTask: Record<string, unknown> = {
      type: 'AntiTurnstileTaskProxyLess',
      websiteURL: targetUrl,
      websiteKey: trimmedSitekey,
      userAgent: ua,
      ...(action ? { action } : {}),
      ...(cdata ? { cdata } : {}),
      ...(action || cdata ? { metadata: { ...(action ? { action } : {}), ...(cdata ? { cdata } : {}) } } : {}),
    };

    const candidateKeys = await getCandidateCapzyKeys(overrideKeys);
    if (candidateKeys.length === 0) {
      setLastCapzyError('No Capzy/CapSolver API keys configured');
      setLastCapzyDiagnostic({
        adapterName: 'capzy',
        taskLifecycleState: 'failed',
        providerErrorCategory: 'AUTHENTICATION_FAILED',
        providerErrorDescription: 'No Capzy/CapSolver API keys configured',
        permanentError: true,
        requestAccepted: false,
        operationCompleted: false,
        attemptsMade: 0,
        maxAttempts,
        retryDelayMs,
      });
      logWarn({}, 'Capzy solver skipped: no Capzy/CapSolver API keys configured');
      return null;
    }

    const preflightCheck = validateCapzyTaskPayload({ clientKey: candidateKeys[0], task: preflightTask });
    if (!preflightCheck.valid) {
      const isMissingSitekey = !trimmedSitekey;
      const errCode = isMissingSitekey ? 'MISSING_TURNSTILE_SITEKEY' : 'INVALID_REQUEST_CONFIGURATION';
      const desc = `Invalid Capzy request payload: ${preflightCheck.errors.join('; ')}`;
      const sanitizedRequest = sanitizeCapzyRequestPayload({ clientKey: candidateKeys[0], task: preflightTask });
      setLastCapzyError(desc);
      setLastCapzyDiagnostic({
        adapterName: 'capzy',
        taskLifecycleState: 'failed',
        providerErrorCode: errCode,
        providerErrorCategory: 'INVALID_REQUEST_CONFIGURATION',
        providerErrorDescription: desc,
        permanentError: true,
        requestAccepted: false,
        operationCompleted: false,
        elapsedTimeMs: 0,
        attemptsMade: 0,
        maxAttempts,
        retryDelayMs,
        sanitizedRequest,
      });
      logWarn({ errors: preflightCheck.errors, sanitizedRequest }, 'Capzy Turnstile request rejected by pre-flight schema validator');
      return null;
    }

    const proxy =
      proxyUrl ||
      (websiteURL.includes('codeforces.com') ? process.env.CODEFORCES_PROXY?.trim() : undefined) ||
      undefined;

    const isRefusingProxy = !!proxy && (proxy.includes('joyproxy.com') || proxy.includes('busyip.com'));
    const isLoopbackProxy = !!proxy && /(?:^|\/\/)(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(proxy);
    const useTurnstileProxy =
      process.env.CAPZY_TURNSTILE_PROXY !== 'false' &&
      Boolean(proxy && !isRefusingProxy && !isLoopbackProxy);

    // When a valid non-loopback proxy is provided (or CAPZY_TURNSTILE_PROXY is enabled), construct and validate AntiTurnstileTask;
    // otherwise use AntiTurnstileTaskProxyLess consistently across all attempts.
    let selectedTask: Record<string, unknown> = preflightTask;
    if (useTurnstileProxy && proxy) {
      let candidateProxyTask: Record<string, unknown> | null = null;
      try {
        const parsed = new URL(proxy);
        const parsedPort = parseInt(parsed.port, 10);
        candidateProxyTask = {
          type: 'AntiTurnstileTask',
          websiteURL: targetUrl,
          websiteKey: trimmedSitekey,
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
      } catch {
        candidateProxyTask = {
          type: 'AntiTurnstileTask',
          websiteURL: targetUrl,
          websiteKey: trimmedSitekey,
          proxyType: '',
          proxyAddress: '',
          proxyPort: 0,
          userAgent: ua,
        };
      }
      const proxyValidation = validateCapzyTaskPayload({ clientKey: candidateKeys[0], task: candidateProxyTask });
      if (!proxyValidation.valid) {
        const desc = `Invalid Capzy proxy request payload: ${proxyValidation.errors.join('; ')}`;
        const sanitizedRequest = sanitizeCapzyRequestPayload({ clientKey: candidateKeys[0], task: candidateProxyTask });
        setLastCapzyError(desc);
        setLastCapzyDiagnostic({
          adapterName: 'capzy',
          taskLifecycleState: 'failed',
          providerErrorCode: 'INVALID_PROXY_CONFIGURATION',
          providerErrorCategory: 'INVALID_REQUEST_CONFIGURATION',
          providerErrorDescription: desc,
          permanentError: true,
          requestAccepted: false,
          operationCompleted: false,
          elapsedTimeMs: 0,
          attemptsMade: 0,
          maxAttempts,
          retryDelayMs,
          sanitizedRequest,
        });
        logWarn({ errors: proxyValidation.errors, sanitizedRequest }, 'Capzy proxied Turnstile request rejected by pre-flight schema validator');
        return null;
      }
      selectedTask = candidateProxyTask;
    }

    for (const apiKey of candidateKeys) {
      throwIfAttemptAborted();
      const store = capzyExecutionStorage.getStore();
      if ((store?.attemptsUsed ?? 0) >= maxAttempts) {
        break;
      }

      const { result, isKeyError, isPermanentError } = await executeCapzyTaskWithRetries(
        apiKey,
        selectedTask,
        timeoutMs,
        store?.attemptsUsed ?? 0,
      );
      if (result?.token) return result;
      if (isKeyError) {
        await rotateToNextCapzyKey(apiKey, 'Key invalid or zero balance during Turnstile task', overrideKeys);
        continue;
      }

      if (isPermanentError || (store?.attemptsUsed ?? 0) >= maxAttempts) {
        break;
      }
    }

    return null;
  });
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
  return withCapzyRequestContext(async () => {
    const resolvedSitekey = typeof sitekey === 'string' && sitekey.trim() ? sitekey.trim() : undefined;
    if (resolvedSitekey) {
      return solveTurnstileWithCapzy(websiteURL, resolvedSitekey, proxyUrl, userAgent, timeoutMs, action, cdata, overrideKeys);
    }

    const maxAttempts = getMaxCapzyAttempts();
    const retryDelayMs = getCapzyRetryDelayMs();
    const candidateKeys = await getCandidateCapzyKeys(overrideKeys);
    if (candidateKeys.length === 0) {
      setLastCapzyError('No Capzy/CapSolver API keys configured');
      setLastCapzyDiagnostic({
        adapterName: 'capzy',
        taskLifecycleState: 'failed',
        providerErrorCategory: 'AUTHENTICATION_FAILED',
        providerErrorDescription: 'No Capzy/CapSolver API keys configured',
        permanentError: true,
        requestAccepted: false,
        operationCompleted: false,
        attemptsMade: 0,
        maxAttempts,
        retryDelayMs,
      });
      logWarn({}, 'Capzy solver skipped: no Capzy/CapSolver API keys configured');
      return null;
    }

    const proxy =
      proxyUrl ||
      process.env.CODEFORCES_PROXY?.trim() ||
      process.env.LEETCODE_RESIDENTIAL_PROXY?.trim() ||
      process.env.LEETCODE_PROXY?.trim() ||
      undefined;
    const ua =
      userAgent && !/HeadlessChrome/i.test(userAgent)
        ? userAgent
        : DEFAULT_DESKTOP_CHROME_USER_AGENT;
    const isRefusingProxy = !!proxy && (proxy.includes('joyproxy.com') || proxy.includes('busyip.com'));
    const targetUrl = typeof websiteURL === 'string' ? websiteURL.split('#')[0] : '';

    if (proxy && !isRefusingProxy) {
      let cfTask: Record<string, unknown> | null = null;
      try {
        const parsed = new URL(proxy);
        const parsedPort = parseInt(parsed.port, 10);
        cfTask = {
          type: 'AntiCloudflareTask',
          websiteURL: targetUrl,
          proxyType: parsed.protocol.replace(':', '') || 'http',
          proxyAddress: parsed.hostname,
          proxyPort: !isNaN(parsedPort) && parsedPort > 0 ? parsedPort : (parsed.protocol === 'https:' ? 443 : 80),
          ...(parsed.username ? { proxyLogin: decodeURIComponent(parsed.username) } : {}),
          ...(parsed.password ? { proxyPassword: decodeURIComponent(parsed.password) } : {}),
          userAgent: ua,
        };
      } catch {
        cfTask = {
          type: 'AntiCloudflareTask',
          websiteURL: targetUrl,
          proxyType: '',
          proxyAddress: '',
          proxyPort: 0,
          userAgent: ua,
        };
      }

      const preflight = validateCapzyTaskPayload({ clientKey: candidateKeys[0], task: cfTask });
      if (!preflight.valid) {
        const desc = `Invalid Capzy AntiCloudflareTask payload: ${preflight.errors.join('; ')}`;
        const sanitizedRequest = sanitizeCapzyRequestPayload({ clientKey: candidateKeys[0], task: cfTask });
        setLastCapzyError(desc);
        setLastCapzyDiagnostic({
          adapterName: 'capzy',
          taskLifecycleState: 'failed',
          providerErrorCode: 'INVALID_PROXY_CONFIGURATION',
          providerErrorCategory: 'INVALID_REQUEST_CONFIGURATION',
          providerErrorDescription: desc,
          permanentError: true,
          requestAccepted: false,
          operationCompleted: false,
          elapsedTimeMs: 0,
          attemptsMade: 0,
          maxAttempts,
          retryDelayMs,
          sanitizedRequest,
        });
        logWarn({ errors: preflight.errors, sanitizedRequest }, 'Capzy AntiCloudflareTask rejected by pre-flight schema validator');
        return null;
      }

      for (const apiKey of candidateKeys) {
        throwIfAttemptAborted();
        const store = capzyExecutionStorage.getStore();
        if ((store?.attemptsUsed ?? 0) >= maxAttempts) {
          break;
        }
        const outcome = await executeCapzyTaskWithRetries(apiKey, cfTask, timeoutMs, store?.attemptsUsed ?? 0);
        if (outcome.result && (outcome.result.token || outcome.result.cfClearance || hasClearanceCookie(outcome.result.cookies))) {
          return {
            token: outcome.result.token,
            cookies: outcome.result.cookies,
            cfClearance: outcome.result.cfClearance || outcome.result.cookies?.cf_clearance,
          };
        }
        if (outcome.isKeyError) {
          await rotateToNextCapzyKey(apiKey, getLastCapzyError() || 'Key error on AntiCloudflareTask', overrideKeys);
          continue;
        }
        if (outcome.isPermanentError || (store?.attemptsUsed ?? 0) >= maxAttempts) {
          break;
        }
      }
      return null;
    }

    // Never substitute a synthetic or documentation-example Turnstile sitekey when both sitekey and valid proxy are missing
    const missingDesc = 'AntiCloudflareTask requires a valid proxy configuration when no Turnstile sitekey is present on the challenge page.';
    const missingTask: Record<string, unknown> = {
      type: 'AntiCloudflareTask',
      websiteURL: targetUrl,
      userAgent: ua,
    };
    const sanitizedRequest = sanitizeCapzyRequestPayload({ clientKey: candidateKeys[0], task: missingTask });
    setLastCapzyError(missingDesc);
    setLastCapzyDiagnostic({
      adapterName: 'capzy',
      taskLifecycleState: 'failed',
      providerErrorCode: 'ERROR_PROXY_REQUIRED',
      providerErrorCategory: 'INVALID_REQUEST_CONFIGURATION',
      providerErrorDescription: missingDesc,
      permanentError: true,
      requestAccepted: false,
      operationCompleted: false,
      elapsedTimeMs: 0,
      attemptsMade: 0,
      maxAttempts,
      retryDelayMs,
      sanitizedRequest,
    });
    logWarn({ websiteURL: targetUrl, sanitizedRequest }, missingDesc);
    return null;
  });
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
  const hasRuntimeSitekey = typeof params.sitekey === 'string' && params.sitekey.trim().length > 0;

  // Phase 1: Local / Render CPSolver. Explicit no-token verification timeouts
  // stop here; only other failures retain the existing retry policy.
  if (solverUrl && hasRuntimeSitekey) {
    let solverHost = solverUrl;
    try {
      solverHost = new URL(solverUrl).host;
    } catch {}

    const maxTries = Math.min(10, positiveInteger(process.env.CPSOLVER_MAX_TRIES, 3));
    const cpsolverTimeoutMs = Math.min(timeoutMs, positiveInteger(process.env.CPSOLVER_TIMEOUT_MS, 90_000));
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
        isRealClearanceValue(res.cfClearance) ||
        hasClearanceCookie(res.cookies)
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
  const resolvedSitekey = params.sitekey;
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

    const maxTries = Math.min(10, positiveInteger(process.env.CPSOLVER_MAX_TRIES, 3));
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

      const hasToken = typeof res.token === 'string' && res.token.trim().length > 10;
      if (res.ok && (hasToken || isRealClearanceValue(res.cfClearance) || hasClearanceCookie(res.cookies))) {
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
