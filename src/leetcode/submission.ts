import { Page } from 'playwright';
import { z } from 'zod';
import { SELECTORS } from './selectors';
import { leetcodeGraphQL } from './graphql';
import { logger } from '../logger';

/**
 * Submission flow (Playwright only):
 *   click Submit â†’ capture the submission id from the network response â†’
 *   poll submissionDetails via GraphQL until the judge finishes â†’ classify.
 *
 * The module only runs when AUTO_SUBMIT=true; the orchestrator decides that.
 */

export class SubmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubmissionError';
  }
}

export type SubmissionClassification =
  | 'ACCEPTED'
  | 'WRONG_ANSWER'
  | 'TIME_LIMIT_EXCEEDED'
  | 'MEMORY_LIMIT_EXCEEDED'
  | 'COMPILE_ERROR'
  | 'RUNTIME_ERROR'
  | 'UNKNOWN';

export interface SubmissionResult {
  submissionId: string | null;
  classification: SubmissionClassification;
  statusDisplay: string;
  runtime: string | null;
  memory: string | null;
  rawStatusMsg: string;
}

const submissionDetailsSchema = z.object({
  submissionDetails: z
    .object({
      statusCode: z.number(),
      runtime: z.string().nullable().optional(),
      memory: z.string().nullable().optional(),
      statusDisplay: z.string().nullable().optional(),
      runtimeDisplay: z.string().nullable().optional(),
      memoryDisplay: z.string().nullable().optional(),
    })
    .nullable(),
});

const SUBMISSION_DETAILS_QUERY = `
  query submissionDetails($submissionId: Int!) {
    submissionDetails(submissionId: $submissionId) {
      statusCode
      runtime
      memory
      statusDisplay
      runtimeDisplay
      memoryDisplay
    }
  }
`;

/** LeetCode judge status codes â†’ our classification. */
const STATUS_CODE_MAP: Record<number, SubmissionClassification> = {
  10: 'ACCEPTED',
  11: 'WRONG_ANSWER',
  12: 'MEMORY_LIMIT_EXCEEDED',
  13: 'TIME_LIMIT_EXCEEDED',
  14: 'RUNTIME_ERROR',
  20: 'COMPILE_ERROR',
};

const JUDGE_PENDING_CODES = new Set([0, 1, 2, 3, 5]); // waiting / judging states

/**
 * Clicks Submit and waits for the judge. Listens to the network for the
 * submission id rather than scraping it from the DOM.
 */
export async function submitCurrentEditor(
  page: Page,
  questionFrontendId: string,
): Promise<SubmissionResult> {
  // Arm the network listener BEFORE clicking.
  const submissionIdPromise = waitForSubmissionId(page, questionFrontendId, 30_000);

  const clicked = await clickSubmit(page);
  if (!clicked) throw new SubmissionError('submit button not found');

  const submissionId = await submissionIdPromise.catch((err) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'could not capture submission ID from the network - will try the result panel',
    );
    return null;
  });

  if (submissionId) {
    logger.info({ submissionId }, 'submission accepted by judge, polling result');
    return pollSubmissionResult(page, submissionId);
  }

  // Fallback: read the result panel in the DOM.
  return readResultPanel(page);
}

async function clickSubmit(page: Page): Promise<boolean> {
  for (const sel of SELECTORS.submitButton) {
    const loc = page.locator(sel).first();
    if ((await loc.count().catch(() => 0)) > 0) {
      await loc.click({ timeout: 10_000 });
      logger.info('submit clicked');
      return true;
    }
  }
  return false;
}

/**
 * LeetCode's submit POST returns { submission_id } on
 * /problems/<slug>/submit/. We match on the URL shape, not on the slug, so
 * this keeps working even if the slug redirects.
 */
