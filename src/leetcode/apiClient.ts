import { APIRequestContext, APIResponse, BrowserContext } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { logger } from '../logger';
import { classifyStatusCode, classifyStatusText, formatJudgeMetric, SubmissionClassification } from './submission';

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
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LeetCodeHttpError';
  }
}

export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const delay = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}

export interface CookieLike {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
}

/**
 * Matches a cookie domain cleanly against a target URL or origin while enforcing
 * RFC-6265 subdomain boundaries (`.leetcode.com` matches `leetcode.com` and
 * `assets.leetcode.com`, never `notleetcode.com`).
 */
export function cookieMatchesOrigin(cookieDomain: string | undefined, originOrUrl: string): boolean {
  if (!cookieDomain) return true;
  let host: string;
  try {
    host = new URL(originOrUrl).hostname.toLowerCase();
  } catch {
    host = originOrUrl.toLowerCase();
  }
  const normalized = cookieDomain.trim().toLowerCase().replace(/^\./, '');
  if (!normalized) return false;
  return host === normalized || host.endsWith(`.${normalized}`);
}

export function selectBestCookieByName<T extends CookieLike>(
  cookies: ReadonlyArray<T>,
  cookieName: string,
  origin = ORIGIN,
): T | null {
  const nowMs = Date.now();
  const candidates: Array<{ cookie: T; index: number; value: string; exactHost: boolean; pathLen: number; expires: number }> = [];
  let host = 'leetcode.com';
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {}

  for (let i = 0; i < cookies.length; i++) {
    const c = cookies[i];
    if (!c || c.name !== cookieName) continue;
    const val = typeof c.value === 'string' ? c.value.trim() : '';
    if (!val) continue;
    if (!cookieMatchesOrigin(c.domain, origin)) continue;
    if (typeof c.expires === 'number' && c.expires > 0 && c.expires * 1000 <= nowMs) continue;
    const dom = (c.domain ?? '').trim().toLowerCase().replace(/^\./, '');
    candidates.push({
      cookie: c,
      index: i,
      value: val,
      exactHost: dom === host,
      pathLen: (c.path ?? '/').length,
      expires: typeof c.expires === 'number' && Number.isFinite(c.expires) ? c.expires : -1,
    });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (a.expires > 0 && b.expires > 0 && a.expires !== b.expires) return b.expires - a.expires;
    if (a.expires > 0 && b.expires <= 0) return -1;
    if (b.expires > 0 && a.expires <= 0) return 1;
    if (a.pathLen !== b.pathLen) return b.pathLen - a.pathLen;
    if (a.exactHost !== b.exactHost) return a.exactHost ? -1 : 1;
    return b.index - a.index;
  });
  return candidates[0]!.cookie;
}

/**
 * Selects the newest non-expired `csrftoken` cookie for the target origin.
 * Avoids `.find()` picking a stale duplicate `.leetcode.com` cookie when a
 * rotated `Set-Cookie` updated a host-only or newer-expiry cookie.
 */
export function selectBestCsrfCookie(cookies: ReadonlyArray<CookieLike>, origin = ORIGIN): string | null {
  return selectBestCookieByName(cookies, 'csrftoken', origin)?.value.trim() ?? null;
}

const SINGLETON_SESSION_COOKIES = new Set(['csrftoken', 'LEETCODE_SESSION', 'cf_clearance']);

/**
 * Collapses duplicate `.leetcode.com` vs `leetcode.com` domain copies of
 * singleton auth/security cookies (`csrftoken`, `LEETCODE_SESSION`, `cf_clearance`)
 * so Playwright HTTP requests never send conflicting duplicate `Cookie:` pairs
 * to Django / Cloudflare after a `Set-Cookie` rotation.
 */
export function deduplicateLeetCodeCookies<T extends CookieLike>(
  cookies: ReadonlyArray<T>,
  origin = ORIGIN,
): T[] {
  const nowSec = Date.now() / 1000;
  const active = cookies.filter((c) => !c.expires || c.expires <= 0 || c.expires > nowSec);
  const winners = new Map<string, T>();
  for (const name of SINGLETON_SESSION_COOKIES) {
    const best = selectBestCookieByName(active, name, origin);
    if (best) winners.set(name, best);
  }
  const emittedSingleton = new Set<string>();
  const out: T[] = [];
  for (const c of active) {
    if (SINGLETON_SESSION_COOKIES.has(c.name) && cookieMatchesOrigin(c.domain, origin)) {
      const winner = winners.get(c.name);
      if (!winner || emittedSingleton.has(c.name)) continue;
      if (c === winner) {
        emittedSingleton.add(c.name);
        out.push(c);
      }
      continue;
    }
    out.push(c);
  }
  return out;
}

