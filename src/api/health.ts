import fs from 'node:fs';
import path from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { logger } from '../logger';
import { AccountStatus } from '@prisma/client';
import {
  getAllSystemState,
  getSystemState,
  latestRun,
  saveStorageStateToDb,
  SystemKeys,
} from '../database/models';
import {
  AccountRecord,
  deleteAccountByLabel,
  getAccountByLabel,
  listAccounts,
  parseStoredStorageState,
} from '../database/accounts';
import {
  applySessionRenewal,
  applyStorageStateDirect,
} from '../browser/sessionRenewal';
import { ingestCookiePayload } from '../accounts/ingest';

/**
 * Health + minimal admin API.
 *
 *   GET  /health        — unauthenticated liveness + last-run + auth status
 *   POST /admin/run-now — manual trigger, protected by SETUP_TOKEN (Bearer)
 *
 * No cookies, tokens, or secrets are ever exposed in responses.
 */

export interface ApiHooks {
  triggerRun: (reason: string) => Promise<{ started: boolean; message: string }>;
  isRunInProgress: () => boolean;
}

/** Shape of a Playwright storageState file — validated, never logged. */
const storageStateSchema = z.object({
  cookies: z.array(z.record(z.unknown())),
  origins: z.array(z.record(z.unknown())),
});

/** Account rows WITHOUT the secret — the only shape /admin/accounts returns. */
function safeAccountView(a: AccountRecord) {
  const parsed = parseStoredStorageState(a.storageState);
  return {
    label: a.label,
    username: a.username,
    status: a.status,
    cookieCount: parsed.ok ? parsed.state.cookies.length : 0,
    lastCheckedAt: a.lastCheckedAt?.toISOString() ?? null,
    lastRunAt: a.lastRunAt?.toISOString() ?? null,
    lastResult: a.lastResult,
    lastError: a.lastError,
    createdAt: a.createdAt.toISOString(),
  };
}

function safeJson(raw: string | undefined | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function startHealthServer(hooks: ApiHooks): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // pino is our logger; fastify's would double-log
    trustProxy: true,
    bodyLimit: 16 * 1024 * 1024, // storageState uploads can exceed the 1MB default
  });

  const requireAdmin = (authorization: string | undefined): boolean =>
    authorization === `Bearer ${config.api.setupToken}`;

  app.get('/health', async () => {
    const [sys, last, accounts] = await Promise.all([getAllSystemState(), latestRun(), listAccounts()]);
    return {
      status: 'ok',
      service: 'leetcode-daily-agent',
      now: new Date().toISOString(),
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
            createdAt: last.createdAt.toISOString(),
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
    validate: z.boolean().optional(), // default true — live LeetCode check after storing
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
      validate: body.data.validate !== false,
    });
    if (!result.ok) {
      return reply.code(400).send(result);
    }
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
    const accounts = await listAccounts();
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

  const port = config.api.port;
  await app.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, 'health server listening');
  return app;
}