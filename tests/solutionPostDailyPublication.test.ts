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
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-06T00:00:00Z'));
  h.states.clear(); h.posts.clear(); vi.clearAllMocks();
  for (const id of ['a', 'b']) h.posts.set(id, { id, status: 'DRAFT_READY', approvedHash: 'approved' });
  h.publish.mockImplementation(async (id: string) => {
    const post = { ...h.posts.get(id), status: 'PUBLISHED', publishedAt: new Date(), publishedUrl: 'https://leetcode.com/' + id };
    h.posts.set(id, post); return post;
  });
});
afterEach(() => vi.useRealTimers());
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
