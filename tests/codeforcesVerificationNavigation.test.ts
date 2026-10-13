import { afterEach, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { openSubmitForm } from '../src/codeforces/submitterService';

afterEach(() => vi.useRealTimers());

it('stops on the first challenged submit URL instead of requesting alternate endpoints', async () => {
  vi.useFakeTimers();
  const goto = vi.fn(async () => ({ status: () => 403 }));
  const page = { goto, url: () => 'https://codeforces.com/contest/1/submit', title: async () => 'Just a moment...',
    locator: () => ({ count: async () => 0 }) } as unknown as Page;
  const run = openSubmitForm(page, { contestId: 1, problemIndex: 'A' });
  const assertion = expect(run).rejects.toMatchObject({ kind: 'blocked', clicked: false,
    message: expect.stringContaining('current solution remains pending') });
  await vi.runAllTimersAsync();
  await assertion;
  expect(goto).toHaveBeenCalledOnce();
});
