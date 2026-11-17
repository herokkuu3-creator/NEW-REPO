import fs from 'node:fs';
import path from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { logger, logRingBuffer } from '../logger';
import { AccountStatus } from '@prisma/client';
import {
  DailyRunSummary,
  getAllSystemState,
  getSystemState,
  getSystemStates,
  latestRun,
  latestRunSummary,
  saveStorageStateToDb,
  SystemKeys,
} from '../database/models';
import {
  AccountRecord,
  AccountSummary,
  deleteAccountByLabel,
  getAccountByLabel,
  listAccounts,
  listAccountSummaries,
  parseStoredStorageState,
} from '../database/accounts';
import {
  applySessionRenewal,
  applyStorageStateDirect,
} from '../browser/sessionRenewal';
import { ingestCookiePayload } from '../accounts/ingest';
import { RunReport, summarizeReport } from '../scheduler/report';
import { isoLocal } from '../time';
import { PIN_COOKIE, PinGate, pinPage, readPinFromEnv, safeNext } from './pinGate';
import { registerSolutionPostRoutes } from '../solutionPosts/routes';
import type { RecoveryService } from '../recovery/service';
import { registerRecoveryRoutes } from '../recovery/routes';
import { getMobileTunnel } from '../recovery/mobileTunnel';
import { runRemoteBrowserPoc } from '../recovery/poc';
import { registerVisualAssetRoutes } from '../solutionPosts/visualStore';
import { registerRangeDiagnostics } from '../scheduler/rangeDiagnostics';
import { probeSageApi, askSage, sageConsoleHtml } from '../ai/sageProbe';
import {
  completeLeetCodePairingSession,
  getLeetCodePairingSession,
  renderLeetCodePairingPortalHtml,
  resolvePublicBaseUrl,
} from '../leetcode/loginHandoff';
import { invalidateHealthCache, registerHealthCacheInvalidator } from './healthCache';
import { resetDailyRetryPollGate } from '../scheduler/dailyRetryGate';

export { invalidateHealthCache };

/**
 * Health + minimal admin API.
 *
 *   GET  /health        — liveness; full details (accounts, runs) only after the
 *                         PIN_CODE is entered (browser form or X-PIN-Code header)
 *   POST /unlock        — PIN form target (sets a short-lived session cookie)
 *   POST /admin/run-now — manual trigger, protected by SETUP_TOKEN (Bearer)
 *   POST /triggerSubmission — re-submit the daily question for every account
 *                          and return one result per account (Bearer)
 *
 * No cookies, tokens, or secrets are ever exposed in responses.
 */

export interface ApiHooks {
  triggerRun: (reason: string) => Promise<{ started: boolean; message: string }>;
  isRunInProgress: () => boolean;
  /** Runs the submission for every account and resolves with the report (null = run already in progress). */
  runSubmission: () => Promise<RunReport | null>;
  triggerCodeforcesRun?: (reason: string) => Promise<{ started: boolean; message: string }>;
  /** LeetCode session recovery (portal + admin diagnostics). */
  recovery?: RecoveryService;
}

/** Shape of a Playwright storageState file — validated, never logged. */
const storageStateSchema = z.object({
  cookies: z.array(z.record(z.unknown())),
  origins: z.array(z.record(z.unknown())),
});

const HEALTH_SYSTEM_KEYS = [
  SystemKeys.authStatus,
  SystemKeys.authUsername,
  SystemKeys.lastReport,
  SystemKeys.lastError,
] as const;

type AccountViewInput = AccountSummary | AccountRecord;

