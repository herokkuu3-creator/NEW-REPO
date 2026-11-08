import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { checkRangeAccess, registerRangeDiagnostics } from '../src/scheduler/rangeDiagnostics';
import { LeetCodeHttpError } from '../src/leetcode/apiClient';
it('checks the real range interfaces without ever submitting and closes its session', async () => {
  const submit = vi.fn(); const close = vi.fn();
  const api = { submit, checkSession: async () => ({ authenticated: true, username: 'alice' }), question: vi.fn(async () => ({ slug: 'example' })) };
  const deps = { getAccount: async () => ({ status: 'ACTIVE', username: 'alice' }), openSession: async () => ({ api, close }) } as any;
  expect(await checkRangeAccess('a', 'example', deps)).toMatchObject({ authenticated: true, questionReadable: true });
  api.question.mockRejectedValueOnce(new LeetCodeHttpError('GraphQL HTTP 429', 429));
  expect(await checkRangeAccess('a', 'example', deps)).toMatchObject({ category: 'rate-limit', questionReadable: false });
  expect(submit).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(2);
});
it('rejects unauthenticated or malformed diagnostic requests', async () => {
  const app = Fastify(); registerRangeDiagnostics(app, header => header === 'Bearer test');
  expect((await app.inject({ method: 'POST', url: '/admin/range/access-check', payload: {} })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: '/admin/range/access-check', headers: { authorization: 'Bearer test' }, payload: { accountId: 'a', slug: 'https://other.test' } })).statusCode).toBe(400);
  await app.close();
});