function waitForSubmissionId(
  page: Page,
  _questionFrontendId: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      page.off('response', handler);
      reject(new Error('timed out waiting for submission id'));
    }, timeoutMs);

    const handler = (response: { url(): string; request(): { method(): string }; json(): Promise<unknown> }) => {
      try {
        const url = response.url();
        if (!/\/problems\/[^/]+\/submit\/?$/.test(new URL(url).pathname)) return;
        if (response.request().method() !== 'POST') return;
        response
          .json()
          .then((body) => {
            const id = (body as { submission_id?: number })?.submission_id;
            if (typeof id === 'number') {
              clearTimeout(timer);
              page.off('response', handler);
              resolve(String(id));
            }
          })
          .catch(() => undefined);
      } catch {
        // ignore malformed URLs
      }
    };

    page.on('response', handler);
  });
}

async function pollSubmissionResult(page: Page, submissionId: string): Promise<SubmissionResult> {
  const deadline = Date.now() + 60_000;
  let lastStatus = 'PENDING';

  while (Date.now() < deadline) {
    await page.waitForTimeout(2_000);
    try {
      const data = await leetcodeGraphQL(
        page,
        SUBMISSION_DETAILS_QUERY,
        { submissionId: Number(submissionId) },
        submissionDetailsSchema,
      );
      const d = data.submissionDetails;
      if (!d) continue;
      if (JUDGE_PENDING_CODES.has(d.statusCode)) continue;

      const classification = STATUS_CODE_MAP[d.statusCode] ?? 'UNKNOWN';
      const result: SubmissionResult = {
        submissionId,
        classification,
        statusDisplay: d.statusDisplay ?? lastStatus,
        runtime: d.runtimeDisplay ?? (d.runtime != null ? `${d.runtime} ms` : null),
        memory: d.memoryDisplay ?? (d.memory != null ? `${d.memory} MB` : null),
        rawStatusMsg: d.statusDisplay ?? `statusCode=${d.statusCode}`,
      };
      logger.info(
        { submissionId, classification: result.classification, runtime: result.runtime, memory: result.memory },
        'judge finished',
      );
      return result;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'submission polling failed - retrying',
      );
    }
  }

  return {
    submissionId,
    classification: 'UNKNOWN',
    statusDisplay: lastStatus,
    runtime: null,
    memory: null,
    rawStatusMsg: 'judge polling timed out',
  };
}

/** DOM fallback when the submission id could not be captured. */
async function readResultPanel(page: Page): Promise<SubmissionResult> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const sel of SELECTORS.resultStatus) {
      const loc = page.locator(sel).first();
      if ((await loc.count().catch(() => 0)) === 0) continue;
      const text = ((await loc.innerText().catch(() => '')) ?? '').trim();
      if (!text || /pending|judging/i.test(text)) continue;

      return {
        submissionId: null,
        classification: classifyStatusText(text),
        statusDisplay: text,
        runtime: await scrapeNear(page, SELECTORS.resultRuntime),
        memory: await scrapeNear(page, SELECTORS.resultMemory),
        rawStatusMsg: text,
      };
    }
    await page.waitForTimeout(2_000);
  }
  return {
    submissionId: null,
    classification: 'UNKNOWN',
    statusDisplay: 'UNKNOWN',
    runtime: null,
    memory: null,
    rawStatusMsg: 'result panel timed out',
  };
}


/** Maps a LeetCode judge status code to our classification. */
export function classifyStatusCode(code: number): SubmissionClassification {
  return STATUS_CODE_MAP[code] ?? 'UNKNOWN';
}
export function classifyStatusText(text: string): SubmissionClassification {
  const t = text.toLowerCase();
  if (t.includes('accepted')) return 'ACCEPTED';
  if (t.includes('wrong answer')) return 'WRONG_ANSWER';
  if (t.includes('time limit')) return 'TIME_LIMIT_EXCEEDED';
  if (t.includes('memory limit')) return 'MEMORY_LIMIT_EXCEEDED';
  if (t.includes('compile error')) return 'COMPILE_ERROR';
  if (t.includes('runtime error')) return 'RUNTIME_ERROR';
  return 'UNKNOWN';
}

async function scrapeNear(page: Page, selectors: readonly string[]): Promise<string | null> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count().catch(() => 0)) > 0) {
      const text = ((await loc.innerText().catch(() => '')) ?? '').trim();
      if (text) return text;
    }
  }
  return null;
}
