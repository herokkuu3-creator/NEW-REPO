import { describe, expect, it, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  withAccount: vi.fn(),
}));

vi.mock('../src/database/prisma', () => ({
  prisma: {
    account: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    systemState: {
      findUnique: vi.fn(),
      upsert: vi.fn(async () => ({})),
      updateMany: vi.fn(),
    },
    solutionPost: {
      findMany: vi.fn(async () => []),
    },
  },
}));

vi.mock('../src/notifications/telegram', () => ({
  sendTelegramMessage: vi.fn(async () => true),
  sendTelegramMessageWithId: vi.fn(async () => 101),
  editTelegramMessage: vi.fn(async () => true),
}));

vi.mock('../src/solutionPosts/service', () => ({
  PostError: class extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  },
  withAccount: h.withAccount,
}));

import { prisma } from '../src/database/prisma';
import {
  extractTopicIdFromUrl,
  scheduleSolutionArticleUpvotes,
  upvoteArticleWithSession,
  UGC_ARTICLE_ADD_REACTION_MUTATION,
  boostSolutionArticleViews,
  fetchLiveSolutionMetrics,
} from '../src/solutionPosts/upvote';

describe('extractTopicIdFromUrl', () => {
  it('extracts topic id correctly from LeetCode solution URLs', () => {
    expect(
      extractTopicIdFromUrl('https://leetcode.com/problems/two-sum/solutions/8605202/lonely-server-filter-row-column-tallies-y9mtt/'),
    ).toBe(8605202);
    expect(extractTopicIdFromUrl('/problems/two-sum/solutions/987654/title/')).toBe(987654);
    expect(extractTopicIdFromUrl('invalid-url')).toBeNull();
    expect(extractTopicIdFromUrl('https://leetcode.com/problems/two-sum/description/')).toBeNull();
  });
});

describe('upvoteArticleWithSession', () => {
  it('casts upvote via GraphQL ugcArticleAddReaction and verifies myReactionType === UPVOTE', async () => {
    const graphql = vi
      .fn()
      // 1. Initial check: not yet upvoted
      .mockResolvedValueOnce({
        ugcArticleSolutionArticle: {
          uuid: '3b6g5b4v',
          topicId: 8605202,
          myReactionType: null,
          reactions: [{ count: 0, reactionType: 'UPVOTE' }],
        },
      })
      // 2. Mutation ugcArticleAddReaction
      .mockResolvedValueOnce({
        ugcArticleAddReaction: { ok: true },
      })
      // 3. Verification check: myReactionType is now UPVOTE and count is 1
      .mockResolvedValueOnce({
        ugcArticleSolutionArticle: {
          uuid: '3b6g5b4v',
          topicId: 8605202,
          myReactionType: 'UPVOTE',
          reactions: [{ count: 1, reactionType: 'UPVOTE' }],
        },
      });

    const res = await upvoteArticleWithSession({ graphql } as any, undefined, 8605202, undefined, 'watch_me_win');
    expect(res).toEqual({
      verified: true,
      alreadyUpvoted: false,
      upvoteCount: 1,
      username: 'watch_me_win',
      method: 'graphql_uuid',
    });
    expect(graphql).toHaveBeenCalledWith(
      UGC_ARTICLE_ADD_REACTION_MUTATION,
      { articleId: '3b6g5b4v', reactionType: 'UPVOTE' },
      expect.anything(),
    );
  });

  it('rejects unverified upvote when myReactionType remains null after mutation attempts', async () => {
    const graphql = vi.fn().mockResolvedValue({
      ugcArticleSolutionArticle: {
        uuid: '3b6g5b4v',
        topicId: 8605202,
        myReactionType: null,
        reactions: [{ count: 0, reactionType: 'UPVOTE' }],
      },
      ugcArticleAddReaction: { ok: true },
    });

    await expect(
      upvoteArticleWithSession({ graphql } as any, undefined, 8605202, undefined, 'watch_me_win'),
    ).rejects.toThrow('UPVOTE_NOT_VERIFIED_ON_LEETCODE');
  });
});

