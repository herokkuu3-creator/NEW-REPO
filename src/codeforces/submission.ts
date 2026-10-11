import type { Page, Response } from 'playwright';
import { BrowserFormError, clickSubmitForm, ensureFormTurnstile, fillSource, isSubmissionHistory, solveCloudflareWithCapzy, solveCloudflareOrchestrated } from './browserForm';
import { getCPSolverUrl } from './captchaSolver';
import { interactWithTurnstileCheckbox } from '../browser/stealth';
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
const configuredTurnstileWait = Number(process.env.CODEFORCES_TURNSTILE_WAIT_MS ?? 60_000);
const TURNSTILE_WAIT_MS = Math.max(
  Number.isFinite(configuredTurnstileWait) ? configuredTurnstileWait : 60_000,
  60_000,
);

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
  return Number.isFinite(configured) && configured >= 0 ? configured : 50_000;
}

async function waitOutChallenge(page: Page, timeoutMs = challengeWaitMs(), proxyUrl?: string): Promise<boolean> {
  if (timeoutMs === 0 || typeof page.context !== 'function') return false;
  const effectiveTimeout = Math.max(timeoutMs, 50_000);
  const deadline = Date.now() + effectiveTimeout;
  const currentUrl = page.url() || 'https://codeforces.com';
  const initialTitle = await page.title().catch(() => '');

  logger.info({ url: currentUrl, title: initialTitle, timeoutMs, effectiveTimeout, hasProxy: !!proxyUrl }, 'waitOutChallenge: starting challenge resolution');

  const initialIsChallenge = /just a moment|checking your browser|attention required|cloudflare/i.test(initialTitle);
  if (!initialIsChallenge && initialTitle.toLowerCase().includes('codeforces')) {
    const loc = page.locator('#header, #body, #pageContent, form:has(textarea[name="source"])');
    if ((await loc.count().catch(() => 0)) > 0) {
      logger.info({ title: initialTitle }, 'waitOutChallenge: page already has Codeforces content, no wait needed');
      return true;
    }
  }

  const solverUrl = getCPSolverUrl();
  if (proxyUrl || solverUrl) {
    try {
      const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => undefined);
      logger.info({ solverUrl, userAgent: userAgent?.slice(0, 80), url: currentUrl }, 'waitOutChallenge: invoking solveCloudflareOrchestrated synchronously');

      const solveStart = Date.now();
      const result = await solveCloudflareOrchestrated({
        websiteURL: currentUrl,
        proxyUrl,
        userAgent,
        timeoutMs: Math.max(35_000, timeoutMs),
      });

      const solveDuration = Date.now() - solveStart;
      logger.info({
        durationMs: solveDuration,
        ok: !!result,
        source: result?.source,
        hasToken: !!result?.token,
        cookieCount: Object.keys(result?.cookies ?? {}).length,
        hasClearance: !!result?.cfClearance,
      }, 'waitOutChallenge: solveCloudflareOrchestrated returned');

      if (result?.cookies && Object.keys(result.cookies).length > 0) {
        const cookiesToSet = Object.entries(result.cookies)
          .filter(([name]) => name.toLowerCase().startsWith('cf_') || name.toLowerCase().startsWith('__cf'))
          .map(([name, value]) => ({
            name,
            value: String(value),
            domain: '.codeforces.com',
            path: '/',
          }));

        if (cookiesToSet.length > 0) {
          logger.info({ count: cookiesToSet.length, names: cookiesToSet.map((c) => c.name), source: result.source }, 'waitOutChallenge: injecting Cloudflare clearance cookies into browser context');
          await page.context().addCookies(cookiesToSet).catch((err) => {
            logger.warn({ err: String(err) }, 'waitOutChallenge: addCookies threw');
          });

          await sleep(500);

          logger.info({ url: page.url() }, 'waitOutChallenge: reloading page after cookie injection...');
          const reloadRes = await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch((err) => {
            logger.warn({ err: String(err) }, 'waitOutChallenge: reload threw');
            return null;
          });

          await sleep(2000);

          const postTitle = await page.title().catch(() => '');
          const postUrl = page.url();
          const isStillChallenge = /just a moment|checking your browser|attention required|cloudflare/i.test(postTitle);
          const hasContent = await page.locator('#header, #body, #pageContent, form:has(textarea[name="source"])').count().catch(() => 0);

          logger.info({
            postStatus: reloadRes?.status() ?? null,
            postTitle,
            postUrl,
            isStillChallenge,
            hasContent,
          }, 'waitOutChallenge: post-reload verification check');

          if (!isStillChallenge && hasContent > 0) {
            logger.info({ postTitle, hasContent }, 'waitOutChallenge: challenge successfully cleared after solver cookies injection!');
            return true;
          }
        }
      }
    } catch (solverErr) {
      logger.warn({ err: errorMessage(solverErr) }, 'waitOutChallenge: orchestrated solver threw an error');
    }
  }

  // Fallback: check loop until deadline
  let clickAttemptedAt = 0;
  while (Date.now() < deadline) {
    try {
      const cookies = await page.context().cookies().catch(() => []);
      const hasClearance = cookies.some((c) => c.name === 'cf_clearance' && c.value.length > 5);
      if (hasClearance) {
        logger.info({ url: page.url() }, 'waitOutChallenge: cf_clearance cookie detected in cookie jar');
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
        logger.info({ title, count, url: page.url() }, 'waitOutChallenge: Codeforces page content detected');
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
    try {
      logger.info({ path }, 'openSubmitForm: navigating to candidate submit path');
      const response = await page.goto(`https://codeforces.com${path}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });

      const status = response?.status() ?? 0;
      const finalUrl = page.url();
      const title = await page.title().catch(() => '');
      logger.info({ path, status, finalUrl, title }, 'openSubmitForm: initial navigation completed');

      if (/\/enter(?:[/?#]|$)/i.test(finalUrl)) {
        throw new Error('Codeforces session is signed out (the submit page redirected to the login page)');
      }

      if (status === 403 || status === 503 || CHALLENGE_RE.test(title)) {
        logger.info({ path, status, title }, 'openSubmitForm: Cloudflare challenge detected (HTTP 403/503 or challenge title)');
        const cleared = await waitOutChallenge(page, undefined, proxyUrl);
        logger.info({ path, cleared }, 'openSubmitForm: waitOutChallenge returned');

        if (cleared) {
          await sleep(1500);
          let fields = await readFields(page);
          logger.info({ path, fieldsCount: fields.length, fields: summarizeFields(fields), url: page.url() }, 'openSubmitForm: checking fields after clearance');
          if (hasSubmitForm(fields)) {
            logger.info({ path, fields: summarizeFields(fields) }, 'Codeforces submit form opened after challenge cleared');
            return;
          }

          logger.info({ path }, 'openSubmitForm: submit form fields not found immediately, navigating with clearance cookies');
          const retryRes = await page.goto(`https://codeforces.com${path}`, {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
          }).catch((err) => {
            logger.warn({ err: String(err) }, 'openSubmitForm: retry navigation threw');
            return null;
          });

          await sleep(1500);
          fields = await readFields(page);
          const retryStatus = retryRes?.status() ?? null;
          const retryTitle = await page.title().catch(() => '');
          logger.info({ path, retryStatus, retryTitle, fieldsCount: fields.length, fields: summarizeFields(fields), url: page.url() }, 'openSubmitForm: post-retry fields check');

          if (hasSubmitForm(fields)) {
            logger.info({ path, fields: summarizeFields(fields) }, 'Codeforces submit form opened after clearance retry navigation');
            return;
          }
          attempts.push(`${path}: HTTP ${status} (challenge cleared but submit form missing on ${page.url()}, fields: ${summarizeFields(fields)})`);
          blocked += 1;
          continue;
        }

        attempts.push(`${path}: HTTP ${status} (Cloudflare challenge could not be cleared)`);
        blocked += 1;
        continue;
      }

      const body = await readBody(page);
      if (CHALLENGE_RE.test(body) || CHALLENGE_RE.test(finalUrl)) {
        logger.info({ path, bodySnippet: body.slice(0, 100) }, 'openSubmitForm: Challenge text matched in body');
        const cleared = await waitOutChallenge(page, undefined, proxyUrl);
        if (cleared) {
          await sleep(1500);
          let fields = await readFields(page);
          if (hasSubmitForm(fields)) {
            logger.info({ path, fields: summarizeFields(fields) }, 'Codeforces submit form opened after challenge cleared');
            return;
          }
          const retryRes = await page.goto(`https://codeforces.com${path}`, {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
          }).catch(() => null);
          await sleep(1500);
          fields = await readFields(page);
          if (hasSubmitForm(fields)) {
            logger.info({ path, fields: summarizeFields(fields) }, 'Codeforces submit form opened after clearance retry navigation');
            return;
          }
          attempts.push(`${path}: challenge cleared but submit form missing on ${page.url()}`);
          blocked += 1;
          continue;
        }
        const settled = await readBody(page);
        if (!cleared && (CHALLENGE_RE.test(settled) || CHALLENGE_RE.test(page.url()))) {
          throw new CodeforcesBlockedError('Codeforces served a browser verification page while opening the submit form');
        }
        attempts.push(`${path}: challenge in body could not be cleared`);
        blocked += 1;
        continue;
      }

      const fields = await readFields(page);
      if (hasSubmitForm(fields)) {
        logger.info({ path, fields: summarizeFields(fields) }, 'Codeforces submit form opened directly');
        return;
      }

      attempts.push(
        `${path}: no submit form (url ${finalUrl}; title "${title}"; fields: ${summarizeFields(fields)})`,
      );
    } catch (err) {
      if (err instanceof CodeforcesBlockedError || err instanceof CodeforcesSubmissionError) throw err;
      attempts.push(`${path}: navigation failed (${errorMessage(err)})`);
    }
  }

  const message = `Codeforces submit form could not be opened for ${source.contestId}/${source.problemIndex} — ${attempts.join(' | ')}`;
  logger.error({ message, blocked, total: candidates.length }, 'openSubmitForm: all candidates exhausted');
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
