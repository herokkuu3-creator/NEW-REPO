import Fastify from 'fastify';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  accounts: [] as Array<{ id: string; label?: string; status: string }>,
  preferences: [] as Array<{ accountId: string; enabled: boolean }>,
  posts: [] as Array<{
    id: string;
    accountId: string;
    problemSlug: string;
    intent: string;
    status: string;
    contentHash?: string | null;
    approvedHash?: string | null;
    publishedUrl?: string | null;
    lastError?: string | null;
    retryCount: number;
    leaseUntil?: Date | null;
  }>,
  locks: new Map<string, string>(),
  timers: [] as Array<{ expr: string; options: any; callback: () => void; stop: ReturnType<typeof vi.fn> }>,
  orderLog: [] as string[],
  fetchLatestEndedContest: vi.fn(),
  solveAndSubmitContestQuestion: vi.fn(),
  generateForRun: vi.fn(),
  approvePost: vi.fn(),
  publishPost: vi.fn(),
  publishDailyPost: vi.fn(),
  sendTelegramMessage: vi.fn(async () => true),
}));

vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn((expr: string, callback: () => void, options?: unknown) => {
      const stop = vi.fn();
      h.timers.push({ expr, options, callback, stop });
      return { stop };
    }),
  },
}));

vi.mock('../src/database/prisma', () => {
  const tx = {
    account: {
      findMany: vi.fn(async ({ where }: any) =>
        h.accounts.filter(a => (!where?.id?.in || where.id.in.includes(a.id)) && a.status !== 'DISABLED'),
      ),
      count: vi.fn(async ({ where }: any) =>
        h.accounts.filter(a => (!where?.id?.in || where.id.in.includes(a.id)) && a.status !== 'DISABLED').length,
      ),
    },
    solutionPostPreference: {
      findMany: vi.fn(async () => h.preferences.filter(p => p.enabled)),
    },
    solutionPost: {
      findUnique: vi.fn(async ({ where }: any) => {
        const key = where?.accountId_problemSlug_intent;
        if (key) {
          return (
            h.posts.find(
              p =>
                p.accountId === key.accountId &&
                p.problemSlug === key.problemSlug &&
                p.intent === (key.intent ?? 'community-solution'),
            ) ?? null
          );
        }
        return h.posts.find(p => p.id === where?.id) ?? null;
      }),
      findMany: vi.fn(async () => h.posts),
    },
    systemState: {
      create: vi.fn(async ({ data }: any) => {
        if (h.locks.has(data.key)) {
          throw new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'test' });
        }
        h.locks.set(data.key, data.value);
        return { key: data.key, value: data.value };
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const key = where?.key ?? create.key;
        const value = h.locks.has(key) ? (update?.value ?? create.value) : create.value;
        h.locks.set(key, value);
        return { key, value };
      }),
      findUnique: vi.fn(async ({ where }: any) =>
        h.locks.has(where.key) ? { key: where.key, value: h.locks.get(where.key)!, updatedAt: new Date() } : null,
      ),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (h.locks.get(where.key) !== where.value) return { count: 0 };
        h.locks.set(where.key, data.value);
        return { count: 1 };
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        if (where?.key && (!where.value || h.locks.get(where.key) === where.value)) {
          h.locks.delete(where.key);
          return { count: 1 };
        }
        return { count: 0 };
      }),
    },
  };
  return { prisma: { ...tx, $transaction: vi.fn(async (action: (db: typeof tx) => unknown) => action(tx)) } };
});

vi.mock('../src/leetcode/contest', () => ({
  fetchLatestEndedContest: h.fetchLatestEndedContest,
  selectStartingContestQuestions: (contest: any, indices: readonly (0 | 1)[] = [0, 1]) =>
    indices.map(i => contest.questions[i]).filter(Boolean),
}));

vi.mock('../leetcode/contest', () => ({
  fetchLatestEndedContest: h.fetchLatestEndedContest,
  selectStartingContestQuestions: (contest: any, indices: readonly (0 | 1)[] = [0, 1]) =>
    indices.map(i => contest.questions[i]).filter(Boolean),
}));

