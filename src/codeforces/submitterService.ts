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
import { BrowserStateCache } from './browserStateCache';
import os from 'node:os';
import { ActionBroker, dispatchAction } from './actionBroker';
import { BrowserFormError, clickSubmitForm, ensureFormTurnstile, fillSource, isSubmissionHistory, blockCodeforcesResource, submissionFeedback, waitForCodeforcesPage } from './browserForm';
import { chromium, firefox, type Browser, type BrowserContext, type Page } from 'playwright';
import type { PhoneVerification } from './phoneVerification';
import { VerificationRelay, verificationHtml } from './verificationRelay';

const PORT = Number(process.env.PORT ?? 10000);
const TOKEN = process.env.CODEFORCES_SUBMITTER_TOKEN?.trim() ?? '';
const HEADLESS = process.env.HEADLESS !== 'false';
const BROWSER_ENGINE = process.env.CODEFORCES_BROWSER === 'chromium' ? 'chromium' : 'firefox';
const BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const NAV_TIMEOUT_MS = Number(process.env.CODEFORCES_NAV_TIMEOUT_MS ?? 60_000);
const TURNSTILE_WAIT_MS = Number(process.env.CODEFORCES_TURNSTILE_WAIT_MS ?? 20_000);
const CHALLENGE_WAIT_MS = Number(process.env.CODEFORCES_CHALLENGE_WAIT_MS ?? 20_000);
const BROWSER_MIN_FREE_MB = Number(process.env.CODEFORCES_BROWSER_MIN_FREE_MB ?? 300);
// Outbound proxy for Firefox, e.g. socks5://127.0.0.1:40000 (the local WARP
// tunnel started by scripts/start-submitter.sh). Empty = direct connection.
const PROXY_SERVER = (process.env.CODEFORCES_PROXY ?? '').trim();
const RUNNER_REPOSITORY = (process.env.CODEFORCES_RUNNER_REPOSITORY ?? '').trim();
const GITHUB_DISPATCH_TOKEN = (process.env.GITHUB_DISPATCH_TOKEN ?? '').trim();
const RUNNER_MODE = (process.env.CODEFORCES_RUNNER_MODE ?? 'github').trim().toLowerCase();
const LOCAL_RUNNER_MODE = RUNNER_MODE === 'local';
const LOCAL_RUNNER_TOKEN = (process.env.CODEFORCES_LOCAL_RUNNER_TOKEN ?? '').trim();
const verificationRelay = new VerificationRelay();
const broker = RUNNER_REPOSITORY || LOCAL_RUNNER_MODE
  ? new ActionBroker((id) => LOCAL_RUNNER_MODE ? Promise.resolve() : dispatchAction(RUNNER_REPOSITORY, GITHUB_DISPATCH_TOKEN, id))
  : null;

const CHALLENGE_RE = /just a moment|checking your browser|verify you are human|cf-chl|enable javascript and cookies/i;
const SIGNED_OUT_RE = /you are not logged in|please login|please sign in|not logged in|register for practice/i;
const REJECTION_RE =
  /you have submitted exactly the same code before|source code is too long|submission failed|invalid csrf|you are not allowed to submit|no such problem|problem not found|not a participant/i;

interface SubmitterEntry {
  contestId: number;
  problemIndex: string;
  gym?: boolean;
  language?: string;
}

interface SubmitRequest {
  requestId?: string;
  label?: string;
  handle?: string;
  code: string;
  entry: SubmitterEntry;
  state: { cookies: unknown[]; origins?: unknown[] };
  networkMode?: 'proxy' | 'tailscale';
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
}

let busy = false;

// ---------------------------------------------------------------------------
// Minimal logging (no app imports). Same shape as the main service's pino lines
// so both services' output reads consistently in the Render log view.
// ---------------------------------------------------------------------------

function log(fields: Record<string, unknown>, msg: string): void {
  const time = new Date().toISOString();
  process.stdout.write(`${JSON.stringify({ level: 30, time, service: 'codeforces-submit-browser', ...fields, msg })}\n`);
}

