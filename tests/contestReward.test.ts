import { describe, expect, it, vi } from 'vitest';
import type { BrowserContext } from 'playwright';
import type { AccountRecord } from '../src/database/accounts';
import { claimContestReward, type ContestRewardApi } from '../src/leetcode/contestReward';
import { LeetCodeApi } from '../src/leetcode/apiClient';
import { buildCoinClaimPicker } from '../src/notifications/telegramBot';
import { formatOutcomeLine } from '../src/scheduler/report';

function account(id: string, label: string): AccountRecord {
  return { id, label, username: label, status: 'ACTIVE' } as unknown as AccountRecord;
}

function rewardApi(responses: unknown[]): ContestRewardApi & { graphql: ReturnType<typeof vi.fn> } {
  return { graphql: vi.fn(async () => responses.shift()) } as unknown as ContestRewardApi & {
    graphql: ReturnType<typeof vi.fn>;
  };
}

describe('LeetCode contest reward GraphQL flow', () => {
  it('does not mutate when the weekly reward is already collected', async () => {
    const api = rewardApi([{ isEasterEggCollected: true }]);
    await expect(claimContestReward(api, 'first')).resolves.toEqual({ offered: false, claimed: false });
    expect(api.graphql).toHaveBeenCalledTimes(1);
    expect(api.graphql.mock.calls[0]![0]).toContain('query easterEgg');
  });

  it('collects an available reward with the frontend mutation', async () => {
    const api = rewardApi([
      { isEasterEggCollected: false },
      { collectContestEasterEgg: { ok: true } },
    ]);
    await expect(claimContestReward(api, 'broZEdex')).resolves.toEqual({ offered: true, claimed: true });
    expect(api.graphql).toHaveBeenCalledTimes(2);
    expect(api.graphql.mock.calls[1]![0]).toContain('mutation collectContestEasterEgg');
  });

  it('sends the authenticated mutation with the session CSRF token', async () => {
    const posts: Array<{ data: { query: string }; headers: Record<string, string> }> = [];
    const context = {
      cookies: vi.fn(async () => [{ name: 'csrftoken', value: 'csrf-123' }]),
      request: {
        post: vi.fn(async (_url: string, init: { data: { query: string }; headers: Record<string, string> }) => {
          posts.push(init);
          const body = init.data.query.includes('mutation collectContestEasterEgg')
            ? { data: { collectContestEasterEgg: { ok: true } } }
            : { data: { isEasterEggCollected: false } };
          return { status: () => 200, text: async () => JSON.stringify(body) };
        }),
      },
    } as unknown as BrowserContext;
    await expect(claimContestReward(new LeetCodeApi(context), 'live-shape')).resolves.toEqual({
      offered: true,
      claimed: true,
    });
    expect(posts).toHaveLength(2);
    expect(posts[1]!.headers['x-csrftoken']).toBe('csrf-123');
    expect(posts[1]!.headers.Origin).toBe('https://leetcode.com');
  });

  it('keeps API errors non-fatal and reports them accurately', async () => {
    const api = { graphql: vi.fn(async () => { throw new Error('GraphQL HTTP 403'); }) } as unknown as ContestRewardApi;
    await expect(claimContestReward(api, 'blocked')).resolves.toEqual({
      offered: false,
      claimed: false,
      error: 'contest reward API failed: GraphQL HTTP 403',
    });
  });

  it('adds the collection note only after a confirmed claim', () => {
    const base = { label: 'dom9090', username: 'dom9090', kind: 'solved' as const, submissionStatus: 'Accepted', runtime: '0 ms', memory: '7.9 MB' };
    expect(formatOutcomeLine(base)).toBe('✅ dom9090 (dom9090) — Accepted · 0 ms · 7.9 MB');
    expect(formatOutcomeLine({ ...base, coinsCollected: true })).toBe(
      '✅ dom9090 (dom9090) — Accepted · 0 ms · 7.9 MB || Coins offered collected',
    );
  });
});

describe('/claimcoins picker', () => {
  it('supports individual multi-selection and an ALL option', () => {
    const accounts = [account('a1', 'first'), account('a2', 'second')];
    const view = buildCoinClaimPicker(accounts, new Set(['a2']));
    expect(view.buttons.map((row) => row[0]!.callback_data)).toEqual([
      'lccoin:a:a1',
      'lccoin:a:a2',
      'lccoin:all',
      'lccoin:run',
    ]);
    expect(view.buttons[0]![0]!.text).toContain('▫️');
    expect(view.buttons[1]![0]!.text).toContain('✅');
    expect(view.buttons[2]![0]!.text).toContain('ALL (2)');
    expect(view.buttons[3]![0]!.text).toContain('Claim selected (1)');
  });
});
