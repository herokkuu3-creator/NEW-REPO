import type { Page, Response } from 'playwright';
import type { BrowserSession } from '../browser/playwright';
import { logger } from '../logger';
import { fetchUserStatus, fetchContestStatus, CodeforcesSubmission } from './api';
import type { SourceIndexEntry } from './sourceRepo';

export type CodeforcesSubmissionResult =
  | {
      ok: true;
      submissionId: string;
      verdict: string;
      statusDisplay: string;
    }
  | {
      ok: false;
      kind: 'signed-out' | 'blocked' | 'submission-error' | 'judge-timeout';
      error: string;
      submissionId?: string | null;
      verdict?: string | null;
      statusDisplay?: string | null;
    };

/** Cloudflare refused every submit endpoint: the server cannot submit, a human can. */
export class CodeforcesBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeforcesBlockedError';
  }
}

export class CodeforcesSubmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeforcesSubmissionError';
  }
}

export interface SubmitField {
  name: string;
  tag: string;
  type: string;
}

export interface SelectOption {
  value: string;
  text: string;
}

const CHALLENGE_RE = /just a moment|checking your browser|verify you are human|cf-chl|enable javascript and cookies/i;
const SIGNED_OUT_RE = /you are not logged in|please login|please sign in|not logged in|register for practice/i;
const REJECTION_RE = /you have submitted exactly the same code before|source code is too long|submission failed|invalid csrf|you are not allowed to submit|no such problem|problem not found|not a participant/i;
const PENDING_VERDICTS = new Set(['TESTING', 'QUEUE', 'QUEUED', undefined, null]);
const VERIFICATION_WINDOW_MS = 150_000;
const VERIFICATION_POLL_MS = 2_500;
const configuredTurnstileWait = Number(process.env.CODEFORCES_TURNSTILE_WAIT_MS ?? 8_000);
const TURNSTILE_WAIT_MS =
  Number.isFinite(configuredTurnstileWait) && configuredTurnstileWait >= 1_000
    ? configuredTurnstileWait
    : 8_000;

/** Outcome of posting the submit form from the browser, before any polling. */
export interface BrowserPostOutcome {
  ok: boolean;
  kind?: 'signed-out' | 'blocked' | 'submission-error';
  error?: string;
  /** HTTP status of the form POST navigation, when the browser reported one. */
  status: number | null;
  finalUrl: string;
  /** Whether the Cloudflare Turnstile field on the form carried a token when it was posted. */
  turnstile: boolean;
  /** Whether a submit control inside the submit form itself was found and clicked. */
  clicked: boolean;
  /** Whether Turnstile rendered an interactive widget instead of solving itself. */
  interactive: boolean;
}

/**
 * Every submit endpoint Codeforces exposes for a problem, most specific first.
 * Finished contests answer /contest/<id>/submit with the problemset form (or a
 * 403 from bot protection), so the caller walks this list until one actually
 * renders a submit form instead of assuming a single URL works.
 */
export function submitFormCandidates(
  source: Pick<SourceIndexEntry, 'contestId' | 'problemIndex' | 'gym'>,
): string[] {
  const { contestId, problemIndex } = source;
  if (contestId === undefined || !problemIndex) return [];
  if (source.gym) return [`/gym/${contestId}/submit`];
  return [
    `/contest/${contestId}/submit`,
    `/problemset/submit/${contestId}/${problemIndex}`,
    `/problemset/submit?contestId=${contestId}&problemIndex=${problemIndex}`,
  ];
}

export function findCsrfField(fields: SubmitField[]): string | null {
  const named = fields.find((field) => field.tag === 'input' && /csrf/i.test(field.name));
  return named?.name ?? null;
}

export function planProblemField(fields: SubmitField[]): 'select-index' | 'input-index' | 'input-code' | 'none' {
  if (fields.some((field) => field.tag === 'select' && /^submittedProblemIndex$/i.test(field.name))) return 'select-index';
  if (fields.some((field) => field.tag === 'input' && /^submittedProblemIndex$/i.test(field.name))) return 'input-index';
  if (fields.some((field) => field.tag === 'input' && /^submittedProblemCode$/i.test(field.name))) return 'input-code';
  return 'none';
}

