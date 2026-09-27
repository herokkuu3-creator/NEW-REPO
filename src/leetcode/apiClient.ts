import { APIRequestContext, BrowserContext } from 'playwright';
import { z } from 'zod';
import { logger } from '../logger';
import { classifyStatusCode, classifyStatusText, SubmissionClassification } from './submission';

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

const submissionListSchema = z.object({
  submissionList: z.object({
    submissions: z.array(
      z.object({
        id: z.union([z.number(), z.string()]),
        statusDisplay: z.string().nullable().optional(),
        runtime: z.string().nullable().optional(),
        memory: z.string().nullable().optional(),
        isPending: z.union([z.boolean(), z.string()]).nullable().optional(),
      }),
    ),
  }).nullable(),
});

const SUBMISSION_LIST_QUERY = `
  query submissions(
    $offset: Int!
    $limit: Int!
    $lastKey: String
    $questionSlug: String!
  ) {
    submissionList(
      offset: $offset
      limit: $limit
      lastKey: $lastKey
      questionSlug: $questionSlug
    ) {
      submissions {
        id
        statusDisplay
        runtime
        memory
        isPending
      }
    }
  }
`;
const JUDGE_PENDING_CODES = new Set([0, 1, 2, 3, 5]);

/**
 * Result of one poll of LeetCode's judge check endpoint
 * (`/submissions/detail/<id>/v2/check/`) — the endpoint the site's own
 * frontend polls after a submit until `state` leaves PENDING/STARTED.
 */
export type JudgeCheckResult =
  | { kind: 'pending'; state: string }
  | {
      kind: 'final';
      classification: SubmissionClassification;
      statusDisplay: string;
      runtime: string | null;
      memory: string | null;
    };

const CHECK_PENDING_STATES = new Set(['PENDING', 'STARTED', 'JUDGING', 'QUEUED']);

/**
 * Interprets a check-endpoint JSON body. Returns null when the body is not
 * something we can interpret (caller then falls back to other sources).
 */
export function parseJudgeCheck(body: unknown): JudgeCheckResult | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const state = typeof b.state === 'string' ? b.state.toUpperCase() : '';
  const statusMsg = typeof b.status_msg === 'string' ? b.status_msg.trim() : '';
  const statusCode = typeof b.status_code === 'number' ? b.status_code : null;

  if (CHECK_PENDING_STATES.has(state)) return { kind: 'pending', state };
  if (!state && !statusMsg && statusCode == null) return null;
  // A body with a state we don't know and no verdict yet — keep waiting.
  if (state !== 'SUCCESS' && !statusMsg && statusCode == null) {
    return { kind: 'pending', state: state || 'PENDING' };
  }

  // Prefer the human verdict text; fall back to the numeric code.
  let classification = statusMsg ? classifyStatusText(statusMsg) : 'UNKNOWN';
  if (classification === 'UNKNOWN' && statusCode != null) {
    classification = classifyStatusCode(statusCode);
  }

  const runtime = typeof b.status_runtime === 'string' && b.status_runtime ? b.status_runtime : null;
  const memory = typeof b.status_memory === 'string' && b.status_memory ? b.status_memory : null;

  return {
    kind: 'final',
    classification,
    statusDisplay: statusMsg || (statusCode != null ? `statusCode=${statusCode}` : state),
    runtime,
    memory,
  };
}

export interface AwaitSubmissionOptions {
  /** Delay before the first poll (default 5s). */
  firstPollDelayMs?: number;
  /** Delay between subsequent polls (default 2s). */
  pollIntervalMs?: number;
}

export class LeetCodeApi {
  private readonly request: APIRequestContext;

  constructor(private readonly context: Pick<BrowserContext, 'request' | 'cookies'>) {
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

  /**
   * One poll of the judge check endpoint — the same GET the LeetCode frontend
   * issues repeatedly after a submit (`/submissions/detail/<id>/v2/check/`).
   * Returns null on any transport/parse problem so the caller can fall back.
   */
  async checkSubmission(submissionId: string, slug: string): Promise<JudgeCheckResult | null> {
    const paths = [
      `${ORIGIN}/submissions/detail/${submissionId}/v2/check/`,
      `${ORIGIN}/submissions/detail/${submissionId}/check/`,
    ];
    for (const url of paths) {
      try {
        const res = await this.request.get(url, {
          headers: {
            Accept: 'application/json',
            Referer: `${ORIGIN}/problems/${slug}/`,
          },
          timeout: REQUEST_TIMEOUT_MS,
        });
        if (res.status() !== 200) {
          logger.debug({ submissionId, url, status: res.status() }, 'judge check non-200');
          continue;
        }
        const text = await res.text();
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          continue;
        }
        const parsed = parseJudgeCheck(json);
        if (parsed) return parsed;
      } catch (err) {
        logger.debug(
          { submissionId, url, err: err instanceof Error ? err.message : String(err) },
          'judge check request failed',
        );
      }
    }
    return null;
  }

