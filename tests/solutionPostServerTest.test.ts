import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ rows: new Map<string, string>(), generate: vi.fn(), approve: vi.fn(), publish: vi.fn(),
  submit: vi.fn(), awaitSubmission: vi.fn(), loadContext: vi.fn(), rewrite: vi.fn(), post: null as any, release: vi.fn(), lease: vi.fn(),
  run: { accountId: 'a', problemSlug: 'example', state: 'SUCCESS', submissionStatus: 'Accepted', submissionId: '123' } }));
vi.mock('../src/database/prisma', () => ({ prisma: {
  account: { findUniqueOrThrow: async () => ({ id: 'a', status: 'ACTIVE' }) },
  dailyRun: { findUniqueOrThrow: async () => h.run },
  solutionPost: { findUniqueOrThrow: async () => h.post, findUnique: async () => h.post },
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
  loadContext: h.loadContext, createPostRouter: async () => ({}),
  withAccount: async (_account: unknown, action: Function) => action({ submitSolution: h.submit, awaitSubmission: h.awaitSubmission }, null, 'alice'),
  PostError: class extends Error { constructor(public code: string) { super(code); } } }));
vi.mock('../src/solutionPosts/implementation', async orig => ({ ...(await orig() as object), generateImplementation: h.rewrite }));
vi.mock('../src/solutionPosts/store', () => ({ approvePost: h.approve }));
vi.mock('../src/solutionPosts/publisher', async orig => ({ ...(await orig() as object), publishPost: h.publish }));
vi.mock('../src/solutionPosts/dailyPublication', () => ({ publishDailyPost: h.publish, dailyPublicationStatus: vi.fn() }));
vi.mock('../src/solutionPosts/scheduler', () => ({ acquireDailyLease: h.lease }));
import { configureServerTest, readServerTest, startServerTest, TEST_CONTROL_KEY } from '../src/solutionPosts/serverTest';
import { hash } from '../src/solutionPosts/article';

beforeEach(() => {
  vi.clearAllMocks(); h.rows.clear(); h.post = null;
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
it('reflects a positively reconciled publication without replaying its request', async () => {
  h.rows.set('solution-post-server-test:job:reconciled', JSON.stringify({ status: 'FAILED', postStatus: 'PUBLISHING', postId: 'post' }));
  h.post = { status: 'PUBLISHED', publishedUrl: 'https://leetcode.com/result', publishedAt: new Date() };
  expect(await readServerTest('reconciled')).toMatchObject({ status: 'PUBLISHED', postStatus: 'PUBLISHED', url: h.post.publishedUrl });
  expect(h.publish).not.toHaveBeenCalled();
});
it('judges exactly the reviewed draft code once and records both measurements', async () => {
  await configureServerTest('a');
  const original = 'class Solution { /* original */ };';
  const implementation = 'class Solution { public: int count() { return 1; } };';
  const title = 'Count the single element';
  const markdown = '```cpp\n' + implementation + '\n```\n';
  const context = { accountId: 'a', username: 'alice', slug: 'example', problemId: '12', title: 'Example',
    difficulty: 'Easy', problem: 'An example problem.', submissionId: '123', code: original, language: 'cpp',
    challengeDate: '2026-11-11', articleImplementation: { code: implementation, approach: 'Return the only count.' } };
  h.post = { id: 'post', accountId: 'a', problemSlug: 'example', submissionId: '123', status: 'AWAITING_APPROVAL',
    title, markdown, context: JSON.stringify(context), contentHash: hash(`${title}\n${markdown}`), codeHash: hash(original) };
  h.submit.mockResolvedValue('456');
  h.awaitSubmission.mockResolvedValueOnce({ classification: 'ACCEPTED', submissionId: '123', runtime: '8 ms', memory: '15 MB' })
    .mockResolvedValueOnce({ classification: 'ACCEPTED', submissionId: '456', runtime: '4 ms', memory: '14 MB' });
  const job = await startServerTest('run', 'manual', 'judge');
  await vi.waitFor(async () => expect(await readServerTest(job.id)).toMatchObject({
    status: 'ACCEPTED', submissionId: '456', implementationSource: 'reviewed_draft', implementationHash: hash(implementation),
    baseline: { runtime: '8 ms', memory: '15 MB' }, verdict: { runtime: '4 ms', memory: '14 MB' },
  }));
  expect(h.submit).toHaveBeenCalledOnce();
  expect(h.submit).toHaveBeenCalledWith({ slug: 'example', questionId: '12', lang: 'cpp', code: implementation });
  expect(h.generate).not.toHaveBeenCalled(); expect(h.approve).not.toHaveBeenCalled(); expect(h.publish).not.toHaveBeenCalled();
});
it('uses the implementation generator when the article draft is still in progress', async () => {
  await configureServerTest('a');
  h.post = { id: 'post', status: 'GENERATING', submissionId: '123' };
  const context = { accountId: 'a', username: 'alice', slug: 'example', problemId: '12', submissionId: '123', language: 'cpp' };
  h.loadContext.mockResolvedValue(context);
  h.rewrite.mockResolvedValue({ value: { code: 'reviewed source' } });
  h.submit.mockResolvedValue('456');
  h.awaitSubmission.mockResolvedValue({ classification: 'ACCEPTED' });
  const job = await startServerTest('run', 'manual', 'judge');
  await vi.waitFor(async () => expect(await readServerTest(job.id)).toMatchObject({ status: 'ACCEPTED', implementationSource: 'server_generator' }));
  expect(h.rewrite).toHaveBeenCalledWith({}, context, [], expect.any(Function));
  expect(h.submit).toHaveBeenCalledWith({ slug: 'example', questionId: '12', lang: 'cpp', code: 'reviewed source' });
  expect(h.generate).not.toHaveBeenCalled(); expect(h.publish).not.toHaveBeenCalled();
});