vi.mock('../src/solutionPosts/contestSolver', () => ({
  solveAndSubmitContestQuestion: h.solveAndSubmitContestQuestion,
}));

vi.mock('./contestSolver', () => ({
  solveAndSubmitContestQuestion: h.solveAndSubmitContestQuestion,
}));

vi.mock('../src/solutionPosts/service', () => ({
  PostError: class extends Error {
    constructor(
      public readonly code: string,
      public readonly details?: object,
    ) {
      super(code);
    }
  },
  generateForRun: h.generateForRun,
  retryPost: vi.fn(),
  requeueInterruptedGeneration: vi.fn(),
  resetFailedSolutionPostRetries: vi.fn(),
}));

vi.mock('../src/solutionPosts/store', () => ({
  approvePost: h.approvePost,
  recoverGeneration: vi.fn(),
}));

vi.mock('../src/solutionPosts/publisher', () => ({
  publishPost: h.publishPost,
  reconcilePost: vi.fn(),
  reserveBrowserPublication: vi.fn(),
  inspectPublication: vi.fn(),
}));

vi.mock('../src/solutionPosts/dailyPublication', () => ({
  publishDailyPost: h.publishDailyPost,
  processDailyPublicationQueue: vi.fn(async () => {}),
  dailyPublicationStatus: vi.fn(async () => ({ minimumGapMs: 1200000 })),
}));

vi.mock('../src/notifications/telegram', () => ({
  sendTelegramMessage: h.sendTelegramMessage,
}));

import { config } from '../src/config';
import { PostError } from '../src/solutionPosts/service';
import { registerSolutionPostRoutes } from '../src/solutionPosts/routes';
import {
  BIWEEKLY_CONTEST_CRON,
  CONTEST_RECOVERY_CRON,
  CONTEST_SCHEDULE_STATE_KEY,
  CONTEST_TIMEZONE,
  WEEKLY_CONTEST_CRON,
  getContestSchedulerDiagnostics,
  isBiweeklyContestSaturdayIST,
  isInContestCatchupWindow,
  runContestSolutionWorkflow,
  runScheduledContestPosts,
  startContestPostScheduler,
} from '../src/solutionPosts/contestScheduler';

