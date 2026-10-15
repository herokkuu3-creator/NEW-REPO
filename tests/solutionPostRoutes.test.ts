import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ schedule: vi.fn(async ids => ({ accountIds: ids, timezone: 'Asia/Kolkata' })) }));
const keys = vi.hoisted(() => ({
  append: vi.fn(async () => ({ added: 2, duplicates: 1 })),
  status: vi.fn(async () => ({ total: 3, active: 2, source: 'database', keys: [
    { position: 1, masked: 'cc_old…0001', active: false }, { position: 2, masked: 'cc_new…0002', active: true },
    { position: 3, masked: 'cc_last…0003', active: false },
  ] })),
}));
vi.mock('../src/database/prisma', () => ({ prisma: { solutionPost: { findMany: vi.fn(async () => []) } } }));
vi.mock('../src/solutionPosts/service', () => ({ generateForRun: vi.fn(), retryPost: vi.fn(), PostError: class extends Error {} }));
vi.mock('../src/solutionPosts/store', () => ({ approvePost: vi.fn() }));
vi.mock('../src/solutionPosts/publisher', () => ({ publishPost: vi.fn(), reconcilePost: vi.fn() }));
vi.mock('../src/solutionPosts/scheduler', () => ({ setSelectedAccounts: h.schedule, runCombined: vi.fn(), POST_CRON: '0 6 * * *', POST_TIMEZONE: 'Asia/Kolkata' }));
vi.mock('../src/solutionPosts/keyPool', () => ({ appendSolutionApiKeys: keys.append, solutionKeyPoolStatus: keys.status }));
import { registerSolutionPostRoutes } from '../src/solutionPosts/routes';
describe('solution admin routes', () => {
  it('requires the existing admin bearer token for reads and mutations', async () => {
    const app = Fastify(); registerSolutionPostRoutes(app, h => h === 'Bearer admin-test');
    for (const [method, url] of [['GET', '/admin/solutions'], ['PUT', '/admin/solutions/schedule'], ['POST', '/admin/solutions/generate']]) {
      const response = await app.inject({ method: method as any, url }); expect(response.statusCode).toBe(401);
    }
    const history = await app.inject({ method: 'GET', url: '/admin/solutions', headers: { authorization: 'Bearer admin-test' } });
    expect(history.statusCode).toBe(200); expect(history.headers['cache-control']).toBe('no-store');
    await app.close();
  });
  it('validates explicit selections and rejects extra publishing flags', async () => {
    const app = Fastify(); registerSolutionPostRoutes(app, h => h === 'Bearer admin-test');
    const request = (payload: object) => app.inject({ method: 'PUT', url: '/admin/solutions/schedule',
      headers: { authorization: 'Bearer admin-test' }, payload });
    expect((await request({ accountIds: ['a'], publishAutomatically: true })).statusCode).toBe(400);
    expect((await request({ accountIds: ['a'] })).statusCode).toBe(200);
    expect(h.schedule).toHaveBeenCalledWith(['a']); await app.close();
  });
  it('adds article API keys without returning plaintext secrets', async () => {
    const app = Fastify(); registerSolutionPostRoutes(app, h => h === 'Bearer admin-test');
    const headers = { authorization: 'Bearer admin-test' };
    expect((await app.inject({ method: 'POST', url: '/admin/solutions/api-keys', headers,
      payload: { apiKeys: 'cc_secret_one,cc_secret_two' } })).statusCode).toBe(200);
    expect(keys.append).toHaveBeenCalledWith('cc_secret_one,cc_secret_two');
    const status = await app.inject({ method: 'GET', url: '/admin/solutions/api-keys', headers });
    expect(status.statusCode).toBe(200); expect(status.body).toContain('cc_old…0001');
    expect(status.body).not.toContain('cc_secret_one');
    expect((await app.inject({ method: 'POST', url: '/admin/solutions/api-keys', headers,
      payload: { apiKeys: '', extra: true } })).statusCode).toBe(400);
    await app.close();
  });
});
