import { Page, Response } from 'playwright';
import { BrowserSession } from '../browser/playwright';
import { logger } from '../logger';
import { fetchUserStatus, fetchContestStatus, CodeforcesSubmission } from './api';
import { SourceIndexEntry } from './sourceRepo';

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

  let before: CodeforcesSubmission[] = [];
  try {
    before = await fetchSubmissions(username, source);
  } catch (err) {
    return {
      ok: false,
      kind: 'submission-error',
      error: `could not read existing Codeforces submissions before submitting: ${errorMessage(err)}`,
    };
  }
  const beforeIds = new Set(before.map((submission) => submission.id));
  const submittedAt = Math.floor(Date.now() / 1000);

  try {
    await openSubmitForm(session.page, source);
    await fillSubmitForm(session.page, source, code);
    const clicked = await clickSubmit(session.page);
    if (!clicked) {
      throw new CodeforcesSubmissionError(
        `Codeforces submit button was not found on ${session.page.url()} (fields: ${summarizeFields(await readFields(session.page))})`,
      );
    }

    const body = await readBody(session.page);
    if (CHALLENGE_RE.test(body) || CHALLENGE_RE.test(session.page.url())) {
      return {
        ok: false,
        kind: 'blocked',
        error: 'Codeforces served a browser verification page during submission',
      };
    }
    if (REJECTION_RE.test(body)) {
      return { ok: false, kind: 'submission-error', error: compactBodyError(body) };
    }
  } catch (err) {
    const message = errorMessage(err);
    if (err instanceof CodeforcesBlockedError || CHALLENGE_RE.test(message)) {
      return { ok: false, kind: 'blocked', error: message };
    }
    return { ok: false, kind: 'submission-error', error: message };
  }

  const submission = await pollForNewSubmission(username, source, beforeIds, submittedAt);
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
      throw new CodeforcesBlockedError('Codeforces served a browser verification page while opening the submit form');
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

async function fillSubmitForm(page: Page, source: SourceIndexEntry, code: string): Promise<void> {
  const problemIndex = source.problemIndex!;
  const contestId = source.contestId!;
  const fields = await readFields(page);

  const csrfName = findCsrfField(fields);
  if (!csrfName) {
    throw new CodeforcesSubmissionError(`Codeforces submit form has no csrf field (fields: ${summarizeFields(fields)})`);
  }

  const contestSelector = page.locator('select[name="contestId"]').first();
  if ((await contestSelector.count().catch(() => 0)) > 0) {
    await contestSelector.selectOption(String(contestId)).catch(() => undefined);
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
      await select.selectOption(target.value);
      break;
    }
    case 'input-index':
      await page.locator('input[name="submittedProblemIndex"]').first().fill(problemIndex);
      break;
    case 'input-code':
      await page.locator('input[name="submittedProblemCode"]').first().fill(`${contestId}${problemIndex}`);
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
  await page.locator('select[name="programTypeId"]').first().selectOption(language.value);

  const sourceBox = page.locator('textarea[name="source"]').first();
  if ((await sourceBox.count().catch(() => 0)) === 0) {
    throw new CodeforcesSubmissionError(`Codeforces submit form has no source textarea (fields: ${summarizeFields(fields)})`);
  }
  await sourceBox.fill(code);

  const token = await page.locator(`input[name="${csrfName}"]`).first().inputValue().catch(() => '');
  if (!token) {
    throw new CodeforcesSubmissionError(`Codeforces ${csrfName} is empty — the submit page was not served correctly`);
  }
}

async function clickSubmit(page: Page): Promise<boolean> {
  const input = page.locator('input[type="submit"][value*="Submit" i]').first();
  if ((await input.count().catch(() => 0)) > 0) {
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => undefined),
      input.click({ timeout: 20_000 }),
    ]);
    return true;
  }
  const button = page.locator('button[type="submit"]').filter({ hasText: /submit/i }).first();
  if ((await button.count().catch(() => 0)) > 0) {
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => undefined),
      button.click({ timeout: 20_000 }),
    ]);
    return true;
  }
  return false;
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

async function pollForNewSubmission(
  username: string,
  source: SourceIndexEntry,
  beforeIds: Set<number>,
  submittedAt: number,
): Promise<CodeforcesSubmission | null> {
  const deadline = Date.now() + VERIFICATION_WINDOW_MS;
  let latest: CodeforcesSubmission | undefined;

  while (Date.now() < deadline) {
    await sleep(2_500);
    const submissions = await fetchSubmissions(username, source).catch(() => [] as CodeforcesSubmission[]);
    const candidate = submissions
      .filter((submission) => !beforeIds.has(submission.id))
      .filter((submission) => submission.creationTimeSeconds >= submittedAt - 10)
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
