/**
 * Isolated Codeforces submitter — its OWN Render free web service.
 *
 * Why this exists
 * ---------------
 * A headless Firefox costs ~390MB the moment it launches (measured in this
 * repo: 115MB -> 502MB of cgroup charge on a 512MB instance), which cannot
 * coexist with the main service's Telegram bot, Prisma client and LeetCode
 * scheduler. Every attempt to submit from inside the main container ended in
 * either an OOM kill ("Ran out of memory (used over 512MB)" — which restarts
 * the whole service) or the memory watchdog closing the browser mid-navigation.
 *
 * This service is deliberately tiny and self-contained: NO Prisma, NO Telegram,
 * NO scheduler, NO LeetCode and no import of the main app's config, so that the
 * whole 512MB cgroup belongs to one Firefox. It does NOT import the app's
 * submission module for the same reason — that module pulls in the config layer.
 *
 * Routes:
 *   GET  /health  -> liveness, used by the main service to wait out a cold start
 *   POST /submit  -> one submission attempt (bearer token), one at a time
 *
 * It never retries its own POST: a retry after an ambiguous network failure
 * could create a duplicate Codeforces submission.
 */
import http from 'node:http';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { AttemptCancelledError, attemptSleep, getAttemptContext, throwIfAttemptAborted, withAttemptContext } from './attemptContext';
import { diagnosticLog, logRingBuffer } from './diagnosticLog';
export { logRingBuffer } from './diagnosticLog';
import { ActionBroker, dispatchAction } from './actionBroker';
import { submissionLogSummary } from './submissionLog';
import { BrowserFormError, clickSubmitForm, ensureFormTurnstile, fillSource, isSubmissionHistory, blockCodeforcesResource, solveCloudflareWithCapzy, getDefaultUserAgent } from './browserForm';
import { initCapzyKeys, getActiveCapzyKeyIndex } from './capzyKeyManager';
import { solveCloudflareOrchestrated, initCPSolverConfig, getCPSolverUrl } from './captchaSolver';
import { applyStealthScripts, interactWithTurnstileCheckbox } from '../browser/stealth';
import { parseProxyList } from './proxyRotator';
import { chromium, firefox, type Browser, type BrowserContext, type Page } from 'playwright';

const PORT = Number(process.env.PORT ?? 10000);
const TOKEN = process.env.CODEFORCES_SUBMITTER_TOKEN?.trim() ?? '';
const HEADLESS = process.env.HEADLESS !== 'false';
const BROWSER_ENGINE = process.env.CODEFORCES_BROWSER === 'chromium' ? 'chromium' : 'firefox';
const BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const NAV_TIMEOUT_MS = Number(process.env.CODEFORCES_NAV_TIMEOUT_MS ?? 60_000);
const TURNSTILE_WAIT_MS = Math.max(Number(process.env.CODEFORCES_TURNSTILE_WAIT_MS ?? 90_000), 60_000);
const CHALLENGE_WAIT_MS = Number(process.env.CODEFORCES_CHALLENGE_WAIT_MS ?? 50_000);
const BROWSER_MIN_FREE_MB = Number(process.env.CODEFORCES_BROWSER_MIN_FREE_MB ?? 300);
// Outbound proxy for Firefox, e.g. socks5://127.0.0.1:40000 (the local WARP
// tunnel started by scripts/start-submitter.sh). Empty = direct connection.
const PROXY_SERVER = (process.env.CODEFORCES_PROXY ?? '').trim();
const RUNNER_REPOSITORY = (process.env.CODEFORCES_RUNNER_REPOSITORY ?? '').trim();
const GITHUB_DISPATCH_TOKEN = (process.env.GITHUB_DISPATCH_TOKEN ?? '').trim();
// Default to the self-contained Render browser. GitHub-hosted execution must be
// opted into explicitly because dispatch can succeed even when account billing
// prevents the workflow job from ever starting.
const RUNNER_MODE = (process.env.CODEFORCES_RUNNER_MODE ?? 'render').trim().toLowerCase();
const LOCAL_RUNNER_MODE = RUNNER_MODE === 'local';
const GITHUB_RUNNER_MODE = RUNNER_MODE === 'github';
const LOCAL_RUNNER_TOKEN = (process.env.CODEFORCES_LOCAL_RUNNER_TOKEN ?? '').trim();
const broker = (GITHUB_RUNNER_MODE && RUNNER_REPOSITORY) || LOCAL_RUNNER_MODE
  ? new ActionBroker((id) => LOCAL_RUNNER_MODE ? Promise.resolve() : dispatchAction(RUNNER_REPOSITORY, GITHUB_DISPATCH_TOKEN, id))
  : null;

let syncedProxies: string[] = [];

const CHALLENGE_RE = /just a moment|checking your browser|verify you are human|cf-chl|enable javascript and cookies/i;
const SIGNED_OUT_RE = /you are not logged in|please login|please sign in|not logged in|register for practice/i;
const REJECTION_RE =
  /you have submitted exactly the same code before|source code is too long|submission failed|invalid csrf|you are not allowed to submit|no such problem|problem not found|not a participant|captcha|turnstile|verification|verify you are human|solve the challenge|security check/i;

interface SubmitterEntry {
  contestId: number;
  problemIndex: string;
  gym?: boolean;
  language?: string;
}

interface SubmitRequest {
  attemptDeadline?: number;
  requiresPostAuthorization?: boolean;
  requestId?: string;
  label?: string;
  handle?: string;
  code: string;
  entry: SubmitterEntry;
  state: { cookies: unknown[]; origins?: unknown[] };
  networkMode?: 'proxy' | 'tailscale';
  proxy?: string;
  capzyApiKeys?: string[];
  capzyActiveKeyIndex?: number;
  cpsolverUrl?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
}

interface SubmitResponse {
  ok: boolean;
  kind?: 'signed-out' | 'blocked' | 'submission-error';
  error?: string;
  status: number | null;
  finalUrl: string;
  clicked: boolean;
  turnstile: boolean;
  interactive: boolean;
  updatedCookies?: unknown[];
  activeCapzyKeyIndex?: number;
}

let busy = false;

// ---------------------------------------------------------------------------
// Minimal logging (no app imports). Same shape as the main service's pino lines
// so both services' output reads consistently in the Render log view.
// ---------------------------------------------------------------------------

function log(fields: Record<string, unknown>, msg: string): void {
  diagnosticLog('codeforces-submit-browser', 30, fields, msg);
}

function logWarn(fields: Record<string, unknown>, msg: string): void {
  diagnosticLog('codeforces-submit-browser', 40, fields, msg);
}