  /** Polls the judge until it reaches a terminal verdict. */
  async awaitSubmission(
    submissionId: string,
    slug: string,
    timeoutMs = 180_000,
    options: AwaitSubmissionOptions = {},
  ): Promise<SubmissionOutcome> {
    const deadline = Date.now() + timeoutMs;
    let lastStatus = 'PENDING';
    const firstDelay = options.firstPollDelayMs ?? 5_000;
    const interval = options.pollIntervalMs ?? 2_000;

    let firstPoll = true;
    let lastCheckFinal: Extract<JudgeCheckResult, { kind: 'final' }> | null = null;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, firstPoll ? firstDelay : interval));
      firstPoll = false;

      // Primary source: the check endpoint LeetCode's own UI polls.
      const check = await this.checkSubmission(submissionId, slug);
      if (check?.kind === 'pending') {
        lastStatus = check.state;
        continue;
      }
      if (check?.kind === 'final') lastCheckFinal = check;
      if (
        check?.kind === 'final' &&
        (check.classification !== 'UNKNOWN' || !/internal error/i.test(check.statusDisplay))
      ) {
        const outcome: SubmissionOutcome = {
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
            classification: outcome.classification,
            statusDisplay: outcome.statusDisplay,
            runtime: outcome.runtime,
            memory: outcome.memory,
            source: 'check',
          },
          'judge finished',
        );
        return outcome;
      }

      // Fallback: GraphQL submissionDetails (+ history verification).
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

      const statusDisplay = d.statusDisplay ?? lastStatus;
      const classification = classifyStatusCode(d.statusCode);

      // LeetCode may temporarily report "Internal Error" from
      // submissionDetails even though the submission has already completed.
      // Verify the exact submission in submission history before declaring
      // the run rejected.
      if (classification === 'UNKNOWN' || /internal error/i.test(statusDisplay)) {
        const history = await this.findSubmissionInHistory(submissionId, slug);

        if (history) {
          const historyClassification = classifyStatusText(history.statusDisplay);

          if (historyClassification !== 'UNKNOWN') {
            const outcome: SubmissionOutcome = {
              submissionId,
              classification: historyClassification,
              statusDisplay: history.statusDisplay,
              runtime: history.runtime != null ? `${history.runtime} ms` : null,
              memory: history.memory != null ? `${history.memory} MB` : null,
              rawStatusMsg: history.statusDisplay,
            };

            logger.info(
              {
                submissionId,
                classification: outcome.classification,
                statusDisplay: outcome.statusDisplay,
                source: 'submissionList',
              },
              'judge result confirmed from submission history',
            );

            return outcome;
          }
        }

        lastStatus = statusDisplay;
        logger.warn(
          { submissionId, statusCode: d.statusCode, statusDisplay },
          'uncertain judge status - continuing to poll',
        );
        continue;
      }

      const outcome: SubmissionOutcome = {
        submissionId,
        classification,
        statusDisplay,
        runtime: d.runtimeDisplay ?? (d.runtime != null ? `${d.runtime} ms` : null),
        memory: d.memoryDisplay ?? (d.memory != null ? `${d.memory} MB` : null),
        rawStatusMsg: statusDisplay,
      };

      logger.info(
        {
          submissionId,
          classification: outcome.classification,
          statusDisplay: outcome.statusDisplay,
          runtime: outcome.runtime,
          memory: outcome.memory,
        },
        'judge finished',
      );

      return outcome;
    }

    // Last chance before giving up: the submission history is authoritative
    // for a finished submission even if the live polling never saw it.
    const history = await this.findSubmissionInHistory(submissionId, slug);
    if (history) {
      const historyClassification = classifyStatusText(history.statusDisplay);
      if (historyClassification !== 'UNKNOWN') {
        logger.info(
          { submissionId, classification: historyClassification, source: 'submissionList' },
          'judge result recovered from submission history after polling timeout',
        );
        return {
          submissionId,
          classification: historyClassification,
          statusDisplay: history.statusDisplay,
          runtime: history.runtime != null ? `${history.runtime} ms` : null,
          memory: history.memory != null ? `${history.memory} MB` : null,
          rawStatusMsg: history.statusDisplay,
        };
      }
    }

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
      rawStatusMsg: `judge polling timed out after ${Math.round(timeoutMs / 1000)}s`,
    };
  }

  private async findSubmissionInHistory(
    submissionId: string,
    slug: string,
  ): Promise<{
    statusDisplay: string;
    runtime: string | null;
    memory: string | null;
  } | null> {
    try {
      const data = await this.graphql(
        SUBMISSION_LIST_QUERY,
        {
          offset: 0,
          limit: 20,
          lastKey: null,
          questionSlug: slug,
        },
        submissionListSchema,
      );

      const row = data.submissionList?.submissions.find(
        (item) => String(item.id) === String(submissionId),
      );

      if (!row || !row.statusDisplay) return null;

      return {
        statusDisplay: row.statusDisplay,
        runtime: row.runtime ?? null,
        memory: row.memory ?? null,
      };
    } catch (err) {
      logger.warn(
        {
          submissionId,
          err: err instanceof Error ? err.message : String(err),
        },
        'submission history lookup failed',
      );
      return null;
    }
  }
}