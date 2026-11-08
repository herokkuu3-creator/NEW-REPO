import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentRangeJob, defaultRangeDeps, RangeDeps, startRangeJob } from './rangeSubmission';
import { leetCodeRequestFailure } from '../leetcode/apiClient';
import { prisma } from '../database/prisma';
import { logger } from '../logger';

/** Read the same session/question endpoints as a range job, without submitting. */
export async function checkRangeAccess(accountId: string, slug: string, deps: RangeDeps = defaultRangeDeps()) {
  const account = await deps.getAccount(accountId);
  if (!account || account.status !== 'ACTIVE') throw Error('ACCOUNT_UNAVAILABLE');
  const session = await deps.openSession(account);
  try {
    const identity = await session.api.checkSession();
    if (!identity.authenticated || !identity.username || (account.username && identity.username.toLowerCase() !== account.username.toLowerCase())) {
      return { accountId, authenticated: false, category: 'session-auth', questionReadable: false };
    }
    try {
      const question = await session.api.question(slug);
      return { accountId, username: identity.username, authenticated: true, questionReadable: question.slug === slug, category: 'ok' };
    } catch (error) { return { accountId, authenticated: true, questionReadable: false, ...leetCodeRequestFailure(error) }; }
  } finally { await session.close(); }
}
export function registerRangeDiagnostics(app: FastifyInstance, authorize: (header: string | undefined) => boolean) {
  // Explicit one-question production test. A caller-supplied UUID makes client
  // retries read the same job instead of sending another submission.
  app.post('/admin/range/server-tests', async (req, reply) => {
    if (!authorize(req.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
    if (!process.env.RENDER_INSTANCE_ID) return reply.code(409).send({ error: 'RENDER_SERVER_REQUIRED' });
    const parsed = z.object({ requestId: z.string().uuid(), accountId: z.string().min(1), questionNumber: z.number().int().min(1).max(9999) }).strict().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_REQUEST' });
    const { requestId, accountId, questionNumber } = parsed.data;
    const key = `range-server-test:${requestId}`;
    const previous = await prisma.systemState.findUnique({ where: { key } });
    if (previous) return JSON.parse(previous.value);
    if (currentRangeJob()) return reply.code(409).send({ error: 'RANGE_ALREADY_RUNNING' });
    const job = { requestId, accountId, questionNumber, executionHost: 'render', revision: process.env.RENDER_GIT_COMMIT ?? null,
      status: 'RUNNING', startedAt: new Date().toISOString() };
    try { await prisma.systemState.create({ data: { key, value: JSON.stringify(job) } }); }
    catch { return reply.code(409).send({ error: 'TEST_ALREADY_CLAIMED' }); }
    void (async () => {
      let result: object;
      try {
        const run = await startRangeJob({ from: questionNumber, to: questionNumber }, accountId, defaultRangeDeps(async () => {}));
        if (!run.started && !('queued' in run)) result = { status: 'FAILED', error: 'RANGE_NOT_STARTED' };
        else {
          const results = (await run.done).map(account => ({ ...account, results: account.results.map(({ capture: _source, ...outcome }) => outcome) }));
          result = { status: results.length === 1 && results[0]?.results[0]?.status === 'accepted' ? 'ACCEPTED' : 'FAILED', results };
        }
      } catch { result = { status: 'FAILED', error: 'SERVER_TEST_FAILED' }; }
      await prisma.systemState.updateMany({ where: { key, value: JSON.stringify(job) }, data: { value: JSON.stringify({ ...job, ...result, finishedAt: new Date().toISOString() }) } });
    })().catch(() => logger.warn({ requestId }, 'range server test result could not be saved'));
    return reply.code(202).send(job);
  });
  app.get('/admin/range/server-tests/:requestId', async (req, reply) => {
    if (!authorize(req.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = z.object({ requestId: z.string().uuid() }).safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_REQUEST' });
    const row = await prisma.systemState.findUnique({ where: { key: `range-server-test:${parsed.data.requestId}` } });
    return row ? JSON.parse(row.value) : reply.code(404).send({ error: 'TEST_NOT_FOUND' });
  });
  app.post('/admin/range/access-check', async (req, reply) => {
    if (!authorize(req.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = z.object({ accountId: z.string().min(1), slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) }).strict().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_REQUEST' });
    try { return { executionHost: process.env.RENDER_INSTANCE_ID ? 'render' : 'local', revision: process.env.RENDER_GIT_COMMIT ?? null,
      ...await checkRangeAccess(parsed.data.accountId, parsed.data.slug) }; }
    catch { return reply.code(409).send({ error: 'RANGE_ACCESS_CHECK_FAILED' }); }
  });
}