export function hasSubmitForm(fields: SubmitField[]): boolean {
  return (
    fields.some((field) => field.tag === 'textarea' && field.name === 'source') &&
    fields.some((field) => field.tag === 'select' && field.name === 'programTypeId')
  );
}

export function chooseLanguageOption(options: SelectOption[], language: 'cpp' | 'python'): SelectOption | null {
  if (language === 'python') {
    return (
      options.find((option) => /PyPy\s*3/i.test(option.text)) ??
      options.find((option) => /Python\s*3/i.test(option.text)) ??
      null
    );
  }
  const ranked = options
    .map((option) => ({ option, match: /GNU\s*G\+\+\s*(\d+)/i.exec(option.text) }))
    .filter((entry): entry is { option: SelectOption; match: RegExpExecArray } => !!entry.match)
    .sort((a, b) => Number(b.match[1]) - Number(a.match[1]));
  return ranked[0]?.option ?? options.find((option) => /C\+\+/i.test(option.text)) ?? null;
}

export function summarizeFields(fields: SubmitField[]): string {
  const names = fields.map((field) => field.name).filter(Boolean);
  return names.length > 0 ? names.join(', ') : '(no named fields)';
}

export async function submitAndVerify(
  session: BrowserSession,
  username: string,
  source: SourceIndexEntry,
  code: string,
): Promise<CodeforcesSubmissionResult> {
  if (source.contestId === undefined || !source.problemIndex) {
    return { ok: false, kind: 'submission-error', error: 'source entry has no contestId/problemIndex' };
  }

  let beforeIds: Set<number>;
  try {
    beforeIds = await captureBefore(username, source);
  } catch (err) {
    return {
      ok: false,
      kind: 'submission-error',
      error: `could not read existing Codeforces submissions before submitting: ${errorMessage(err)}`,
    };
  }
  const submittedAt = Math.floor(Date.now() / 1000);

  const posted = await postSubmitForm(session, source, code);
  if (!posted.ok) {
    return { ok: false, kind: posted.kind ?? 'submission-error', error: posted.error ?? 'Codeforces rejected the submission form' };
  }

  const submission = await pollForVerdict(username, source, beforeIds, submittedAt);
  if (!submission) {
    return {
      ok: false,
      kind: 'judge-timeout',
      error: `submission was sent, but no matching new ${source.contestId}/${source.problemIndex} submission appeared within the verification window`,
    };
  }

  const verdict = submission.verdict ?? 'TESTING';
  logger.info(
    { username, contestId: source.contestId, problemIndex: source.problemIndex, submissionId: submission.id, verdict },
    'Codeforces submission verdict received',
  );

  if (verdict === 'OK') {
    return { ok: true, submissionId: String(submission.id), verdict, statusDisplay: 'OK' };
  }
  return {
    ok: false,
    kind: 'submission-error',
    error: `Codeforces verdict: ${verdict}`,
    submissionId: String(submission.id),
    verdict,
    statusDisplay: verdict,
  };
}

/** Ids of the account's submissions before a POST, read browserless. */
export async function captureBefore(handle: string, source: SourceIndexEntry): Promise<Set<number>> {
  return new Set((await fetchSubmissions(handle, source)).map((submission) => submission.id));
}

/**
 * Opens the submit page in the browser, fills the form and posts it.
 *
 * Callers must close the browser as soon as this resolves, before polling for
 * the verdict: on the 512MB free instance, holding the browser open while the
 * verdict was polled was enough to OOM-kill the whole service mid-submission.
 */
