import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ rows: new Map<string, string>(), generate: vi.fn(), approve: vi.fn(), publish: vi.fn(),
  release: vi.fn(), lease: vi.fn(), run: { accountId: 'a', state: 'SUCCESS', submissionStatus: 'Accepted', submissionId: '123' } }));
vi.mock('../src/database/prisma', () => ({ prisma: {
  account: { findUniqueOrThrow: async () => ({ id: 'a', status: 'ACTIVE' }) },
  dailyRun: { findUniqueOrThrow: async () => h.run },
  systemState: {
    findUnique: async ({ where }: any) => h.rows.has(where.key) ? { value: h.rows.get(where.key) } : null,
    findUniqueOrThrow: async ({ where }: any) => ({ value: h.rows.get(where.key) }),
    create: async ({ data }: any) => { if (h.rows.has(data.key)) throw Error('duplicate'); h.rows.set(data.key, data.value); },
    upsert: async ({ where, create, update }: any) => h.rows.set(where.key, h.rows.has(where.key) ? update.value : create.value),
    updateMany: async ({ where, data }: any) => {
      if (h.rows.get(where.key) !== where.value) return { count: 0 };
      h.rows.set(where.key, data.value); return { count: 1 };
    },
    deleteMany: async ({ where }: any) => { h.rows.delete(where.key); return { count: 1 }; },
  },
} }));
vi.mock('../src/solutionPosts/service', () => ({ generateForRun: h.generate,
  PostError: class extends Error { constructor(public code: string) { super(code); } } }));
vi.mock('../src/solutionPosts/store', () => ({ approvePost: h.approve }));
vi.mock('../src/solutionPosts/publisher', () => ({ publishPost: h.publish }));
vi.mock('../src/solutionPosts/dailyPublication', () => ({ publishDailyPost: h.publish, dailyPublicationStatus: vi.fn() }));
vi.mock('../src/solutionPosts/scheduler', () => ({ acquireDailyLease: h.lease }));
import { configureServerTest, readServerTest, startServerTest, TEST_CONTROL_KEY } from '../src/solutionPosts/serverTest';

beforeEach(() => {
  vi.clearAllMocks(); h.rows.clear();
  h.run.accountId = 'a';
  vi.stubEnv('RENDER_INSTANCE_ID', 'test-render'); vi.stubEnv('RENDER_GIT_COMMIT', 'revision');
  h.lease.mockResolvedValue(h.release);
  h.release.mockResolvedValue(undefined);
  h.generate.mockResolvedValue({ id: 'post', status: 'AWAITING_APPROVAL', contentHash: 'hash' });
  h.approve.mockResolvedValue({ id: 'post', status: 'DRAFT_READY' });
  h.publish.mockResolvedValue({ id: 'post', status: 'PUBLISHED', publishedUrl: 'https://leetcode.com/result', lastError: null });
});
afterEach(() => vi.unstubAllEnvs());
it('is disabled by default and rejects non-Render execution', async () => {
  await expect(startServerTest('run')).rejects.toThrow('SERVER_TEST_DISABLED');
  vi.stubEnv('RENDER_INSTANCE_ID', '');
  await expect(startServerTest('run')).rejects.toThrow('RENDER_SERVER_REQUIRED');
  expect(h.generate).not.toHaveBeenCalled();
});
it('runs generation, hash approval, and publication on the server with a durable result', async () => {
  await configureServerTest('a');
  const job = await startServerTest('run');
  await vi.waitFor(async () => expect((await readServerTest(job.id)).status).toBe('PUBLISHED'));
  expect(h.generate).toHaveBeenCalledWith('a', 'run', true);
  expect(h.approve).toHaveBeenCalledWith('post', 'hash'); expect(h.publish).toHaveBeenCalledWith('post');
  expect(await readServerTest(job.id)).toMatchObject({ executionHost: 'render', revision: 'revision', url: 'https://leetcode.com/result' });
  await vi.waitFor(() => expect(h.release).toHaveBeenCalled());
  await vi.waitFor(() => expect(JSON.parse(h.rows.get(TEST_CONTROL_KEY)!).active).toBeUndefined());
  await configureServerTest(null); expect(h.rows.has(TEST_CONTROL_KEY)).toBe(false);
});
it('expires and restricts execution to the enabled account', async () => {
  await configureServerTest('a'); h.run.accountId = 'b';
  await expect(startServerTest('run')).rejects.toThrow('ACCEPTED_SUBMISSION_REQUIRED');
  h.rows.set(TEST_CONTROL_KEY, JSON.stringify({ accountId: 'a', until: 0 }));
  await expect(startServerTest('run')).rejects.toThrow('SERVER_TEST_DISABLED');
  expect(h.generate).not.toHaveBeenCalled();
});
it('allows only one concurrent test and never publishes a rejected draft', async () => {
  await configureServerTest('a');
  let finish!: (post: unknown) => void;
  h.generate.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const job = await startServerTest('run');
  await expect(startServerTest('run')).rejects.toThrow('SERVER_TEST_IN_PROGRESS');
  finish({ id: 'post', status: 'FAILED', lastError: 'TECHNICAL_REVIEW_FAILED' });
  await vi.waitFor(async () => expect((await readServerTest(job.id)).status).toBe('FAILED'));
  expect(h.approve).not.toHaveBeenCalled(); expect(h.publish).not.toHaveBeenCalled();
});
