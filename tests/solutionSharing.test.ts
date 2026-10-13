import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SolutionCache } from '../src/solutions/solutionCache';

/**
 * 1) SolutionCache unit tests.
 * 2) Multi-account worker test with every I/O dependency mocked: proves the
 *    daily solution is fetched ONCE and shared, and every account still gets
 *    its own submission and its own outcome.
 */

const key = (over: Partial<{ date: string; questionId: string }> = {}) => ({
  date: '2026-09-27',
  questionId: '1190',
  language: 'cpp',
  source: 'walkccc',
  ...over,
});

describe('SolutionCache', () => {
  it('produces once and reuses for the same key', async () => {
    const c = new SolutionCache<string>();
    const produce = vi.fn(async () => 'code');
    expect(await c.get(key(), produce)).toBe('code');
    expect(await c.get(key(), produce)).toBe('code');
    expect(await c.get(key(), produce)).toBe('code');
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight fetch between concurrent callers', async () => {
    const c = new SolutionCache<string>();
    let resolve!: (v: string) => void;
    const produce = vi.fn(() => new Promise<string>((r) => (resolve = r)));
    const a = c.get(key(), produce);
    const b = c.get(key(), produce);
    resolve('x');
    expect(await Promise.all([a, b])).toEqual(['x', 'x']);
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it('does not cache failures — the next caller retries', async () => {
    const c = new SolutionCache<string>();
    const produce = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce('ok');
    await expect(c.get(key(), produce)).rejects.toThrow('network');
    expect(c.has(key())).toBe(false);
    expect(await c.get(key(), produce)).toBe('ok');
    expect(produce).toHaveBeenCalledTimes(2);
  });

  it('keys by question and drops entries from previous days', async () => {
    const c = new SolutionCache<string>();
    await c.get(key(), async () => 'a');
    await c.get(key({ questionId: '1' }), async () => 'b');
    expect(c.size).toBe(2);
    const produce = vi.fn(async () => 'next-day');
    expect(await c.get(key({ date: '2026-09-28' }), produce)).toBe('next-day');
    expect(produce).toHaveBeenCalledTimes(1);
    expect(c.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Worker integration (all I/O mocked)
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  fetchWalkccc: vi.fn(),
  fetchCommunity: vi.fn(),
  submit: vi.fn(),
  await: vi.fn(),
  accounts: [] as Array<Record<string, unknown>>,
  runs: new Map<string, Record<string, unknown>>(),
}));

vi.mock('../src/config', async (orig) => {
  const real = (await orig()) as { config: Record<string, unknown> };
  return {
    config: {
      ...real.config,
      transport: 'api',
      solution: { ...(real.config.solution as object), source: 'walkccc' },
      llm: { ...(real.config.llm as object), language: 'cpp' },
    },
  };
});

vi.mock('../src/solutions/walkccc', async (orig) => ({
  ...((await orig()) as object),
  fetchWalkcccSolution: h.fetchWalkccc,
  signatureMatchesStarter: () => true,
}));

vi.mock('../src/solutions/communitySolutions', async (orig) => ({
  ...((await orig()) as object),
  fetchCommunitySolution: h.fetchCommunity,
}));

vi.mock('../src/database/accounts', () => ({
  ensureAccountsSeeded: vi.fn(async () => undefined),
  listEnabledAccounts: vi.fn(async () => h.accounts),
  parseStoredStorageState: () => ({ ok: true, state: { cookies: [], origins: [] } }),
  patchAccount: vi.fn(async () => undefined),
}));

vi.mock('../src/database/models', async () => {
  const { RunState } = await import('@prisma/client');
  return {
    RunState,
    SystemKeys: { lastReport: 'lastReport', lastRunSummary: 'lastRunSummary' },
    setSystemState: vi.fn(async () => undefined),
    findRunByDate: vi.fn(async (accountId: string) => h.runs.get(accountId) ?? null),
    createRun: vi.fn(async (input: Record<string, unknown>) => {
      const row = { id: `run-${input.accountId}`, ...input, updatedAt: new Date() };
      h.runs.set(input.accountId as string, row);
      return row;
    }),
    updateRun: vi.fn(async (id: string, data: Record<string, unknown>) => {
      const row = [...h.runs.values()].find((r) => r.id === id)!;
      for (const [k, v] of Object.entries(data)) if (k !== 'attempts') row[k] = v;
      return row;
    }),
    finalizeRun: vi.fn(async (id: string, state: string, extra: Record<string, unknown>) => {
      const row = [...h.runs.values()].find((r) => r.id === id)!;
      Object.assign(row, extra, { state, updatedAt: new Date() });
      return { submissionId: null, submissionStatus: null, runtime: null, memory: null, error: null, ...row };
    }),
  };
});

vi.mock('../src/browser/playwright', () => ({
  launchWithStorageStateObject: vi.fn(async () => ({ context: {}, page: {}, close: async () => undefined })),
}));
vi.mock('../src/browser/sessionCheck', () => ({
  checkSession: vi.fn(async () => ({ authenticated: true, username: 'u' })),
}));
vi.mock('../src/browser/diagnostics', () => ({
  captureDiagnostics: vi.fn(),
  pruneDiagnostics: vi.fn(),
}));
vi.mock('../src/notifications/notifier', () => ({ notifyMultiRunReport: vi.fn(async () => undefined) }));
vi.mock('../src/leetcode/dailyChallenge', async (orig) => ({
  ...((await orig()) as object),
  fetchDailyChallenge: vi.fn(async () => ({
    slug: 'reverse-substrings-between-each-pair-of-parentheses',
    title: 'Reverse Substrings',
    difficulty: 'Medium',
  })),
  fetchQuestionData: vi.fn(async () => ({})),
}));
vi.mock('../src/leetcode/parser', async (orig) => ({
  ...((await orig()) as object),
  parseProblem: () => ({
    frontendId: '1190',
    slug: 'reverse-substrings-between-each-pair-of-parentheses',
    questionId: '1298',
    starterCode: 'class Solution { public: string reverseParentheses(string s) {} };',
  }),
}));
vi.mock('../src/leetcode/apiClient', async (orig) => {
  const real = (await orig()) as object;
  return {
    ...real,
    LeetCodeApi: class {
      submitSolution = h.submit;
      awaitSubmission = h.await;
    },
  };
});

describe('multi-account run shares one solution', () => {
  beforeEach(() => {
    h.fetchWalkccc.mockReset();
    h.fetchCommunity.mockReset();
    h.fetchCommunity.mockRejectedValue(new Error('no community solution'));
    h.submit.mockReset();
    h.await.mockReset();
    h.runs.clear();
    h.accounts = ['a1', 'a2', 'a3'].map((label) => ({
      id: `id-${label}`,
      label,
      username: label,
      storageState: '{}',
    }));
    let n = 0;
    h.submit.mockImplementation(async () => String(++n));
    h.await.mockImplementation(async (id: string) => ({
      submissionId: id,
      classification: 'ACCEPTED',
      statusDisplay: 'Accepted',
      runtime: '0 ms',
      memory: '8.6 MB',
      rawStatusMsg: 'Accepted',
    }));
  });

  it('fetches walkccc once for all accounts, submits for each, one outcome per account', async () => {
    h.fetchWalkccc.mockResolvedValue({ code: 'class Solution {};', sourceUrl: 'u' });
    const { executeDailyRun } = await import('../src/scheduler/dailyWorker');

    const report = await executeDailyRun('trigger-submission');

    expect(h.fetchWalkccc).toHaveBeenCalledTimes(1);
    expect(h.submit).toHaveBeenCalledTimes(3);
    expect(report.accounts.map((a) => [a.label, a.kind, a.submissionId])).toEqual([
      ['a1', 'solved', '1'],
      ['a2', 'solved', '2'],
      ['a3', 'solved', '3'],
    ]);
    expect(report.totals.solved).toBe(3);

    // A second trigger the same day reuses the cached solution and re-submits (force).
    const again = await executeDailyRun('trigger-submission');
    expect(h.fetchWalkccc).toHaveBeenCalledTimes(1);
    expect(h.submit).toHaveBeenCalledTimes(6);
    expect(again.totals.solved).toBe(3);
  });

  it('resubmits a previously solved-but-not-submitted row on the normal daily trigger', async () => {
    h.accounts = [{
      id: 'id-a1',
      label: 'a1',
      username: 'a1',
      storageState: '{}',
    }];
    h.runs.set('id-a1', {
      id: 'run-a1',
      accountId: 'id-a1',
      date: '2026-09-28',
      problemSlug: 'old-problem',
      title: 'Old Problem',
      difficulty: 'Easy',
      language: 'cpp',
      state: 'SUCCESS',
      submissionStatus: 'SOLVED_NOT_SUBMITTED (legacy run)',
    });
    h.fetchWalkccc.mockResolvedValue({ code: 'class Solution {};', sourceUrl: 'u' });

    const { executeDailyRun } = await import('../src/scheduler/dailyWorker');
    const report = await executeDailyRun('cron');

    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(report.accounts[0]).toMatchObject({
      label: 'a1',
      kind: 'solved',
      submissionId: '1',
    });
  });

  it('calls onAccountOutcome once per account, in order, as each finishes', async () => {
    h.fetchWalkccc.mockResolvedValue({ code: 'class Solution {};', sourceUrl: 'u' });
    const { runSubmissionNow } = await import('../src/scheduler/dailyWorker');
    const seen: string[] = [];
    const report = await runSubmissionNow('trigger-submission', {
      onAccountOutcome: (o, i, t) => {
        // at callback time, later accounts must not have been submitted yet
        seen.push(`${i}/${t}:${o.label}:${o.kind}:submits=${h.submit.mock.calls.length}`);
        if (i === 2) throw new Error('telegram down'); // must not break the run
      },
    });
    expect(seen).toEqual(['1/3:a1:solved:submits=1', '2/3:a2:solved:submits=2', '3/3:a3:solved:submits=3']);
    expect(report?.totals.solved).toBe(3);
  });

  it('a failed fetch is retried by the next account instead of failing everyone', async () => {
    const { WalkcccError } = await import('../src/solutions/walkccc');
    // First fetch fails; the cache must not keep the failure (fresh module = empty cache).
    h.fetchWalkccc
      .mockRejectedValueOnce(new WalkcccError('temporary'))
      .mockResolvedValue({ code: 'class Solution {};', sourceUrl: 'u' });
    vi.resetModules();
    const { executeDailyRun } = await import('../src/scheduler/dailyWorker');

    const report = await executeDailyRun('trigger-submission');

    expect(report.accounts.map((a) => a.kind)).toEqual(['failed', 'solved', 'solved']);
    expect(h.fetchWalkccc).toHaveBeenCalledTimes(2);
    expect(h.submit).toHaveBeenCalledTimes(2);
  });

  it('uses community solution as primary, fetching diverse candidates per account', async () => {
    h.fetchCommunity.mockResolvedValue({
      code: 'class Solution { public: string reverseParentheses(string s) { return s; } };',
      sourceUrl: 'https://leetcode.com/solutions/test',
      title: 'Community Solution',
      uuid: 'comm-123',
      rankIndex: 1,
    });
    vi.resetModules();
    const { executeDailyRun } = await import('../src/scheduler/dailyWorker');

    const report = await executeDailyRun('trigger-submission');

    expect(report.totals.solved).toBe(3);
    expect(report.accounts.map((a) => a.kind)).toEqual(['solved', 'solved', 'solved']);
    expect(h.fetchCommunity).toHaveBeenCalledTimes(3);
    expect(h.fetchWalkccc).toHaveBeenCalledTimes(0);
    expect(h.submit).toHaveBeenCalledTimes(3);
  });

  it('falls back to walkccc when community solutions fails', async () => {
    h.fetchCommunity.mockRejectedValue(new Error('no community solution'));
    h.fetchWalkccc.mockResolvedValue({
      code: 'class Solution { public: string reverseParentheses(string s) { return s; } };',
      sourceUrl: 'u',
    });
    vi.resetModules();
    const { executeDailyRun } = await import('../src/scheduler/dailyWorker');

    const report = await executeDailyRun('trigger-submission');

    expect(report.totals.solved).toBe(3);
    expect(report.accounts.map((a) => a.kind)).toEqual(['solved', 'solved', 'solved']);
    expect(h.fetchCommunity).toHaveBeenCalledTimes(3);
    expect(h.fetchWalkccc).toHaveBeenCalledTimes(1); // Cached by walkcccCache!
    expect(h.submit).toHaveBeenCalledTimes(3);
  });
});
