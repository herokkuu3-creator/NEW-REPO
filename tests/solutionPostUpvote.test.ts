import { describe, expect, it, vi, beforeEach } from 'vitest';
import { extractTopicIdFromUrl, scheduleSolutionArticleUpvotes } from '../src/solutionPosts/upvote';

vi.mock('../src/database/prisma', () => ({
  prisma: {
    account: {
      findMany: vi.fn(),
    },
    systemState: {
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock('../src/notifications/telegram', () => ({
  sendTelegramMessage: vi.fn(async () => undefined),
}));

import { prisma } from '../src/database/prisma';

describe('extractTopicIdFromUrl', () => {
  it('extracts topic id correctly from LeetCode solution URLs', () => {
    expect(extractTopicIdFromUrl('https://leetcode.com/problems/two-sum/solutions/123456/best-hashmap-solution/')).toBe(123456);
    expect(extractTopicIdFromUrl('/problems/two-sum/solutions/987654/title/')).toBe(987654);
    expect(extractTopicIdFromUrl('invalid-url')).toBeNull();
    expect(extractTopicIdFromUrl('https://leetcode.com/problems/two-sum/description/')).toBeNull();
  });
});

describe('scheduleSolutionArticleUpvotes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips scheduling when publishedUrl is absent', async () => {
    const res = await scheduleSolutionArticleUpvotes({
      id: 'post-1',
      publishedUrl: null,
      accountId: 'acc-1',
      problemSlug: 'two-sum',
    });
    expect(res.scheduled).toBe(false);
    expect(res.count).toBe(0);
  });

  it('skips scheduling when no other accounts exist', async () => {
    vi.mocked(prisma.account.findMany).mockResolvedValueOnce([]);
    const res = await scheduleSolutionArticleUpvotes({
      id: 'post-1',
      publishedUrl: 'https://leetcode.com/problems/two-sum/solutions/123456/my-post/',
      accountId: 'acc-1',
      problemSlug: 'two-sum',
    });
    expect(res.scheduled).toBe(false);
    expect(res.count).toBe(0);
  });

  it('persists scheduled job state when other accounts exist', async () => {
    vi.mocked(prisma.account.findMany).mockResolvedValueOnce([
      { id: 'acc-2', label: 'second_acc', status: 'ACTIVE' } as any,
      { id: 'acc-3', label: 'third_acc', status: 'ACTIVE' } as any,
    ]);

    const res = await scheduleSolutionArticleUpvotes(
      {
        id: 'post-1',
        publishedUrl: 'https://leetcode.com/problems/two-sum/solutions/123456/my-post/',
        accountId: 'acc-1',
        problemSlug: 'two-sum',
      },
      { initialDelayMs: 0, accountGapMs: 0 },
    );

    expect(res.scheduled).toBe(true);
    expect(res.count).toBe(2);
    expect(prisma.systemState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: 'solution-post-upvotes:post-1' },
      }),
    );
  });
});
