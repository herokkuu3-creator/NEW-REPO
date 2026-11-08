import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { defaultRangeDeps, RangeDeps } from './rangeSubmission';
import { leetCodeRequestFailure } from '../leetcode/apiClient';

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
  app.post('/admin/range/access-check', async (req, reply) => {
    if (!authorize(req.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = z.object({ accountId: z.string().min(1), slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) }).strict().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_REQUEST' });
    try { return { executionHost: process.env.RENDER_INSTANCE_ID ? 'render' : 'local', revision: process.env.RENDER_GIT_COMMIT ?? null,
      ...await checkRangeAccess(parsed.data.accountId, parsed.data.slug) }; }
    catch { return reply.code(409).send({ error: 'RANGE_ACCESS_CHECK_FAILED' }); }
  });
}