function isMockFn(fn: unknown): boolean {
  return typeof fn === 'function' && 'mock' in fn && typeof (fn as { mock?: unknown }).mock === 'object';
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function resolveCookieCount(a: AccountViewInput): number {
  if ('cookieCount' in a && typeof a.cookieCount === 'number') {
    return a.cookieCount;
  }
  if ('storageState' in a && typeof a.storageState === 'string') {
    const parsed = parseStoredStorageState(a.storageState);
    return parsed.ok ? parsed.state.cookies.length : 0;
  }
  return 0;
}

/** Account rows WITHOUT the secret — the only shape /admin/accounts returns. */
function safeAccountView(a: AccountViewInput) {
  return {
    label: a.label,
    username: a.username,
    status: a.status,
    cookieCount: resolveCookieCount(a),
    lastCheckedAt: a.lastCheckedAt ? isoLocal(toDate(a.lastCheckedAt)) : null,
    lastRunAt: a.lastRunAt ? isoLocal(toDate(a.lastRunAt)) : null,
    lastResult: a.lastResult,
    lastError: a.lastError,
    createdAt: isoLocal(toDate(a.createdAt)),
  };
}

async function fetchHealthSystemState(): Promise<Record<string, string>> {
  if (!isMockFn(getSystemStates) && isMockFn(getAllSystemState)) {
    return getAllSystemState();
  }
  return getSystemStates(HEALTH_SYSTEM_KEYS);
}

async function fetchLatestRunSummary(): Promise<DailyRunSummary | null> {
  if (!isMockFn(latestRunSummary) && isMockFn(latestRun)) {
    return latestRun();
  }
  return latestRunSummary();
}

async function fetchAccountSummaries(): Promise<AccountViewInput[]> {
  if (!isMockFn(listAccountSummaries) && isMockFn(listAccounts)) {
    return listAccounts();
  }
  return listAccountSummaries();
}

function safeJson(raw: string | undefined | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Response body of POST /triggerSubmission — one entry per account, no secrets. */
export function formatSubmissionResponse(report: RunReport) {
  return {
    ok: true,
    date: report.date,
    reason: report.reason,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    summary: summarizeReport(report),
    totals: report.totals,
    accounts: report.accounts.map((a) => ({
      label: a.label,
      username: a.username ?? null,
      status: a.kind,
      success: a.kind === 'solved',
      state: a.state ?? null,
      submissionId: a.submissionId ?? null,
      verdict: a.submissionStatus ?? null,
      runtime: a.runtime ?? null,
      memory: a.memory ?? null,
      error: a.error ?? null,
    })),
  };
}

export async function startHealthServer(
  hooks: ApiHooks,
  opts: { pinCode?: string; healthCacheTtlMs?: number } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // pino is our logger; fastify's would double-log
    trustProxy: true,
    bodyLimit: 16 * 1024 * 1024, // storageState uploads can exceed the 1MB default
  });

  // Short-lived cache + single-flight deduplication for authenticated /health
  // reads (disabled by default under Vitest unless explicitly configured).
  const defaultCacheTtlMs = process.env.VITEST ? 0 : 10_000;
  const healthCacheTtlMs = Math.max(0, opts.healthCacheTtlMs ?? defaultCacheTtlMs);
  interface HealthSnapshot {
    sys: Record<string, string>;
    last: DailyRunSummary | null;
    accounts: AccountViewInput[];
  }
  let cacheEpoch = 0;
  let cachedHealth: { snapshot: HealthSnapshot; expiresAt: number } | null = null;
  let inflightHealth: { epoch: number; promise: Promise<HealthSnapshot> } | null = null;

  const unregisterHealthCache = registerHealthCacheInvalidator(() => {
    cacheEpoch += 1;
    cachedHealth = null;
  });
  app.addHook('onClose', async () => {
    unregisterHealthCache();
  });

  const loadHealthSnapshot = async (): Promise<HealthSnapshot> => {
    const nowMs = Date.now();
    if (healthCacheTtlMs > 0 && cachedHealth && cachedHealth.expiresAt > nowMs) {
      return cachedHealth.snapshot;
    }
    if (inflightHealth && inflightHealth.epoch === cacheEpoch) {
      return inflightHealth.promise;
    }
    const startEpoch = cacheEpoch;
    const promise = Promise.all([
      fetchHealthSystemState(),
      fetchLatestRunSummary(),
      fetchAccountSummaries(),
    ])
      .then(([sys, last, accounts]) => {
        const snapshot: HealthSnapshot = { sys, last, accounts };
        if (healthCacheTtlMs > 0 && cacheEpoch === startEpoch) {
          cachedHealth = { snapshot, expiresAt: Date.now() + healthCacheTtlMs };
        }
        return snapshot;
      })
      .finally(() => {
        if (inflightHealth?.promise === promise) {
          inflightHealth = null;
        }
      });
    inflightHealth = { epoch: startEpoch, promise };
    return promise;
  };

  // --- PIN gate for everything that used to be public ------------------------
  const pinGate = new PinGate(opts.pinCode ?? readPinFromEnv(), config.api.setupToken);
  if (!pinGate.configured) {
    logger.warn('PIN_CODE is not set - /health details stay locked (only {"status":"ok"} is served)');
  }

  // HTML PIN form posts application/x-www-form-urlencoded (small bodies only).
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 4096 },
    (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    },
  );

  const wantsHtml = (accept: string | undefined): boolean => /text\/html/i.test(accept ?? '');

  // Public liveness endpoint for external uptime monitors (e.g. UptimeRobot).
  // It is deliberately unauthenticated, side-effect free, and supports both
  // GET and HEAD so either monitor request style receives a 2xx response.
  app.route({
    method: ['GET', 'HEAD'],
    url: '/',
    handler: async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('X-Robots-Tag', 'noindex, nofollow');
      return { status: 'ok' };
    },
  });

  app.post('/unlock', async (req, reply) => {
    const body = (req.body ?? {}) as { pin?: string; next?: string };
    const next = safeNext(body.next);
    const result = pinGate.checkPin(req.ip, body.pin);
    reply.header('Cache-Control', 'no-store');
    if (result === 'ok') {
      const token = pinGate.issueToken();
      reply.header(
        'Set-Cookie',
        `${PIN_COOKIE}=${encodeURIComponent(token.value)}; Max-Age=${token.maxAgeS}; Path=/; HttpOnly; SameSite=Strict${req.protocol === 'https' ? '; Secure' : ''}`,
      );
      return reply.redirect(next, 303);
    }
    const message =
      result === 'locked'
        ? 'Too many wrong attempts. Try again in 15 minutes.'
        : result === 'not-configured'
          ? 'PIN_CODE is not configured on the server.'
          : 'Wrong PIN.';
    logger.warn({ result }, 'PIN unlock attempt rejected');
    return reply
      .code(result === 'locked' ? 429 : 401)
      .type('text/html; charset=utf-8')
      .send(pinPage({ next, message, disabled: result !== 'wrong' }));
  });

  app.get('/lock', async (_req, reply) => {
    reply.header('Set-Cookie', `${PIN_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`);
    return reply.redirect('/health', 303);
  });

  const requireAdmin = (authorization: string | undefined): boolean =>
    authorization === `Bearer ${config.api.setupToken}`;

  registerSolutionPostRoutes(app, requireAdmin);
  registerVisualAssetRoutes(app);
  registerRangeDiagnostics(app, requireAdmin);

  // --- LeetCode session recovery portal + admin diagnostics ------------------
  if (hooks.recovery) {
    const recovery = hooks.recovery;
    registerRecoveryRoutes(app, recovery);
    app.get('/admin/recovery', async (req, reply) => {
      if (!requireAdmin(req.headers.authorization)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
      return { ok: true, open: await recovery.describeOpen() };
    });
    app.post('/admin/recovery/monitor', async (req, reply) => {
      if (!requireAdmin(req.headers.authorization)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
      return { ok: true, summary: await recovery.monitorAccounts() };
    });
    // Proof of concept FROM THIS SERVER'S NETWORK: how do LeetCode/Cloudflare treat the remote browser?
    app.post('/admin/recovery/poc', async (req, reply) => {
      if (!requireAdmin(req.headers.authorization)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
      if (recovery.activeSessionCount > 0) return reply.code(409).send({ ok: false, error: 'a recovery session is active' });
      const { screenshot, ...result } = await runRemoteBrowserPoc({ settleMs: 12_000 });
      return { ok: true, result, frameBytes: screenshot?.length ?? 0 };
    });

    const tunnel = getMobileTunnel();
    app.server.on('upgrade', (req, socket, head) => {
      const urlPath = (req.url || '').split('?')[0];
      if (urlPath === '/auth/recover/tunnel') {
        tunnel.handleUpgrade(req, socket, head);
        return;
      }
      socket.destroy();
    });
    app.addHook('onClose', async () => {
      await tunnel.close();
    });
    app.get('/admin/recovery/tunnel', async (req, reply) => {
      if (!requireAdmin(req.headers.authorization)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
      return { ok: true, tunnel: tunnel.getStatus(), egress: await recovery.getEgressStatus() };
    });
  }

  // --- Telegram-initiated LeetCode interactive pairing routes (/lclogin) -----
  app.get('/auth/leetcode/:token', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    const { token } = req.params as { token: string };
    const now = Date.now();
    const session = getLeetCodePairingSession(token, now);

    if (!session) {
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(renderLeetCodePairingPortalHtml(null, 'invalid'));
    }

    if (session.status === 'completed' || session.status === 'completing') {
      return reply
        .code(409)
        .type('text/html; charset=utf-8')
        .send(renderLeetCodePairingPortalHtml(null, 'used'));
    }

    if (session.status === 'cancelled') {
      return reply
        .code(410)
        .type('text/html; charset=utf-8')
        .send(renderLeetCodePairingPortalHtml(null, 'cancelled'));
    }

    if (session.status === 'expired' || now >= session.expiresAt) {
      return reply
        .code(410)
        .type('text/html; charset=utf-8')
        .send(renderLeetCodePairingPortalHtml(null, 'expired'));
    }

    const baseUrl = resolvePublicBaseUrl();
    const pairingUrl = `${baseUrl}/auth/leetcode/${session.token}`;
    const viewSession = {
      ...session,
      pairingUrl,
      companionCommand: `npm run auth:login -- "${pairingUrl}"`,
      expiresInMinutes: Math.max(1, Math.ceil((session.expiresAt - now) / 60_000)),
    };

    return reply
      .code(200)
      .type('text/html; charset=utf-8')
      .send(renderLeetCodePairingPortalHtml(viewSession));
  });

  app.post('/auth/leetcode/:token', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    const { token } = req.params as { token: string };
    const outcome = await completeLeetCodePairingSession(token, req.body);

    if (!outcome.ok) {
      return reply.code(outcome.httpStatus).send({
        ok: false,
        code: outcome.code,
        error: outcome.error,
        label: outcome.label ?? null,
        username: outcome.username ?? null,
        localVerifiedUsername: outcome.localVerifiedUsername ?? null,
        accountStatus: outcome.accountStatus ?? null,
        serverVerified: outcome.serverVerified ?? false,
        localVsServerMismatch: outcome.localVsServerMismatch ?? false,
      });
    }

    invalidateHealthCache();
    resetDailyRetryPollGate();
    const trigger = await hooks.triggerRun('session-renewal').catch(() => ({
      started: false,
      message: 'not started',
    }));

    return reply.code(200).send({
      ok: true,
      label: outcome.label,
      username: outcome.username,
      localVerifiedUsername: outcome.localVerifiedUsername,
      accountStatus: outcome.accountStatus,
      serverVerified: outcome.serverVerified,
      localVsServerMismatch: outcome.localVsServerMismatch,
      cookieCount: outcome.cookieCount,
      detail: outcome.detail,
      runStarted: trigger.started,
      runMessage: trigger.message,
    });
  });

  // Sage Inkstone (Intern-AI) Console and API endpoints
  app.get('/sage', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const hostLabel = process.env.RENDER_EXTERNAL_URL ? 'Render Web Service' : (process.env.RENDER_INSTANCE_ID ? 'Render Container' : 'Local Host');
    return reply.type('text/html; charset=utf-8').send(sageConsoleHtml(hostLabel));
  });

  app.post('/sage/test', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as { apiKey?: string; model?: string };
    const result = await probeSageApi(body.apiKey, body.model);
    return reply.send(result);
  });

  app.get('/admin/sage/test', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const query = (req.query ?? {}) as { apiKey?: string; model?: string };
    const result = await probeSageApi(query.apiKey, query.model);
    return reply.send(result);
  });

  app.post('/admin/sage/test', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as { apiKey?: string; model?: string };
    const result = await probeSageApi(body.apiKey, body.model);
    return reply.send(result);
  });

  app.post('/sage/ask', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as { question?: string; apiKey?: string; model?: string; maxTokens?: number };
    const result = await askSage(body.question || '', { apiKey: body.apiKey, model: body.model, maxTokens: body.maxTokens });
    return reply.send(result);
  });

  app.post('/admin/sage/ask', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as { question?: string; apiKey?: string; model?: string; maxTokens?: number };
    const result = await askSage(body.question || '', { apiKey: body.apiKey, model: body.model, maxTokens: body.maxTokens });
    return reply.send(result);
  });

  app.post('/api/sage/ask', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as { question?: string; apiKey?: string; model?: string; maxTokens?: number };
    const result = await askSage(body.question || '', { apiKey: body.apiKey, model: body.model, maxTokens: body.maxTokens });
    return reply.send(result);
  });

  app.get('/health', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    if (!pinGate.isUnlocked(req.ip, req.headers)) {
      // Locked: liveness only — enough for Render's health check, nothing else.
      if (wantsHtml(req.headers.accept)) {
        const locked = pinGate.isLockedOut(req.ip);
        return reply
          .type('text/html; charset=utf-8')
          .send(
            pinPage({
              next: '/health',
              message: locked ? 'Too many wrong attempts. Try again in 15 minutes.' : undefined,
              disabled: locked || !pinGate.configured,
            }),
          );
      }
      return { status: 'ok' };
    }
    const { sys, last, accounts } = await loadHealthSnapshot();
    return {
      status: 'ok',
      service: 'leetcode-daily-agent',
      now: isoLocal(),
      runInProgress: hooks.isRunInProgress(),
      authentication: {
        status: sys['authStatus'] ?? 'unknown',
        username: sys['authUsername'] ?? null,
      },
      accounts: {
        total: accounts.length,
        active: accounts.filter((a) => a.status === AccountStatus.ACTIVE).length,
        expired: accounts.filter((a) => a.status === AccountStatus.EXPIRED).length,
        items: accounts.map(safeAccountView),
      },
      lastReport: safeJson(sys[SystemKeys.lastReport]),
      lastRun: last
        ? {
            date: last.date,
            problemSlug: last.problemSlug,
            title: last.title,
            state: last.state,
            submissionStatus: last.submissionStatus,
            runtime: last.runtime,
            memory: last.memory,
            createdAt: isoLocal(toDate(last.createdAt)),
          }
        : null,
      lastError: sys['lastError'] ?? null,
    };
  });

  const runNowBodySchema = z.object({}).passthrough();

  app.post('/admin/run-now', async (req, reply) => {
    if (!requireAdmin(req.headers.authorization)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    runNowBodySchema.parse(req.body ?? {});
    const result = await hooks.triggerRun('admin-api');
    return reply.code(result.started ? 202 : 409).send(result);
  });

  app.post('/admin/codeforces-run', async (req, reply) => {
    if (!requireAdmin(req.headers.authorization)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (!hooks.triggerCodeforcesRun) {
      return reply.code(501).send({ error: 'Codeforces trigger not supported' });
    }
    const result = await hooks.triggerCodeforcesRun('admin-api');
    return reply.code(result.started ? 202 : 409).send(result);
  });

  /**
   * Re-submits today's daily question for EVERY account and waits for the
   * judge on each, then answers with a separate result per account:
   *
   *   curl -X POST -H "Authorization: Bearer $SETUP_TOKEN" \
   *        https://<service>.onrender.com/triggerSubmission
   *
   *   200 { ok, date, summary, totals, accounts: [{ label, username, status, ... }] }
   *   409 { ok: false, error }  — a run is already in progress
   *
   * Overrides the per-day dedupe (like /admin/run-now), so accounts already
   * solved today are submitted again. The solution is fetched once and
   * shared by all accounts.
   */
  app.post('/triggerSubmission', async (req, reply) => {
    if (!requireAdmin(req.headers.authorization)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (hooks.isRunInProgress()) {
      return reply.code(409).send({ ok: false, error: 'a run is already in progress — try again when it finishes' });
    }
    let report: RunReport | null;
    try {
      report = await hooks.runSubmission();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'triggerSubmission failed');
      return reply.code(500).send({ ok: false, error: msg });
    }
    if (!report) {
      return reply.code(409).send({ ok: false, error: 'a run is already in progress — try again when it finishes' });
    }
    invalidateHealthCache();
    return reply.send(formatSubmissionResponse(report));
  });

  /**
   * Upload / refresh the storageState credential.
   *
   * Render's free tier has NO shell access and NO persistent disk, so this
   * endpoint is how the authenticated session gets onto the service:
   *   curl -X POST -H "Authorization: Bearer $SETUP_TOKEN" \
   *        -H "Content-Type: application/json" \
   *        --data-binary @local-auth/storage-state.json \
   *        https://<service>.onrender.com/admin/storage-state
   *
   * The snapshot is stored in Postgres (durable across restarts and
   * spin-downs) and mirrored to the filesystem path when writable.
   * The content is NEVER logged.
   */
  app.post('/admin/storage-state', async (req, reply) => {
    if (!requireAdmin(req.headers.authorization)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const parsed = storageStateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid storageState payload — expected a Playwright storageState JSON object',
      });
    }
    const json = JSON.stringify(parsed.data);
    await saveStorageStateToDb(json);
    invalidateHealthCache();
    resetDailyRetryPollGate();
    try {
      const target = config.browser.storageStatePath;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, json);
    } catch {
      // Ephemeral/read-only filesystem is fine — the DB copy is authoritative.
    }
    logger.info({ cookies: parsed.data.cookies.length }, 'storageState updated via admin API');
    return reply.send({
      ok: true,
      stored: 'database',
      cookies: parsed.data.cookies.length,
      origins: parsed.data.origins.length,
    });
  });

  /**
   * The endpoint scripts/capture-session.ts uploads to after a successful
   * LOCAL sign-in. Body: a raw Playwright storageState JSON. The session is
   * re-validated against LeetCode BEFORE anything is stored (a bad upload
   * can never clobber the working credential), and a successful upload
   * immediately triggers today's run — recovery is one script run.
   *
   *   200 { ok, username, cookieCount, runStarted }  — renewed
   *   422 { ok: false, error }                        — rejected (reason in body)
   */
  app.post('/admin/upload-session', async (req, reply) => {
    if (!requireAdmin(req.headers.authorization)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const parsed = storageStateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: 'expected a Playwright storageState JSON object ({ cookies: [...], origins: [...] })',
      });
    }
    const result = await applyStorageStateDirect(
      parsed.data as unknown as Parameters<typeof applyStorageStateDirect>[0],
    );
    if (!result.ok) {
      logger.warn({ error: result.error }, 'uploaded session rejected by validation');
      return reply.code(422).send(result);
    }
    invalidateHealthCache();
    resetDailyRetryPollGate();
    const trigger = await hooks.triggerRun('session-renewal');
    logger.info(
      { username: result.username, cookies: result.cookieCount, runStarted: trigger.started },
      'session uploaded from local capture — run recovery attempted',
    );
    return reply.send({ ...result, runStarted: trigger.started, runMessage: trigger.message });
  });

  /**
   * Session renewal without Telegram — same validate-then-save logic the
   * /renew bot command uses. Body: { "cookies": "<header string | Cookie-
   * Editor JSON array | storageState object>" }, or a raw storageState body.
   *
   *   curl -X POST -H "Authorization: Bearer $SETUP_TOKEN" \
   *        -H "Content-Type: application/json" \
   *        -d '{"cookies":"LEETCODE_SESSION=...; csrftoken=..."}' \
   *        https://<service>.onrender.com/admin/renew-session
   *
   * The cookies are validated against LeetCode BEFORE anything is stored, so
   * a bad payload can never clobber the working credential. 200 = renewed,
   * 422 = rejected (the error explains why). After a 200, trigger the run
   * with POST /admin/run-now.
   */
  app.post('/admin/renew-session', async (req, reply) => {
    if (!requireAdmin(req.headers.authorization)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const body = req.body as unknown;
    let payload: string;
    if (typeof body === 'string') {
      payload = body;
    } else if (body && typeof body === 'object' && typeof (body as { cookies?: unknown }).cookies === 'string') {
      payload = (body as { cookies: string }).cookies;
    } else {
      payload = JSON.stringify(body ?? {});
    }
    const result = await applySessionRenewal(payload);
    if (result.ok) {
      invalidateHealthCache();
      resetDailyRetryPollGate();
    }
    logger.info({ ok: result.ok }, 'session renewal attempted via admin API');
    return reply.code(result.ok ? 200 : 422).send(result);
  });

  // --- Multi-account management ---------------------------------------------
  //
  //   POST   /admin/accounts       — add/update an account from cookies
  //   GET    /admin/accounts       — list accounts (labels + status, NO secrets)
  //   DELETE /admin/accounts/:label — remove an account
  //   GET    /admin/report         — the latest multi-account run report

  const accountLabelSchema = z
    .string()
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,31}$/,
      'label must match [a-zA-Z0-9][a-zA-Z0-9_.-]{0,31}',
    );

  const addAccountSchema = z.object({
    // Optional: without a label the account is keyed by the LeetCode username
    // read from the session token (same user again = override).
    label: accountLabelSchema.optional(),
    cookies: z.unknown(),
    validate: z.boolean().optional(), // default false — live check is deferred to the daily run
  });

  app.post('/admin/accounts', async (req, reply) => {
    if (!requireAdmin(req.headers.authorization)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const body = addAccountSchema.safeParse(req.body ?? {});
    if (!body.success) {
      return reply
        .code(400)
        .send({ ok: false, error: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    }

    // Accept the same formats as Telegram: a cookie header string, a
    // Cookie-Editor JSON array, or a storageState object — or a raw
    // storageState body with no wrapper at all.
    const raw = body.data.cookies === undefined ? req.body : body.data.cookies;
    const payload = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
    const result = await ingestCookiePayload(payload, {
      label: body.data.label,
      validate: body.data.validate === true,
    });
    if (!result.ok) {
      return reply.code(400).send(result);
    }
    invalidateHealthCache();
    resetDailyRetryPollGate();
    const trigger = result.status === AccountStatus.EXPIRED ? null : await hooks.triggerRun('session-renewal');
    return reply.send({
      ...result,
      runStarted: trigger?.started ?? false,
      runMessage: trigger?.message ?? 'not started — the account is expired',
    });
  });

  app.get('/admin/accounts', async (req, reply) => {
    if (!requireAdmin(req.headers.authorization)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const accounts = await fetchAccountSummaries();
    return { total: accounts.length, accounts: accounts.map(safeAccountView) };
  });

  app.delete('/admin/accounts/:label', async (req, reply) => {
    if (!requireAdmin(req.headers.authorization)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const { label } = req.params as { label: string };
    const existing = await getAccountByLabel(label);
    if (!existing) {
      return reply.code(404).send({ ok: false, error: `no account named "${label}"` });
    }
    await deleteAccountByLabel(label);
    invalidateHealthCache();
    logger.info({ label }, 'account deleted via admin API');
    return reply.send({ ok: true, label, deleted: true });
  });

  app.get('/admin/report', async (req, reply) => {
    if (!requireAdmin(req.headers.authorization)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const raw = await getSystemState(SystemKeys.lastReport);
    return { report: safeJson(raw) };
  });

  app.get('/logs', async (req, reply) => {
    const query = req.query as { limit?: string; format?: string; level?: string };
    const limit = Math.min(1000, Math.max(1, parseInt(query?.limit || '200', 10)));
    let entries = logRingBuffer.slice(-limit);
    if (query?.level) {
      const minLevel = parseInt(query.level, 10);
      if (!isNaN(minLevel)) {
        entries = entries.filter((e) => typeof e.level === 'number' && e.level >= minLevel);
      }
    }
    if (query?.format === 'text') {
      reply.header('content-type', 'text/plain; charset=utf-8');
      return entries
        .map((e) => `[${e.time ?? ''}] [${e.level ?? ''}] ${e.msg ?? ''} ${JSON.stringify(e)}`)
        .join('\n');
    }
    return { ok: true, count: entries.length, logs: entries };
  });

  const port = config.api.port;
  await app.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, 'health server listening');
  return app;
}