/** Builds consistent desktop Chrome client hints matching the active User-Agent. */
export function buildBrowserClientHeaders(userAgent?: string): Record<string, string> {
  const ua = userAgent || '';
  const headers: Record<string, string> = {
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (/Firefox\//i.test(ua)) return headers;
  const chromeMatch = /Chrome\/(\d+)/i.exec(ua);
  const major = chromeMatch?.[1] ?? '126';
  const platform = /Windows/i.test(ua)
    ? '"Windows"'
    : /Macintosh|Mac OS X/i.test(ua)
      ? '"macOS"'
      : /Android/i.test(ua)
        ? '"Android"'
        : '"Linux"';
  headers['sec-ch-ua'] = `"Not/A)Brand";v="8", "Chromium";v="${major}", "Google Chrome";v="${major}"`;
  headers['sec-ch-ua-mobile'] = '?0';
  headers['sec-ch-ua-platform'] = platform;
  return headers;
}

export function isCsrfRejectionBody(text: string): boolean {
  return /csrf(?:_?token)?|csrf verification failed|csrfmiddlewaretoken|csrf cookie not set|origin checking failed/i.test(text);
}

/**
 * Summarizes an HTTP error response from the FULL body before slicing so
 * verbose HTML `<head><style>` blocks cannot truncate `"CSRF verification failed"`
 * or Cloudflare `<title>` / challenge markers.
 */
export function summarizeHttpErrorBody(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const fields = ['error', 'detail', 'message', 'msg']
        .map((k) => parsed[k])
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
      if (fields.length > 0) return fields.join(' | ').replace(/\s+/g, ' ').trim().slice(0, 300);
    } catch {}
  }

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(trimmed);
  const title = titleMatch?.[1]?.replace(/\s+/g, ' ').trim();
  const signals: string[] = [];
  if (isCsrfRejectionBody(trimmed)) {
    const csrfPhrase = /(?:CSRF verification failed\.?[^<]*|Origin checking failed[^<]*|CSRF cookie not set\.?)/i.exec(trimmed)?.[0];
    signals.push(csrfPhrase ? csrfPhrase.replace(/\s+/g, ' ').trim() : 'CSRF verification failed');
  }
  if (/cf-chl|challenge-platform|just a moment|attention required|sorry, you have been blocked/i.test(trimmed)) {
    const cfMatch = /(?:Just a moment\.\.\.|Attention Required!\s*\|?\s*Cloudflare|Sorry, you have been blocked|cf-chl|challenge-platform)/i.exec(trimmed)?.[0];
    if (cfMatch) signals.push(cfMatch.replace(/\s+/g, ' ').trim());
  }
  if (/(?:error\s+1015|you are being rate limited|429\s+too many requests|too many requests)/i.test(trimmed)) {
    const rateMatch = /(?:Error\s+1015[^<]{0,60}|You are being rate limited[^<]{0,60}|429\s+Too Many Requests|Too Many Requests)/i.exec(trimmed)?.[0];
    if (rateMatch) signals.push(rateMatch.replace(/\s+/g, ' ').trim());
  }

  const isHtml = /<(?:!doctype|html|head|body)\b/i.test(trimmed);
  const visibleBodyText = isHtml
    ? trimmed
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/\s+/g, ' ')
        .trim()
    : trimmed.replace(/\s+/g, ' ');

  const uniqueSignals = signals.filter(
    (s, idx) =>
      signals.findIndex((other) => other.toLowerCase() === s.toLowerCase()) === idx &&
      (!title || !title.toLowerCase().includes(s.toLowerCase())),
  );

  if (title || uniqueSignals.length > 0) {
    const prefix = [title ? `[${title}]` : '', ...uniqueSignals].filter(Boolean).join(' ');
    const remaining = Math.max(0, 300 - prefix.length - 1);
    const bodySuffix =
      visibleBodyText && !prefix.toLowerCase().includes(visibleBodyText.toLowerCase())
        ? visibleBodyText
        : '';
    return (bodySuffix && remaining > 20 ? `${prefix} ${bodySuffix.slice(0, remaining)}` : prefix).slice(0, 300);
  }
  if (isHtml) {
    return visibleBodyText ? `[HTML] ${visibleBodyText}`.slice(0, 300) : '[HTML response]';
  }
  return visibleBodyText.slice(0, 300);
}

