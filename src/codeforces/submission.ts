import type { Page, Response } from 'playwright';
import { BrowserFormError, clickSubmitForm, ensureFormTurnstile, fillSource, isSubmissionHistory, solveCloudflareWithCapzy } from './browserForm';
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
const REJECTION_RE =
  /you have submitted exactly the same code before|source code is too long|submission failed|invalid csrf|you are not allowed to submit|no such problem|problem not found|not a participant|captcha|turnstile|verification|verify you are human|solve the challenge|security check/i;
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
  /** Fresh cookies from the browser session for session continuity across submissions. */
  updatedCookies?: unknown[];
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

  const verificationFlags = { turnstile: false, interactive: false };
  const proxyUrl = (session as unknown as { proxyUrl?: string }).proxyUrl;
  try {
    await openSubmitForm(page, source, proxyUrl);
    const ts = await fillSubmitForm(page, source, code, proxyUrl);
    Object.assign(verificationFlags, ts);
    const click = await clickSubmitForm(page);
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
      const cleared = await waitOutChallenge(page, undefined, proxyUrl);
      const settled = await readBody(page);
      const settledUrl = page.url();
      if (!cleared || CHALLENGE_RE.test(settled) || CHALLENGE_RE.test(settledUrl) || /__cf_chl/i.test(settledUrl)) {
        return {
          ok: false,
          kind: 'blocked',
          error: `Codeforces cloudflare challenge did not clear in the browser (HTTP ${click.status ?? '?'}, ${settledUrl})`,
          status: click.status,
          finalUrl: settledUrl,
          ...flags,
        };
      }
      return finishPost(settled, settledUrl, null, flags);
    }
    return finishPost(body, page.url(), click.status, flags);
  } catch (err) {
    const message = errorMessage(err);
    const kind = err instanceof BrowserFormError ? err.kind : err instanceof CodeforcesBlockedError || CHALLENGE_RE.test(message) ? 'blocked' : 'submission-error';
    return { ...fail(kind, message), ...verificationFlags, ...(err instanceof BrowserFormError ? {
      turnstile: verificationFlags.turnstile || err.flags.turnstile,
      interactive: verificationFlags.interactive || err.flags.interactive,
      clicked: err.clicked,
    } : {}) };
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
  if (status !== null && status >= 400) {
    return { ok: false, kind: 'submission-error', error: `Codeforces answered the submission with HTTP ${status}`, status, finalUrl, ...flags };
  }
  if (!/codeforces\.com/i.test(finalUrl)) {
    return { ok: false, kind: 'submission-error', error: `the submit form left codeforces.com (${finalUrl})`, status, finalUrl, ...flags };
  }
  if (!isSubmissionHistory(finalUrl)) {
    const errorMsg = REJECTION_RE.test(body)
      ? `Codeforces rejected submission: ${compactBodyError(body)}`
      : 'Codeforces did not redirect to submission history after the POST; acceptance is uncertain and the POST was not retried.';
    return { ok: false, kind: 'submission-error', error: errorMsg, status, finalUrl, ...flags };
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
  return Number.isFinite(configured) && configured >= 0 ? configured : 25_000;
}

async function waitOutChallenge(page: Page, timeoutMs = challengeWaitMs(), proxyUrl?: string): Promise<boolean> {
  if (timeoutMs === 0) return false;
  const deadline = Date.now() + Math.max(timeoutMs, 45_000);
  let clickAttemptedAt = 0;

  if (proxyUrl) {
    try {
      const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => undefined);
      logger.info({ proxyUrl, userAgent }, 'waitOutChallenge: requesting Capzy solve');
      const result = await solveCloudflareWithCapzy(page.url() || 'https://codeforces.com', proxyUrl, userAgent, 30_000);
      if (result?.cookies && Object.keys(result.cookies).length > 0) {
        const cookiesToSet = Object.entries(result.cookies)
          .filter(([name]) => name.toLowerCase().startsWith('cf_') || name.toLowerCase().startsWith('__cf'))
          .map(([name, value]) => ({
            name, value: String(value), domain: '.codeforces.com', path: '/',
          }));
        if (cookiesToSet.length > 0) {
          logger.info({ count: cookiesToSet.length, names: cookiesToSet.map(c => c.name) }, 'waitOutChallenge: injecting Capzy Cloudflare cookies');
          await page.context().addCookies(cookiesToSet).catch(() => undefined);
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => undefined);
          await sleep(2_000);
          if ((await page.locator('#body').count().catch(() => 0)) > 0) {
            logger.info({ url: page.url() }, 'Codeforces challenge cleared in the browser after Capzy reload');
            return true;
          }
        }
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'waitOutChallenge: Capzy attempt failed');
    }
  }

  while (Date.now() < deadline) {
    await sleep(1_000);
    const isCodeforces = (await page.locator('#body').count().catch(() => 0)) > 0;
    if (isCodeforces) {
      logger.info({ url: page.url() }, 'Codeforces challenge cleared in the browser');
      return true;
    }

    if (Date.now() > clickAttemptedAt + 5_000) {
      try {
        const frameLocator = page.frameLocator('iframe[src*="challenges.cloudflare.com"]').first();
        const checkbox = frameLocator.locator('.ctp-checkbox-container, .mark, input[type="checkbox"]').first();
        if ((await checkbox.count().catch(() => 0)) > 0 && await checkbox.isVisible().catch(() => false)) {
          clickAttemptedAt = Date.now();
          await checkbox.click({ timeout: 500 }).catch(() => {});
        } else {
          const body = frameLocator.locator('body').first();
          if ((await body.count().catch(() => 0)) > 0 && await body.isVisible().catch(() => false)) {
            clickAttemptedAt = Date.now();
            await body.click({ position: { x: 10, y: 10 }, timeout: 500 }).catch(() => {});
          }
        }
      } catch {}
    }
  }
  logger.warn({ timeoutMs, url: page.url() }, 'Codeforces challenge did not clear in the browser');
  return false;
}

export async function openSubmitForm(page: Page, source: SourceIndexEntry, proxyUrl?: string): Promise<void> {
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
      if (await waitOutChallenge(page, undefined, proxyUrl)) {
        const settledFields = await readFields(page);
        if (hasSubmitForm(settledFields)) {
          logger.info({ path, fields: summarizeFields(settledFields) }, 'Codeforces submit form opened after HTTP 403 challenge cleared');
          return;
        }
      }
      attempts.push(`${path}: HTTP ${status} (Cloudflare challenge)`);
      blocked += 1;
      continue;
    }

    const body = await readBody(page);
    if (CHALLENGE_RE.test(body) || CHALLENGE_RE.test(finalUrl)) {
      await waitOutChallenge(page, undefined, proxyUrl);
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

async function fillSubmitForm(page: Page, source: SourceIndexEntry, code: string, proxyUrl?: string): Promise<{ turnstile: boolean; interactive: boolean }> {
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

  await fillSource(page, code);

  const token = await page.locator(`input[name="${csrfName}"]`).first().inputValue({ timeout: 5000 }).catch(() => '');
  if (!token) {
    throw new CodeforcesSubmissionError(`Codeforces ${csrfName} is empty — the submit page was not served correctly`);
  }

  return ensureFormTurnstile(page, TURNSTILE_WAIT_MS, proxyUrl);
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
  const useful = lines.find((line) =>
    /error|invalid|csrf|too long|failed|same code|not allowed|participant|captcha|turnstile|verification|human|robot/i.test(line)
  );
  return useful?.slice(0, 500) ?? 'Codeforces rejected the submission form';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