describe('scheduleSolutionArticleUpvotes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { ugcArticleSolutionArticle: { hitCount: 15 } } }),
      }),
    );
    vi.mocked(prisma.systemState.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.account.findFirst).mockResolvedValue(null);
  });

  it('skips scheduling when publishedUrl is absent', async () => {
    const res = await scheduleSolutionArticleUpvotes({
      id: 'post-missing-url',
      publishedUrl: null,
      accountId: 'acc-1',
      problemSlug: 'two-sum',
    });
    expect(res.scheduled).toBe(false);
    expect(res.count).toBe(0);
  });

  it('skips scheduling when no accounts exist', async () => {
    vi.mocked(prisma.account.findFirst).mockResolvedValueOnce(null);
    vi.mocked(prisma.account.findMany).mockResolvedValueOnce([]);
    const res = await scheduleSolutionArticleUpvotes({
      id: 'post-no-accounts',
      publishedUrl: 'https://leetcode.com/problems/two-sum/solutions/123456/my-post/',
      accountId: 'acc-1',
      problemSlug: 'two-sum',
    });
    expect(res.scheduled).toBe(false);
    expect(res.count).toBe(0);
  });

  it('upvotes immediately with author account and then verifies other accounts', async () => {
    vi.mocked(prisma.account.findFirst).mockResolvedValueOnce({
      id: 'acc-1',
      label: 'watch_me_win',
      username: 'watch_me_win',
      status: 'ACTIVE',
    } as any);
    vi.mocked(prisma.account.findMany).mockResolvedValueOnce([
      { id: 'acc-2', label: 'second_acc', username: 'second_acc', status: 'ACTIVE' } as any,
      { id: 'acc-3', label: 'third_acc', username: 'third_acc', status: 'ACTIVE' } as any,
    ]);

    let currentCount = 0;
    h.withAccount.mockImplementation(async (account: any, action: any) => {
      const api = {
        graphql: vi
          .fn()
          .mockResolvedValueOnce({
            ugcArticleSolutionArticle: {
              uuid: '3b6g5b4v',
              topicId: 123456,
              myReactionType: null,
              reactions: [{ count: currentCount, reactionType: 'UPVOTE' }],
            },
          })
          .mockResolvedValueOnce({
            ugcArticleAddReaction: { ok: true },
          })
          .mockImplementationOnce(async () => {
            currentCount += 1;
            return {
              ugcArticleSolutionArticle: {
                uuid: '3b6g5b4v',
                topicId: 123456,
                myReactionType: 'UPVOTE',
                reactions: [{ count: currentCount, reactionType: 'UPVOTE' }],
              },
            };
          }),
      };
      return action(api, undefined, account.username);
    });

    const res = await scheduleSolutionArticleUpvotes(
      {
        id: 'post-verified-all',
        publishedUrl: 'https://leetcode.com/problems/two-sum/solutions/123456/my-post/',
        accountId: 'acc-1',
        problemSlug: 'two-sum',
      },
      { initialDelayMs: 0, accountGapMs: 0 },
    );

    expect(res.scheduled).toBe(true);
    expect(res.count).toBe(2);

    // Wait for background async job to finish
    await new Promise((r) => setTimeout(r, 30));

    expect(h.withAccount).toHaveBeenCalledTimes(3); // 1 author + 2 other accounts
    const call = vi.mocked(prisma.systemState.updateMany).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ key: 'solution-post-upvotes:post-verified-all' });
    const saved = JSON.parse(String(call?.data?.value));
    expect(saved).toMatchObject({
      status: 'COMPLETED',
      verified: true,
      verifiedCount: 3,
      failedCount: 0,
      liveUpvoteCount: 3,
      totalViewsGenerated: 63,
    });
  });

  it('boosts solution article views across all accounts (at least 20+ views per account)', async () => {
    vi.mocked(prisma.account.findMany).mockResolvedValueOnce([
      { id: 'acc-1', label: 'acc1', username: 'acc1', status: 'ACTIVE', storageState: '{}' } as any,
      { id: 'acc-2', label: 'acc2', username: 'acc2', status: 'ACTIVE', storageState: '{}' } as any,
    ]);

    const res = await boostSolutionArticleViews(
      {
        id: 'post-boost',
        publishedUrl: 'https://leetcode.com/problems/two-sum/solutions/8603495/title/',
        topicId: 8603495,
        problemSlug: 'two-sum',
      },
      22,
    );

    expect(res.accountsProcessed).toBe(2);
    expect(res.totalViews).toBe(44);
    expect(prisma.systemState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: 'solution-post-views:post-boost' },
      }),
    );
  });
});

describe('fetchLiveSolutionMetrics', () => {
  it('retrieves live hitCount and upvotes accurately from LeetCode GraphQL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            ugcArticleSolutionArticle: {
              uuid: 'xJPIXDcb',
              topicId: 8603347,
              title: 'Clean Two Pointers',
              slug: 'clean-two-pointers',
              hitCount: 14,
              reactions: [{ count: 16, reactionType: 'UPVOTE' }],
            },
          },
        }),
      }),
    );

    const metrics = await fetchLiveSolutionMetrics(8603347);
    expect(metrics).toEqual({
      topicId: 8603347,
      hitCount: 14,
      upvotes: 16,
      uuid: 'xJPIXDcb',
      title: 'Clean Two Pointers',
      slug: 'clean-two-pointers',
    });
  });
});
