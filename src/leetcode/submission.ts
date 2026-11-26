import { Page } from 'playwright';
import { z } from 'zod';
import { SELECTORS } from './selectors';
import { leetcodeGraphQL } from './graphql';
import { parseJudgeCheck, type JudgeCheckResult } from './apiClient';
import { logger } from '../logger';

/**
 * Submission flow (Playwright only):
 *   click Submit â†’ capture the submission id from the network response â†’
 *   poll submissionDetails via GraphQL until the judge finishes â†’ classify.
 *
 * The orchestrator always uses this module when running through the browser transport.
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

/** LeetCode judge status codes → our classification. */
const STATUS_CODE_MAP: Record<number, SubmissionClassification> = {
  10: 'ACCEPTED',
  11: 'WRONG_ANSWER',
  12: 'MEMORY_LIMIT_EXCEEDED',
  14: 'TIME_LIMIT_EXCEEDED',
  15: 'RUNTIME_ERROR',
  20: 'COMPILE_ERROR',
};

/** Normalizes LeetCode runtime/memory strings without appending duplicate or bogus units. */
export function formatJudgeMetric(value: string | null | undefined, unit: 'ms' | 'MB'): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed || /^n\/?a$/i.test(trimmed)) return null;
  return /^\d+(?:\.\d+)?$/.test(trimmed) ? `${trimmed} ${unit}` : trimmed;
}

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
  const pendingSubmissionId = waitForSubmissionId(page, questionFrontendId, 30_000);
  pendingSubmissionId.promise.catch(() => undefined);

  let clicked = false;
  try {
    clicked = await clickSubmit(page);
  } catch (err) {
    pendingSubmissionId.cancel();
    throw err;
  }
  if (!clicked) {
    pendingSubmissionId.cancel();
    throw new SubmissionError('submit button not found');
  }

  const submissionId = await pendingSubmissionId.promise.catch((err) => {
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
): { promise: Promise<string>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let rejectFn: ((err: Error) => void) | undefined;
  let handler:
    | ((response: { url(): string; request(): { method(): string }; json(): Promise<unknown> }) => void)
    | undefined;

  const cleanup = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (handler) {
      page.off('response', handler);
      handler = undefined;
    }
  };

  const promise = new Promise<string>((resolve, reject) => {
    rejectFn = reject;
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('timed out waiting for submission id'));
    }, timeoutMs);

    handler = (response) => {
      try {
        const url = response.url();
        if (!/\/problems\/[^/]+\/submit\/?$/.test(new URL(url).pathname)) return;
        if (response.request().method() !== 'POST') return;
        response
          .json()
          .then((body) => {
            if (settled) return;
            const id = (body as { submission_id?: unknown })?.submission_id;
            const validId =
              (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) ||
              (typeof id === 'string' && /^[1-9]\d*$/.test(id));
            if (validId) {
              settled = true;
              cleanup();
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

  const cancel = () => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectFn?.(new Error('cancelled waiting for submission id'));
  };

  return { promise, cancel };
}

async function pollSubmissionResult(page: Page, submissionId: string): Promise<SubmissionResult> {
  const deadline = Date.now() + 60_000;
  let lastStatus = 'PENDING';
  const numericId = Number(submissionId);
  // submissionDetails accepts GraphQL Int! (signed 32-bit); newer IDs overflow it.
  const canQueryDetails =
    Number.isSafeInteger(numericId) && numericId > 0 && numericId <= 2_147_483_647;
  let lastCheckFinal: Extract<JudgeCheckResult, { kind: 'final' }> | null = null;

  while (Date.now() < deadline) {
    await page.waitForTimeout(Math.min(2_000, Math.max(1, deadline - Date.now())));

    // Primary source: LeetCode's own /v2/check/ polling endpoint via in-page fetch.
    try {
      const checkBody = await page
        .evaluate(async (id) => {
          const res = await fetch(
            `https://leetcode.com/submissions/detail/${encodeURIComponent(id)}/v2/check/`,
            {
              method: 'GET',
              credentials: 'include',
              headers: { Accept: 'application/json' },
              signal: AbortSignal.timeout(15_000),
            },
          );
          if (!res.ok) return null;
          return await res.json().catch(() => null);
        }, submissionId)
        .catch(() => null);

      const check = parseJudgeCheck(checkBody);
      if (check?.kind === 'pending') {
        lastStatus = check.state;
        continue;
      }
      if (check?.kind === 'final') {
        lastCheckFinal = check;
        if (check.classification !== 'UNKNOWN') {
          const result: SubmissionResult = {
            submissionId,
            classification: check.classification,
            statusDisplay: check.statusDisplay,
            runtime: check.runtime,
            memory: check.memory,
            rawStatusMsg: check.statusDisplay,
          };
          logger.info(
            {
              submissionId,
              classification: result.classification,
              runtime: result.runtime,
              memory: result.memory,
              source: 'check',
            },
            'judge finished',
          );
          return result;
        }
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'in-page judge check polling failed - falling back',
      );
    }

    if (canQueryDetails) {
      try {
        const data = await leetcodeGraphQL(
          page,
          SUBMISSION_DETAILS_QUERY,
          { submissionId: numericId },
          submissionDetailsSchema,
        );
        const d = data.submissionDetails;
        if (d) {
          if (JUDGE_PENDING_CODES.has(d.statusCode)) {
            lastStatus = d.statusDisplay ?? lastStatus;
            continue;
          }

          const statusDisplay = d.statusDisplay ?? lastStatus;
          const textClass = d.statusDisplay ? classifyStatusText(d.statusDisplay) : 'UNKNOWN';
          const classification = textClass !== 'UNKNOWN' ? textClass : classifyStatusCode(d.statusCode);
          const result: SubmissionResult = {
            submissionId,
            classification,
            statusDisplay,
            runtime: formatJudgeMetric(d.runtimeDisplay ?? d.runtime, 'ms'),
            memory: formatJudgeMetric(d.memoryDisplay ?? d.memory, 'MB'),
            rawStatusMsg: d.statusDisplay ?? `statusCode=${d.statusCode}`,
          };
          logger.info(
            { submissionId, classification: result.classification, runtime: result.runtime, memory: result.memory },
            'judge finished',
          );
          return result;
        }
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'submission polling failed - retrying',
        );
      }
    }

    const panelResult = await tryReadResultPanelOnce(page, submissionId);
    if (panelResult) return panelResult;
  }

  const finalPanel = await tryReadResultPanelOnce(page, submissionId);
  if (finalPanel) return finalPanel;

  if (lastCheckFinal) {
    return {
      submissionId,
      classification: lastCheckFinal.classification,
      statusDisplay: lastCheckFinal.statusDisplay,
      runtime: lastCheckFinal.runtime,
      memory: lastCheckFinal.memory,
      rawStatusMsg: lastCheckFinal.statusDisplay,
    };
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

async function tryReadResultPanelOnce(
  page: Page,
  submissionId: string | null,
): Promise<SubmissionResult | null> {
  for (const sel of SELECTORS.resultStatus) {
    const loc = page.locator(sel).first();
    if ((await loc.count().catch(() => 0)) === 0) continue;
    const text = ((await loc.innerText().catch(() => '')) ?? '').trim();
    if (!text || /pending|judging/i.test(text)) continue;

    return {
      submissionId,
      classification: classifyStatusText(text),
      statusDisplay: text,
      runtime: await scrapeNear(page, SELECTORS.resultRuntime),
      memory: await scrapeNear(page, SELECTORS.resultMemory),
      rawStatusMsg: text,
    };
  }
  return null;
}

/** DOM fallback when the submission id could not be captured. */
async function readResultPanel(page: Page): Promise<SubmissionResult> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const res = await tryReadResultPanelOnce(page, null);
    if (res) return res;
    await page.waitForTimeout(Math.min(2_000, Math.max(1, deadline - Date.now())));
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
      if (!text) continue;
      const match = /\b\d+(?:\.\d+)?\s*(?:ms|s|MB|KB)\b/i.exec(text);
      return match ? match[0].replace(/\s+/, ' ') : text;
    }
  }
  return null;
}