function logError(fields: Record<string, unknown>, msg: string): void {
  diagnosticLog('codeforces-submit-browser', 50, fields, msg);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return attemptSleep(ms);
}

// ---------------------------------------------------------------------------
// Memory telemetry (cgroup v2/v1) — the same accounting Render bills and kills on
// ---------------------------------------------------------------------------

function cgroupUsedMb(): number | null {
  const candidates = [
    '/sys/fs/cgroup/memory.current',
    '/sys/fs/cgroup/memory/memory.usage_in_bytes',
  ];
  for (const path of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const raw = require('node:fs').readFileSync(path, 'utf8').trim();
      if (raw && raw !== 'max') {
        const value = Number(raw);
        if (Number.isFinite(value) && value < 1e15) return Math.round(value / 1_048_576);
      }
    } catch {
      // try the next layout
    }
  }
  return null;
}

function freeMemoryMb(): number | null {
  const cgroupLimit = (() => {
    try {
      const raw = require('node:fs').readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
      return raw === 'max' ? null : Math.round(Number(raw) / 1_048_576);
    } catch { return null; }
  })();
  const limit = Number(process.env.MEMORY_LIMIT_MB ?? cgroupLimit ?? Math.round(os.totalmem() / 1_048_576));
  const used = cgroupUsedMb();
  return used === null ? Math.round(os.freemem() / 1_048_576) : Math.max(0, limit - used);
}

function releaseHeap(): void {
  (globalThis as { gc?: () => void }).gc?.();
}

// ---------------------------------------------------------------------------
// Firefox
// ---------------------------------------------------------------------------

interface Session {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  traffic: BrowserTrafficMeter;
  close: () => Promise<void>;
}

interface BrowserTrafficMeter {
  record: (url: string, type: string, bytes: number) => void;
  summary: () => { responses: number; bytes: number; codeforcesBytes: number; challengeBytes: number; otherBytes: number };
}

function createBrowserTrafficMeter(): BrowserTrafficMeter {
  let responses = 0;
  let bytes = 0;
  let codeforcesBytes = 0;
  let challengeBytes = 0;
  let otherBytes = 0;
  return {
    record(url, type, size) {
      // Only count useful page response bodies. Headers and the proxy tunnel
      // overhead are provider-specific, but this makes unexpected payloads
      // visible in the GitHub runner log without recording URLs or secrets.
      if (!Number.isFinite(size) || size <= 0 || type === 'document' && size > 10 * 1024 * 1024) return;
      responses += 1;
      bytes += size;
      try {
        const host = new URL(url).hostname.toLowerCase();
        if (host === 'challenges.cloudflare.com' || host.endsWith('.challenges.cloudflare.com')) challengeBytes += size;
        else if (host === 'codeforces.com' || host.endsWith('.codeforces.com')) codeforcesBytes += size;
        else otherBytes += size;
      } catch { otherBytes += size; }
    },
    summary: () => ({ responses, bytes, codeforcesBytes, challengeBytes, otherBytes }),
  };
}

/** Converts the standard provider endpoint into Playwright's proxy shape.
 * Credentials remain separate from the server field and are never logged. */
function browserProxy(raw: string): { server: string; username?: string; password?: string } | undefined {
  if (!raw) return undefined;
  const first = parseProxyList(raw)[0] ?? raw.trim();
  try {
    const endpoint = new URL(first);
    if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(endpoint.protocol) || !endpoint.hostname) return undefined;
    const server = `${endpoint.protocol}//${endpoint.host}`;
    const username = decodeURIComponent(endpoint.username);
    const password = decodeURIComponent(endpoint.password);
    return { server, ...(username ? { username } : {}), ...(password ? { password } : {}) };
  } catch {
    return undefined;
  }
}

function proxyLabel(proxy: ReturnType<typeof browserProxy>): string {
  if (!proxy) return 'direct';
  try { return new URL(proxy.server).origin; } catch { return 'configured'; }
}

