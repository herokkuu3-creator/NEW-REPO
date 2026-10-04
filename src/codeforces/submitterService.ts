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
import { firefox, type Browser, type BrowserContext, type Page } from 'playwright';

const PORT = Number(process.env.PORT ?? 10000);
const TOKEN = process.env.CODEFORCES_SUBMITTER_TOKEN?.trim() ?? '';
const HEADLESS = process.env.HEADLESS !== 'false';
const BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const NAV_TIMEOUT_MS = Number(process.env.CODEFORCES_NAV_TIMEOUT_MS ?? 60_000);
const TURNSTILE_WAIT_MS = Number(process.env.CODEFORCES_TURNSTILE_WAIT_MS ?? 20_000);
const CHALLENGE_WAIT_MS = Number(process.env.CODEFORCES_CHALLENGE_WAIT_MS ?? 20_000);
const BROWSER_MIN_FREE_MB = Number(process.env.CODEFORCES_BROWSER_MIN_FREE_MB ?? 300);

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
  label?: string;
  handle?: string;
  code: string;
  entry: SubmitterEntry;
  state: { cookies: unknown[]; origins?: unknown[] };
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
  const limit = Number(process.env.MEMORY_LIMIT_MB ?? 512);
  const used = cgroupUsedMb();
  return used === null ? null : Math.max(0, limit - used);
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

async function launchFirefox(state: SubmitRequest['state'], label: string): Promise<Session> {
  let browser: Browser | null = null;
  try {
    const active = (browser = await firefox.launch({
      headless: HEADLESS,
      firefoxUserPrefs: {
        'permissions.default.image': 2,
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
    }));
    const context = await active.newContext({
      storageState: { cookies: state.cookies, origins: state.origins ?? [] } as Parameters<
        BrowserContext['storageState']
      > extends never
        ? never
        : never,
      viewport: { width: 900, height: 600 },
      locale: 'en-US',
      serviceWorkers: 'block',
    });
    await context.route('**/*', async (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'media' || type === 'font' || type === 'stylesheet') {
        await route.abort();
        return;
      }
      await route.continue();
    });
    const page = context.pages()[0] ?? (await context.newPage());
    return {
      browser: active,
      context,
      page,
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

async function waitOutChallenge(page: Page, timeoutMs = CHALLENGE_WAIT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1_000);
    const body = await readBody(page);
    if (!CHALLENGE_RE.test(body) && !CHALLENGE_RE.test(page.url()) && !/__cf_chl/i.test(page.url())) return true;
  }
  return false;
}

async function openSubmitForm(page: Page, entry: SubmitterEntry): Promise<void> {
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
        attempts.push(`${path}: HTTP ${status} (Cloudflare challenge)`);
        blocked += 1;
        continue;
      }
      const body = await readBody(page);
      if (CHALLENGE_RE.test(body) || CHALLENGE_RE.test(finalUrl)) {
        if (!(await waitOutChallenge(page))) {
          attempts.push(`${path}: challenge did not clear`);
          blocked += 1;
          continue;
        }
      }
      const fields = await readFields(page);
      if (hasSubmitForm(fields)) {
        log({ path, fields: summarize(fields) }, 'Codeforces submit form opened');
        return;
      }
      attempts.push(`${path}: no submit form (url ${page.url()}; fields: ${summarize(fields)})`);
    } catch (err) {
      attempts.push(`${path}: ${errorMessage(err)}`);
    }
  }

  const message = `Codeforces submit form could not be opened for ${entry.contestId}/${entry.problemIndex} — ${attempts.join(' | ')}`;
  throw new Error(blocked === paths.length ? `blocked: ${message}` : message);
}

async function waitForToken(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await page
      .locator('input[name="turnstileToken"]')
      .first()
      .inputValue()
      .catch(() => '');
    if (value.trim()) return true;
    await sleep(500);
  }
  return false;
}

async function ensureTurnstile(page: Page): Promise<{ turnstile: boolean; interactive: boolean }> {
  if ((await page.locator('input[name="turnstileToken"]').first().count().catch(() => 0)) === 0) {
    return { turnstile: false, interactive: false };
  }
  if (await waitForToken(page, TURNSTILE_WAIT_MS)) {
    log({}, 'Codeforces Turnstile solved itself');
    return { turnstile: true, interactive: false };
  }
  const interactive =
    (await page.locator('iframe[src*="challenges.cloudflare.com"]').count().catch(() => 0)) > 0;
  throw new Error(
    interactive
      ? `blocked: Codeforces Turnstile requires interactive verification; no token appeared within ${TURNSTILE_WAIT_MS}ms`
      : `blocked: Codeforces Turnstile did not issue a token within ${TURNSTILE_WAIT_MS}ms`,
  );
}

