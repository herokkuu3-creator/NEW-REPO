import { logger } from '../logger';
import { randomUUID } from 'node:crypto';
import { logMemory } from '../memory';
import type { StorageStateShape } from '../browser/cookiePayload';
import type { SourceIndexEntry } from './sourceRepo';
import type { BrowserPostOutcome } from './submission';
import type { CodeforcesNetworkMode } from './worker';
import { CODEFORCES_ATTEMPT_MS } from './attempts';
import { getRemovedProxyHashes, resolveActiveProxy, type ActiveProxyResult } from './proxyManager';
import { sendTelegramMessage } from '../notifications/telegram';
import { getCapzyApiKeys, getActiveCapzyKeyIndex, setActiveCapzyKeyIndex } from './capzyKeyManager';
import { getCPSolverUrl } from './captchaSolver';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function notifyProxyInUse(networkMode: CodeforcesNetworkMode = 'proxy'): Promise<ActiveProxyResult | null> {
  if (networkMode === 'tailscale') return null;
  const activeProxy = await resolveActiveProxy().catch((err) => {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'failed to resolve active proxy for submission');
    return null;
  });
  if (activeProxy) {
    const fallbackNotice = activeProxy.fallbackOccurred
      ? '\n⚠️ <i>(Preferred proxy was unreachable; fell back to pool rotation)</i>'
      : '';
    const msg = `🌐 Proxy in use: <b>${escapeHtml(activeProxy.host)}</b> (user: <code>${escapeHtml(activeProxy.username)}</code>)${fallbackNotice}`;
    await sendTelegramMessage(msg, { parseMode: 'HTML' }).catch(() => undefined);
  }
  return activeProxy;
}

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
  /** Confirmed that the browser never sent a submission. */
  safeToRetry?: boolean;
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
async function wakeSubmitter(url: string, attemptDeadline: number): Promise<boolean> {
  const deadline = Math.min(attemptDeadline, Date.now() + WAKE_TIMEOUT_MS);
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - Date.now()))) });
      if (response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { busy?: boolean };
        logger.info({ url, attempts, busy: payload.busy ?? false }, 'isolated Codeforces submitter is awake');
        if (payload.busy) {
          // Another submission is still running there; give it a moment.
          await sleep(Math.max(0, Math.min(WAKE_INTERVAL_MS, deadline - Date.now())));
          continue;
        }
        return true;
      }
    } catch {
      // Cold start / still booting — keep waiting.
    }
    await sleep(Math.max(0, Math.min(WAKE_INTERVAL_MS, deadline - Date.now())));
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
  networkMode: CodeforcesNetworkMode = 'proxy',
  options: {
    deadline?: number;
    onProgress?: (phase: 'queued' | 'running') => Promise<void> | void;
    activeProxy?: ActiveProxyResult | null;
  } = {},
): Promise<PostedResult | null> {
  const deadline = options.deadline ?? Date.now() + CODEFORCES_ATTEMPT_MS;
  const url = remoteSubmitterUrl();
  const token = process.env.CODEFORCES_SUBMITTER_TOKEN?.trim() ?? '';
  if (!url || !token) return null;

  const failed = (error: string, safeToRetry = true): PostedResult => ({
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
    safeToRetry,
  });

  if (entry.contestId === undefined || !entry.problemIndex) {
    return failed('source entry has no contestId/problemIndex');
  }

  const activeProxy = options.activeProxy !== undefined
    ? options.activeProxy
    : await notifyProxyInUse(networkMode).catch(() => null);

  if (!(await wakeSubmitter(url, deadline))) {
    return failed(
      `the isolated submitter at ${url} did not answer /health within ${Math.round(WAKE_TIMEOUT_MS / 1000)}s`,
    );
  }

  logMemory('isolated submitter preflight', { label, url });
  const payload = {
    requestId: randomUUID(),
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
    networkMode,
    proxy: activeProxy?.url,
    preferredProxy: activeProxy?.url,
    removedProxies: await getRemovedProxyHashes().catch(() => []),
    attemptDeadline: deadline,
    requiresPostAuthorization: true,
    capzyApiKeys: await getCapzyApiKeys().catch(() => []),
    capzyActiveKeyIndex: await getActiveCapzyKeyIndex().catch(() => 0),
    cpsolverUrl: getCPSolverUrl(),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN?.trim(),
    telegramChatId: process.env.TELEGRAM_CHAT_ID?.trim(),
  };

  const submittedAt = Math.floor(Date.now() / 1000);
  let response: Response;
  try {
    response = await fetch(`${url}/submit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Math.max(1, Math.min(SUBMIT_TIMEOUT_MS, deadline - Date.now()))),
    });
  } catch (err) {
    // Deliberately NOT retried: the POST may have reached Codeforces.
    const recovered = await waitForActionResult(url, token, payload.requestId, deadline, options.onProgress);
    if (recovered) return normalizeOutcome(recovered, submittedAt, 'GitHub browser');
    return {
      ...failed(
        `the isolated submitter call failed and was not retried (a retry could duplicate the submission): ${
          err instanceof Error ? err.message : String(err)
        }`, false,
      ),
      submittedAt,
    };
  }

  let body = (await response.json().catch(() => null)) as
    | (Partial<PostedResult> & { error?: string; kind?: string })
    | null;
  if (!body && response.status >= 500) {
    body = await waitForActionResult(url, token, payload.requestId, deadline, options.onProgress);
    if (body) return normalizeOutcome(body, submittedAt, 'GitHub browser');
  }
  if (response.status === 202 && typeof (body as { jobId?: unknown } | null)?.jobId === 'string') {
    const id = (body as { jobId: string }).jobId;
    logger.info({ id }, 'submitViaRemoteSubmitter: dispatched to runner broker, awaiting job result...');
    body = await waitForActionResult(url, token, id, deadline, options.onProgress);
    logger.info({ id, result: body }, 'submitViaRemoteSubmitter: received runner result from broker');
    if (!body || 'jobId' in body) {
      return { ...failed(`GitHub browser job ${id} did not return a result; its Codeforces outcome is uncertain`, false), submittedAt };
    }
  }
  if (!body) {
    return {
      ...failed(`the isolated submitter answered HTTP ${response.status} with a body that was not JSON`, false),
      submittedAt,
    };
  }

  if (body && typeof (body as any).activeCapzyKeyIndex === 'number') {
    await setActiveCapzyKeyIndex((body as any).activeCapzyKeyIndex).catch(() => {});
  }

  const outcome = normalizeOutcome(body, submittedAt, response.status === 202 ? 'GitHub browser' : 'isolated browser');
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
      error: outcome.error,
    },
    'isolated Codeforces browser submitter finished',
  );
  return outcome;
}

function normalizeOutcome(body: Partial<PostedResult>, submittedAt: number, transport: string): PostedResult {
  return {
    ok: body.ok === true,
    kind: (body.kind as BrowserPostOutcome['kind']) ?? undefined,
    error: body.error,
    status: typeof body.status === 'number' ? body.status : null,
    finalUrl: typeof body.finalUrl === 'string' ? body.finalUrl : '',
    turnstile: body.turnstile === true,
    clicked: body.clicked === true,
    interactive: body.interactive === true,
    submittedAt,
    transport,
    safeToRetry: body.safeToRetry === true || (body.clicked === false && body.ok === false && (body.kind === 'blocked' || body.kind === 'submission-error')),
    updatedCookies: Array.isArray(body.updatedCookies) ? body.updatedCookies : undefined,
  };
}

export async function waitForActionResult(url: string, token: string, id: string, deadline: number,
  onProgress?: (phase: 'queued' | 'running') => Promise<void> | void): Promise<Partial<PostedResult> | null> {
  let lastProgress = -Infinity;
  let lastPhase: 'queued' | 'running' | undefined;
  while (Date.now() < deadline) {
    await sleep(Math.max(0, Math.min(3_000, deadline - Date.now())));
    if (Date.now() >= deadline) break;
    try {
      const poll = await fetch(`${url}/jobs/${id}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - Date.now()))),
      });
      if (poll.status === 404) return null;
      if (!poll.ok) continue;
      const state = await poll.json() as { pending?: boolean; claimed?: boolean; result?: Partial<PostedResult> };
      if (state.pending === false && state.result) return state.result;
      const phase = state.claimed ? 'running' : 'queued';
      if (phase !== lastPhase || Date.now() - lastProgress >= 30_000) {
        lastProgress = Date.now();
        lastPhase = phase;
        await onProgress?.(phase);
      }
    } catch { /* Keep polling the same job. Never enqueue another submission. */ }
  }
  // Cancellation is atomic with the runner's pre-click authorization. A late
  // guarded runner cannot POST a cancelled job. Legacy claimed jobs are not cancelled.
  const response = await fetch(`${url}/jobs/${id}/cancel`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000),
  }).catch(() => null);
  const cancelled = response?.ok && (await response.json().catch(() => ({})) as { cancelled?: boolean }).cancelled === true;
  return { ok: false, kind: 'blocked', clicked: !cancelled, safeToRetry: !!cancelled,
    error: cancelled ? 'Eight-minute limit reached; browser job cancelled before submission'
      : 'Eight-minute limit reached; the runner may have submitted. No duplicate submission was started; checking Codeforces history.' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