function makeContest(kind: 'weekly' | 'biweekly', titleSlug: string, endTimeIso: string) {
  const endTimeSec = Math.floor(new Date(endTimeIso).getTime() / 1000);
  return {
    title: kind === 'weekly' ? 'Weekly Contest 528' : 'Biweekly Contest 196',
    titleSlug,
    kind,
    startTimeSec: endTimeSec - 5400,
    endTimeSec,
    questions: [
      { index: 0 as const, label: 'Q1' as const, title: 'Smallest Pair', titleSlug: 'smallest-pair', questionId: '1001', credit: 3 },
      { index: 1 as const, label: 'Q2' as const, title: 'Grid Jump', titleSlug: 'grid-jump', questionId: '1002', credit: 4 },
      { index: 2 as const, label: 'Q3' as const, title: 'Tree Paths', titleSlug: 'tree-paths', questionId: '1003', credit: 5 },
      { index: 3 as const, label: 'Q4' as const, title: 'Hard Flow', titleSlug: 'hard-flow', questionId: '1004', credit: 6 },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.locks.clear();
  h.posts = [];
  h.timers = [];
  h.orderLog = [];
  h.accounts = [
    { id: 'acc-1', label: 'first', status: 'ACTIVE' },
    { id: 'acc-2', label: 'second', status: 'ACTIVE' },
  ];
  h.preferences = [
    { accountId: 'acc-1', enabled: true },
    { accountId: 'acc-2', enabled: true },
  ];

  h.solveAndSubmitContestQuestion.mockImplementation(async ({ accountId, question, onStage }: any) => {
    h.orderLog.push(`${accountId}:${question.label}:solve`);
    await onStage?.({ stage: 'solving_code', detail: `Solving ${question.label}` });
    await onStage?.({ stage: 'accepted', detail: 'Accepted' });
    return {
      id: `run-${accountId}-${question.titleSlug}`,
      accountId,
      problemSlug: question.titleSlug,
      state: 'SUCCESS',
      submissionId: `sub-${question.questionId}`,
      submissionStatus: 'Accepted',
    };
  });

  h.generateForRun.mockImplementation(async (accountId: string, runId: string, _force: boolean, onStage: any) => {
    const label = runId.includes('smallest-pair') ? 'Q1' : 'Q2';
    const slug = runId.includes('smallest-pair') ? 'smallest-pair' : 'grid-jump';
    h.orderLog.push(`${accountId}:${label}:generate`);
    await onStage?.('drafting_intuition', 'Explaining 1-liner');
    return {
      id: `post-${accountId}-${slug}`,
      accountId,
      problemSlug: slug,
      intent: 'contest-solution',
      status: 'AWAITING_APPROVAL',
      contentHash: 'a'.repeat(64),
      publishedUrl: null,
      lastError: null,
      retryCount: 1,
    };
  });

  h.approvePost.mockImplementation(async (id: string, contentHash: string) => ({
    id,
    status: 'DRAFT_READY',
    contentHash,
    approvedHash: contentHash,
  }));

  h.publishPost.mockImplementation(async (id: string) => {
    const label = id.includes('smallest-pair') ? 'Q1' : 'Q2';
    const acc = id.startsWith('post-acc-1') ? 'acc-1' : 'acc-2';
    h.orderLog.push(`${acc}:${label}:publish`);
    return {
      id,
      status: 'PUBLISHED',
      publishedUrl: `https://leetcode.com/problems/${label === 'Q1' ? 'smallest-pair' : 'grid-jump'}/solutions/99/${id}/`,
      lastError: null,
    };
  });
});

describe('IST biweekly cadence & catch-up windows', () => {
  it('matches the exact 14-day Saturday IST cadence anchored to 2026-11-07', () => {
    // 2026-11-07 21:31 IST (anchor Biweekly Contest 195)
    expect(isBiweeklyContestSaturdayIST(new Date('2026-11-07T16:01:00Z'))).toBe(true);
    // Early IST morning on 2026-11-07 (still 2026-11-06 UTC!)
    expect(isBiweeklyContestSaturdayIST(new Date('2026-11-06T19:00:00Z'))).toBe(true);
    // Midnight rollover into Sunday 2026-11-08 00:00 IST
    expect(isBiweeklyContestSaturdayIST(new Date('2026-11-07T18:30:00Z'))).toBe(false);

    // Off-Saturday 2026-11-14
    expect(isBiweeklyContestSaturdayIST(new Date('2026-11-14T16:01:00Z'))).toBe(false);
    // Biweekly 196 on 2026-11-21
    expect(isBiweeklyContestSaturdayIST(new Date('2026-11-21T16:01:00Z'))).toBe(true);
    // Off-Saturday 2026-11-28
    expect(isBiweeklyContestSaturdayIST(new Date('2026-11-28T16:01:00Z'))).toBe(false);
    // Biweekly 197 on 2026-12-05
    expect(isBiweeklyContestSaturdayIST(new Date('2026-12-05T16:01:00Z'))).toBe(true);

    // Year-boundary Dec -> Jan: 2026-12-19 (true), 2026-12-26 (false), 2027-01-02 (true)
    expect(isBiweeklyContestSaturdayIST(new Date('2026-12-19T16:01:00Z'))).toBe(true);
    expect(isBiweeklyContestSaturdayIST(new Date('2026-12-26T16:01:00Z'))).toBe(false);
    expect(isBiweeklyContestSaturdayIST(new Date('2027-01-02T16:01:00Z'))).toBe(true);
    expect(isBiweeklyContestSaturdayIST(new Date('2027-01-09T16:01:00Z'))).toBe(false);
  });

  it('enforces Sunday 09:30 vs 09:31 IST for weekly and Sat 21:31 + 3h Sun catchup for biweekly', () => {
    // Weekly Sunday 09:30:59 IST -> false; 09:31:00 IST -> true
    expect(isInContestCatchupWindow('weekly', new Date('2026-11-15T04:00:59Z'))).toBe(false);
    expect(isInContestCatchupWindow('weekly', new Date('2026-11-15T04:01:00Z'))).toBe(true);
    expect(isInContestCatchupWindow('weekly', new Date('2026-11-15T18:29:00Z'))).toBe(true);
    // Early Sunday 00:30 IST is before 09:31 -> false for weekly
    expect(isInContestCatchupWindow('weekly', new Date('2026-11-14T19:00:00Z'))).toBe(false);
    // Monday 09:31 IST -> false
    expect(isInContestCatchupWindow('weekly', new Date('2026-11-16T04:01:00Z'))).toBe(false);

    // Biweekly Saturday 21:30:59 IST -> false; 21:31:00 IST -> true
    expect(isInContestCatchupWindow('biweekly', new Date('2026-11-07T16:00:59Z'))).toBe(false);
    expect(isInContestCatchupWindow('biweekly', new Date('2026-11-07T16:01:00Z'))).toBe(true);
    // Catch-up into early Sunday IST (up to 02:59 IST) -> true; 03:00 IST -> false
    expect(isInContestCatchupWindow('biweekly', new Date('2026-11-07T19:30:00Z'))).toBe(true); // 01:00 IST Sun
    expect(isInContestCatchupWindow('biweekly', new Date('2026-11-07T21:29:00Z'))).toBe(true); // 02:59 IST Sun
    expect(isInContestCatchupWindow('biweekly', new Date('2026-11-07T21:30:00Z'))).toBe(false); // 03:00 IST Sun
    // Off-Saturday 2026-11-14 21:31 IST and its early Sunday -> false
    expect(isInContestCatchupWindow('biweekly', new Date('2026-11-14T16:01:00Z'))).toBe(false);
    expect(isInContestCatchupWindow('biweekly', new Date('2026-11-14T19:30:00Z'))).toBe(false);
  });
});

describe('runContestSolutionWorkflow', () => {
  it('runs Q1 then Q2 sequentially per account and publishes immediately in manual mode', async () => {
    const contest = makeContest('weekly', 'weekly-contest-528', '2026-11-15T04:00:00Z');
    const events: any[] = [];

    const results = await runContestSolutionWorkflow({
      contest,
      questionIndices: [0, 1],
      accountIds: ['acc-1', 'acc-2'],
      onProgress: event => { events.push(event); },
      now: new Date('2026-11-15T04:01:00Z'),
    });

    expect(results).toHaveLength(4);
    expect(results.every(r => r.status === 'PUBLISHED')).toBe(true);
    expect(h.orderLog).toEqual([
      'acc-1:Q1:solve',
      'acc-1:Q1:generate',
      'acc-1:Q1:publish',
      'acc-1:Q2:solve',
      'acc-1:Q2:generate',
      'acc-1:Q2:publish',
      'acc-2:Q1:solve',
      'acc-2:Q1:generate',
      'acc-2:Q1:publish',
      'acc-2:Q2:solve',
      'acc-2:Q2:generate',
      'acc-2:Q2:publish',
    ]);
    expect(h.publishDailyPost).not.toHaveBeenCalled();
    expect(h.publishPost).toHaveBeenCalledTimes(4);
    expect(h.generateForRun).toHaveBeenCalledWith(
      'acc-1',
      'run-acc-1-smallest-pair',
      false,
      expect.any(Function),
      'manual',
      { intent: 'contest-solution', articleStyle: 'one-liner' },
    );
    expect(h.solveAndSubmitContestQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc-1',
        contestSlug: 'weekly-contest-528',
        istDate: '2026-11-15',
      }),
    );
    expect(events.some(e => e.accountId === 'acc-1' && e.questionLabel === 'Q1' && e.stage === 'published' && e.publishedUrl)).toBe(true);
    expect(h.locks.size).toBe(0);
  });

  it('continues to Q2 and remaining accounts when Q1 fails, and respects Coarena pause', async () => {
    const contest = makeContest('weekly', 'weekly-contest-528', '2026-11-15T04:00:00Z');
    h.solveAndSubmitContestQuestion.mockImplementationOnce(async () => {
      throw new PostError('CONTEST_PROBLEM_LOCKED');
    });
    h.generateForRun.mockImplementationOnce(async (accountId: string) => ({
      id: `post-${accountId}-grid-jump`,
      accountId,
      problemSlug: 'grid-jump',
      status: 'RETRY_PENDING',
      lastError: 'COARENA_RATE_LIMIT',
      leaseUntil: new Date('2026-11-15T04:05:00Z'),
    }));

    const results = await runContestSolutionWorkflow({
      contest,
      questionIndices: [0, 1],
      accountIds: ['acc-1', 'acc-2'],
      now: new Date('2026-11-15T04:01:00Z'),
    });

    expect(results).toEqual([
      expect.objectContaining({ accountId: 'acc-1', questionLabel: 'Q1', status: 'FAILED', error: 'CONTEST_PROBLEM_LOCKED' }),
      expect.objectContaining({ accountId: 'acc-1', questionLabel: 'Q2', status: 'RETRY_PENDING', error: 'COARENA_RATE_LIMIT' }),
      expect.objectContaining({ accountId: 'acc-2', questionLabel: 'Q1', status: 'PUBLISHED' }),
      expect.objectContaining({ accountId: 'acc-2', questionLabel: 'Q2', status: 'PUBLISHED' }),
    ]);
    expect(h.publishPost).toHaveBeenCalledTimes(2);
  });

  it('skips re-solving already published contest posts and deduplicates active question leases', async () => {
    const contest = makeContest('weekly', 'weekly-contest-528', '2026-11-15T04:00:00Z');
    h.posts = [
      {
        id: 'existing-q1',
        accountId: 'acc-1',
        problemSlug: 'smallest-pair',
        intent: 'contest-solution',
        status: 'PUBLISHED',
        publishedUrl: 'https://leetcode.com/problems/smallest-pair/solutions/1/ok/',
        retryCount: 1,
      },
    ];
    h.locks.set(
      'contest-question-job:acc-1:weekly-contest-528:grid-jump',
      JSON.stringify({ owner: 'other', until: Date.now() + 60_000 }),
    );

    const results = await runContestSolutionWorkflow({
      contest,
      questionIndices: [0, 1],
      accountIds: ['acc-1'],
      now: new Date('2026-11-15T04:01:00Z'),
    });

    expect(results).toEqual([
      expect.objectContaining({
        accountId: 'acc-1',
        questionLabel: 'Q1',
        status: 'PUBLISHED',
        publishedUrl: 'https://leetcode.com/problems/smallest-pair/solutions/1/ok/',
      }),
      expect.objectContaining({
        accountId: 'acc-1',
        questionLabel: 'Q2',
        status: 'SKIPPED',
        error: 'ACCOUNT_JOB_IN_PROGRESS',
      }),
    ]);
    expect(h.solveAndSubmitContestQuestion).not.toHaveBeenCalled();
  });
});