export function leetCodeRequestFailure(err: unknown): { category: string; detail: string } {
  const msg = err instanceof Error ? err.message : String(err);
  if (isSubmissionLimitError(err)) return { category: 'submission-limit', detail: 'LeetCode explicitly reported a submission quota' };
  if (/csrf|csrftoken|origin checking failed/i.test(msg)) return { category: 'session-csrf', detail: 'Server session CSRF token rejected; refresh the account session' };
  if (/not.*(?:signed|logged).*in|not\s+authenticated|unauthenticated|authentication|session.*expired/i.test(msg) || (err instanceof LeetCodeHttpError && err.status === 401)) {
    return { category: 'session-auth', detail: 'Server session requires authentication' };
  }
  const html = /<!doctype|<html|\[html(?: response)?\]|cloudflare|cf-chl|just a moment/i.test(msg);
  const isHttp429 = (err instanceof LeetCodeHttpError && err.status === 429) || /\bHTTP 429\b/i.test(msg);
  if (isHttp429 || /too (?:many requests|fast)|you are being rate limited|error\s+1015|submit.{0,20}(?:too often|too frequently)|try again.{0,12}(?:seconds?|minutes?)/i.test(msg)) {
    return {
      category: 'rate-limit',
      detail: 'Server request rate limited; no daily quota confirmed' + (isHttp429 ? ' (HTTP 429)' : ''),
    };
  }
  if (html || (err instanceof LeetCodeHttpError && /non-JSON body/i.test(msg))) return { category: 'challenge', detail: 'Server returned an unexpected page; no account submission quota confirmed' };
  if (err instanceof LeetCodeHttpError && err.status === 403) return { category: 'access-denied', detail: 'Server request denied (HTTP 403); no account submission quota confirmed' };
  if (/no submission_id/.test(msg)) return { category: 'unknown-submit-response', detail: 'Submission response had no ID; outcome needs reconciliation' };
  return { category: 'request-failed', detail: 'Server request failed' };
}

/**
 * Detects LeetCode account-level submission limit / daily quota errors.
 * Note: Cloudflare rate limits / HTML interstitials (e.g. submit HTTP 429: <!DOCTYPE html>)
 * are temporary network/Cloudflare challenge blocks, NOT an account-level daily limit!
 */
export function isSubmissionLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // HTML or Cloudflare interstitial responses are NEVER LeetCode daily quota limits
  if (/<!DOCTYPE|<html|<head|\[html(?: response)?\]|cloudflare|cf-chl|just a moment/i.test(msg)) {
    return false;
  }
  // A temporary submission-frequency limit is not evidence of a daily quota.
  return /\b(?:today|daily|per day|24[ -]?hours?)\b/i.test(msg) &&
    /submission.{0,35}(?:limit|quota)|(?:limit|quota).{0,35}submission|daily limit|quota exceeded/i.test(msg);
}

/** A 403, 429, or non-JSON/HTML body from LeetCode or Cloudflare usually means an interstitial or challenge block. */
export function looksLikeChallenge(err: unknown): boolean {
  if (isSubmissionLimitError(err)) return false;
  if (leetCodeRequestFailure(err).category === 'rate-limit') return true;
  if (/csrf|csrftoken|not.*(?:signed|logged).*in|not\s+authenticated|unauthenticated|authentication|session.*expired/i.test(err instanceof Error ? err.message : String(err))) return false;
  if (err instanceof LeetCodeHttpError) {
    if (err.status === 403 || err.status === 429) return true;
    if (/non-JSON body/i.test(err.message)) return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/<!DOCTYPE|<html|<head|\[html(?: response)?\]|cloudflare|cf-chl|just a moment/i.test(msg)) return true;
  return false;
}

