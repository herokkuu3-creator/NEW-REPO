import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ states: new Map<string, string>(), posts: new Map<string, any>(), publish: vi.fn() }));
vi.mock('../src/database/prisma', () => ({ prisma: {
  solutionPost: { findUniqueOrThrow: async ({ where }: any) => ({ ...h.posts.get(where.id) }) },
  systemState: {
    findUnique: async ({ where }: any) => h.states.has(where.key) ? { key: where.key, value: h.states.get(where.key) } : null,
    findMany: async ({ where }: any) => [...h.states].filter(([key]) => key.startsWith(where.key.startsWith)).map(([key, value]) => ({ key, value })),
    create: async ({ data }: any) => { if (h.states.has(data.key)) throw Object.assign(Error(), { code: 'P2002' }); h.states.set(data.key, data.value); },
    updateMany: async ({ where, data }: any) => {
      if (h.states.get(where.key) !== where.value) return { count: 0 };
      h.states.set(where.key, data.value); return { count: 1 };
    },
    upsert: async ({ where, create, update }: any) => {
      if (!h.states.has(where.key)) h.states.set(where.key, create.value);
      else if (update.value) h.states.set(where.key, update.value);
    },
    deleteMany: async ({ where }: any) => { h.states.delete(where.key); },
  },
} }));
vi.mock('../src/solutionPosts/publisher', () => ({ publishPost: h.publish }));
import { publishDailyPost, processDailyPublicationQueue, dailyPublicationStatus, DAILY_PUBLICATION_GAP_MS } from '../src/solutionPosts/dailyPublication';
import { postPresentationVariant } from '../src/solutionPosts/presentationStyles';
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-06T00:00:00Z'));
  h.states.clear(); h.posts.clear(); vi.clearAllMocks();
  for (const id of ['a', 'b']) h.posts.set(id, { id, status: 'DRAFT_READY', approvedHash: 'approved', context: JSON.stringify({
    accountId: id, username: id, problemId: '1', slug: 'example', title: 'Example', difficulty: 'Easy', problem: 'Example problem',
    submissionId: '1', language: 'cpp', code: 'original code', challengeDate: '2026-11-06',
    articleImplementation: { code: 'rewritten code', approach: 'Use a direct calculation.' }, presentation: postPresentationVariant(0, 0),
  }) });
  h.publish.mockImplementation(async (id: string) => {
    const post = { ...h.posts.get(id), status: 'PUBLISHED', publishedAt: new Date(), publishedUrl: 'https://leetcode.com/' + id };
    h.posts.set(id, post); return post;
  });
});
afterEach(() => vi.useRealTimers());
it('takes a stale draft out of the queue without using a publication slot', async () => {
  const post = h.posts.get('a');
  post.context = JSON.stringify({ ...JSON.parse(post.context), presentation: undefined });
  expect((await publishDailyPost('a')).lastError).toBe('ARTICLE_LAYOUT_REFRESH_REQUIRED');
  expect(h.publish).not.toHaveBeenCalled();
  expect((await publishDailyPost('b')).status).toBe('PUBLISHED');
});
it('queues the second account and publishes only after a full 20-minute gap', async () => {
  expect((await publishDailyPost('a')).status).toBe('PUBLISHED');
  expect((await publishDailyPost('b')).lastError).toBe('DAILY_PUBLICATION_COOLDOWN');
  vi.setSystemTime(Date.now() + DAILY_PUBLICATION_GAP_MS - 1);
  await processDailyPublicationQueue(); expect(h.publish).toHaveBeenCalledTimes(1);
  vi.setSystemTime(Date.now() + 1);
  await processDailyPublicationQueue(); expect(h.publish).toHaveBeenCalledTimes(2);
  expect(h.posts.get('b').publishedAt - h.posts.get('a').publishedAt).toBe(DAILY_PUBLICATION_GAP_MS);
});
it('retains the gap after the queue module restarts', async () => {
  await publishDailyPost('a'); await publishDailyPost('b');
  vi.resetModules();
  const restarted = await import('../src/solutionPosts/dailyPublication');
  await restarted.processDailyPublicationQueue(); expect(h.publish).toHaveBeenCalledTimes(1);
  expect(await restarted.dailyPublicationStatus()).toMatchObject({ lastPostId: 'a', minimumGapMs: 1200000 });
});
it('serializes concurrent replicas and does not replay an uncertain publication', async () => {
  const results = await Promise.all([publishDailyPost('a'), publishDailyPost('b')]);
  expect(results.filter(p => p.status === 'PUBLISHED')).toHaveLength(1);
  expect(h.publish).toHaveBeenCalledTimes(1);
  vi.setSystemTime(Date.now() + DAILY_PUBLICATION_GAP_MS);
  h.publish.mockImplementationOnce(async () => ({ id: 'b', status: 'PUBLISHING' }));
  await publishDailyPost('b');
  expect((await dailyPublicationStatus()).nextEligibleAt).toBe(new Date(Date.now() + DAILY_PUBLICATION_GAP_MS).toISOString());
});
it('preserves the reservation when a post-request database failure prevents saving the outcome', async () => {
  h.publish.mockImplementationOnce(async () => {
    h.posts.set('a', { id: 'a', status: 'PUBLISHING' });
    throw Error('database unavailable after mutation');
  });
  await expect(publishDailyPost('a')).rejects.toThrow('database unavailable');
  expect((await dailyPublicationStatus()).nextEligibleAt).toBe(new Date(Date.now() + 30 * 60 * 1000).toISOString());
  vi.setSystemTime(Date.now() + DAILY_PUBLICATION_GAP_MS);
  expect((await publishDailyPost('b')).lastError).toBe('DAILY_PUBLICATION_COOLDOWN');
  expect(h.publish).toHaveBeenCalledTimes(1);
});