export async function postSubmitForm(
  session: BrowserSession,
  source: SourceIndexEntry,
  code: string,
): Promise<BrowserPostOutcome> {
  const page = session.page;
  const fail = (kind: BrowserPostOutcome['kind'], error: string): BrowserPostOutcome => ({
    ok: false,
    kind,
    error,
    status: null,
    finalUrl: page.url(),
    turnstile: false,
    clicked: false,
    interactive: false,
  });

  try {
    await openSubmitForm(page, source);
    const ts = await fillSubmitForm(page, source, code);
    const click = await clickSubmit(page);
    const flags = { turnstile: ts.turnstile, clicked: click.clicked, interactive: ts.interactive };
    if (!click.clicked) {
      return {
        ...fail('submission-error', `Codeforces submit control was not found inside the submit form on ${page.url()}`),
        status: click.status,
        ...flags,
      };
    }
    logger.info({ ...flags, status: click.status }, 'Codeforces submit form posted from the browser');

    const body = await readBody(page);
    if (click.status === 403 || click.status === 503 || CHALLENGE_RE.test(body) || CHALLENGE_RE.test(page.url()) || /__cf_chl/i.test(page.url())) {
      await waitOutChallenge(page);
      let settled = await readBody(page);
      let settledUrl = page.url();
      if (CHALLENGE_RE.test(settled) || CHALLENGE_RE.test(settledUrl) || /__cf_chl/i.test(settledUrl)) {
        return {
          ok: false,
          kind: 'blocked',
          error: `Codeforces cloudflare challenge did not clear in the browser (HTTP ${click.status ?? '?'}, ${settledUrl})`,
          status: click.status,
          finalUrl: settledUrl,
          ...flags,
        };
      }
      
      if (!/\/my/i.test(settledUrl) && /submit/i.test(settledUrl)) {
        logger.info({}, 'Challenge cleared, but POST data was lost. Re-filling and re-submitting...');
        await fillSubmitForm(page, source, code);
        const click2 = await clickSubmit(page);
        settled = await readBody(page);
        settledUrl = page.url();
        click.status = click2.status;
      }
      
      return finishPost(settled, settledUrl, click.status, flags);
    }
    return finishPost(body, page.url(), click.status, flags);
  } catch (err) {
    const message = errorMessage(err);
    const kind = err instanceof CodeforcesBlockedError || CHALLENGE_RE.test(message) ? 'blocked' : 'submission-error';
    return { ...fail(kind, message) };
  }
}

function finishPost(
  body: string,
  finalUrl: string,
  status: number | null,
  flags: { turnstile: boolean; clicked: boolean; interactive: boolean },
): BrowserPostOutcome {
  if (SIGNED_OUT_RE.test(body) || /\/enter(?:[/?#]|$)/i.test(finalUrl)) {
    return {
      ok: false,
      kind: 'signed-out',
      error: 'Codeforces answered the submission with a signed-out page; re-send the session cookies with /renew',
      status,
      finalUrl,
      ...flags,
    };
  }
  if (REJECTION_RE.test(body)) {
    return { ok: false, kind: 'submission-error', error: compactBodyError(body), status, finalUrl, ...flags };
  }
  if (!/codeforces\.com/i.test(finalUrl)) {
    return { ok: false, kind: 'submission-error', error: `the submit form left codeforces.com (${finalUrl})`, status, finalUrl, ...flags };
  }
  return { ok: true, status, finalUrl, ...flags };
}

/**
 * How long to let a managed challenge clear. The free tier cannot hold Firefox
 * open for a long managed challenge, so the default is short — a normal managed
 * challenge clears in a second or two, and otherwise the step is abandoned with
 * a real reason instead of starving the container.
 */
function challengeWaitMs(): number {
  const configured = Number(process.env.CODEFORCES_CHALLENGE_WAIT_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 8_000;
}

async function waitOutChallenge(page: Page, timeoutMs = challengeWaitMs()): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1_000);
    const isCodeforces = (await page.locator('#body').count().catch(() => 0)) > 0;
    if (isCodeforces) {
      logger.info({ url: page.url() }, 'Codeforces challenge cleared in the browser');
      return true;
    }
  }
  logger.warn({ timeoutMs, url: page.url() }, 'Codeforces challenge did not clear in the browser');
  return false;
}

