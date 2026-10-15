import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../database/prisma';
import { generateForRun, retryPost, PostError } from './service';
import { approvePost } from './store';
import { publishPost, reconcilePost } from './publisher';
import { runCombined, setSelectedAccounts, POST_CRON, POST_TIMEZONE } from './scheduler';
import { appendSolutionApiKeys, solutionKeyPoolStatus } from './keyPool';

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
      publishing: 'review-required', accounts: await prisma.solutionPostPreference.findMany({ where: { enabled: true } }) }));
    scoped.put('/admin/solutions/schedule', async req => {
      const body = z.object({ accountIds: z.array(z.string().min(1)).max(100) }).strict().parse(req.body);
      return setSelectedAccounts(body.accountIds);
    });
    scoped.post('/admin/solutions/daily', async req => {
      const body = z.object({ accountIds: z.array(z.string().min(1)).min(1).max(100) }).strict().parse(req.body);
      return runCombined(body.accountIds);
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
      return { added: result.added, duplicates: result.duplicates, ...status };
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