async function fillSubmitForm(page: Page, entry: SubmitterEntry, code: string): Promise<{ turnstile: boolean; interactive: boolean }> {
  log({}, 'reading fields');
  const fields = await readFields(page);

  const csrfName = fields.find((field) => field.tag === 'input' && /csrf/i.test(field.name))?.name;
  if (!csrfName) throw new Error(`Codeforces submit form has no csrf field (fields: ${summarize(fields)})`);

  log({}, 'selecting contest');
  const contestSelector = page.locator('select[name="contestId"]').first();
  if ((await contestSelector.count().catch(() => 0)) > 0) {
    await contestSelector.selectOption(String(entry.contestId), { timeout: 5000 }).catch(() => undefined);
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
    await page.locator('select[name="submittedProblemIndex"]').first().selectOption(target.value, { timeout: 5000 });
  } else if (fields.some((field) => field.tag === 'input' && /^submittedProblemIndex$/i.test(field.name))) {
    await page.locator('input[name="submittedProblemIndex"]').first().fill(entry.problemIndex, { timeout: 5000 });
  } else if (fields.some((field) => field.tag === 'input' && /^submittedProblemCode$/i.test(field.name))) {
    await page.locator('input[name="submittedProblemCode"]').first().fill(`${entry.contestId}${entry.problemIndex}`, { timeout: 5000 });
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
  await page.locator('select[name="programTypeId"]').first().selectOption(language.value, { timeout: 5000 });

  log({}, 'unchecking toggle editor');
  const toggle = page.locator('#toggleEditorCheckbox').first();
  if ((await toggle.count().catch(() => 0)) > 0) {
    if (await toggle.isChecked().catch(() => false)) {
      await toggle.uncheck({ force: true, timeout: 5000 }).catch(() => undefined);
    }
  }

  log({}, 'filling source code textarea');
  const sourceBox = page.locator('textarea[name="source"]').first();
  if ((await sourceBox.count().catch(() => 0)) === 0) throw new Error('Codeforces submit form has no source textarea');
  await sourceBox.evaluate((node, content) => {
    (node as HTMLTextAreaElement).value = content;
  }, code).catch((err) => { log({err: err.message}, 'evaluate failed'); });
  // Also try to force-fill just in case Playwright needs to trigger events
  await sourceBox.fill(code, { force: true, timeout: 5000 }).catch((err) => { log({err: err.message}, 'force fill failed'); });

  log({}, 'reading token');
  const token = await page.locator(`input[name="${csrfName}"]`).first().inputValue({ timeout: 5000 }).catch(() => '');
  if (!token) throw new Error(`Codeforces ${csrfName} is empty — the submit page was not served correctly`);

  log({}, 'checking turnstile');
  return ensureTurnstile(page);
}

/**
 * Clicks the submit control OF THE SUBMIT FORM: the page also carries a header
 * search form whose button is type=submit too, and clicking that posts nothing.
 */
async function clickSubmit(page: Page): Promise<{ clicked: boolean; status: number | null }> {
  log({}, 'locating submit button');
  const scoped = page
    .locator(
      'form:has(textarea[name="source"]) input[type="submit"], form:has(textarea[name="source"]) button[type="submit"]',
    )
    .first();
  if ((await scoped.count().catch(() => 0)) === 0) {
    log({}, 'no submit button found');
    return { clicked: false, status: null };
  }
  
  log({}, 'clicking submit button');
  try {
    const [response] = await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((e) => {
        log({err: e.message}, 'waitForNavigation rejected');
        return null;
      }),
      scoped.click({ timeout: 15_000 }),
    ]);
    log({}, 'submit click finished');
    return { clicked: true, status: response?.status() ?? null };
  } catch (err) {
    log({ err: err instanceof Error ? err.message : String(err) }, 'submit click threw');
    throw err;
  }
}

function compactBodyError(body: string): string {
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const useful = lines.find((line) => /error|invalid|csrf|too long|failed|same code|not allowed|participant/i.test(line));
  return useful?.slice(0, 500) ?? 'Codeforces rejected the submission form';
}

async function submit(request: SubmitRequest): Promise<SubmitResponse> {
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
  const session = await launchFirefox(request.state, label);
  log({ label, usedMb: cgroupUsedMb() }, 'Firefox launched for isolated Codeforces submission');

  const flags = { turnstile: false, interactive: false };
  try {
    await openSubmitForm(session.page, request.entry);
    const ts = await fillSubmitForm(session.page, request.entry, request.code);
    flags.turnstile = ts.turnstile;
    flags.interactive = ts.interactive;

    const click = await clickSubmit(session.page);
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
      const cleared = await waitOutChallenge(session.page);
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
    return { ok: true, status: click.status, finalUrl, clicked: true, ...flags };
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

const server = http.createServer((req, res) => {
  const url = req.url ?? '/';

  // Public liveness endpoint for Render/UptimeRobot. Keep this path completely
  // independent of the browser, auth token, or Codeforces itself. Support both
  // GET and HEAD because HTTP monitors may use either request style.
  if ((req.method === 'GET' || req.method === 'HEAD') && (url === '/health' || url === '/')) {
    const body = JSON.stringify({
      ok: true,
      service: 'codeforces-submit-browser',
      busy,
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
  if (busy) {
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

    busy = true;
    const startedAt = Date.now();
    void submit(parsed)
      .then((result) => {
        log({ result, ms: Date.now() - startedAt }, 'isolated Codeforces browser submitter finished');
        json(res, 200, result);
      })
      .catch((err) => {
        const message = errorMessage(err);
        const kind = /^blocked:/.test(message) ? 'blocked' : 'submission-error';
        logError({ err: message, ms: Date.now() - startedAt }, 'isolated Codeforces browser submitter failed');
        json(res, 200, {
          ok: false,
          kind,
          error: message,
          status: null,
          finalUrl: '',
          clicked: false,
          turnstile: false,
          interactive: false,
        });
      })
      .finally(() => {
        busy = false;
        releaseHeap();
      });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log(
    { port: PORT, headless: HEADLESS, usedMb: cgroupUsedMb(), tokenConfigured: TOKEN.length > 0 },
    'isolated Codeforces submitter listening',
  );
});