export async function openSubmitForm(page: Page, source: SourceIndexEntry): Promise<void> {
  const candidates = submitFormCandidates(source);
  if (candidates.length === 0) {
    throw new CodeforcesSubmissionError('source entry has no contestId/problemIndex');
  }

  const attempts: string[] = [];
  let blocked = 0;
  for (const path of candidates) {
    let response: Response | null = null;
    try {
      response = await page.goto(`https://codeforces.com${path}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
    } catch (err) {
      attempts.push(`${path}: navigation failed (${errorMessage(err)})`);
      continue;
    }

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
      await waitOutChallenge(page);
      const settled = await readBody(page);
      if (CHALLENGE_RE.test(settled) || CHALLENGE_RE.test(page.url())) {
        throw new CodeforcesBlockedError('Codeforces served a browser verification page while opening the submit form');
      }
      const settledFields = await readFields(page);
      if (hasSubmitForm(settledFields)) {
        logger.info({ path, fields: summarizeFields(settledFields) }, 'Codeforces submit form opened after the challenge cleared');
        return;
      }
      attempts.push(`${path}: challenge cleared but no submit form (url ${page.url()})`);
      continue;
    }

    const fields = await readFields(page);
    if (hasSubmitForm(fields)) {
      logger.info({ path, fields: summarizeFields(fields) }, 'Codeforces submit form opened');
      return;
    }

    attempts.push(
      `${path}: no submit form (url ${finalUrl}; title "${await page.title().catch(() => '')}"; fields: ${summarizeFields(fields)})`,
    );
  }

  const message = `Codeforces submit form could not be opened for ${source.contestId}/${source.problemIndex} — ${attempts.join(' | ')}`;
  if (blocked === candidates.length) throw new CodeforcesBlockedError(message);
  throw new CodeforcesSubmissionError(message);
}

async function fillSubmitForm(page: Page, source: SourceIndexEntry, code: string): Promise<{ turnstile: boolean; interactive: boolean }> {
  const settled = await page.locator('form:has(textarea[name="source"])').waitFor({ state: 'attached', timeout: 15_000 }).then(() => true).catch(() => false);
  if (!settled) {
    const body = await readBody(page);
    const title = await page.title().catch(() => '');
    logger.warn({ title, bodySnippet: body.slice(0, 500) }, 'Form did not settle, page is stuck');
  }
  
  const problemIndex = source.problemIndex!;
  const contestId = source.contestId!;
  const fields = await readFields(page);

  const csrfName = findCsrfField(fields);
  if (!csrfName) {
    throw new CodeforcesSubmissionError(`Codeforces submit form has no csrf field (fields: ${summarizeFields(fields)})`);
  }

  const contestSelector = page.locator('select[name="contestId"]').first();
  if ((await contestSelector.count().catch(() => 0)) > 0) {
    await contestSelector.selectOption(String(contestId), { force: true, timeout: 5000 }).catch(() => undefined);
  }

  switch (planProblemField(fields)) {
    case 'select-index': {
      const select = page.locator('select[name="submittedProblemIndex"]').first();
      const options = await readOptions(page, 'submittedProblemIndex');
      const target =
        options.find((option) => option.value.trim().toUpperCase() === problemIndex.toUpperCase()) ??
        options.find((option) => option.text.trim().toUpperCase() === problemIndex.toUpperCase());
      if (!target) {
        throw new CodeforcesSubmissionError(
          `contest ${contestId} submit form has no option for problem ${problemIndex} (options: ${options.map((o) => o.text).join(', ') || 'none'})`,
        );
      }
      await select.selectOption(target.value, { force: true, timeout: 5000 });
      break;
    }
    case 'input-index':
      await page.locator('input[name="submittedProblemIndex"]').first().fill(problemIndex, { force: true, timeout: 5000 });
      break;
    case 'input-code':
      await page.locator('input[name="submittedProblemCode"]').first().fill(`${contestId}${problemIndex}`, { force: true, timeout: 5000 });
      break;
    default:
      throw new CodeforcesSubmissionError(
        `Codeforces submit form has no problem selector (fields: ${summarizeFields(fields)})`,
      );
  }

  const options = await readOptions(page, 'programTypeId');
  if (options.length === 0) {
    throw new CodeforcesSubmissionError(`Codeforces submit form has no programTypeId options (fields: ${summarizeFields(fields)})`);
  }
  const language = chooseLanguageOption(options, source.language);
  if (!language) {
    throw new CodeforcesSubmissionError(
      source.language === 'python'
        ? `no Python 3 language option on the Codeforces form (options: ${options.map((o) => o.text).join(', ')})`
        : `no C++ language option on the Codeforces form (options: ${options.map((o) => o.text).join(', ')})`,
    );
  }
  await page.locator('select[name="programTypeId"]').first().selectOption(language.value, { force: true, timeout: 5000 });

  const sourceBox = page.locator('textarea[name="source"]').first();
  if ((await sourceBox.count().catch(() => 0)) === 0) {
    throw new CodeforcesSubmissionError(`Codeforces submit form has no source textarea (fields: ${summarizeFields(fields)})`);
  }

  await page.evaluate((content) => {
    const toggle = document.getElementById('toggleEditorCheckbox') as HTMLInputElement | null;
    if (toggle && toggle.checked) {
      toggle.click(); // Let Codeforces' own JS cleanly destroy CodeMirror
    }
    const ta = document.querySelector('textarea[name="source"]') as HTMLTextAreaElement | null;
    if (ta) {
      ta.value = content;
    }
    // mock window.editor so native submit click doesn't crash Codeforces JS
    (window as any).editor = { save: () => {} };
  }, code).catch(() => undefined);

  const token = await page.locator(`input[name="${csrfName}"]`).first().inputValue({ timeout: 5000 }).catch(() => '');
  if (!token) {
    throw new CodeforcesSubmissionError(`Codeforces ${csrfName} is empty — the submit page was not served correctly`);
  }

  return ensureTurnstile(page);
}

/** The token Cloudflare's widget writes into the form; Codeforces refuses to post without it. */
async function turnstileToken(page: Page): Promise<string> {
  return page.locator('input[name="turnstileToken"]').first().inputValue().catch(() => '');
}

async function waitForToken(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await turnstileToken(page)).trim()) return true;
    await sleep(500);
  }
  return false;
}

/**
 * Cloudflare's Turnstile widget fills `turnstileToken`, and Codeforces refuses
 * the POST without it. On a trusted/managed session it resolves on its own in a
 * second or two. If it instead demands an interactive challenge, the container
 * must NOT be kept alive trying to automate it: the step is abandoned with the
 * reason recorded, so the service survives and the report says what happened.
 */
async function ensureTurnstile(
  page: Page,
  timeoutMs = TURNSTILE_WAIT_MS,
): Promise<{ turnstile: boolean; interactive: boolean }> {
  if ((await page.locator('input[name="turnstileToken"]').first().count().catch(() => 0)) === 0) {
    return { turnstile: false, interactive: false };
  }

  const solverUrl = process.env.TURNSTILE_SOLVER_URL;
  if (solverUrl) {
    const sitekey = await page.locator('.cf-turnstile').first().getAttribute('data-sitekey').catch(() => null);
    if (sitekey) {
      logger.info({ sitekey, solverUrl }, 'Requesting Turnstile token from external solver...');
      try {
        const res = await fetch(`${solverUrl.replace(/\/+$/, '')}/solve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ siteurl: page.url(), sitekey })
        });
        const data = (await res.json()) as { token?: string };
        if (data.token) {
          logger.info({}, 'External Turnstile solver succeeded');
          await page.evaluate((tok) => {
            const el = document.querySelector('input[name="turnstileToken"]') as HTMLInputElement;
            if (el) el.value = tok;
          }, data.token);
          return { turnstile: true, interactive: false };
        }
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'External Turnstile solver failed');
      }
    }
  }

  if (await waitForToken(page, timeoutMs)) {
    logger.info('Codeforces Turnstile solved itself in the browser');
    return { turnstile: true, interactive: false };
  }

  const interactive =
    (await page.locator('iframe[src*="challenges.cloudflare.com"]').count().catch(() => 0)) > 0;
  logger.warn({ interactive }, 'Codeforces Turnstile failed to issue a token. Proceeding anyway.');
  return { turnstile: true, interactive };
}