async function launchFirefox(
  state: SubmitRequest['state'],
  label: string,
  networkMode: SubmitRequest['networkMode'] = 'proxy',
  proxyUrl?: string,
): Promise<Session> {
  let browser: Browser | null = null;
  const configuredProxy = (proxyUrl || PROXY_SERVER || '').trim();
  const proxy = networkMode === 'tailscale' ? undefined : browserProxy(configuredProxy);
  if (networkMode !== 'tailscale' && configuredProxy && !proxy) {
    throw new Error('CODEFORCES_PROXY must be a http(s), socks4, or socks5 endpoint');
  }
  const isCloudRunner = process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true' || process.env.STRICT_PROXY === 'true';
  if (networkMode !== 'tailscale' && !proxy && isCloudRunner) {
    throw new Error('Residential proxy is strictly required on cloud runners to prevent Cloudflare datacenter IP detection');
  }
  try {
    const useModernHeadless = BROWSER_ENGINE === 'chromium' && HEADLESS;
    const active = (browser = await (BROWSER_ENGINE === 'chromium' ? chromium : firefox).launch({
      headless: useModernHeadless ? false : HEADLESS,
      ...(proxy ? { proxy } : {}),
      ...(BROWSER_ENGINE === 'chromium' ? {
        // Keep the browser's native identity and automation defaults. Only
        // suppress browser-owned background downloads to conserve proxy data.
        args: [
          ...(useModernHeadless ? ['--headless=new'] : []),
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
          '--disable-component-update', '--safebrowsing-disable-auto-update',
          '--disable-sync', '--disable-default-apps', '--no-default-browser-check',
          '--disable-background-networking', '--disable-domain-reliability',
          '--metrics-recording-only', '--no-pings',
        ],
      } : {
        firefoxUserPrefs: {
          // Memory / process / session — keep footprint tiny
          'browser.cache.disk.enable': false,
          'browser.cache.memory.enable': false,
          'browser.cache.offline.enable': false,
          'browser.cache.memory.capacity': 0,
          'browser.sessionhistory.max_entries': 2,
          'browser.sessionstore.max_tabs_undo': 0,
          'browser.sessionstore.max_windows_undo': 0,
          'network.prefetch-next': false,
          'browser.newtabpage.enabled': false,
          'toolkit.telemetry.enabled': false,
          'datareporting.policy.dataSubmissionEnabled': false,
          'dom.ipc.processCount': 1,
          'dom.ipc.processPrelaunch.enabled': false,
          'dom.ipc.keepProcessesAlive.web': 0,
        },
      }),
    }));
    const context = await active.newContext({
      storageState: { cookies: state.cookies ?? [], origins: state.origins ?? [] } as Parameters<
        BrowserContext['storageState']
      > extends never
        ? never
        : never,
      userAgent: getDefaultUserAgent(BROWSER_ENGINE),
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
      serviceWorkers: 'allow',
    });
    await applyStealthScripts(context, BROWSER_ENGINE);
    if (process.env.CODEFORCES_BLOCK_ASSETS !== 'false') {
      await context.route('**/*', async (route) => {
        const type = route.request().resourceType();
        if (blockCodeforcesResource(route.request().url(), type)) {
          await route.abort();
          return;
        }
        await route.continue();
      });
    }
    const traffic = createBrowserTrafficMeter();
    context.on('response', (response) => {
      void response.allHeaders()
        .then((headers) => traffic.record(response.url(), response.request().resourceType(), Number(headers['content-length'] ?? 0)))
        .catch(() => undefined);
    });
    const page = context.pages()[0] ?? (await context.newPage());
    return {
      browser: active,
      context,
      page,
      traffic,
      close: async () => {
        await context.close().catch(() => undefined);
        await active.close().catch(() => undefined);
      },
    };
  } catch (err) {
    await browser?.close().catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Submit-form handling (the same selectors/logic as the main app's browser path)
// ---------------------------------------------------------------------------

function candidates(entry: SubmitterEntry): string[] {
  if (entry.gym) return [`/gym/${entry.contestId}/submit`];
  return [
    `/contest/${entry.contestId}/submit`,
    `/problemset/submit/${entry.contestId}/${entry.problemIndex}`,
    `/problemset/submit?contestId=${entry.contestId}&problemIndex=${entry.problemIndex}`,
  ];
}

async function readBody(page: Page): Promise<string> {
  const body = (await page.locator('body').innerText().catch(() => '')) ?? '';
  return body.slice(0, 20_000);
}

async function readFields(page: Page): Promise<Array<{ name: string; tag: string }>> {
  return page
    .evaluate(() =>
      Array.from(document.querySelectorAll('input, select, textarea')).map((element) => ({
        name: element.getAttribute('name') ?? '',
        tag: element.tagName.toLowerCase(),
      })),
    )
    .catch(() => []);
}

function hasSubmitForm(fields: Array<{ name: string; tag: string }>): boolean {
  return (
    fields.some((field) => field.tag === 'textarea' && field.name === 'source') &&
    fields.some((field) => field.tag === 'select' && field.name === 'programTypeId')
  );
}

function summarize(fields: Array<{ name: string; tag: string }>): string {
  const names = fields.map((field) => field.name).filter(Boolean);
  return names.length > 0 ? names.join(', ') : '(no named fields)';
}

async function waitOutChallenge(page: Page, timeoutMs = CHALLENGE_WAIT_MS, proxyUrl?: string, overrideKeys?: string[]): Promise<boolean> {
  if (timeoutMs === 0 || typeof page.context !== 'function') return false;
  const effectiveTimeout = Math.max(timeoutMs, 50_000);
  const deadline = Date.now() + effectiveTimeout;
  const currentUrl = page.url() || 'https://codeforces.com';
  const initialTitle = await page.title().catch(() => '');

  log({ url: currentUrl, title: initialTitle, timeoutMs, effectiveTimeout, hasProxy: !!proxyUrl }, 'waitOutChallenge: starting challenge resolution');

  // Check if challenge is already gone before doing anything
  const initialIsChallenge = /just a moment|checking your browser|attention required|cloudflare/i.test(initialTitle);
  if (!initialIsChallenge && initialTitle.toLowerCase().includes('codeforces')) {
    const loc = page.locator('#header, #body, #pageContent, form:has(textarea[name="source"])');
    if ((await loc.count().catch(() => 0)) > 0) {
      log({ title: initialTitle }, 'waitOutChallenge: page already has Codeforces content, no wait needed');
      return true;
    }
  }

  const solverUrl = getCPSolverUrl();
  if (proxyUrl || solverUrl) {
    try {
      const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => undefined);
      const currentCookies = await page.context().cookies().catch(() => []);
      log({ solverUrl, userAgent: userAgent?.slice(0, 80), url: currentUrl }, 'waitOutChallenge: invoking solveCloudflareOrchestrated synchronously');

      const solveStart = Date.now();
      const result = await solveCloudflareOrchestrated({
        websiteURL: currentUrl,
        proxyUrl,
        userAgent,
        cookies: currentCookies,
        timeoutMs: Math.max(35_000, timeoutMs),
        overrideKeys,
      });

      const solveDuration = Date.now() - solveStart;
      log({
        durationMs: solveDuration,
        ok: !!result,
        source: result?.source,
        hasToken: !!result?.token,
        cookieCount: Object.keys(result?.cookies ?? {}).length,
        hasClearance: !!result?.cfClearance,
      }, 'waitOutChallenge: solveCloudflareOrchestrated returned');

      const cookiesToSet: Array<{ name: string; value: string; domain: string; path: string }> = [];
      if (result?.cookies && Object.keys(result.cookies).length > 0) {
        for (const [name, value] of Object.entries(result.cookies)) {
          if (name.toLowerCase().startsWith('cf_') || name.toLowerCase().startsWith('__cf')) {
            cookiesToSet.push({ name, value: String(value), domain: '.codeforces.com', path: '/' });
          }
        }
      }
      if (result?.cfClearance && result.cfClearance.length > 5 && result.cfClearance !== 'cleared') {
        if (!cookiesToSet.some((c) => c.name === 'cf_clearance')) {
          cookiesToSet.push({ name: 'cf_clearance', value: result.cfClearance, domain: '.codeforces.com', path: '/' });
        }
      }

      if (cookiesToSet.length > 0 || Boolean(result)) {
        if (cookiesToSet.length > 0) {
          log({ count: cookiesToSet.length, names: cookiesToSet.map((c) => c.name), source: result?.source }, 'waitOutChallenge: injecting Cloudflare clearance cookies into browser context');
          await page.context().addCookies(cookiesToSet).catch((err) => {
            logWarn({ err: String(err) }, 'waitOutChallenge: addCookies threw');
          });
        }

        await sleep(500);

          log({ url: page.url() }, 'waitOutChallenge: reloading page after cookie injection...');
          const reloadRes = await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch((err) => {
            logWarn({ err: String(err) }, 'waitOutChallenge: reload threw');
            return null;
          });

          await sleep(2000);

          const postTitle = await page.title().catch(() => '');
          const postUrl = page.url();
          const isStillChallenge = /just a moment|checking your browser|attention required|cloudflare/i.test(postTitle);
          const hasContent = await page.locator('#header, #body, #pageContent, form:has(textarea[name="source"])').count().catch(() => 0);

          log({
            postStatus: reloadRes?.status() ?? null,
            postTitle,
            postUrl,
            isStillChallenge,
            hasContent,
          }, 'waitOutChallenge: post-reload verification check');

          if (!isStillChallenge && hasContent > 0) {
            log({ postTitle, hasContent }, 'waitOutChallenge: challenge successfully cleared after solver cookies injection!');
            return true;
          }
        }
    } catch (solverErr) {
      throwIfAttemptAborted();
      logWarn({ err: errorMessage(solverErr) }, 'waitOutChallenge: orchestrated solver threw an error');
    }
  }

  // Fallback: check loop until deadline
  let clickAttemptedAt = 0;
  while (Date.now() < deadline) {
    throwIfAttemptAborted();
    try {
      const cookies = await page.context().cookies().catch(() => []);
      const hasClearance = cookies.some((c) => c.name === 'cf_clearance' && c.value.length > 5);
      if (hasClearance) {
        log({}, 'waitOutChallenge: cf_clearance cookie detected in cookie jar');
        return true;
      }
    } catch {}

    try {
      const title = await page.title().catch(() => '');
      const isChallengeTitle = /just a moment|checking your browser|attention required|cloudflare/i.test(title);
      const isCodeforces = title.toLowerCase().includes('codeforces') && !isChallengeTitle;
      const loc = page.locator('#header, #body, #pageContent, .main-menu-list, form:has(textarea[name="source"])');
      const count = await loc.count().catch(() => 0);
      if (isCodeforces && count > 0) {
        log({ title, count }, 'waitOutChallenge: Codeforces page content detected');
        return true;
      }
    } catch {}

    if (Date.now() > clickAttemptedAt + 3_500) {
      clickAttemptedAt = Date.now();
      try {
        const handled = await interactWithTurnstileCheckbox(page);
        if (!handled && typeof page.frameLocator === 'function') {
          const frameLocator = page.frameLocator('iframe[src*="challenges.cloudflare.com"], iframe[src*="challenge-platform"], iframe[title*="Turnstile"], iframe[title*="Cloudflare"]').first();
          const checkbox = frameLocator.locator('.ctp-checkbox-container, .mark, input[type="checkbox"], #challenge-stage, #cf-stage').first();
          if ((await checkbox.count().catch(() => 0)) > 0) {
            await checkbox.click({ force: true, timeout: 1500 }).catch(() => {});
          }
        }
      } catch {}
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(500, Math.max(10, remaining)));
  }

  logWarn({ url: page.url(), title: await page.title().catch(() => '') }, 'waitOutChallenge: challenge did not clear before deadline');
  return false;
}

export async function openSubmitForm(page: Page, entry: SubmitterEntry, proxyUrl?: string, overrideKeys?: string[]): Promise<void> {
  const paths = candidates(entry);
  const attempts: string[] = [];

  for (const path of paths) {
    throwIfAttemptAborted();
    try {
      log({ path }, 'openSubmitForm: navigating to candidate submit path');
      const response = await page.goto(`https://codeforces.com${path}`, {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT_MS,
      });
      const status = response?.status() ?? 0;
      const finalUrl = page.url();
      const title = await page.title().catch(() => '');
      log({ path, status, finalUrl, title }, 'openSubmitForm: initial navigation completed');

      if (/\/enter(?:[/?#]|$)/i.test(finalUrl)) {
        throw new Error('Codeforces session is signed out (the submit page redirected to the login page)');
      }

      if (status === 403 || status === 503 || CHALLENGE_RE.test(title)) {
        log({ path, status, title }, 'openSubmitForm: Cloudflare challenge detected (HTTP 403/503 or challenge title)');
        const cleared = await waitOutChallenge(page, undefined, proxyUrl, overrideKeys);
        log({ path, cleared }, 'openSubmitForm: waitOutChallenge returned');

        if (cleared) {
          await sleep(1500);
          let fields = await readFields(page);
          log({ path, fieldsCount: fields.length, fields: summarize(fields), url: page.url() }, 'openSubmitForm: checking fields after clearance');
          if (hasSubmitForm(fields)) {
            log({ path, fields: summarize(fields) }, 'Codeforces submit form opened after challenge cleared');
            return;
          }

          log({ path }, 'openSubmitForm: submit form fields not found immediately, navigating with clearance cookies');
          const retryRes = await page.goto(`https://codeforces.com${path}`, {
            waitUntil: 'domcontentloaded',
            timeout: NAV_TIMEOUT_MS,
          }).catch((err) => {
            logWarn({ err: String(err) }, 'openSubmitForm: retry navigation threw');
            return null;
          });

          await sleep(1500);
          fields = await readFields(page);
          const retryStatus = retryRes?.status() ?? null;
          const retryTitle = await page.title().catch(() => '');
          log({ path, retryStatus, retryTitle, fieldsCount: fields.length, fields: summarize(fields), url: page.url() }, 'openSubmitForm: post-retry fields check');

          if (hasSubmitForm(fields)) {
            log({ path, fields: summarize(fields) }, 'Codeforces submit form opened after clearance retry navigation');
            return;
          }
          attempts.push(`${path}: HTTP ${status} (challenge cleared but submit form missing on ${page.url()}, fields: ${summarize(fields)})`);
          continue;
        }

        attempts.push(`${path}: HTTP ${status} (Cloudflare challenge could not be cleared)`);
        continue;
      }

      const body = await readBody(page);
      if (CHALLENGE_RE.test(body) || CHALLENGE_RE.test(finalUrl)) {
        log({ path, bodySnippet: body.slice(0, 100) }, 'openSubmitForm: Challenge text matched in body');
        const cleared = await waitOutChallenge(page, undefined, proxyUrl, overrideKeys);
        if (cleared) {
          await sleep(1500);
          let fields = await readFields(page);
          if (hasSubmitForm(fields)) {
            log({ path, fields: summarize(fields) }, 'Codeforces submit form opened after challenge cleared');
            return;
          }
          const retryRes = await page.goto(`https://codeforces.com${path}`, {
            waitUntil: 'domcontentloaded',
            timeout: NAV_TIMEOUT_MS,
          }).catch(() => null);
          await sleep(1500);
          fields = await readFields(page);
          if (hasSubmitForm(fields)) {
            log({ path, fields: summarize(fields) }, 'Codeforces submit form opened after clearance retry navigation');
            return;
          }
          attempts.push(`${path}: challenge cleared but submit form missing on ${page.url()}`);
          continue;
        }
        attempts.push(`${path}: challenge in body could not be cleared`);
        continue;
      }

      const fields = await readFields(page);
      if (hasSubmitForm(fields)) {
        log({ path, fields: summarize(fields) }, 'Codeforces submit form opened directly');
        return;
      }
      attempts.push(`${path}: no submit form (url ${page.url()}; title "${title}"; fields: ${summarize(fields)})`);
    } catch (err) {
      throwIfAttemptAborted();
      if (err instanceof BrowserFormError) throw err;
      attempts.push(`${path}: ${errorMessage(err)}`);
    }
  }

  const message = `Codeforces submit form could not be opened for ${entry.contestId}/${entry.problemIndex} — ${attempts.join(' | ')}`;
  logError({ message }, 'openSubmitForm: all candidates exhausted');
  throw new BrowserFormError(message, 'blocked');
}

/**
 * Sets a <select> in the page directly and fires the events Codeforces listens
 * to. Playwright's selectOption runs actionability checks that time out when
 * Firefox is starved at the 512MB limit; a DOM assignment is instant.
 */
async function setSelectValue(page: Page, name: string, value: string): Promise<void> {
  const done = await page
    .evaluate(
      ({ name, value }) => {
        const el = document.querySelector(`select[name="${name}"]`) as HTMLSelectElement | null;
        if (!el) return false;
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return el.value === value;
      },
      { name, value },
    )
    .catch(() => false);
  if (done) return;
  log({ name }, 'DOM select failed, falling back to selectOption');
  await page.locator(`select[name="${name}"]`).first().selectOption(value, { force: true, timeout: 20_000 });
}

async function fillSubmitForm(page: Page, entry: SubmitterEntry, code: string, proxyUrl?: string, overrideKeys?: string[]): Promise<{ turnstile: boolean; interactive: boolean }> {
  log({ hasProxy: !!proxyUrl }, 'fillSubmitForm: starting form fill');
  log({}, 'waiting for form to settle');
  const settled = await page.locator('form:has(textarea[name="source"])').waitFor({ state: 'attached', timeout: 15_000 }).then(() => true).catch(() => false);
  if (!settled) {
    const body = await readBody(page);
    const title = await page.title().catch(() => '');
    log({ title, bodySnippet: body.slice(0, 500) }, 'Form did not settle, page is stuck');
  }
  
  log({}, 'reading fields');
  const fields = await readFields(page);

  const csrfName = fields.find((field) => field.tag === 'input' && /csrf/i.test(field.name))?.name;
  if (!csrfName) throw new Error(`Codeforces submit form has no csrf field (fields: ${summarize(fields)})`);

  log({}, 'selecting contest');
  const contestSelector = page.locator('select[name="contestId"]').first();
  if ((await contestSelector.count().catch(() => 0)) > 0) {
    await setSelectValue(page, 'contestId', String(entry.contestId));
  }

  log({}, 'selecting problem index');
  const hasSelect = fields.some((field) => field.tag === 'select' && /^submittedProblemIndex$/i.test(field.name));
  if (hasSelect) {
    const options = await page
      .locator('select[name="submittedProblemIndex"] option')
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          value: (node as HTMLOptionElement).value,
          text: (node.textContent ?? '').trim(),
        })),
      )
      .catch(() => [] as Array<{ value: string; text: string }>);
    const target =
      options.find((option) => option.value.trim().toUpperCase() === entry.problemIndex.toUpperCase()) ??
      options.find((option) => option.text.trim().toUpperCase() === entry.problemIndex.toUpperCase());
    if (!target) {
      throw new Error(
        `contest ${entry.contestId} submit form has no option for problem ${entry.problemIndex}`,
      );
    }
    await setSelectValue(page, 'submittedProblemIndex', target.value);
  } else if (fields.some((field) => field.tag === 'input' && /^submittedProblemIndex$/i.test(field.name))) {
    await page.locator('input[name="submittedProblemIndex"]').first().fill(entry.problemIndex, { force: true, timeout: 5000 });
  } else if (fields.some((field) => field.tag === 'input' && /^submittedProblemCode$/i.test(field.name))) {
    await page.locator('input[name="submittedProblemCode"]').first().fill(`${entry.contestId}${entry.problemIndex}`, { force: true, timeout: 5000 });
  } else {
    throw new Error(`Codeforces submit form has no problem selector (fields: ${summarize(fields)})`);
  }

  log({}, 'selecting language');
  const options = await page
    .locator('select[name="programTypeId"] option')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({ value: (node as HTMLOptionElement).value, text: (node.textContent ?? '').trim() })),
    )
    .catch(() => [] as Array<{ value: string; text: string }>);
  if (options.length === 0) throw new Error(`Codeforces submit form has no programTypeId options`);

  const wantsPython = entry.language === 'python';
  const language = wantsPython
    ? (options.find((option) => /PyPy\s*3/i.test(option.text)) ?? options.find((option) => /Python\s*3/i.test(option.text)))
    : options
        .map((option) => ({ option, match: /GNU\s*G\+\+\s*(\d+)/i.exec(option.text) }))
        .filter((candidate): candidate is { option: { value: string; text: string }; match: RegExpExecArray } => !!candidate.match)
        .sort((a, b) => Number(b.match[1]) - Number(a.match[1]))[0]?.option ??
      options.find((option) => /C\+\+/i.test(option.text));
  if (!language) throw new Error(`no ${wantsPython ? 'Python 3' : 'C++'} language option on the Codeforces form`);
  await setSelectValue(page, 'programTypeId', language.value);

  log({}, 'syncing editor and filling source');
  const sourceBox = page.locator('textarea[name="source"]').first();
  if ((await sourceBox.count().catch(() => 0)) === 0) throw new Error('Codeforces submit form has no source textarea');

  await fillSource(page, code);

  log({}, 'reading token');
  const token = await page.locator(`input[name="${csrfName}"]`).first().inputValue({ timeout: 5000 }).catch(() => '');
  if (!token) throw new Error(`Codeforces ${csrfName} is empty — the submit page was not served correctly`);

  log({}, 'checking turnstile');
  return ensureFormTurnstile(page, TURNSTILE_WAIT_MS, proxyUrl, overrideKeys);
}

