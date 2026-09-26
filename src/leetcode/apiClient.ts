import { APIRequestContext, BrowserContext } from 'playwright';
import { z } from 'zod';
import { logger } from '../logger';
import { classifyStatusCode, SubmissionClassification } from './submission';

/**
 * LeetCode API client — same-origin requests through the browser context's
 * own request API (so the authenticated cookies apply), WITHOUT ever
 * navigating to an HTML page.
 *
 * Why this exists: LeetCode's HTML pages are Cloudflare-protected and
 * routinely challenge datacenter IPs on page navigation, while the GraphQL
 * API answers normally from the same session. Driving the API directly means
 * the pipeline no longer performs the navigation that triggers the
 * interstitial. Nothing here evades a check — these are the same endpoints
 * the site's own frontend calls, with the user's own session.
 */

const ORIGIN = 'https://leetcode.com';
const REQUEST_TIMEOUT_MS = 60_000;

export class LeetCodeHttpError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'LeetCodeHttpError';
  }
}

/** A 403 or a non-JSON body from LeetCode usually means an interstitial. */
export function looksLikeChallenge(err: unknown): boolean {
  if (err instanceof LeetCodeHttpError) {
    if (err.status === 403 || err.status === 429) return true;
    if (/non-JSON body|no submission_id/i.test(err.message)) return true;
  }
  return false;
}

export interface SubmissionOutcome {
  submissionId: string;
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

const JUDGE_PENDING_CODES = new Set([0, 1, 2, 3, 5]);

export class LeetCodeApi {
  private readonly request: APIRequestContext;

  constructor(private readonly context: BrowserContext) {
    this.request = context.request;
  }

  async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const res = await this.request.post(`${ORIGIN}/graphql`, {
      headers: { 'Content-Type': 'application/json' },
      data: { query, variables },
      timeout: REQUEST_TIMEOUT_MS,
    });
    const status = res.status();
    const body = await res.text();
    if (status !== 200) {
      throw new LeetCodeHttpError(`GraphQL HTTP ${status}`, status);
    }

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      // An HTML body here is the signature of a bot interstitial.
      throw new LeetCodeHttpError('GraphQL returned non-JSON body');
    }

    const errors = (json as { errors?: { message?: string }[] }).errors;
    if (errors && errors.length > 0) {
      throw new LeetCodeHttpError(`GraphQL error: ${errors[0]?.message ?? 'unknown'}`);
    }

    const parsed = schema.safeParse((json as { data?: unknown }).data);
    if (!parsed.success) {
      throw new LeetCodeHttpError(
        `GraphQL response failed validation: ${parsed.error.issues[0]?.message}`,
      );
    }
    return parsed.data;
  }

  /** The CSRF cookie LeetCode issues to the session; used for state-changing POSTs. */
  private async csrfToken(): Promise<string | null> {
    const cookies = await this.context.cookies(ORIGIN);
    return cookies.find((c) => c.name === 'csrftoken')?.value ?? null;
  }

  /**
   * Submits code through LeetCode's own submit endpoint — the same request
   * the site's editor makes. `questionId` is LeetCode's INTERNAL id (from
   * GraphQL), which is not the same as the visible frontend number.
   */
  async submitSolution(params: {
    slug: string;
    questionId: string;
    lang: string;
    code: string;
  }): Promise<string> {
    const token = await this.csrfToken();
    if (!token) {
      throw new LeetCodeHttpError(
        'the stored session has no csrftoken cookie — re-run `npm run auth:setup` and re-upload storageState',
      );
    }

    const res = await this.request.post(`${ORIGIN}/problems/${params.slug}/submit/`, {
      headers: {
        'x-csrftoken': token,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Origin: ORIGIN,
        Referer: `${ORIGIN}/problems/${params.slug}/submissions/`,
      },
      data: {
        lang: params.lang,
        question_id: params.questionId,
        typed_code: params.code,
      },
      timeout: REQUEST_TIMEOUT_MS,
    });

    const status = res.status();
    const text = await res.text();
    if (status !== 200) {
      const detail = text.replace(/\s+/g, ' ').trim().slice(0, 300);
      throw new LeetCodeHttpError(
        `submit HTTP ${status}${detail ? `: ${detail}` : ''}`,
        status,
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new LeetCodeHttpError('submit returned non-JSON body');
    }
    const id = (json as { submission_id?: number }).submission_id;
    if (typeof id !== 'number') {
      throw new LeetCodeHttpError('submit response contained no submission_id');
    }
    logger.info({ submissionId: String(id) }, 'submission accepted by the judge, polling result');
    return String(id);
  }

  /** Polls the judge until it reaches a terminal verdict. */
  async awaitSubmission(submissionId: string, timeoutMs = 60_000): Promise<SubmissionOutcome> {
    const deadline = Date.now() + timeoutMs;
    let lastStatus = 'PENDING';

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2_000));
      const data = await this.graphql(
        SUBMISSION_DETAILS_QUERY,
        { submissionId: Number(submissionId) },
        submissionDetailsSchema,
      ).catch(() => null);

      const d = data?.submissionDetails;
      if (!d) continue;
      if (JUDGE_PENDING_CODES.has(d.statusCode)) {
        lastStatus = d.statusDisplay ?? lastStatus;
        continue;
      }

      const outcome: SubmissionOutcome = {
        submissionId,
        classification: classifyStatusCode(d.statusCode),
        statusDisplay: d.statusDisplay ?? lastStatus,
        runtime: d.runtimeDisplay ?? (d.runtime != null ? `${d.runtime} ms` : null),
        memory: d.memoryDisplay ?? (d.memory != null ? `${d.memory} MB` : null),
        rawStatusMsg: d.statusDisplay ?? `statusCode=${d.statusCode}`,
      };
      logger.info(
        {
          submissionId,
          classification: outcome.classification,
          runtime: outcome.runtime,
          memory: outcome.memory,
        },
        'judge finished',
      );
      return outcome;
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
}