/**
 * Clicks the submit control OF THE SUBMIT FORM. The page also carries a header
 * search form whose button is `type="submit"` too, so the control is looked up
 * inside the form holding the source textarea rather than page-wide: clicking the
 * wrong form is a click that posts nothing at all.
 */
async function clickSubmit(page: Page): Promise<{ clicked: boolean; status: number | null }> {
  const form = page.locator('form:has(textarea[name="source"])').first();
  if ((await form.count().catch(() => 0)) === 0) return { clicked: false, status: null };

  const [response] = await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => null),
    form.locator('input[type="submit"]').first().click({ force: true, timeout: 15_000 }).catch(() => undefined),
  ]);
  return { clicked: true, status: response?.status() ?? null };
}

async function readFields(page: Page): Promise<SubmitField[]> {
  return page
    .evaluate(() =>
      Array.from(document.querySelectorAll('input, select, textarea')).map((element) => ({
        name: element.getAttribute('name') ?? '',
        tag: element.tagName.toLowerCase(),
        type: (element.getAttribute('type') ?? '').toLowerCase(),
      })),
    )
    .catch(() => []);
}

async function readOptions(page: Page, name: string): Promise<SelectOption[]> {
  return page
    .locator(`select[name="${name}"] option`)
    .evaluateAll((nodes) =>
      nodes.map((node) => ({ value: (node as HTMLOptionElement).value, text: (node.textContent ?? '').trim() })),
    )
    .catch(() => []);
}