function compactBodyError(body: string): string {
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const useful = lines.find((line) =>
    /error|invalid|csrf|too long|failed|same code|not allowed|participant|captcha|turnstile|verification|human|robot/i.test(line)
  );
  return useful?.slice(0, 500) ?? 'Codeforces rejected the submission form';
}

function isAlreadySubmittedCodeError(error: string | null | undefined): boolean {
  return /exactly the same code|same code before|already submitted/i.test(error ?? '');
}

export async function submit(request: SubmitRequest, authorizePost?: () => Promise<boolean>, signal?: AbortSignal): Promise<SubmitResponse> {
  const deadline = Math.min(Date.now() + 7 * 60_000,
    typeof request.attemptDeadline === 'number' && Number.isFinite(request.attemptDeadline) ? request.attemptDeadline - 60_000 : Infinity);
  const requestId = typeof request.requestId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(request.requestId) ? request.requestId : randomUUID();
  try {
    return await withAttemptContext(requestId, deadline, async () => {
      log({ deadline: new Date(deadline).toISOString() }, 'browser submission attempt started');
      return submitWithinAttempt(request, authorizePost);
    }, signal);
  } catch (err) {
    if (err instanceof AttemptCancelledError) throw new BrowserFormError(`${err.message}; no submission was sent.`, 'blocked');
    throw err;
  }
}