/** Computes a bounded backoff delay (ms) for an HTTP 429 rate-limit error, honoring Retry-After. */
export function computeLeetCodeRateLimitDelayMs(err: unknown, fallbackWaitMs: number): number {
  const retryAfterMs = err instanceof LeetCodeHttpError ? err.retryAfterMs : undefined;
  const isTest = Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');
  if (isTest && fallbackWaitMs < 1_000) {
    return retryAfterMs !== undefined ? Math.min(Math.max(0, retryAfterMs), 50) : Math.max(0, fallbackWaitMs);
  }
  return Math.min(90_000, Math.max(retryAfterMs ?? fallbackWaitMs, 5_000));
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

interface LeetCodeRequestPolicy {
  beforeRequest(deadline?: number): Promise<void>;
  observe(error: unknown): void;
  signal: AbortSignal;
  timeoutMs: number;
}

async function readResponse(res: APIResponse) {
  try {
    return { status: res.status(), text: await res.text(), retryAfterMs: parseRetryAfter(res.headers?.()['retry-after']) };
  } finally {
    await res.dispose?.().catch(() => undefined);
  }
}

export class LeetCodeApi {
  private readonly request: APIRequestContext;

  constructor(
    private readonly context: Pick<BrowserContext, 'request' | 'cookies'>,
    private readonly policy?: LeetCodeRequestPolicy,
  ) {
    this.request = context.request;
  }

  private async requestOptions(deadline?: number, beforeSend?: () => Promise<void>) {
    if (beforeSend) await beforeSend();
    else await this.policy?.beforeRequest(deadline);
    this.policy?.signal.throwIfAborted();
    const timeout = Math.min(this.policy?.timeoutMs ?? REQUEST_TIMEOUT_MS, (deadline ?? Infinity) - Date.now());
    if (timeout <= 0) throw new Error('Judge polling window expired');
    return { timeout, signal: this.policy?.signal };
  }

  private fail(error: LeetCodeHttpError): never {
    this.policy?.observe(error);
    throw error;
  }

  private checkVerdictFailure(error: unknown) {
    this.policy?.signal.throwIfAborted();
    if (this.policy && looksLikeChallenge(error)) throw error;
  }

  async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    schema: z.ZodType<T>,
    deadline?: number,
  ): Promise<T> {
    const sendGraphqlPost = async (csrf: string | null) =>
      this.request.post(`${ORIGIN}/graphql`, {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Origin: ORIGIN,
          Referer: `${ORIGIN}/`,
          ...(csrf ? { 'x-csrftoken': csrf } : {}),
        },
        data: { query, variables },
        ...await this.requestOptions(deadline),
      });

    const token = await this.csrfToken();
    let res = await sendGraphqlPost(token);
    let { status, text: body, retryAfterMs } = await readResponse(res);
    if (status === 403 && isCsrfRejectionBody(body)) {
      const refreshed = await this.refreshCsrfToken(undefined, token);
      if (refreshed) {
        res = await sendGraphqlPost(refreshed);
        ({ status, text: body, retryAfterMs } = await readResponse(res));
      }
    }
    if (status !== 200) {
      const detail = summarizeHttpErrorBody(body);
      this.fail(new LeetCodeHttpError(`GraphQL HTTP ${status}${detail ? `: ${detail}` : ''}`, status, retryAfterMs));
    }

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      // An HTML body here is the signature of a bot interstitial.
      this.fail(new LeetCodeHttpError('GraphQL returned non-JSON body', status, retryAfterMs));
    }

    const errors = (json as { errors?: { message?: string }[] }).errors;
    if (errors && errors.length > 0) {
      this.fail(new LeetCodeHttpError(`GraphQL error: ${errors[0]?.message ?? 'unknown'}`, status, retryAfterMs));
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
    return selectBestCsrfCookie(cookies, ORIGIN);
  }

  /**
   * Attempts a single lightweight same-origin GET refresh when Django rejects or
   * rotates `csrftoken`. Never runs when the underlying transport omits `.get`.
   */
  private async refreshCsrfToken(slug?: string, previousToken?: string | null): Promise<string | null> {
    const rotatedAlready = await this.csrfToken().catch(() => null);
    if (rotatedAlready && rotatedAlready !== previousToken) {
      return rotatedAlready;
    }
    if (typeof this.request.get !== 'function') return null;

    const safeSlug = slug ? encodeURIComponent(slug) : undefined;
    const endpoints: Array<{ url: string; headers: Record<string, string> }> = [
      {
        url: `${ORIGIN}/api/problems/algorithms/`,
        headers: {
          Accept: 'application/json, text/plain, */*',
          Referer: safeSlug ? `${ORIGIN}/problems/${safeSlug}/` : `${ORIGIN}/`,
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
        },
      },
      ...(safeSlug
        ? [{
            url: `${ORIGIN}/problems/${safeSlug}/`,
            headers: {
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              Referer: `${ORIGIN}/problemset/`,
              'Sec-Fetch-Dest': 'document',
              'Sec-Fetch-Mode': 'navigate',
              'Sec-Fetch-Site': 'same-origin',
            },
          }]
        : []),
    ];

    for (const target of endpoints) {
      try {
        const res = await this.request.get(target.url, {
          headers: target.headers,
          ...await this.requestOptions(),
        });
        await res.dispose?.().catch(() => undefined);
      } catch {
        // Best-effort cookie refresh only; check jar before failing.
      }
      const next = await this.csrfToken().catch(() => null);
      if (next && next !== previousToken) return next;
    }
    return await this.csrfToken().catch(() => null);
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
  }, beforeSend?: () => Promise<void>): Promise<string> {
    const token = await this.csrfToken();
    if (!token) {
      throw new LeetCodeHttpError(
        'the stored session has no csrftoken cookie — re-run `npm run auth:setup` and re-upload storageState',
      );
    }

    const safeSlug = encodeURIComponent(params.slug);
    const sendSubmitPost = async (csrf: string, waitBeforeSend?: () => Promise<void>) =>
      this.request.post(`${ORIGIN}/problems/${safeSlug}/submit/`, {
        headers: {
          'x-csrftoken': csrf,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/plain, */*',
          Origin: ORIGIN,
          Referer: `${ORIGIN}/problems/${safeSlug}/`,
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
        },
        data: {
          lang: params.lang,
          question_id: params.questionId,
          typed_code: params.code,
        },
        ...await this.requestOptions(undefined, waitBeforeSend),
      });

    let res = await sendSubmitPost(token, beforeSend);
    let { status, text, retryAfterMs } = await readResponse(res);

    if (
      status === 403 &&
      (isCsrfRejectionBody(text) || /not\s+authenticated|unauthenticated/i.test(text))
    ) {
      const refreshed = await this.refreshCsrfToken(params.slug, token);
      if (refreshed) {
        res = await sendSubmitPost(refreshed);
        ({ status, text, retryAfterMs } = await readResponse(res));
      }
    }

    if (status !== 200) {
      const detail = summarizeHttpErrorBody(text);
      this.fail(new LeetCodeHttpError(
        `submit HTTP ${status}${detail ? `: ${detail}` : ''}`,
        status,
        retryAfterMs,
      ));
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      this.fail(new LeetCodeHttpError('submit returned non-JSON body', status, retryAfterMs));
    }
    const id = (json as { submission_id?: number | string } | null)?.submission_id;
    if (!((typeof id === 'number' && Number.isSafeInteger(id) && id > 0) || (typeof id === 'string' && /^[1-9]\d*$/.test(id)))) {
      const errMsg = (json as { error?: string })?.error ?? (json as { detail?: string })?.detail;
      if (errMsg) {
        this.fail(new LeetCodeHttpError(`submit rejected: ${errMsg}`, status, retryAfterMs));
      }
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
  async checkSubmission(submissionId: string, slug: string, deadline?: number): Promise<JudgeCheckResult | null> {
    const safeId = encodeURIComponent(submissionId);
    const safeSlug = encodeURIComponent(slug);
    const paths = [
      `${ORIGIN}/submissions/detail/${safeId}/v2/check/`,
      `${ORIGIN}/submissions/detail/${safeId}/check/`,
    ];
    for (const url of paths) {
      try {
        const res = await this.request.get(url, {
          headers: {
            Accept: 'application/json',
            Referer: `${ORIGIN}/problems/${safeSlug}/`,
          },
          ...await this.requestOptions(deadline),
        });
        const { status, text, retryAfterMs } = await readResponse(res);
        if (status !== 200) {
          if (this.policy && (status === 403 || status === 429)) {
            this.fail(new LeetCodeHttpError(`judge check HTTP ${status}`, status, retryAfterMs));
          }
          logger.debug({ submissionId, url, status }, 'judge check non-200');
          continue;
        }
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          if (this.policy && looksLikeChallenge(text)) {
            this.fail(new LeetCodeHttpError('judge check returned non-JSON body', status, retryAfterMs));
          }
          continue;
        }
        const parsed = parseJudgeCheck(json);
        if (parsed) return parsed;
      } catch (err) {
        this.checkVerdictFailure(err);
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
    const numericId = Number(submissionId);
    // submissionDetails accepts a GraphQL Int, which cannot represent newer IDs.
    const canQueryDetails = Number.isInteger(numericId) && numericId > 0 && numericId <= 2_147_483_647;
    const requestDeadline = this.policy ? deadline : undefined;
    let nextHistoryCheck = 0;

    let firstPoll = true;
    let lastCheckFinal: Extract<JudgeCheckResult, { kind: 'final' }> | null = null;

    while (Date.now() < deadline) {
      await sleep(Math.min(firstPoll ? firstDelay : interval, deadline - Date.now()), undefined, { signal: this.policy?.signal });
      if (Date.now() >= deadline) break;
      firstPoll = false;

      // Primary source: the check endpoint LeetCode's own UI polls.
      const check = await this.checkSubmission(submissionId, slug, requestDeadline);
      if (check?.kind === 'pending') {
        lastStatus = check.state;
        continue;
      }
      if (check?.kind === 'final') lastCheckFinal = check;
      if (check?.kind === 'final' && check.classification !== 'UNKNOWN') {
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
      const data = canQueryDetails ? await this.graphql(
        SUBMISSION_DETAILS_QUERY,
        { submissionId: numericId },
        submissionDetailsSchema,
        requestDeadline,
      ).catch((error) => { this.checkVerdictFailure(error); return null; }) : null;

      const d = data?.submissionDetails;
      if (d && JUDGE_PENDING_CODES.has(d.statusCode)) {
        lastStatus = d.statusDisplay ?? lastStatus;
        continue;
      }

      const statusDisplay = d?.statusDisplay ?? lastStatus;
      const textClass = d?.statusDisplay ? classifyStatusText(d.statusDisplay) : 'UNKNOWN';
      const classification = d
        ? (textClass !== 'UNKNOWN' ? textClass : classifyStatusCode(d.statusCode))
        : 'UNKNOWN';

      // LeetCode may temporarily report "Internal Error" from
      // submissionDetails even though the submission has already completed.
      // Verify the exact submission in submission history before declaring
      // the run rejected.
      if (!d || classification === 'UNKNOWN' || /internal error/i.test(statusDisplay)) {
        if (Date.now() >= nextHistoryCheck) {
          const history = await this.findSubmissionInHistory(submissionId, slug, requestDeadline);
          if (history) return history;
          nextHistoryCheck = Date.now() + 15_000;
        }
        lastStatus = statusDisplay;
        continue;
      }

      const outcome: SubmissionOutcome = {
        submissionId,
        classification,
        statusDisplay,
        runtime: formatJudgeMetric(d.runtimeDisplay ?? d.runtime, 'ms'),
        memory: formatJudgeMetric(d.memoryDisplay ?? d.memory, 'MB'),
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
    if (history) return history;

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
    deadline = this.policy ? Date.now() + this.policy.timeoutMs : undefined,
  ): Promise<SubmissionOutcome | null> {
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
        deadline,
      );

      const row = data.submissionList?.submissions.find(
        (item) => String(item.id) === String(submissionId),
      );

      if (!row?.statusDisplay || row.isPending === true || row.isPending === 'true') return null;
      const classification = classifyStatusText(row.statusDisplay);
      if (classification === 'UNKNOWN') return null;

      logger.info({ submissionId, classification, source: 'submissionList' }, 'judge result confirmed from submission history');
      return {
        submissionId,
        classification,
        statusDisplay: row.statusDisplay,
        runtime: formatJudgeMetric(row.runtime, 'ms'),
        memory: formatJudgeMetric(row.memory, 'MB'),
        rawStatusMsg: row.statusDisplay,
      };
    } catch (err) {
      this.checkVerdictFailure(err);
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