async function readBody(page: Page): Promise<string> {
  const body = (await page.locator('body').innerText().catch(() => '')) ?? '';
  return body.slice(0, 20_000);
}

async function fetchSubmissions(username: string, source: SourceIndexEntry): Promise<CodeforcesSubmission[]> {
  return source.gym
    ? fetchContestStatus(source.contestId!, username, 100)
    : fetchUserStatus(username, 100);
}

/**
 * Reads the verdict of the submission that appeared after `submittedAt`.
 * Runs browserless, so the browser that posted it can already be gone.
 */
export async function pollForVerdict(
  username: string,
  source: SourceIndexEntry,
  beforeIds: Set<number>,
  submittedAt: number,
  deps: { sleep?: (ms: number) => Promise<void>; now?: () => number; windowMs?: number } = {},
): Promise<CodeforcesSubmission | null> {
  const wait = deps.sleep ?? sleep;
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.windowMs ?? VERIFICATION_WINDOW_MS);
  const maxPolls = Math.ceil((deps.windowMs ?? VERIFICATION_WINDOW_MS) / VERIFICATION_POLL_MS) + 2;
  let latest: CodeforcesSubmission | undefined;

  for (let poll = 0; poll < maxPolls && now() < deadline; poll++) {
    await wait(VERIFICATION_POLL_MS);
    const submissions = await fetchSubmissions(username, source).catch(() => [] as CodeforcesSubmission[]);
    const candidate = submissions
      .filter((submission) => !beforeIds.has(submission.id))
      .filter((submission) => submission.creationTimeSeconds >= submittedAt - 30)
      .filter((submission) =>
        submission.problem.contestId === source.contestId || submission.contestId === source.contestId,
      )
      .filter((submission) => submission.problem.index === source.problemIndex)
      .sort((a, b) => b.id - a.id)[0];

    if (candidate) {
      latest = candidate;
      if (!PENDING_VERDICTS.has(candidate.verdict)) return candidate;
    }
  }
  return latest ?? null;
}

function compactBodyError(body: string): string {
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const useful = lines.find((line) => /error|invalid|csrf|too long|failed|same code|not allowed|participant/i.test(line));
  return useful?.slice(0, 500) ?? 'Codeforces rejected the submission form';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
