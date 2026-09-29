import { Page } from 'playwright';
import { BrowserSession } from '../browser/playwright';
import { logger } from '../logger';
import { fetchUserStatus, fetchContestStatus, CodeforcesSubmission } from './api';
import { SourceIndexEntry } from './sourceRepo';
import { inspectCodeforcesSessionPage } from './session';

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

export class CodeforcesSubmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeforcesSubmissionError';
  }
}

const CHALLENGE_RE = /just a moment|checking your browser|verify you are human|cf-chl/i;
const PENDING_VERDICTS = new Set(['TESTING', 'QUEUE', 'QUEUED', undefined, null]);

export async function submitAndVerify(
  session: BrowserSession,
  username: string,
  source: SourceIndexEntry,
  code: string,
): Promise<CodeforcesSubmissionResult> {
  if (source.contestId === undefined || !source.problemIndex) {
    return { ok: false, kind: 'submission-error', error: 'source entry has no contestId/problemIndex' };
  }

  const before = await fetchSubmissions(username, source);
  const beforeIds = new Set(before.map((s) => s.id));
  const submittedAt = Math.floor(Date.now() / 1000);

  try {
    await openSubmitForm(session.page, source);
    await fillSubmitForm(session.page, source, code);
    const result = await clickSubmit(session.page);
    if (!result) throw new CodeforcesSubmissionError('Codeforces submit button was not found');

    const body = ((await session.page.locator('body').innerText().catch(() => '')) ?? '').slice(0, 20_000);
    if (CHALLENGE_RE.test(body) || CHALLENGE_RE.test(session.page.url())) {
      return {
        ok: false,
        kind: 'blocked',
        error: 'Codeforces served a browser verification page during submission',
      };
    }
    if (/source code is too long|submission failed|invalid csrf|csrf/i.test(body)) {
      return {
        ok: false,
        kind: 'submission-error',
        error: compactBodyError(body),
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (CHALLENGE_RE.test(msg)) return { ok: false, kind: 'blocked', error: msg };
    return { ok: false, kind: 'submission-error', error: msg };
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

async function openSubmitForm(page: Page, source: SourceIndexEntry): Promise<void> {
  const path = source.gym
    ? `/gym/${source.contestId}/submit`
    : `/contest/${source.contestId}/submit`;
  await page.goto(`https://codeforces.com${path}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await page.waitForTimeout(500);

  const check = await inspectCodeforcesSessionPage(page);
  if (!check.ok) {
    if (check.reason === 'signed-out') throw new Error('Codeforces session is signed out');
    if (check.reason === 'blocked') throw new Error(check.error);
  }

  const csrf = page.locator('input[name="csrf_token"]').first();
  if ((await csrf.count().catch(() => 0)) === 0) {
    throw new CodeforcesSubmissionError('Codeforces submit form has no csrf_token field');
  }
}

async function fillSubmitForm(page: Page, source: SourceIndexEntry, code: string): Promise<void> {
  const problemIndex = page.locator('select[name="submittedProblemIndex"]').first();
  if ((await problemIndex.count().catch(() => 0)) > 0) {
    const option = problemIndex.locator('option').filter({ hasText: new RegExp(`^\\s*${escapeRegExp(source.problemIndex!)}\\s*$`) }).first();
    if ((await option.count().catch(() => 0)) > 0) {
      const value = await option.getAttribute('value');
      if (value) {
        await problemIndex.selectOption(value);
      } else {
        await problemIndex.selectOption({ label: source.problemIndex! });
      }
    } else {
      await problemIndex.selectOption({ label: source.problemIndex! });
    }
  } else {
    const input = page.locator('input[name="submittedProblemIndex"]').first();
    if ((await input.count().catch(() => 0)) === 0) {
      throw new CodeforcesSubmissionError('Codeforces submit form has no problem selector');
    }
    await input.fill(source.problemIndex!);
  }

  const language = page.locator('select[name="programTypeId"]').first();
  if ((await language.count().catch(() => 0)) === 0) {
    throw new CodeforcesSubmissionError('Codeforces submit form has no programTypeId selector');
  }
  const optionTexts = await language.locator('option').evaluateAll((nodes) =>
    nodes.map((node) => ({ value: (node as HTMLOptionElement).value, text: (node.textContent ?? '').trim() })),
  );
  const preferred = source.language === 'python'
    ? optionTexts.find((o) => /Python\s*3|PyPy\s*3/i.test(o.text))
    : optionTexts.find((o) => /GNU G?\+\+(?:23|20|17|14)|C\+\+/i.test(o.text));
  if (!preferred) {
    throw new CodeforcesSubmissionError(
      source.language === 'python'
        ? 'no Python 3 language option exists on the Codeforces form'
        : 'no C++ language option exists on the Codeforces form',
    );
  }
  await language.selectOption(preferred.value);

  const sourceBox = page.locator('textarea[name="source"]').first();
  if ((await sourceBox.count().catch(() => 0)) === 0) {
    throw new CodeforcesSubmissionError('Codeforces submit form has no source textarea');
  }
  await sourceBox.fill(code);

  const csrf = page.locator('input[name="csrf_token"]').first();
  if ((await csrf.inputValue().catch(() => '')) === '') {
    throw new CodeforcesSubmissionError('Codeforces csrf_token is empty');
  }
}

async function clickSubmit(page: Page): Promise<boolean> {
  const input = page.locator('input[type="submit"][value*="Submit" i]').first();
  if ((await input.count().catch(() => 0)) > 0) {
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined),
      input.click({ timeout: 15_000 }),
    ]);
    return true;
  }
  const button = page.locator('button[type="submit"]').filter({ hasText: /submit/i }).first();
  if ((await button.count().catch(() => 0)) > 0) {
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined),
      button.click({ timeout: 15_000 }),
    ]);
    return true;
  }
  return false;
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
  const deadline = Date.now() + 75_000;
  let latest: CodeforcesSubmission | undefined;

  while (Date.now() < deadline) {
    await sleep(2_500);
    const submissions = await fetchSubmissions(username, source);
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
  const lines = body.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const useful = lines.find((line) => /error|invalid|csrf|too long|failed/i.test(line));
  return useful?.slice(0, 500) ?? 'Codeforces rejected the submission form';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
