import Fastify from 'fastify';
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ rows: new Map<string, string>(), start: vi.fn(), current: vi.fn() }));
vi.mock('../src/database/prisma', () => ({ prisma: { systemState: {
  findUnique: async ({ where }: any) => h.rows.has(where.key) ? { value: h.rows.get(where.key) } : null,
  create: async ({ data }: any) => { if (h.rows.has(data.key)) throw Error('duplicate'); h.rows.set(data.key, data.value); },
  updateMany: async ({ where, data }: any) => { if (h.rows.get(where.key) !== where.value) return { count: 0 }; h.rows.set(where.key, data.value); return { count: 1 }; },
} } }));
vi.mock('../src/scheduler/rangeSubmission', () => ({ startRangeJob: h.start, currentRangeJob: h.current, defaultRangeDeps: () => ({}) }));
import { registerRangeDiagnostics } from '../src/scheduler/rangeDiagnostics';
beforeEach(() => { vi.clearAllMocks(); h.rows.clear(); h.current.mockReturnValue(null); vi.stubEnv('RENDER_INSTANCE_ID', 'render'); });
it('runs exactly one range question on the server and reads retries by UUID without submitting twice', async () => {
  const app = Fastify(); registerRangeDiagnostics(app, header => header === 'Bearer test');
  h.start.mockResolvedValue({ started: true, done: Promise.resolve([{ label: 'a', results: [{ number: 1572, status: 'accepted', submissionId: '123', capture: { code: 'private source' } }] }]) });
  const payload = { requestId: '00000000-0000-4000-8000-000000000001', accountId: 'a', questionNumber: 1572 };
  const post = () => app.inject({ method: 'POST', url: '/admin/range/server-tests', headers: { authorization: 'Bearer test' }, payload });
  expect((await post()).statusCode).toBe(202);
  await vi.waitFor(() => expect([...h.rows.values()][0]).toContain('ACCEPTED'));
  const retry = await post(); expect(retry.json().status).toBe('ACCEPTED');
  expect(h.start).toHaveBeenCalledTimes(1); expect(h.start).toHaveBeenCalledWith({ from: 1572, to: 1572 }, 'a', {});
  expect(retry.body).not.toContain('private source');
  expect((await app.inject({ method: 'GET', url: '/admin/range/server-tests/' + payload.requestId })).statusCode).toBe(401);
  await app.close(); vi.unstubAllEnvs();
});
it('does not start a test during another range job or on the local host', async () => {
  const app = Fastify(); registerRangeDiagnostics(app, () => true);
  const request = () => app.inject({ method: 'POST', url: '/admin/range/server-tests', payload: { requestId: '00000000-0000-4000-8000-000000000002', accountId: 'a', questionNumber: 1572 } });
  h.current.mockReturnValue({}); expect((await request()).json().error).toBe('RANGE_ALREADY_RUNNING');
  vi.stubEnv('RENDER_INSTANCE_ID', ''); expect((await request()).json().error).toBe('RENDER_SERVER_REQUIRED');
  expect(h.start).not.toHaveBeenCalled(); await app.close(); vi.unstubAllEnvs();
});