describe('runScheduledContestPosts & recovery', () => {
  it('gates weekly runs before 09:31 IST and executes at 09:31 IST', async () => {
    h.accounts = [h.accounts[0]!];
    h.preferences = [{ accountId: 'acc-1', enabled: true }];
    const contest = makeContest('weekly', 'weekly-contest-528', '2026-11-15T04:00:00Z');
    h.fetchLatestEndedContest.mockResolvedValue(contest);

    const early = await runScheduledContestPosts('weekly', new Date('2026-11-15T04:00:59Z'), 'cron');
    expect(early.status).toBe('OUTSIDE_WINDOW');
    expect(h.fetchLatestEndedContest).not.toHaveBeenCalled();

    const ok = await runScheduledContestPosts('weekly', new Date('2026-11-15T04:01:00Z'), 'cron');
    expect(ok.status).toBe('FINISHED');
    expect(ok.contestSlug).toBe('weekly-contest-528');
    expect(ok.results).toHaveLength(2);
    expect(ok.results?.every(r => r.status === 'PUBLISHED')).toBe(true);
    expect(JSON.parse(h.locks.get(CONTEST_SCHEDULE_STATE_KEY)!)).toMatchObject({
      status: 'FINISHED',
      contestSlug: 'weekly-contest-528',
    });
  });

  it('prevents biweekly misfire on off-Saturdays and postponed contests', async () => {
    h.accounts = [h.accounts[0]!];
    h.preferences = [{ accountId: 'acc-1', enabled: true }];

    const offSat = await runScheduledContestPosts('biweekly', new Date('2026-11-14T16:01:00Z'), 'cron');
    expect(offSat.status).toBe('OUTSIDE_WINDOW');
    expect(h.fetchLatestEndedContest).not.toHaveBeenCalled();

    // On valid biweekly Saturday 2026-11-21, if LeetCode only returns old 2026-11-07 contest (postponed), skip!
    const oldContest = makeContest('biweekly', 'biweekly-contest-195', '2026-11-07T16:00:00Z');
    h.fetchLatestEndedContest.mockResolvedValueOnce(oldContest);
    const postponed = await runScheduledContestPosts('biweekly', new Date('2026-11-21T16:01:00Z'), 'cron');
    expect(postponed.status).toBe('STALE_CONTEST');
    expect(h.solveAndSubmitContestQuestion).not.toHaveBeenCalled();

    // When live Biweekly 196 matches 2026-11-21, it runs and publishes (including Telegram notifications)
    const telegramMutable = config.telegram as { enabled: boolean };
    const prevEnabled = telegramMutable.enabled;
    telegramMutable.enabled = true;
    try {
      const validContest = makeContest('biweekly', 'biweekly-contest-196', '2026-11-21T16:00:00Z');
      h.fetchLatestEndedContest.mockResolvedValueOnce(validContest);
      const validRun = await runScheduledContestPosts('biweekly', new Date('2026-11-21T16:01:00Z'), 'cron');
      expect(validRun.status).toBe('FINISHED');
      expect(validRun.results?.every(r => r.status === 'PUBLISHED')).toBe(true);
      expect(h.sendTelegramMessage).toHaveBeenCalledTimes(2);
      expect(h.sendTelegramMessage.mock.calls[0]![0]).toContain('Biweekly Contest 196');
      expect(h.sendTelegramMessage.mock.calls[1]![0]).toContain('2 published');
    } finally {
      telegramMutable.enabled = prevEnabled;
    }
  });

  it('deduplicates overlapping cron/recovery triggers via contest CAS lease and reclaims stale leases', async () => {
    h.accounts = [h.accounts[0]!];
    h.preferences = [{ accountId: 'acc-1', enabled: true }];
    const contest = makeContest('weekly', 'weekly-contest-528', '2026-11-15T04:00:00Z');
    h.fetchLatestEndedContest.mockResolvedValue(contest);

    // Active CAS lease blocks start
    h.locks.set('contest-post-job:weekly-contest-528', JSON.stringify({ owner: 'other-replica', until: Date.now() + 60_000 }));
    const blocked = await runScheduledContestPosts('weekly', new Date('2026-11-15T04:01:00Z'), 'recovery');
    expect(blocked).toEqual({ status: 'BUSY', contestSlug: 'weekly-contest-528' });
    expect(h.solveAndSubmitContestQuestion).not.toHaveBeenCalled();

    // Stale CAS lease (>25 min old) is reclaimed cleanly
    h.locks.set('contest-post-job:weekly-contest-528', JSON.stringify({ owner: 'crashed-replica', until: Date.now() - 1000 }));
    const reclaimed = await runScheduledContestPosts('weekly', new Date('2026-11-15T04:05:00Z'), 'recovery');
    expect(reclaimed.status).toBe('FINISHED');
    expect(h.solveAndSubmitContestQuestion).toHaveBeenCalledTimes(2);
    expect(h.locks.has('contest-post-job:weekly-contest-528')).toBe(false);
  });

  it('recovers CONTEST_PROBLEM_LOCKED on subsequent recovery tick without re-running completed Q1', async () => {
    h.accounts = [h.accounts[0]!];
    h.preferences = [{ accountId: 'acc-1', enabled: true }];
    const contest = makeContest('weekly', 'weekly-contest-528', '2026-11-15T04:00:00Z');
    h.fetchLatestEndedContest.mockResolvedValue(contest);

    // 09:31 IST: Q1 succeeds, Q2 throws CONTEST_PROBLEM_LOCKED
    h.solveAndSubmitContestQuestion
      .mockImplementationOnce(async ({ accountId, question }: any) => ({
        id: `run-${accountId}-${question.titleSlug}`,
        accountId,
        problemSlug: question.titleSlug,
        state: 'SUCCESS',
        submissionId: '101',
        submissionStatus: 'Accepted',
      }))
      .mockImplementationOnce(async () => {
        throw new PostError('CONTEST_PROBLEM_LOCKED');
      });

    const first = await runScheduledContestPosts('weekly', new Date('2026-11-15T04:01:00Z'), 'cron');
    expect(first.status).toBe('FINISHED');
    expect(first.results).toEqual([
      expect.objectContaining({ questionLabel: 'Q1', status: 'PUBLISHED' }),
      expect.objectContaining({ questionLabel: 'Q2', status: 'FAILED', error: 'CONTEST_PROBLEM_LOCKED' }),
    ]);

    // 09:35 IST recovery: Q1 is already marked done, ONLY Q2 runs and succeeds!
    h.solveAndSubmitContestQuestion.mockClear();
    const second = await runScheduledContestPosts('weekly', new Date('2026-11-15T04:05:00Z'), 'recovery');
    expect(second.status).toBe('FINISHED');
    expect(h.solveAndSubmitContestQuestion).toHaveBeenCalledTimes(1);
    expect(h.solveAndSubmitContestQuestion.mock.calls[0]![0].question.titleSlug).toBe('grid-jump');
    expect(second.results).toEqual([expect.objectContaining({ questionLabel: 'Q2', status: 'PUBLISHED' })]);

    // 09:40 IST recovery: both Q1 and Q2 done -> IDLE with zero calls
    h.solveAndSubmitContestQuestion.mockClear();
    const third = await runScheduledContestPosts('weekly', new Date('2026-11-15T04:10:00Z'), 'recovery');
    expect(third.status).toBe('IDLE');
    expect(h.solveAndSubmitContestQuestion).not.toHaveBeenCalled();
  });

  it('bounds recovery attempts to 5 while bypassing count increments on Coarena/lock contention', async () => {
    h.accounts = [h.accounts[0]!];
    h.preferences = [{ accountId: 'acc-1', enabled: true }];
    const contest = {
      ...makeContest('weekly', 'weekly-contest-528', '2026-11-15T04:00:00Z'),
      questions: [makeContest('weekly', 'weekly-contest-528', '2026-11-15T04:00:00Z').questions[0]!],
    };
    h.fetchLatestEndedContest.mockResolvedValue(contest);

    // Contention (COARENA_CAPACITY) must not consume retry budget
    h.generateForRun.mockResolvedValueOnce({
      id: 'post-acc-1-smallest-pair',
      accountId: 'acc-1',
      problemSlug: 'smallest-pair',
      status: 'RETRY_PENDING',
      lastError: 'COARENA_CAPACITY',
      leaseUntil: new Date('2026-11-15T04:02:00Z'),
    });
    await runScheduledContestPosts('weekly', new Date('2026-11-15T04:01:00Z'), 'cron');
    expect(JSON.parse(h.locks.get('contest-post-budget:weekly-contest-528:acc-1:smallest-pair')!).attempts).toBe(0);

    // 5 consecutive CONTEST_PROBLEM_LOCKED attempts stop retrying on 6th attempt
    h.solveAndSubmitContestQuestion.mockRejectedValue(new PostError('CONTEST_PROBLEM_LOCKED'));
    for (let i = 1; i <= 5; i++) {
      const res = await runScheduledContestPosts('weekly', new Date(`2026-11-15T04:0${i + 1}:00Z`), 'recovery');
      expect(res.status).toBe('FINISHED');
    }
    expect(h.solveAndSubmitContestQuestion).toHaveBeenCalledTimes(6); // 1 from Coarena round + 5 locked attempts
    expect(JSON.parse(h.locks.get('contest-post-budget:weekly-contest-528:acc-1:smallest-pair')!).attempts).toBe(5);

    const sixth = await runScheduledContestPosts('weekly', new Date('2026-11-15T04:15:00Z'), 'recovery');
    expect(sixth.status).toBe('IDLE');
    expect(h.solveAndSubmitContestQuestion).toHaveBeenCalledTimes(6);
  });

  it('registers weekly, biweekly, and 5-min recovery cron jobs in Asia/Kolkata and cleans up on stop', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-15T04:01:00Z')); // Sunday 09:31 IST
    h.accounts = [h.accounts[0]!];
    h.preferences = [{ accountId: 'acc-1', enabled: true }];
    h.fetchLatestEndedContest.mockResolvedValue(makeContest('weekly', 'weekly-contest-528', '2026-11-15T04:00:00Z'));

    const stop = startContestPostScheduler();
    try {
      expect(h.timers.map(t => [t.expr, t.options])).toEqual([
        [WEEKLY_CONTEST_CRON, { timezone: CONTEST_TIMEZONE }],
        [BIWEEKLY_CONTEST_CRON, { timezone: CONTEST_TIMEZONE }],
        [CONTEST_RECOVERY_CRON, { timezone: CONTEST_TIMEZONE }],
      ]);
      // Boot tick catches up immediately inside Sunday 09:31 IST window
      await vi.waitFor(() => expect(h.publishPost).toHaveBeenCalledTimes(2));
    } finally {
      stop();
      vi.useRealTimers();
    }
    for (const timer of h.timers) {
      expect(timer.stop).toHaveBeenCalledTimes(1);
    }
  });

  it('exposes contestScheduler in diagnostics and triggers manual contest scheduled endpoint', async () => {
    h.accounts = [h.accounts[0]!];
    h.preferences = [{ accountId: 'acc-1', enabled: true }];
    const contest = makeContest('biweekly', 'biweekly-contest-195', '2026-11-07T16:00:00Z');
    h.fetchLatestEndedContest.mockResolvedValue(contest);

    const app = Fastify();
    registerSolutionPostRoutes(app, header => header === 'Bearer admin-test');
    try {
      const unauth = await app.inject({ method: 'POST', url: '/admin/solutions/contest/scheduled' });
      expect(unauth.statusCode).toBe(401);

      const bad = await app.inject({
        method: 'POST',
        url: '/admin/solutions/contest/scheduled',
        headers: { authorization: 'Bearer admin-test' },
        payload: { kind: 'daily' },
      });
      expect(bad.statusCode).toBe(400);

      const trigger = await app.inject({
        method: 'POST',
        url: '/admin/solutions/contest/scheduled',
        headers: { authorization: 'Bearer admin-test' },
        payload: { kind: 'biweekly' },
      });
      expect(trigger.statusCode).toBe(202);
      expect(trigger.json()).toMatchObject({ status: 'ACCEPTED', kinds: ['biweekly'], timezone: CONTEST_TIMEZONE });

      await vi.waitFor(() => expect(h.publishPost).toHaveBeenCalledTimes(2));

      const diag = await app.inject({
        method: 'GET',
        url: '/admin/solutions/diagnostics',
        headers: { authorization: 'Bearer admin-test' },
      });
      expect(diag.statusCode).toBe(200);
      expect(diag.json().contestScheduler).toMatchObject({
        timezone: CONTEST_TIMEZONE,
        weeklyCron: WEEKLY_CONTEST_CRON,
        biweeklyCron: BIWEEKLY_CONTEST_CRON,
        recoveryCron: CONTEST_RECOVERY_CRON,
        state: expect.objectContaining({ status: 'FINISHED', contestSlug: 'biweekly-contest-195' }),
      });
      expect(await getContestSchedulerDiagnostics()).toMatchObject({ timezone: CONTEST_TIMEZONE });
    } finally {
      await app.close();
    }
  });
});
