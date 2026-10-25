import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { prisma } from '../database/prisma';
import { generateForRun, retryPost, PostError, resetFailedSolutionPostRetries } from './service';
import { approvePost } from './store';
import { publishPost, reconcilePost } from './publisher';
import { runCombined, setSelectedAccounts, POST_CRON, POST_TIMEZONE, runScheduledSolutionPosts,
  isScheduledSolutionRunInProgress, SCHEDULE_STATE_KEY } from './scheduler';
import { appendSolutionApiKeys, solutionKeyPoolStatus, testSolutionApiKey } from './keyPool';
import { PROVIDER_CHECK_STATE_KEY } from './providerDiagnostics';
import { probeOxion } from './oxionProbe';
import { probeExperiential } from './experientialProbe';
import { probeBazaarLink } from './bazaarlinkProbe';

export function registerSolutionPostRoutes(app: FastifyInstance, authorize: (header: string | undefined) => boolean) {
  app.register(async scoped => {
    scoped.addHook('onRequest', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!authorize(req.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
    });
    scoped.setErrorHandler((error, _req, reply) => {
      reply.code(error instanceof z.ZodError ? 400 : 409).send({
        error: error instanceof z.ZodError ? 'INVALID_REQUEST' : error instanceof PostError ? error.code : 'SOLUTION_OPERATION_FAILED',
      });
    });
    scoped.get('/admin/solutions', async req => {
      const query = z.object({ accountId: z.string().optional(), before: z.string().datetime().optional() }).parse(req.query);
      return prisma.solutionPost.findMany({ where: { ...(query.accountId ? { accountId: query.accountId } : {}),
        ...(query.before ? { createdAt: { lt: new Date(query.before) } } : {}) },
        select: { id: true, accountId: true, problemSlug: true, submissionId: true, status: true, title: true,
          style: true, model: true, reviewModel: true, lastError: true, retryCount: true, publishedUrl: true,
          createdAt: true, updatedAt: true }, orderBy: { createdAt: 'desc' }, take: 100 });
    });
    scoped.get('/admin/solutions/accounts', async () => prisma.account.findMany({
      where: { status: { not: 'DISABLED' } }, orderBy: { label: 'asc' },
      select: { id: true, label: true, username: true, status: true, runs: {
        where: { state: 'SUCCESS', submissionStatus: 'Accepted', submissionId: { not: null } },
        orderBy: { updatedAt: 'desc' }, take: 10,
        select: { id: true, date: true, problemSlug: true, submissionId: true, language: true },
      } },
    }));
    scoped.get('/admin/solutions/schedule', async () => ({ cron: POST_CRON, timezone: POST_TIMEZONE,
      publishing: config.solutionPosts.autoPublish ? 'automatic' : 'review-required',
      accounts: await prisma.solutionPostPreference.findMany({ where: { enabled: true } }) }));
    scoped.put('/admin/solutions/schedule', async req => {
      const body = z.object({ accountIds: z.array(z.string().min(1)).max(100) }).strict().parse(req.body);
      return setSelectedAccounts(body.accountIds);
    });
    scoped.post('/admin/solutions/daily', async req => {
      const body = z.object({ accountIds: z.array(z.string().min(1)).min(1).max(100) }).strict().parse(req.body);
      return runCombined(body.accountIds);
    });
    scoped.get('/admin/solutions/diagnostics', async () => ({
      serverTime: new Date().toISOString(), executionHost: process.env.RENDER_INSTANCE_ID ? 'render' : 'local',
      revision: process.env.RENDER_GIT_COMMIT ?? null,
      cron: POST_CRON, timezone: POST_TIMEZONE, autoPublish: config.solutionPosts.autoPublish,
      running: isScheduledSolutionRunInProgress(), models: config.solutionPosts.models,
      selected: await prisma.solutionPostPreference.findMany({ where: { enabled: true } }),
      scheduler: await prisma.systemState.findUnique({ where: { key: SCHEDULE_STATE_KEY } }),
      provider: await prisma.systemState.findUnique({ where: { key: PROVIDER_CHECK_STATE_KEY } }),
      keys: await solutionKeyPoolStatus(),
    }));
    scoped.post('/admin/solutions/scheduled', async (req, reply) => {
      z.object({}).strict().parse(req.body ?? {});
      if (isScheduledSolutionRunInProgress()) return reply.code(202).send({ status: 'ALREADY_RUNNING' });
      // Return before a cold-start proxy timeout. Durable diagnostics record completion.
      void runScheduledSolutionPosts();
      return reply.code(202).send({ status: 'ACCEPTED', cron: POST_CRON, timezone: POST_TIMEZONE });
    });
    scoped.post('/admin/solutions/generate', async req => {
      const body = z.object({ accountId: z.string().min(1), runId: z.string().min(1) }).strict().parse(req.body);
      const post = await generateForRun(body.accountId, body.runId);
      return { id: post.id, status: post.status, lastError: post.lastError };
    });
    // Keys are write-only: callers receive only masked slots and the active position.
    scoped.get('/admin/solutions/api-keys', async () => solutionKeyPoolStatus());
    scoped.post('/admin/solutions/api-keys', async req => {
      const { apiKeys } = z.object({ apiKeys: z.string().min(1).max(52000) }).strict().parse(req.body);
      const result = await appendSolutionApiKeys(apiKeys);
      const status = await solutionKeyPoolStatus();
      if (status.active) await resetFailedSolutionPostRetries();
      return { added: result.added, duplicates: result.duplicates, ...status };
    });
    scoped.post('/admin/solutions/api-keys/test', async req => {
      const body = z.object({ apiKey: z.string().min(8).max(512).optional(),
        model: z.enum(['gpt-5.6-terra', 'gpt-5.6-luna', 'gemini-3.7-flash', 'gemini-3.8-flash', 'qwen/qwen3.8-27b']).optional(),
      }).strict().parse(req.body ?? {});
      return testSolutionApiKey(body.apiKey, body.model);
    });
    scoped.post('/admin/solutions/openrouter/free-test', async req => {
      const { apiKey } = z.object({ apiKey: z.string().regex(/^sk-or-v1-[A-Za-z0-9]{64}$/) })
        .strict().parse(req.body ?? {});
      const model = 'nvidia/nemotron-3-ultra-550b-a55b:free';
      const maskedKey = `${apiKey.slice(0, 10)}…${apiKey.slice(-4)}`;
      try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with exactly OPENROUTER_RENDER_OK.' }],
            max_tokens: 512, temperature: 0 }),
          signal: AbortSignal.timeout(45000),
        });
        const raw = await response.text();
        let data: any = {};
        try { data = JSON.parse(raw); } catch {}
        const content = data.choices?.[0]?.message?.content;
        const cost = data.usage?.cost ?? data.usage?.total_cost ?? null;
        return { ok: response.ok && typeof content === 'string' && content.trim().length > 0,
          executionHost: process.env.RENDER_INSTANCE_ID ? 'render' : 'local', status: response.status,
          keyMasked: maskedKey, requestedModel: model, servedModel: data.model ?? null,
          provider: data.provider ?? null, finishReason: data.choices?.[0]?.finish_reason ?? null,
          replyReceived: typeof content === 'string' && content.trim().length > 0,
          reportedCostUsd: cost,
          ...(response.ok ? {} : { error: String(data.error?.message ?? `HTTP_${response.status}`).replaceAll(apiKey, '[REDACTED]').slice(0, 300) }),
        };
      } catch {
        return { ok: false, executionHost: process.env.RENDER_INSTANCE_ID ? 'render' : 'local',
          status: 0, keyMasked: maskedKey, requestedModel: model, error: 'OPENROUTER_REQUEST_FAILED' };
      }
    });
    // A fixed provider origin prevents this authenticated diagnostic from becoming a general proxy.
    scoped.post('/admin/solutions/oxion/test', async req => {
      const body = z.object({ apiKey: z.string().regex(/^cc_[A-Za-z0-9_-]{16,128}$/),
        model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/).optional(),
        structured: z.boolean().default(false), maxTokens: z.union([z.literal(128), z.literal(512)]).default(128),
      }).strict().parse(req.body ?? {});
      return probeOxion(body.apiKey, body.model, body.structured, body.maxTokens);
    });
    scoped.post('/admin/solutions/experiential/test', async req => {
      const body = z.object({ apiKey: z.string().regex(/^xpl_[A-Za-z0-9_-]{16,128}$/),
        model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/).optional(),
      }).strict().parse(req.body ?? {});
      return probeExperiential(body.apiKey, body.model);
    });
    scoped.post('/admin/solutions/bazaarlink/free-test', async req => {
      const body = z.object({ apiKey: z.string().regex(/^sk-bl-[A-Za-z0-9_-]{16,128}$/) })
        .strict().parse(req.body ?? {});
      return probeBazaarLink(body.apiKey);
    });
    scoped.get('/admin/solutions/:id', async req => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const post = await prisma.solutionPost.findUniqueOrThrow({ where: { id } });
      // The context contains source/problem only, but keep it internal rather than exposing it unnecessarily.
      const { context: _context, leaseUntil: _lease, ...preview } = post;
      return preview;
    });
    scoped.post('/admin/solutions/:id/retry', async req => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const post = await retryPost(id); return { id, status: post.status, lastError: post.lastError };
    });
    scoped.post('/admin/solutions/:id/approve', async req => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const { contentHash } = z.object({ contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(req.body);
      const post = await approvePost(id, contentHash); return { id, status: post.status };
    });
    scoped.post('/admin/solutions/:id/publish', async req => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const post = await publishPost(id); return { id, status: post.status, url: post.publishedUrl, lastError: post.lastError };
    });
    scoped.post('/admin/solutions/:id/reconcile', async req => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const { url } = z.object({ url: z.string().url() }).strict().parse(req.body);
      const post = await reconcilePost(id, url); return { id, status: post.status, url: post.publishedUrl };
    });
  });
}
