import { describe, expect, it, vi } from 'vitest';
import type { BrowserContext } from 'playwright';
import type { AccountRecord } from '../src/database/accounts';
import {
  claimDailyCheckin,
  claimDailyCheckinForAccount,
  CHECKIN_MUTATION,
  type DailyCheckinApi,
} from '../src/leetcode/dailyCheckin';
import { claimContestRewardForAccount } from '../src/leetcode/contestReward';
import { LeetCodeApi } from '../src/leetcode/apiClient';
import { formatOutcomeLine } from '../src/scheduler/report';

function account(id: string, label: string): AccountRecord {
  return {
    id,
    label,
    username: label,
    status: 'ACTIVE',
    storageState: JSON.stringify({ cookies: [{ name: 'csrftoken', value: 'c1' }] }),
  } as unknown as AccountRecord;
}

function checkinApi(response: unknown): DailyCheckinApi & { graphql: ReturnType<typeof vi.fn> } {
  return { graphql: vi.fn(async () => response) } as unknown as DailyCheckinApi & {
    graphql: ReturnType<typeof vi.fn>;
  };
}

describe('LeetCode daily check-in GraphQL flow', () => {
  it('claims +1 coin on the first check-in of the day', async () => {
    const api = checkinApi({ checkin: { checkedIn: true, ok: true, error: null } });
    const res = await claimDailyCheckin(api, 'test-acc');
    expect(res).toEqual({ checkedIn: true, awarded: true });
    expect(api.graphql).toHaveBeenCalledTimes(1);
    expect(api.graphql.mock.calls[0]![0]).toContain('mutation checkin');
  });

  it('detects when already checked in today without error', async () => {
    const api = checkinApi({ checkin: { checkedIn: true, ok: false, error: 'Already checked in' } });
    const res = await claimDailyCheckin(api, 'test-acc');
    expect(res).toEqual({ checkedIn: true, awarded: false });
  });

  it('detects when error message says already checked in', async () => {
    const api = checkinApi({ checkin: { checkedIn: false, ok: false, error: 'User already checked in today' } });
    const res = await claimDailyCheckin(api, 'test-acc');
    expect(res).toEqual({ checkedIn: true, awarded: false });
  });

  it('sends the authenticated mutation with headers through LeetCodeApi', async () => {
    const posts: Array<{ data: { query: string }; headers: Record<string, string> }> = [];
    const context = {
      cookies: vi.fn(async () => [{ name: 'csrftoken', value: 'csrf-daily-123' }]),
      request: {
        post: vi.fn(async (_url: string, init: { data: { query: string }; headers: Record<string, string> }) => {
          posts.push(init);
          return {
            status: () => 200,
            text: async () => JSON.stringify({ data: { checkin: { checkedIn: true, ok: true } } }),
          };
        }),
      },
    } as unknown as BrowserContext;

    const api = new LeetCodeApi(context);
    const res = await claimDailyCheckin(api, 'live-checkin');
    expect(res).toEqual({ checkedIn: true, awarded: true });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.headers['x-csrftoken']).toBe('csrf-daily-123');
    expect(posts[0]!.headers.Origin).toBe('https://leetcode.com');
  });

  it('keeps API errors non-fatal and reports them gracefully', async () => {
    const api = {
      graphql: vi.fn(async () => {
        throw new Error('GraphQL HTTP 403 Cloudflare challenge');
      }),
    } as unknown as DailyCheckinApi;
    const res = await claimDailyCheckin(api, 'blocked-acc');
    expect(res.checkedIn).toBe(false);
    expect(res.error).toContain('GraphQL HTTP 403');
  });

  it('handles empty response gracefully', async () => {
    const api = checkinApi(null);
    const res = await claimDailyCheckin(api, 'empty-acc');
    expect(res).toEqual({ checkedIn: false, error: 'empty checkin response' });
  });

  it('formats outcome line with daily check-in note', () => {
    const base = {
      label: 'user1',
      username: 'user1',
      kind: 'solved' as const,
      submissionStatus: 'Accepted',
      runtime: '0 ms',
      memory: '8 MB',
    };
    expect(formatOutcomeLine({ ...base, dailyCheckin: true })).toBe(
      '✅ user1 (user1) — Accepted · 0 ms · 8 MB || Daily check-in done',
    );
    expect(formatOutcomeLine({ ...base, dailyCheckin: true, coinsCollected: true })).toBe(
      '✅ user1 (user1) — Accepted · 0 ms · 8 MB || Daily check-in done || Coins offered collected',
    );
  });
});