function logError(fields: Record<string, unknown>, msg: string): void {
  const time = new Date().toISOString();
  process.stdout.write(`${JSON.stringify({ level: 50, time, service: 'codeforces-submit-browser', ...fields, msg })}\n`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  close: () => Promise<void>;
}

/** Converts the standard provider endpoint into Playwright's proxy shape.
 * Credentials remain separate from the server field and are never logged. */
function browserProxy(raw: string): { server: string; username?: string; password?: string } | undefined {
  if (!raw) return undefined;
  try {
    const endpoint = new URL(raw);
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

async function launchFirefox(state: SubmitRequest['state'], label: string, networkMode: SubmitRequest['networkMode'] = 'proxy', progress: (phase: string) => Promise<void> = async () => {}): Promise<Session> {
  let browser: Browser | null = null;
  const proxy = networkMode === 'tailscale' ? undefined : browserProxy(PROXY_SERVER);
  if (networkMode !== 'tailscale' && PROXY_SERVER && !proxy) {
    throw new Error('CODEFORCES_PROXY must be a http(s), socks4, or socks5 endpoint');
  }
  try {
    const active = (browser = await (BROWSER_ENGINE === 'chromium' ? chromium : firefox).launch({
      headless: HEADLESS,
      ...(proxy ? { proxy } : {}),
      ...(BROWSER_ENGINE === 'firefox' ? { firefoxUserPrefs: {
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
      } } : {}),
    }));
    const directory = process.env.CODEFORCES_BROWSER_STATE_DIR;
    const cache = directory && TOKEN ? new BrowserStateCache<SubmitRequest['state']>(directory, TOKEN, {
      label, state, networkMode, route: networkMode === 'tailscale' ? process.env.TAILSCALE_EXIT_NODE : PROXY_SERVER,
      engine: BROWSER_ENGINE, version: active.version(),
    }) : null;
    const restored = await cache?.load();
    await progress(restored ? 'session-restored' : 'session-fresh');
    const context = await active.newContext({
      storageState: (restored ?? { cookies: state.cookies, origins: state.origins ?? [] }) as Parameters<
        BrowserContext['storageState']
      > extends never
        ? never
        : never,
      viewport: { width: 900, height: 600 },
      locale: 'en-US',
      serviceWorkers: 'block',
    });
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
    const page = context.pages()[0] ?? (await context.newPage());
    return {
      browser: active,
      context,
      page,
      close: async () => {
        if (cache) {
          try {
            const updated = await context.storageState({ indexedDB: true });
            await cache.save(updated);
          } catch { log({ label }, 'browser session cache could not be saved; submission result is unchanged'); }
        }
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

export async function openSubmitForm(page: Page, entry: SubmitterEntry, phoneVerification?: PhoneVerification): Promise<void> {
  const paths = candidates(entry);
  const attempts: string[] = [];
  let blocked = 0;

  for (const path of paths) {
    try {
      const response = await page.goto(`https://codeforces.com${path}`, {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT_MS,
      });
      const status = response?.status() ?? 0;
      const finalUrl = page.url();
      if (/\/enter(?:[/?#]|$)/i.test(finalUrl)) {
        throw new Error('Codeforces session is signed out (the submit page redirected to the login page)');
      }
      if (status === 403 || status === 503) {
        const title = (await page.title().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120);
        const mitigation = await response?.headerValue('cf-mitigated').catch(() => null);
        const challengeResources = await page.locator('script[src*="/cdn-cgi/challenge-platform/"], iframe[src*="challenges.cloudflare.com"]').count().catch(() => 0);
        const challengeDetected = mitigation === 'challenge' || challengeResources > 0 || CHALLENGE_RE.test(title) || CHALLENGE_RE.test(await readBody(page));
        log({ path, status, title, mitigation: mitigation ?? null, challengeDetected }, 'Codeforces submit page access diagnostics');
        const cleared = challengeDetected && (await waitForCodeforcesPage(page, 'submit', CHALLENGE_WAIT_MS)
          || await phoneVerification?.(page, 'submit'));
        if (!cleared) {
          const reason = challengeDetected ? 'detected verification did not complete' : 'access denied or unavailable; no verification widget detected';
          if (challengeDetected && phoneVerification) {
            throw new BrowserFormError('Codeforces verification was not completed during the phone handoff. No submission was sent; try again when you can open the private link.', 'blocked');
          }
          attempts.push(`${path}: HTTP ${status} (${reason}${title ? `; page title: ${title}` : ''})`);
          blocked += 1;
          continue;
        }
      }
      const body = await readBody(page);
      if (CHALLENGE_RE.test(body) || CHALLENGE_RE.test(page.url())) {
        if (!(await waitForCodeforcesPage(page, 'submit', CHALLENGE_WAIT_MS)
          || await phoneVerification?.(page, 'submit'))) {
          if (phoneVerification) throw new BrowserFormError('Codeforces verification was not completed during the phone handoff. No submission was sent.', 'blocked');
          attempts.push(`${path}: challenge did not clear`);
          blocked += 1;
          continue;
        }
      }
      if (/\/enter(?:[/?#]|$)/i.test(page.url())) {
        throw new Error('Codeforces session is signed out (verification redirected to the login page)');
      }
      const fields = await readFields(page);
      if (hasSubmitForm(fields)) {
        log({ path, fields: summarize(fields) }, 'Codeforces submit form opened');
        return;
      }
      attempts.push(`${path}: no submit form (url ${page.url()}; fields: ${summarize(fields)})`);
    } catch (err) {
      if (err instanceof BrowserFormError) throw err;
      attempts.push(`${path}: ${errorMessage(err)}`);
    }
  }

  const message = `Codeforces submit form could not be opened for ${entry.contestId}/${entry.problemIndex} — ${attempts.join(' | ')}`;
  if (blocked > 0) throw new BrowserFormError(message, 'blocked');
  throw new Error(message);
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

async function fillSubmitForm(page: Page, entry: SubmitterEntry, code: string): Promise<{ turnstile: boolean; interactive: boolean }> {
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

  log({}, 'switching off editor and filling source');
  const sourceBox = page.locator('textarea[name="source"]').first();
  if ((await sourceBox.count().catch(() => 0)) === 0) throw new Error('Codeforces submit form has no source textarea');

  await fillSource(page, code);

  log({}, 'reading token');
  const token = await page.locator(`input[name="${csrfName}"]`).first().inputValue({ timeout: 5000 }).catch(() => '');
  if (!token) throw new Error(`Codeforces ${csrfName} is empty — the submit page was not served correctly`);

  log({}, 'checking turnstile');
  return ensureFormTurnstile(page, TURNSTILE_WAIT_MS);
}

function compactBodyError(body: string): string {
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const useful = lines.find((line) => /error|invalid|csrf|too long|failed|same code|not allowed|participant/i.test(line));
  return useful?.slice(0, 500) ?? 'Codeforces rejected the submission form';
}

export async function submit(request: SubmitRequest, progress: (phase: string) => Promise<void> = async () => {}, phoneVerification?: PhoneVerification): Promise<SubmitResponse> {
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
    };
  }

  releaseHeap();
  const session = await launchFirefox(request.state, label, request.networkMode, progress);
  log({ label, browser: BROWSER_ENGINE, usedMb: cgroupUsedMb() }, 'browser launched for isolated Codeforces submission');

  const flags = { turnstile: false, interactive: false };
  let phoneRequested = false;
  const requestPhone = phoneVerification ? async (page: Page, mode: Parameters<PhoneVerification>[1]) => {
    phoneRequested = true;
    return phoneVerification(page, mode);
  } : undefined;
  try {
    let ts: { turnstile: boolean; interactive: boolean } | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await progress('opening');
        await openSubmitForm(session.page, request.entry, requestPhone);
        await progress('verification');
        try {
          ts = await fillSubmitForm(session.page, request.entry, request.code);
        } catch (err) {
          if (!(err instanceof BrowserFormError) || err.kind !== 'blocked' || err.clicked
            || !(err.flags.turnstile || err.flags.interactive)
            || !await requestPhone?.(session.page, 'turnstile')) throw err;
          ts = await ensureFormTurnstile(session.page, 1000);
        }
        break;
      } catch (err) {
        if (!(err instanceof BrowserFormError) || err.kind !== 'blocked' || err.clicked || attempt === 1 || phoneRequested) {
          if (err instanceof BrowserFormError && err.kind === 'blocked') await progress('verification-blocked');
          throw err;
        }
        await progress('verification-retry');
        await sleep(10_000);
      }
    }
    if (!ts) throw new Error('submit form preparation did not finish');
    flags.turnstile = ts.turnstile;
    flags.interactive = ts.interactive;

    await progress(ts.turnstile ? 'verification-cleared' : 'verification-not-required');
    await progress('submitting');
    const click = await clickSubmitForm(session.page);
    if (!click.clicked) {
      return {
        ok: false,
        kind: 'submission-error',
        error: `Codeforces submit control was not found inside the submit form on ${session.page.url()}`,
        status: click.status,
        finalUrl: session.page.url(),
        clicked: false,
        ...flags,
      };
    }
    log({ status: click.status, turnstile: flags.turnstile, interactive: flags.interactive }, 'Codeforces form posted from isolated browser');

    let body = await readBody(session.page);
    let finalUrl = session.page.url();
    if (click.status === 403 || click.status === 503 || CHALLENGE_RE.test(body) || CHALLENGE_RE.test(finalUrl) || /__cf_chl/i.test(finalUrl)) {
      await progress('verification');
      const cleared = await waitForCodeforcesPage(session.page, 'result', CHALLENGE_WAIT_MS)
        || await requestPhone?.(session.page, 'result');
      body = await readBody(session.page);
      finalUrl = session.page.url();
      if (!cleared || CHALLENGE_RE.test(body) || CHALLENGE_RE.test(finalUrl)) {
        await progress('verification-blocked');
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
    if (!isSubmissionHistory(finalUrl)) {
      const feedback = await submissionFeedback(session.page);
      const returnedForm = await session.page.locator('form:has(textarea[name="source"])').count() > 0;
      const path = new URL(finalUrl).pathname;
      log({ status: click.status, path, returnedForm, feedback }, 'Codeforces POST returned without submission history');
      const verificationRequired = !!feedback && /anti.?bot|verification|turnstile|captcha/i.test(feedback);
      if (verificationRequired) await progress('verification-blocked');
      return { ok: false, kind: verificationRequired ? 'blocked' : 'submission-error', error: feedback
        ? `Codeforces returned the submit form: ${feedback}`
        : `Codeforces did not redirect to submission history after the POST (HTTP ${click.status ?? '?'}, path ${path}, submit form ${returnedForm ? 'present' : 'absent'}); acceptance is uncertain and the POST was not retried.`, status: click.status, finalUrl, clicked: true, ...flags, ...(verificationRequired ? { turnstile: true } : {}) };
    }
    return { ok: true, status: click.status, finalUrl, clicked: true, ...flags };
  } catch (err) {
    if (err instanceof BrowserFormError) {
      throw new BrowserFormError(err.message, err.kind, {
        turnstile: flags.turnstile || err.flags.turnstile,
        interactive: flags.interactive || err.flags.interactive,
      }, err.clicked);
    }
    throw err;
  } finally {
    await session.close();
    log({ usedMb: cgroupUsedMb() }, 'isolated Codeforces browser closed');
  }
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

function json(res: http.ServerResponse, code: number, payload: unknown): void {
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

  if (req.method === 'GET' && url === '/verify') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow',
      'content-security-policy': "default-src 'self'; img-src 'self' blob:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
    res.end(verificationHtml);
    return;
  }
  if (url === '/verification/frame' || url === '/verification/action') {
    const token = req.headers['x-verification-token'];
    const session = typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) ? verificationRelay.frame(token) : null;
    if (!session || broker?.status(session.id)?.pending !== true) { json(res, 410, { error: 'verification session ended' }); return; }
    if (url === '/verification/frame' && req.method === 'GET' && session.image) {
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', 'x-expires-at': String(session.expiresAt), 'referrer-policy': 'no-referrer' });
      res.end(session.image);
      return;
    }
    if (url === '/verification/action' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk: Buffer) => { raw += chunk.toString(); if (raw.length > 256) req.destroy(); });
      req.on('end', () => {
        try { json(res, verificationRelay.queue(session.token, JSON.parse(raw)) ? 200 : 400, { accepted: true }); }
        catch { json(res, 400, { error: 'invalid interaction' }); }
      });
      return;
    }
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  // Public liveness endpoint for Render/UptimeRobot. Keep this path completely
  // independent of the browser, auth token, or Codeforces itself. Support both
  // GET and HEAD because HTTP monitors may use either request style.
  if ((req.method === 'GET' || req.method === 'HEAD') && (url === '/health' || url === '/')) {
    const body = JSON.stringify({
      ok: true,
      service: 'codeforces-submit-browser',
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

  const jobRoute = /^\/jobs\/([a-f0-9-]{36})(?:\/(claim|result|network|progress|verification))?$/.exec(url);
  if (broker && req.method === 'GET' && url === '/jobs/next') {
    if (!runnerAuthorized(req)) { json(res, 401, { error: 'unauthorized' }); return; }
    json(res, 200, { jobId: broker.nextId, networkMode: broker.nextId ? broker.nextNetworkMode : null });
    return;
  }
  if (broker && jobRoute) {
    if (!runnerAuthorized(req)) { json(res, 401, { error: 'unauthorized' }); return; }
    const id = jobRoute[1]!;
    const action = jobRoute[2];
    if (req.method === 'GET' && !action) {
      const status = broker.status(id);
      const verification = status?.pending ? verificationRelay.metadata(id) : undefined;
      json(res, status ? 200 : 404, status ? { ...status, ...(verification ? { verification } : {}) } : { error: 'job not found or expired' });
      return;
    }
    if (req.method === 'GET' && action === 'network') {
      const networkMode = broker.networkMode(id);
      json(res, networkMode ? 200 : 404, networkMode ? { networkMode } : { error: 'job not found or expired' });
      return;
    }
    if (req.method === 'POST' && action === 'claim') {
      const payload = broker.claim(id);
      json(res, payload ? 200 : 404, payload ?? { error: 'job not found or already claimed' });
      return;
    }
    if (req.method === 'POST' && action === 'verification') {
      if (broker.status(id)?.pending !== true || !broker.updateProgress(id, 'verification-required')) { json(res, 409, { error: 'inactive job' }); return; }
      let raw = '';
      req.on('data', (chunk: Buffer) => { raw += chunk.toString(); if (raw.length > 601_000) req.destroy(); });
      req.on('end', () => {
        try {
          const value = JSON.parse(raw) as { close?: boolean; image: string; width: number; height: number };
          if (value.close === true) {
            verificationRelay.close(id);
            broker.updateProgress(id, 'verification');
            json(res, 200, { closed: true });
          } else {
            json(res, 200, verificationRelay.publish(id, value.image, value.width, value.height));
          }
        } catch { json(res, 400, { error: 'invalid verification frame' }); }
      });
      return;
    }
    if (req.method === 'POST' && action === 'progress') {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
        if (raw.length > 512) req.destroy();
      });
      req.on('end', () => {
        try {
          const value = JSON.parse(raw) as { phase?: unknown };
          if (typeof value.phase !== 'string' || !/^[a-z-]{1,40}$/.test(value.phase)) throw new Error('invalid progress');
          json(res, broker.updateProgress(id, value.phase) ? 200 : 409, { accepted: true });
        } catch { json(res, 400, { error: 'invalid progress' }); }
      });
      return;
    }
    if (req.method === 'POST' && action === 'result') {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
        if (raw.length > 8192) req.destroy();
      });
      req.on('end', () => {
        try {
          const value = JSON.parse(raw) as SubmitResponse;
          if (typeof value?.ok !== 'boolean' || typeof value?.clicked !== 'boolean') throw new Error('invalid result');
          const accepted = broker.finish(id, value);
          if (accepted) verificationRelay.close(id);
          json(res, accepted ? 200 : 409, { accepted: broker.status(id)?.pending === false });
        } catch { json(res, 400, { error: 'invalid result' }); }
      });
      return;
    }
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

    if (broker) {
      void broker.enqueue(parsed, parsed.requestId)
        .then((id) => { log({ id }, 'Codeforces browser job dispatched'); json(res, 202, { jobId: id }); })
        .catch((err) => { logError({ err: errorMessage(err) }, 'browser job dispatch failed'); json(res, 503, { ok: false, error: errorMessage(err) }); });
      return;
    }
    busy = true;
    const startedAt = Date.now();
    void submit(parsed)
      .then((result) => {
        log({ result, ms: Date.now() - startedAt }, 'isolated Codeforces browser submitter finished');
        json(res, 200, result);
      })
      .catch((err) => {
        const message = errorMessage(err);
        const kind = err instanceof BrowserFormError ? err.kind : /^blocked:/.test(message) ? 'blocked' : 'submission-error';
        logError({ err: message, ms: Date.now() - startedAt }, 'isolated Codeforces browser submitter failed');
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
