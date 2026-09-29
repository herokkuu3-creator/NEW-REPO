import { logger } from '../logger';
import { logMemory } from '../memory';
import type { StorageStateShape } from '../browser/cookiePayload';
import type { SourceIndexEntry } from './sourceRepo';
import type { BrowserPostOutcome } from './submission';

/**
 * Client for the isolated Codeforces submitter.
 *
 * A headless Firefox costs ~390MB the moment it launches (measured: 115MB ->
 * 502MB of cgroup charge on a 512MB instance), which cannot coexist with this
 * service's Telegram bot, Prisma client and LeetCode scheduler. When a second
 * free web service is configured (`CODEFORCES_SUBMITTER_URL`), the browser POST
 * happens there, in a container that holds nothing else — and this service keeps
 * doing everything else: the queue, the source fetch, the pre-submission
 * snapshot and the browserless verdict poll.
 *
 * Free instances sleep after inactivity, so the submitter is woken with
 * `GET /health` first. The POST itself is never retried: a retry after an
 * ambiguous network failure could create a duplicate Codeforces submission.
 */

export interface PostedResult extends BrowserPostOutcome {
  /** When the POST was attempted, for the verdict poll's time window. */
  submittedAt: number;
  /** Which transport did the POST, for the log line and error text. */
  transport: string;
}

const WAKE_TIMEOUT_MS = Number(process.env.CODEFORCES_SUBMITTER_WAKE_MS ?? 120_000);
const WAKE_INTERVAL_MS = 3_000;
const SUBMIT_TIMEOUT_MS = Number(process.env.CODEFORCES_SUBMITTER_TIMEOUT_MS ?? 300_000);

export function remoteSubmitterUrl(): string | null {
  const raw = process.env.CODEFORCES_SUBMITTER_URL?.trim();
  return raw ? raw.replace(/\/+$/, '') : null;
}

export function isRemoteSubmitterConfigured(): boolean {
  return remoteSubmitterUrl() !== null && (process.env.CODEFORCES_SUBMITTER_TOKEN?.trim() ?? '') !== '';
}

/** Waits out the submitter's cold start. Returns true once /health answers. */
async function wakeSubmitter(url: string): Promise<boolean> {
  const deadline = Date.now() + WAKE_TIMEOUT_MS;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(15_000) });
      if (response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { busy?: boolean };
        logger.info({ url, attempts, busy: payload.busy ?? false }, 'isolated Codeforces submitter is awake');
        if (payload.busy) {
          // Another submission is still running there; give it a moment.
          await sleep(WAKE_INTERVAL_MS);
          continue;
        }
        return true;
      }
    } catch {
      // Cold start / still booting — keep waiting.
    }
    await sleep(WAKE_INTERVAL_MS);
  }
  logger.warn({ url, attempts: attempts - 1, wakeTimeoutMs: WAKE_TIMEOUT_MS }, 'isolated Codeforces submitter did not wake');
  return false;
}

/**
 * Sends exactly one submission request to the isolated submitter.
 *
 * Returns null when the submitter is not configured, so the caller can fall back
 * to a local browser.
 */
export async function submitViaRemoteSubmitter(
  state: StorageStateShape,
  label: string,
  handle: string,
  entry: SourceIndexEntry,
  code: string,
): Promise<PostedResult | null> {
  const url = remoteSubmitterUrl();
  const token = process.env.CODEFORCES_SUBMITTER_TOKEN?.trim() ?? '';
  if (!url || !token) return null;

  const failed = (error: string): PostedResult => ({
    ok: false,
    kind: 'blocked',
    error,
    status: null,
    finalUrl: '',
    turnstile: false,
    clicked: false,
    interactive: false,
    submittedAt: Math.floor(Date.now() / 1000),
    transport: 'isolated browser',
  });

  if (entry.contestId === undefined || !entry.problemIndex) {
    return failed('source entry has no contestId/problemIndex');
  }

  if (!(await wakeSubmitter(url))) {
    return failed(
      `the isolated submitter at ${url} did not answer /health within ${Math.round(WAKE_TIMEOUT_MS / 1000)}s`,
    );
  }

  logMemory('isolated submitter preflight', { label, url });
  const payload = {
    label,
    handle,
    code,
    entry: {
      contestId: entry.contestId,
      problemIndex: entry.problemIndex,
      gym: entry.gym,
      language: entry.language,
    },
    state: { cookies: state.cookies, origins: state.origins ?? [] },
  };

  const submittedAt = Math.floor(Date.now() / 1000);
  let response: Response;
  try {
    response = await fetch(`${url}/submit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });
  } catch (err) {
    // Deliberately NOT retried: the POST may have reached Codeforces.
    return {
      ...failed(
        `the isolated submitter call failed and was not retried (a retry could duplicate the submission): ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
      submittedAt,
    };
  }

  const body = (await response.json().catch(() => null)) as
    | (Partial<PostedResult> & { error?: string; kind?: string })
    | null;
  if (!body) {
    return {
      ...failed(`the isolated submitter answered HTTP ${response.status} with a body that was not JSON`),
      submittedAt,
    };
  }

  const outcome: PostedResult = {
    ok: body.ok === true,
    kind: (body.kind as BrowserPostOutcome['kind']) ?? undefined,
    error: body.error,
    status: typeof body.status === 'number' ? body.status : null,
    finalUrl: typeof body.finalUrl === 'string' ? body.finalUrl : '',
    turnstile: body.turnstile === true,
    clicked: body.clicked === true,
    interactive: body.interactive === true,
    submittedAt,
    transport: 'isolated browser',
  };
  logger.info(
    {
      transport: outcome.transport,
      httpStatus: response.status,
      ok: outcome.ok,
      kind: outcome.kind,
      status: outcome.status,
      finalUrl: outcome.finalUrl,
      clicked: outcome.clicked,
      turnstile: outcome.turnstile,
      interactive: outcome.interactive,
    },
    'isolated Codeforces browser submitter finished',
  );
  return outcome;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