async function submitWithinAttempt(request: SubmitRequest, authorizePost?: () => Promise<boolean>): Promise<SubmitResponse> {
  if (request.capzyApiKeys && request.capzyApiKeys.length > 0) {
    initCapzyKeys(request.capzyApiKeys, request.capzyActiveKeyIndex);
  }
  if (request.cpsolverUrl || request.telegramBotToken || request.telegramChatId) {
    initCPSolverConfig({
      url: request.cpsolverUrl,
      telegramBotToken: request.telegramBotToken,
      telegramChatId: request.telegramChatId,
    });
  }

  // Leave one minute for result delivery and browserless judge polling.
  const { deadline, signal, requestId } = getAttemptContext()!;
  if (Date.now() >= deadline) throw new BrowserFormError('Browser attempt expired before starting; no submission was sent.', 'blocked');
  const label = request.label ?? request.handle ?? 'account';
  const available = freeMemoryMb();
  log({ label, availableMb: available, minimumFreeMb: BROWSER_MIN_FREE_MB }, 'isolated Codeforces browser preflight');
  if (available !== null && available < BROWSER_MIN_FREE_MB) {
    return {
      ok: false,
      kind: 'blocked',
      error: `isolated submitter only has ${available}MB free; floor is ${BROWSER_MIN_FREE_MB}MB`,
      status: null,
      finalUrl: '',
      clicked: false,
      turnstile: false,
      interactive: false,
      activeCapzyKeyIndex: await getActiveCapzyKeyIndex().catch(() => 0),
    };
  }

  releaseHeap();
  const session = await launchFirefox(request.state, label, request.networkMode, request.proxy);
  log({ label, browser: BROWSER_ENGINE, usedMb: cgroupUsedMb() }, 'browser launched for isolated Codeforces submission');

  const flags = { turnstile: false, interactive: false };
  let clickStarted = false;
  const onAbort = () => {
    log({ requestId, reason: signal.reason instanceof AttemptCancelledError ? signal.reason.reason : 'cancelled', clicked: clickStarted }, 'browser submission attempt cancelled');
    void session.browser.close().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    throwIfAttemptAborted();
    await openSubmitForm(session.page, request.entry, request.proxy, request.capzyApiKeys);
    const ts = await fillSubmitForm(session.page, request.entry, request.code, request.proxy, request.capzyApiKeys);
    flags.turnstile = ts.turnstile;
    flags.interactive = ts.interactive;

    throwIfAttemptAborted();
    if (Date.now() >= deadline) throw new BrowserFormError('Browser attempt expired before submission.', 'blocked');
    if (request.requiresPostAuthorization && (!authorizePost || !await authorizePost())) {
      throw new BrowserFormError('The attempt was cancelled before submission; no POST was sent.', 'blocked');
    }
    throwIfAttemptAborted();
    if (Date.now() >= deadline) throw new BrowserFormError('Browser attempt expired before submission.', 'blocked');
    clickStarted = true;
    const click = await clickSubmitForm(session.page);
    if (!click.clicked) {
      return {
        ok: false,
        kind: 'submission-error',
        error: `Codeforces submit control was not found inside the submit form on ${session.page.url()}`,
        status: click.status,
        finalUrl: session.page.url(),
        clicked: false,
        activeCapzyKeyIndex: await getActiveCapzyKeyIndex().catch(() => 0),
        ...flags,
      };
    }
    log({ status: click.status, turnstile: flags.turnstile, interactive: flags.interactive }, 'Codeforces form posted from isolated browser');

    let body = await readBody(session.page);
    let finalUrl = session.page.url();
    if (click.status === 403 || click.status === 503 || CHALLENGE_RE.test(body) || CHALLENGE_RE.test(finalUrl) || /__cf_chl/i.test(finalUrl)) {
      const cleared = await waitOutChallenge(session.page, undefined, request.proxy, request.capzyApiKeys);
      body = await readBody(session.page);
      finalUrl = session.page.url();
      if (!cleared || CHALLENGE_RE.test(body) || CHALLENGE_RE.test(finalUrl)) {
        return {
          ok: false,
          kind: 'blocked',
          error: `Codeforces cloudflare challenge did not clear after posting (HTTP ${click.status ?? '?'}, ${finalUrl})`,
          status: click.status,
          finalUrl,
          clicked: true,
          ...flags,
        };
      }
      click.status = null; // The initial challenged response is no longer the displayed document.
    }

    if (SIGNED_OUT_RE.test(body) || /\/enter(?:[/?#]|$)/i.test(finalUrl)) {
      return {
        ok: false,
        kind: 'signed-out',
        error: 'Codeforces answered the submission with a signed-out page; re-send the session cookies with /renew',
        status: click.status,
        finalUrl,
        clicked: true,
        ...flags,
      };
    }
    if (REJECTION_RE.test(body)) {
      return {
        ok: false,
        kind: 'submission-error',
        error: compactBodyError(body),
        status: click.status,
        finalUrl,
        clicked: true,
        ...flags,
      };
    }
    if (click.status !== null && click.status >= 400) {
      return { ok: false, kind: 'submission-error', error: `Codeforces answered the submission with HTTP ${click.status}`, status: click.status, finalUrl, clicked: true, ...flags };
    }
    if (!/codeforces\.com/i.test(finalUrl)) {
      return {
        ok: false,
        kind: 'submission-error',
        error: `the submit form left codeforces.com (${finalUrl})`,
        status: click.status,
        finalUrl,
        clicked: true,
        ...flags,
      };
    }
    const latestCookies = await session.page.context().cookies().catch(() => []) as unknown[];
    if (!isSubmissionHistory(finalUrl)) {
      const pageInfo = await session.page.evaluate(() => {
        const errorSelectors = [
          '.error',
          '.alert',
          '.alert-error',
          '.field-error',
          '.error__desc',
          'span.for__source',
          'span.for__programTypeId',
          'span.for__submittedProblemIndex',
          'span[class*="error"]',
          'div[class*="error"]',
          'p[class*="error"]',
          '.notice',
        ];
        const errorEls = Array.from(document.querySelectorAll(errorSelectors.join(', ')));
        const errorText = errorEls
          .map((el) => (el as HTMLElement).innerText || el.textContent || '')
          .map((t) => t.trim())
          .filter((t) => t.length > 0 && !/^\s*$/.test(t))
          .join('; ');

        // An active Turnstile challenge must have an actual Cloudflare challenge iframe,
        // NOT merely the empty template container <div class="cf-turnstile">.
        const challengeIframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
        const hasActiveTurnstile = !!challengeIframe;

        return {
          errorText,
          hasTurnstile: hasActiveTurnstile,
        };
      }).catch(() => ({ errorText: '', hasTurnstile: false }));

      const visibleBody = await readBody(session.page);
      const rejectionError = pageInfo.errorText || (REJECTION_RE.test(visibleBody) ? compactBodyError(visibleBody) : '');
      const isDuplicate = isAlreadySubmittedCodeError(rejectionError || visibleBody);
      const errorMsg = rejectionError
        ? (isDuplicate ? rejectionError : `Codeforces rejected submission: ${rejectionError}`)
        : pageInfo.hasTurnstile
          ? 'Codeforces required Cloudflare Turnstile challenge on submission; acceptance was prevented.'
          : 'Codeforces did not redirect to submission history after the POST; acceptance is uncertain and the POST was not retried.';
      const kind = (rejectionError || isDuplicate) ? 'submission-error' : (pageInfo.hasTurnstile ? 'blocked' : 'submission-error');
      return { ok: false, kind, error: errorMsg, status: click.status, finalUrl, clicked: true, updatedCookies: latestCookies, activeCapzyKeyIndex: await getActiveCapzyKeyIndex().catch(() => 0), ...flags };
    }
    return { ok: true, status: click.status, finalUrl, clicked: true, updatedCookies: latestCookies, activeCapzyKeyIndex: await getActiveCapzyKeyIndex().catch(() => 0), ...flags };
  } catch (err) {
    if (signal.aborted) throw new BrowserFormError(
      clickStarted ? 'Browser attempt cancelled after submission started; acceptance is uncertain. Do not retry the POST.' : 'Browser attempt cancelled before submission; no POST was sent.',
      clickStarted ? 'submission-error' : 'blocked', flags, clickStarted);
    if (err instanceof BrowserFormError) {
      throw new BrowserFormError(err.message, err.kind, {
        turnstile: flags.turnstile || err.flags.turnstile,
        interactive: flags.interactive || err.flags.interactive,
      }, err.clicked);
    }
    throw new BrowserFormError(err instanceof Error ? err.message : String(err), 'submission-error', flags, clickStarted);
  } finally {
    signal.removeEventListener('abort', onAbort);
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([session.close(), new Promise<void>(resolve => { closeTimer = setTimeout(resolve, 3000); })]);
    } finally { if (closeTimer) clearTimeout(closeTimer); }
    log({ usedMb: cgroupUsedMb(), proxiedPageTraffic: session.traffic.summary() }, 'isolated Codeforces browser closed');
  }
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

function json(res: http.ServerResponse, code: number, payload: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function authorized(req: http.IncomingMessage): boolean {
  if (!TOKEN) return false;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${TOKEN}`;
}

/** In local-runner mode, only the PC process can take a queued browser job. */
function runnerAuthorized(req: http.IncomingMessage): boolean {
  if (!LOCAL_RUNNER_MODE) return authorized(req);
  if (!LOCAL_RUNNER_TOKEN) return false;
  return req.headers.authorization === `Bearer ${LOCAL_RUNNER_TOKEN}`;
}

export const server = http.createServer((req, res) => {
  const url = req.url ?? '/';

  // Public liveness endpoint for Render/UptimeRobot. Keep this path completely
  // independent of the browser, auth token, or Codeforces itself. Support both
  // GET and HEAD because HTTP monitors may use either request style.
  if ((req.method === 'GET' || req.method === 'HEAD') && (url === '/health' || url === '/')) {
    const body = JSON.stringify({
      ok: true,
      service: 'codeforces-submit-browser',
      revision: process.env.RENDER_GIT_COMMIT ?? null,
      busy: broker?.busy ?? busy,
      usedMb: cgroupUsedMb(),
      uptimeSeconds: Math.round(process.uptime()),
    });
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    });
    if (req.method === 'HEAD') {
      res.end();
    } else {
      res.end(body);
    }
    return;
  }

  if (req.method === 'GET' && (url === '/logs' || url.startsWith('/logs?'))) {
    const query = new URL(url, 'http://localhost').searchParams;
    const limit = Math.min(1000, Math.max(1, parseInt(query.get('limit') || '200', 10)));
    let entries = logRingBuffer.slice(-limit);
    const requestId = query.get('requestId');
    if (requestId) entries = logRingBuffer.filter(entry => entry.requestId === requestId).slice(-limit);
    const lvl = query.get('level');
    if (lvl) {
      const minLevel = parseInt(lvl, 10);
      if (!isNaN(minLevel)) {
        entries = entries.filter((e) => typeof e.level === 'number' && e.level >= minLevel);
      }
    }
    if (query.get('format') === 'text') {
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(
        entries
          .map((e) => `[${e.time}] [${e.level === 50 ? 'ERROR' : e.level === 40 ? 'WARN' : 'INFO'}] ${e.msg} ${JSON.stringify(e)}`)
          .join('\n'),
      );
      return;
    }
    json(res, 200, { ok: true, count: entries.length, logs: entries });
    return;
  }

  const jobRoute = /^\/jobs\/([a-f0-9-]{36})(?:\/(claim|result|network|cancel|authorize-post))?$/.exec(url);
  if (broker && req.method === 'GET' && url === '/jobs/next') {
    if (!runnerAuthorized(req)) { json(res, 401, { error: 'unauthorized' }); return; }
    json(res, 200, {
      jobId: broker.nextId,
      networkMode: broker.nextId ? broker.nextNetworkMode : null,
      removedProxies: broker.nextId ? broker.nextRemovedProxies : [],
      proxy: broker.nextId ? broker.nextProxy : null,
    });
    return;
  }
  if (broker && jobRoute) {
    if (!runnerAuthorized(req)) { json(res, 401, { error: 'unauthorized' }); return; }
    const id = jobRoute[1]!;
    const action = jobRoute[2];
    if (req.method === 'GET' && !action) {
      const status = broker.status(id);
      json(res, status ? 200 : 404, status?.pending ? { ...status, claimed: broker.isClaimed(id) } : status ?? { error: 'job not found or expired' });
      return;
    }
    if (req.method === 'GET' && action === 'network') {
      const networkMode = broker.networkMode(id);
      json(res, networkMode ? 200 : 404, networkMode ? {
        networkMode,
        removedProxies: broker.removedProxies(id),
        proxy: broker.proxy(id),
      } : { error: 'job not found or expired' });
      return;
    }
    if (req.method === 'POST' && action === 'claim') {
      const payload = broker.claim(id, req.headers['x-codeforces-post-guard'] === '1');
      log({ id, accepted: !!payload }, 'Codeforces browser job claim');
      json(res, payload ? 200 : 404, payload ?? { error: 'job not found or already claimed' });
      return;
    }
    if (req.method === 'POST' && action === 'cancel') {
      const claimed = broker.isClaimed(id);
      const cancelled = broker.cancelUnclaimed(id);
      log({ id, claimed, cancelled }, 'Codeforces browser job cancellation');
      json(res, 200, { cancelled });
      return;
    }
    if (req.method === 'POST' && action === 'authorize-post') {
      json(res, 200, { authorized: broker.authorizePost(id) });
      return;
    }
    if (req.method === 'POST' && action === 'result') {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
        if (raw.length > 65536) req.destroy();
      });
      req.on('end', () => {
        try {
          const value = JSON.parse(raw) as SubmitResponse;
          if (typeof value?.ok !== 'boolean' || typeof value?.clicked !== 'boolean') throw new Error('invalid result');
          json(res, broker.finish(id, value) ? 200 : 409, { accepted: broker.status(id)?.pending === false });
        } catch { json(res, 400, { error: 'invalid result' }); }
      });
      return;
    }
  }

  if (req.method === 'POST' && url === '/proxy/sync') {
    if (!runnerAuthorized(req)) { json(res, 401, { error: 'unauthorized' }); return; }
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
      if (raw.length > 65536) req.destroy();
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(raw) as { proxies?: string };
        if (typeof body?.proxies === 'string') {
          syncedProxies = parseProxyList(body.proxies);
          log({ count: syncedProxies.length }, 'synced proxy list from GitHub Actions runner');
        }
        json(res, 200, { ok: true, count: syncedProxies.length });
      } catch {
        json(res, 400, { error: 'invalid payload' });
      }
    });
    return;
  }

  if (req.method === 'GET' && url === '/proxy/list') {
    if (!runnerAuthorized(req)) { json(res, 401, { error: 'unauthorized' }); return; }
    json(res, 200, { proxies: syncedProxies });
    return;
  }

  if (req.method !== 'POST' || url !== '/submit') {
    json(res, 404, { ok: false, error: 'not found' });
    return;
  }

  if (!TOKEN) {
    logError({}, 'CODEFORCES_SUBMITTER_TOKEN is not set - refusing every submit');
    json(res, 503, { ok: false, error: 'submitter token is not configured' });
    return;
  }
  if (!authorized(req)) {
    json(res, 401, { ok: false, error: 'unauthorized' });
    return;
  }
  if (broker?.busy ?? busy) {
    json(res, 409, { ok: false, error: 'a Codeforces submission is already running' });
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > BODY_LIMIT_BYTES) {
      json(res, 413, { ok: false, error: 'request body too large' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (size > BODY_LIMIT_BYTES) return;
    let parsed: SubmitRequest;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as SubmitRequest;
    } catch {
      json(res, 400, { ok: false, error: 'invalid JSON body' });
      return;
    }
    if (
      !parsed ||
      typeof parsed.code !== 'string' ||
      !parsed.entry ||
      typeof parsed.entry.contestId !== 'number' ||
      typeof parsed.entry.problemIndex !== 'string' ||
      !parsed.state ||
      !Array.isArray(parsed.state.cookies)
    ) {
      json(res, 400, { ok: false, error: 'missing code, entry.contestId, entry.problemIndex or state.cookies' });
      return;
    }

    // Recheck after reading the body: two slow uploads can both pass the first
    // check before either one reserves the browser slot.
    if (broker?.busy ?? busy) {
      json(res, 409, { ok: false, error: 'a Codeforces submission is already running' });
      return;
    }
    if (broker) {
      void broker.enqueue(parsed, parsed.requestId)
        .then((id) => { log({ id }, 'Codeforces browser job dispatched'); json(res, 202, { jobId: id }); })
        .catch((err) => { logError({ err: errorMessage(err) }, 'browser job dispatch failed'); json(res, 503, { ok: false, error: errorMessage(err) }); });
      return;
    }
    busy = true;
    const startedAt = Date.now();
    if (typeof parsed.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(parsed.requestId)) parsed.requestId = randomUUID();
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(new AttemptCancelledError('disconnect')); };
    res.on('close', onClose);
    // Direct service mode has no deferred runner that can outlive this request.
    void submit(parsed, async () => !controller.signal.aborted, controller.signal)
      .then((result) => {
        log({ requestId: parsed.requestId, result: submissionLogSummary(result), ms: Date.now() - startedAt }, 'isolated Codeforces browser submitter finished');
        json(res, 200, result);
      })
      .catch((err) => {
        const message = errorMessage(err);
        const kind = err instanceof BrowserFormError ? err.kind : /^blocked:/.test(message) ? 'blocked' : 'submission-error';
        logError({ requestId: parsed.requestId, err: message, ms: Date.now() - startedAt }, 'isolated Codeforces browser submitter failed');
        json(res, 200, {
          ok: false,
          kind,
          error: message,
          status: null,
          finalUrl: '',
          clicked: err instanceof BrowserFormError && err.clicked,
          turnstile: err instanceof BrowserFormError && err.flags.turnstile,
          interactive: err instanceof BrowserFormError && err.flags.interactive,
        });
      })
      .finally(() => {
        res.removeListener('close', onClose);
        busy = false;
        releaseHeap();
      });
  });
});

if (require.main === module) server.listen(PORT, '0.0.0.0', () => {
  log(
    { port: PORT, headless: HEADLESS, proxy: proxyLabel(browserProxy(PROXY_SERVER)), runnerRepository: RUNNER_REPOSITORY || null, runnerMode: RUNNER_MODE, runnerDispatchConfigured: GITHUB_DISPATCH_TOKEN.length > 0, localRunnerConfigured: LOCAL_RUNNER_TOKEN.length > 0, usedMb: cgroupUsedMb(), tokenConfigured: TOKEN.length > 0 },
    'isolated Codeforces submitter listening',
  );
});
