import Fastify from 'fastify';
import { AccountStatus, Prisma, RunState } from '@prisma/client';
import OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';

const XML_ILLEGAL_CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/;

const activeMocks = new Set<string>();
function mockModule(id: string, factory: () => unknown) {
  activeMocks.add(id);
  vi.doMock(id, factory);
}

afterEach(() => {
  for (const id of activeMocks) vi.doUnmock(id);
  activeMocks.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('article.ts nested C++ templates and CRLF JSON parsing', () => {
  it('supports nested C++ templates longest-first in single pass without backtick corruption and parses CRLF JSON', async () => {
    const {
      articleSchema,
      contextSchema,
      parseJSON,
      renderArticle,
      validateArticle,
    } = await import('../src/solutionPosts/article');

    expect(parseJSON('```json\r\n{"ready":true,"count":2}\r\n```')).toEqual({ ready: true, count: 2 });
    expect(parseJSON('```\r\n{"ok":1}\r\n```')).toEqual({ ok: 1 });

    const code = [
      'class Solution {',
      'public:',
      '    int solve(vector<vector<int>>& grid) {',
      '        priority_queue<pair<int, int>> pq;',
      '        vector<int> row = grid[0];',
      '        return (int)row.size() + (int)pq.size();',
      '    }',
      '};',
    ].join('\n');

    const context = contextSchema.parse({
      accountId: 'acc-1',
      username: 'alice',
      problemId: '1',
      slug: 'nested-templates-demo',
      title: 'Nested Templates Demo',
      difficulty: 'Medium',
      problem: 'Compute value using nested vectors and a priority queue.',
      submissionId: '1001',
      language: 'cpp',
      code,
      challengeDate: '2026-11-17',
    });

    const draft = articleSchema.parse({
      title: '✨ Clean Heap and Matrix Scan Without Extra Copies',
      sections: [
        {
          kind: 'intuition',
          heading: 'Core insight',
          markdown: 'Store pairs in priority_queue<pair<int, int>> and scan vector<vector<int>> rows, reusing `vector<int>`.',
        },
        {
          kind: 'approach',
          heading: 'Steps',
          markdown: '- Inspect vector<vector<int>> directly.\n- Push into priority_queue<pair<int, int>>.\n- Read vector<int> row size.',
        },
        {
          kind: 'correctness',
          heading: 'Why it holds',
          markdown: 'Every cell in vector<vector<int>> is counted once.',
        },
        {
          kind: 'dryRun',
          heading: 'Quick trace',
          markdown: '**Input:** `[[1]]`\n\nRow size is one.\n\n**Output:** `1`',
        },
        {
          kind: 'takeaways',
          heading: 'Takeaway',
          markdown: 'Nested containers pair cleanly when indexed directly.',
        },
      ],
      time: { bound: 'O(n)', reason: 'Each row in vector<vector<int>> is visited once.' },
      space: { bound: 'O(n)', reason: 'The priority_queue<pair<int, int>> holds bounded entries.' },
      visuals: [
        {
          id: 'visual-1',
          after: 'intuition',
          title: 'Build the queue',
          caption: 'Insert row items into the heap.',
          theme: 'aurora',
          frames: [
            { label: 'Start', items: ['1', '2'], active: [0], state: 'pq=[1]', metric: 'size=1', note: 'Push first.' },
            { label: 'Next', items: ['1', '2'], active: [1], state: 'pq=[2,1]', metric: 'size=2', note: 'Push second.' },
          ],
        },
        {
          id: 'visual-2',
          after: 'dryRun',
          title: 'Scan matrix row',
          caption: 'Measure the first row.',
          theme: 'ocean',
          frames: [
            { label: 'Read', items: ['1'], active: [0], state: 'row=1', metric: 'ans=1', note: 'Read row.' },
            { label: 'Done', items: ['1'], active: [0], state: 'done', metric: 'ans=1', note: 'Return size.' },
          ],
        },
      ],
    });

    expect(() => validateArticle(JSON.stringify(draft), context)).not.toThrow();
    const md = renderArticle(draft, context);

    expect(md).toContain('`priority_queue<pair<int, int>>`');
    expect(md).toContain('`vector<vector<int>>`');
    expect(md).toContain('reusing `vector<int>`');
    expect(md).toContain('Read `vector<int>` row size.');
    expect(md.split('## 💻 Accepted code')[0]).not.toContain('``');
    expect(md).not.toContain('`vector<`vector<int>`>`');
    expect(md).not.toContain('`priority_queue<`pair<int, int>`>`');
  });
});

describe('contestScheduler.ts fixes', () => {
  it('reuses existing DailyRun on force retry, runs recoverGeneration, extracts CoarenaPause code, and wakes scheduler', async () => {
    vi.resetModules();
    const locks = new Map<string, string>();
    const posts: Array<Record<string, any>> = [
      {
        id: 'post-existing',
        accountId: 'acc-1',
        problemSlug: 'smallest-pair',
        intent: 'contest-solution',
        status: 'FAILED',
        publishedUrl: null,
        lastError: 'GENERATION_FAILED',
        leaseUntil: null,
        retryCount: 1,
      },
    ];
    const recoverGeneration = vi.fn(async () => {});
    const notifyWork = vi.fn();
    const solveAndSubmit = vi.fn(async ({ question }: any) => {
      if (question.titleSlug === 'grid-jump') {
        const { CoarenaPause } = await import('../src/solutionPosts/coarenaLimits');
        throw new CoarenaPause('COARENA_RATE_LIMIT', new Date('2026-11-15T04:10:00Z'));
      }
      return {
        id: `run-acc-1-${question.titleSlug}`,
        accountId: 'acc-1',
        problemSlug: question.titleSlug,
        state: 'SUCCESS',
        submissionId: '101',
        submissionStatus: 'Accepted',
      };
    });
    const generateForRun = vi.fn(async () => ({
      id: 'post-existing',
      accountId: 'acc-1',
      problemSlug: 'smallest-pair',
      status: 'RETRY_PENDING',
      lastError: 'COARENA_DAILY_LIMIT',
      leaseUntil: new Date('2026-11-16T00:00:00Z'),
    }));

    const contest = {
      title: 'Weekly Contest 528',
      titleSlug: 'weekly-contest-528',
      kind: 'weekly' as const,
      startTimeSec: Math.floor(new Date('2026-11-15T02:30:00Z').getTime() / 1000),
      endTimeSec: Math.floor(new Date('2026-11-15T04:00:00Z').getTime() / 1000),
      questions: [
        { index: 0 as const, label: 'Q1' as const, title: 'Smallest Pair', titleSlug: 'smallest-pair', questionId: '1001', credit: 3 },
        { index: 1 as const, label: 'Q2' as const, title: 'Grid Jump', titleSlug: 'grid-jump', questionId: '1002', credit: 4 },
      ],
    };

    mockModule('../src/database/prisma', () => ({
      prisma: {
        account: { findMany: vi.fn(async () => [{ id: 'acc-1', status: 'ACTIVE' }]) },
        solutionPostPreference: { findMany: vi.fn(async () => [{ accountId: 'acc-1' }]) },
        solutionPost: {
          findUnique: vi.fn(async ({ where }: any) =>
            posts.find(
              p => p.accountId === where.accountId_problemSlug_intent.accountId &&
                p.problemSlug === where.accountId_problemSlug_intent.problemSlug,
            ) ?? null,
          ),
        },
        systemState: {
          create: vi.fn(async ({ data }: any) => {
            if (locks.has(data.key)) throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
            locks.set(data.key, data.value);
          }),
          upsert: vi.fn(async ({ where, create, update }: any) => {
            const key = where?.key ?? create.key;
            locks.set(key, locks.has(key) ? (update?.value ?? create.value) : create.value);
          }),
          findUnique: vi.fn(async ({ where }: any) => (locks.has(where.key) ? { key: where.key, value: locks.get(where.key)! } : null)),
          updateMany: vi.fn(async ({ where, data }: any) => {
            if (locks.get(where.key) !== where.value) return { count: 0 };
            locks.set(where.key, data.value);
            return { count: 1 };
          }),
          deleteMany: vi.fn(async ({ where }: any) => {
            if (locks.get(where.key) === where.value) locks.delete(where.key);
            return { count: 1 };
          }),
        },
      },
    }));
    mockModule('../src/leetcode/contest', () => ({
      fetchLatestEndedContest: vi.fn(async () => contest),
      selectStartingContestQuestions: (_c: any, indices: readonly (0 | 1)[]) => indices.map(i => contest.questions[i]).filter(Boolean),
    }));
    mockModule('../src/solutionPosts/contestSolver', () => ({ solveAndSubmitContestQuestion: solveAndSubmit }));
    mockModule('../src/solutionPosts/service', () => ({
      PostError: class extends Error { constructor(public readonly code: string) { super(code); } },
      generateForRun,
    }));
    mockModule('../src/solutionPosts/store', () => ({ recoverGeneration, approvePost: vi.fn() }));
    mockModule('../src/solutionPosts/schedulerGate', () => ({ notifySolutionPostSchedulerWork: notifyWork }));
    mockModule('../src/notifications/telegram', () => ({ sendTelegramMessage: vi.fn(async () => true) }));

    const { runContestSolutionWorkflow, runScheduledContestPosts } = await import('../src/solutionPosts/contestScheduler');

    const now = new Date('2026-11-15T04:01:00Z');
    const results = await runContestSolutionWorkflow({
      contest,
      questionIndices: [0, 1],
      accountIds: ['acc-1'],
      force: true,
      now,
    });

    expect(recoverGeneration).toHaveBeenCalledWith(now);
    // Q1 has existing failed post -> forceFreshSubmit must be false even when force=true.
    expect(solveAndSubmit.mock.calls[0]![0].forceFreshSubmit).toBe(false);
    // Q2 has no existing post -> forceFreshSubmit is true when force=true.
    expect(solveAndSubmit.mock.calls[1]![0].forceFreshSubmit).toBe(true);
    // Q1 returned RETRY_PENDING (CoarenaPause) and Q2 threw CoarenaPause -> both yield RETRY_PENDING + exact code + wake call.
    expect(results).toEqual([
      expect.objectContaining({ questionLabel: 'Q1', status: 'RETRY_PENDING', error: 'COARENA_DAILY_LIMIT' }),
      expect.objectContaining({ questionLabel: 'Q2', status: 'RETRY_PENDING', error: 'COARENA_RATE_LIMIT' }),
    ]);
    expect(notifyWork).toHaveBeenCalledTimes(2);

    recoverGeneration.mockClear();
    notifyWork.mockClear();
    const scheduled = await runScheduledContestPosts('weekly', now, 'cron');
    expect(scheduled.status).toBe('FINISHED');
    expect(recoverGeneration).toHaveBeenCalledWith(now);
    expect(notifyWork).toHaveBeenCalled();
  });
});

describe('service.ts retryPost and requeueInterruptedGeneration fixes', () => {
  it('retryPost verifies stored context via LeetCode when DailyRun was overwritten, and requeue clears both contest locks', async () => {
    vi.resetModules();
    const { contextSchema, hash } = await import('../src/solutionPosts/article');
    const { SOLUTION_ARTICLE_WORK_MS } = await import('../src/solutionPosts/router');

    const code = 'class Solution { public: int solve() { return 1; } };';
    const ctx = contextSchema.parse({
      accountId: 'acc-1',
      username: 'alice',
      problemId: '1',
      slug: 'two-sum',
      title: 'Two Sum',
      difficulty: 'Easy',
      problem: 'Find two numbers.',
      submissionId: '555',
      language: 'cpp',
      code,
      challengeDate: '2026-11-17',
    });

    const staleAt = new Date(Date.now() - SOLUTION_ARTICLE_WORK_MS - 30_000);
    let currentPost: any = {
      id: 'post-1',
      accountId: 'acc-1',
      problemSlug: 'two-sum',
      submissionId: '555',
      intent: 'community-solution',
      status: 'FAILED',
      lastError: 'AI_MODELS_EXHAUSTED',
      leaseUntil: null,
      retryCount: 1,
      codeHash: hash(code),
      context: JSON.stringify(ctx),
      updatedAt: staleAt,
    };

    const locks = new Map<string, { value: string; updatedAt: Date }>([
      ['contest-post-job:weekly-contest-529', { value: 'c-lock', updatedAt: new Date(staleAt.getTime() - 1000) }],
      ['contest-question-job:acc-1:weekly-contest-529:two-sum', { value: 'q-lock', updatedAt: new Date(staleAt.getTime() - 1000) }],
    ]);

    const awaitSubmission = vi.fn(async () => ({ classification: 'ACCEPTED' }));
    const generateArticle = vi.fn(async () => ({
      title: '✨ Direct Lookup Without Sorting or Extra Scans',
      markdown: '```cpp\n' + code + '\n```',
      model: 'mock-model',
      reviewModel: 'mock-review',
      style: 'minimal and clear',
      attempts: [],
      visuals: [{ id: 'visual-1' }, { id: 'visual-2' }],
      assets: [{ id: 'visual-1', url: 'https://assets.example.test/1.gif', alt: 'a' }, { id: 'visual-2', url: 'https://assets.example.test/2.gif', alt: 'b' }],
      visualFallback: false,
    }));

    const findUniqueOrThrowMock = vi.fn(async () => structuredClone(currentPost));

    mockModule('../src/database/prisma', () => ({
      prisma: {
        dailyRun: {
          findFirst: vi.fn(async ({ select }: any) => {
            if (select?.date) return { date: 'contest:weekly-contest-529:two-sum:2026-11-17' };
            return null; // Overwritten DailyRun slot -> returns null!
          }),
          findUniqueOrThrow: vi.fn(),
        },
        account: {
          findUniqueOrThrow: vi.fn(async () => ({
            id: 'acc-1',
            label: 'main',
            username: 'alice',
            status: 'ACTIVE',
            storageState: '{"cookies":[{"name":"LEETCODE_SESSION","value":"s"}],"origins":[]}',
          })),
        },
        solutionPost: {
          findUniqueOrThrow: findUniqueOrThrowMock,
          findUnique: vi.fn(async () => structuredClone(currentPost)),
          findMany: vi.fn(async () => []),
          upsert: vi.fn(async () => structuredClone(currentPost)),
          updateMany: vi.fn(async ({ where, data }: any) => {
            if (currentPost.id !== where.id || currentPost.status !== where.status) return { count: 0 };
            for (const [k, v] of Object.entries(data)) {
              currentPost[k] = typeof v === 'object' && v && 'increment' in v ? currentPost[k] + v.increment : v;
            }
            currentPost.updatedAt = new Date(currentPost.updatedAt.getTime() + 1);
            return { count: 1 };
          }),
        },
        systemState: {
          findUnique: vi.fn(async ({ where }: any) => locks.get(where.key) ?? null),
          create: vi.fn(async () => ({})),
          upsert: vi.fn(async () => ({})),
          deleteMany: vi.fn(async ({ where }: any) => {
            const existing = locks.get(where.key);
            if (existing && (!where.value || existing.value === where.value)) {
              locks.delete(where.key);
              return { count: 1 };
            }
            return { count: 0 };
          }),
        },
      },
    }));
    mockModule('playwright', () => ({
      chromium: {
        launch: vi.fn(async () => ({
          newContext: async () => ({ newPage: async () => ({}) }),
          close: async () => undefined,
        })),
      },
    }));
    mockModule('../src/browser/sessionCheck', () => ({
      checkSession: vi.fn(async () => ({ authenticated: true, username: 'alice' })),
    }));
    mockModule('../src/leetcode/apiClient', () => ({
      LeetCodeApi: class {
        awaitSubmission = awaitSubmission;
      },
    }));
    mockModule('../src/solutionPosts/article', async orig => ({
      ...(await orig() as object),
      generateArticle,
    }));
    mockModule('../src/solutionPosts/implementation', async orig => ({
      ...(await orig() as object),
      generateImplementation: vi.fn(async () => ({ value: { code, approach: 'Direct return' }, attempts: [] })),
    }));
    mockModule('../src/solutionPosts/presentation', async orig => ({
      ...(await orig() as object),
      reservePostPresentation: vi.fn(async () => ({
        layout: 'notebook',
        diagrams: ['timeline', 'rail'],
        themes: ['paper', 'coral'],
        visualVersion: 7,
        scenes: ['orbit', 'film'],
        directions: ['forward', 'forward'],
        motions: ['scan', 'slide'],
        format: { index: 0, optimization: true },
      })),
    }));
    mockModule('../src/solutionPosts/visualStore', () => ({
      storeVisualAssets: vi.fn(),
      verifyHostedVisualAssets: vi.fn(async () => true),
    }));
    mockModule('../src/solutionPosts/keyPool', async orig => ({
      ...(await orig() as object),
      loadSolutionKeyPool: vi.fn(async () => ({ keys: ['sk-test'], activeIndex: 0, stored: false })),
    }));
    mockModule('../src/solutionPosts/coarena', async orig => ({
      ...(await orig() as object),
      loadCoarenaKey: vi.fn(async () => null),
    }));

    const { retryPost, requeueInterruptedGeneration } = await import('../src/solutionPosts/service');

    // 1. Even with DailyRun missing (null), retryPost verifies stored context & live LeetCode verdict.
    const retried = await retryPost('post-1');
    expect(retried.status).toBe('AWAITING_APPROVAL');
    expect(awaitSubmission).toHaveBeenCalledWith('555', 'two-sum', 30000, { firstPollDelayMs: 0 });

    // 2. Rejected verdict when DailyRun is null throws ACCEPTED_SUBMISSION_REQUIRED.
    currentPost.status = 'FAILED';
    awaitSubmission.mockResolvedValueOnce({ classification: 'WRONG_ANSWER' });
    await expect(retryPost('post-1')).rejects.toThrow('ACCEPTED_SUBMISSION_REQUIRED');

    // 3. Tampered stored context code when DailyRun is null throws SOURCE_INTEGRITY_FAILED.
    currentPost.codeHash = '0'.repeat(64);
    await expect(retryPost('post-1')).rejects.toThrow('SOURCE_INTEGRITY_FAILED');

    // 4. requeueInterruptedGeneration clears BOTH contest-post-job and contest-question-job locks while keeping exact select.
    currentPost.intent = 'contest-solution';
    currentPost.status = 'GENERATING';
    currentPost.updatedAt = staleAt;
    findUniqueOrThrowMock.mockClear();

    const recovered = await requeueInterruptedGeneration('post-1', staleAt);
    expect(recovered.status).toBe('RETRY_PENDING');
    expect(locks.has('contest-post-job:weekly-contest-529')).toBe(false);
    expect(locks.has('contest-question-job:acc-1:weekly-contest-529:two-sum')).toBe(false);
    expect(findUniqueOrThrowMock.mock.calls[0]![0]).toEqual({
      where: { id: 'post-1' },
      select: {
        id: true,
        accountId: true,
        submissionId: true,
        intent: true,
        status: true,
        lastError: true,
        updatedAt: true,
      },
    });
  });
});

describe('upvote.ts fixes', () => {
  it('falls back to browser on UPVOTE_NOT_VERIFIED_ON_LEETCODE, returns latestHitCount, deduplicates cookies, and guards concurrent scheduling', async () => {
    vi.resetModules();

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://leetcode.com/graphql/') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (String(body.query).includes('userStatus')) {
          return new Response(JSON.stringify({ data: { userStatus: { isSignedIn: true, username: 'alice' } } }));
        }
        if (String(body.query).includes('hitResource')) {
          return new Response(JSON.stringify({ data: { hitResource: { ok: true, count: 42 } } }));
        }
        if (String(body.query).includes('ugcArticleAddReaction')) {
          return new Response(JSON.stringify({ data: { ugcArticleAddReaction: { ok: false } } }));
        }
        if (String(body.query).includes('ugcArticleSolutionArticle')) {
          return new Response(JSON.stringify({
            data: {
              ugcArticleSolutionArticle: {
                uuid: 'uuid-1',
                topicId: 88888,
                hitCount: 41,
                myReactionType: null,
                reactions: [{ count: 0, reactionType: 'UPVOTE' }],
              },
            },
          }));
        }
      }
      return new Response('{}');
    });
    vi.stubGlobal('fetch', fetchMock);

    const browserUpvote = vi.fn(async (_account: any, action: any) => {
      const api = {
        graphql: vi.fn()
          .mockResolvedValueOnce({
            ugcArticleSolutionArticle: { uuid: 'uuid-1', topicId: 88888, myReactionType: null, reactions: [{ count: 0, reactionType: 'UPVOTE' }] },
          })
          .mockResolvedValueOnce({ ugcArticleAddReaction: { ok: true } })
          .mockResolvedValueOnce({
            ugcArticleSolutionArticle: { uuid: 'uuid-1', topicId: 88888, myReactionType: 'UPVOTE', reactions: [{ count: 1, reactionType: 'UPVOTE' }] },
          }),
      };
      return action(api, undefined, 'alice');
    });

    mockModule('../src/solutionPosts/service', () => ({
      PostError: class extends Error { constructor(public readonly code: string) { super(code); } },
      withAccount: browserUpvote,
    }));
    mockModule('../src/database/prisma', () => ({
      prisma: {
        systemState: {
          findUnique: vi.fn(async () => null),
          findMany: vi.fn(async () => []),
          upsert: vi.fn(async () => ({})),
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
        account: {
          findFirst: vi.fn(async () => new Promise(resolve => setTimeout(() => resolve({
            id: 'acc-1',
            label: 'alice',
            username: 'alice',
            status: 'ACTIVE',
            storageState: '{"cookies":[]}',
          }), 15))),
          findMany: vi.fn(async () => []),
          update: vi.fn(async () => ({})),
        },
        solutionPost: {
          findMany: vi.fn(async () => []),
        },
      },
    }));
    mockModule('../src/notifications/telegram', () => ({
      sendTelegramMessage: vi.fn(async () => true),
      sendTelegramMessageWithId: vi.fn(async () => 1),
      editTelegramMessage: vi.fn(async () => true),
    }));

    const {
      cookieGraphqlClient,
      generateArticleViewsWithAccount,
      scheduleSolutionArticleUpvotes,
      upvoteSolutionArticleWithAccount,
    } = await import('../src/solutionPosts/upvote');

    const dupStorageState = JSON.stringify({
      cookies: [
        { name: 'LEETCODE_SESSION', value: 'stale_sess', domain: '.leetcode.com', expires: 1_900_000_000 },
        { name: 'LEETCODE_SESSION', value: 'fresh_sess', domain: 'leetcode.com', expires: 2_000_000_000 },
        { name: 'csrftoken', value: 'stale_csrf', domain: '.leetcode.com', expires: 1_900_000_000 },
        { name: 'csrftoken', value: 'fresh_csrf', domain: 'leetcode.com', expires: 2_000_000_000 },
      ],
    });
    const account = { id: 'acc-1', label: 'alice', username: 'alice', status: AccountStatus.ACTIVE, storageState: dupStorageState };

    const client = cookieGraphqlClient(account);
    expect(client).not.toBeNull();
    await client!.graphql('query { userStatus { isSignedIn username } }', {}, (await import('zod')).z.any());
    const gqlHeaders = fetchMock.mock.calls.at(-1)![1]?.headers as Record<string, string>;
    expect(gqlHeaders['x-csrftoken']).toBe('fresh_csrf');
    expect(gqlHeaders.cookie).toContain('LEETCODE_SESSION=fresh_sess');
    expect(gqlHeaders.cookie).not.toContain('stale_sess');
    expect(gqlHeaders.cookie).not.toContain('stale_csrf');

    fetchMock.mockClear();
    const viewRes = await generateArticleViewsWithAccount(account, 88888, 'https://leetcode.com/problems/two-sum/solutions/88888/x/', 'two-sum', 1, 0);
    expect(viewRes.latestHitCount).toBe(42);
    const viewHeaders = fetchMock.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(viewHeaders.cookie).toContain('LEETCODE_SESSION=fresh_sess');
    expect(viewHeaders.cookie).not.toContain('stale_sess');

    // Cookie GraphQL fails UPVOTE_NOT_VERIFIED_ON_LEETCODE -> must fall back to browser session and return latestHitCount!
    const upRes = await upvoteSolutionArticleWithAccount(account, 88888, 'https://leetcode.com/problems/two-sum/solutions/88888/x/', {
      generateViews: true,
      viewsCount: 1,
      delayMs: 0,
      problemSlug: 'two-sum',
    });
    expect(browserUpvote).toHaveBeenCalledTimes(1);
    expect(upRes).toMatchObject({ verified: true, method: 'graphql_uuid', viewsGenerated: 1, latestHitCount: 42 });

    // Concurrent scheduleSolutionArticleUpvotes calls for the same post ID must be deduplicated synchronously by schedulingIds.
    const post = {
      id: 'post-concurrent-1',
      publishedUrl: 'https://leetcode.com/problems/two-sum/solutions/88888/x/',
      accountId: 'acc-1',
      problemSlug: 'two-sum',
    };
    const [first, second] = await Promise.all([
      scheduleSolutionArticleUpvotes(post, { initialDelayMs: 0, accountGapMs: 0 }),
      scheduleSolutionArticleUpvotes(post, { initialDelayMs: 0, accountGapMs: 0 }),
    ]);
    expect([first.scheduled, second.scheduled].filter(Boolean)).toHaveLength(1);
    await new Promise(r => setTimeout(r, 30));
  });
});

describe('scheduler.ts intent filter fix', () => {
  it('filters solutionPost.findMany by intent: community-solution so contest posts do not mask daily drafts', async () => {
    vi.resetModules();
    const generateForRun = vi.fn(async () => ({ id: 'post-daily', status: 'AWAITING_APPROVAL', contentHash: 'h'.repeat(64) }));
    const posts = [
      { accountId: 'a', problemSlug: 'today', intent: 'contest-solution', status: 'PUBLISHED', retryCount: 1, updatedAt: new Date() },
    ];
    const findManyMock = vi.fn(async ({ where }: any) =>
      posts.filter(p => !where.intent || p.intent === where.intent),
    );

    mockModule('../src/database/prisma', () => ({
      prisma: {
        solutionPostPreference: { findMany: vi.fn(async () => [{ accountId: 'a' }]) },
        account: { findMany: vi.fn(async () => [{ id: 'a', status: 'ACTIVE' }]) },
        dailyRun: {
          findMany: vi.fn(async () => [
            { id: 'run-a', accountId: 'a', problemSlug: 'today', state: 'SUCCESS', submissionId: '101', submissionStatus: 'Accepted' },
          ]),
          findUnique: vi.fn(async () => ({
            id: 'run-a', accountId: 'a', problemSlug: 'today', state: 'SUCCESS', submissionId: '101', submissionStatus: 'Accepted',
          })),
        },
        solutionPost: {
          findMany: findManyMock,
          findUnique: vi.fn(async () => null),
        },
        systemState: {
          create: vi.fn(async () => ({})),
          findUnique: vi.fn(async () => null),
          upsert: vi.fn(async () => ({})),
          updateMany: vi.fn(async () => ({ count: 1 })),
          deleteMany: vi.fn(async () => ({ count: 1 })),
        },
      },
    }));
    mockModule('../src/solutionPosts/service', () => ({
      PostError: class extends Error { constructor(public readonly code: string) { super(code); } },
      generateForRun,
      resolveCurrentDaily: vi.fn(async () => ({ date: '2026-10-15', slug: 'today' })),
      retryPost: vi.fn(),
    }));
    mockModule('../src/solutionPosts/store', () => ({
      recoverGeneration: vi.fn(),
      approvePost: vi.fn(async (id: string) => ({ id, status: 'DRAFT_READY', contentHash: 'h'.repeat(64) })),
    }));
    mockModule('../src/solutionPosts/dailyPublication', () => ({
      publishDailyPost: vi.fn(async (id: string) => ({ id, status: 'PUBLISHED', publishedUrl: 'https://leetcode.com/p/1/' })),
      processDailyPublicationQueue: vi.fn(async () => {}),
    }));
    mockModule('../src/solutionPosts/publisher', () => ({ publishPost: vi.fn() }));

    const { runScheduledSolutionPosts } = await import('../src/solutionPosts/scheduler');
    const result = await runScheduledSolutionPosts(new Date('2026-10-15T00:30:00Z'));

    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ intent: 'community-solution' }),
    }));
    expect(result.status).toBe('FINISHED');
    expect(generateForRun).toHaveBeenCalledTimes(1);
  });
});

describe('dailyPublication.ts fixes', () => {
  it('resets failures on re-queue, deletes dead queue keys when not DRAFT_READY, and stops keep-alive before 60m cooldown', async () => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-17T00:00:00Z'));

    const states = new Map<string, string>();
    const posts = new Map<string, any>();
    const stopKeepAlive = vi.fn();
    const startKeepAlive = vi.fn(() => stopKeepAlive);

    const { postPresentationVariant } = await import('../src/solutionPosts/presentationStyles');
    const validCtx = JSON.stringify({
      accountId: 'a',
      username: 'alice',
      problemId: '1',
      slug: 'example',
      title: 'Example',
      difficulty: 'Easy',
      problem: 'Example problem.',
      submissionId: '1',
      language: 'cpp',
      code: 'class Solution {};',
      challengeDate: '2026-11-17',
      articleImplementation: { code: 'class Solution { int f() { return 1; } };', approach: 'Return one directly.' },
      presentation: postPresentationVariant(0, 0),
    });

    posts.set('a', { id: 'a', status: 'DRAFT_READY', approvedHash: 'h', context: validCtx });
    posts.set('dead', { id: 'dead', status: 'FAILED', approvedHash: null, context: validCtx });

    mockModule('../src/database/prisma', () => ({
      prisma: {
        solutionPost: { findUniqueOrThrow: vi.fn(async ({ where }: any) => ({ ...posts.get(where.id) })) },
        systemState: {
          findUnique: vi.fn(async ({ where }: any) => (states.has(where.key) ? { key: where.key, value: states.get(where.key)! } : null)),
          findMany: vi.fn(async ({ where }: any) =>
            [...states].filter(([k]) => k.startsWith(where.key.startsWith)).map(([key, value]) => ({ key, value })),
          ),
          create: vi.fn(async ({ data }: any) => {
            if (states.has(data.key)) throw Object.assign(new Error('dup'), { code: 'P2002' });
            states.set(data.key, data.value);
          }),
          updateMany: vi.fn(async ({ where, data }: any) => {
            if (states.get(where.key) !== where.value) return { count: 0 };
            states.set(where.key, data.value);
            return { count: 1 };
          }),
          upsert: vi.fn(async ({ where, create, update }: any) => {
            states.set(where.key, states.has(where.key) ? (update.value ?? states.get(where.key)!) : create.value);
          }),
          deleteMany: vi.fn(async ({ where }: any) => {
            states.delete(where.key);
            return { count: 1 };
          }),
        },
      },
    }));
    mockModule('../src/solutionPosts/keepAlive', () => ({ startArticleWorkKeepAlive: startKeepAlive }));
    mockModule('../src/solutionPosts/publisher', () => ({
      publishPost: vi.fn(async (id: string) => {
        const updated = { ...posts.get(id), status: 'PUBLISHED', publishedAt: new Date(), publishedUrl: 'https://leetcode.com/p/' + id };
        posts.set(id, updated);
        return updated;
      }),
    }));

    const {
      DAILY_PUBLICATION_STATE_KEY,
      processDailyPublicationQueue,
      publishDailyPost,
    } = await import('../src/solutionPosts/dailyPublication');

    // 1. Dead queue key whose post status !== DRAFT_READY is deleted during queue drain and releases keep-alive.
    const qKeyDead = 'solution-post-daily-publication:queue:dead';
    states.set(qKeyDead, JSON.stringify({ postId: 'dead', queuedAt: '2026-11-16T00:00:00Z', failures: 0 }));
    await processDailyPublicationQueue();
    expect(states.has(qKeyDead)).toBe(false);
    expect(stopKeepAlive).toHaveBeenCalledTimes(1);

    // 2. Re-queueing an exhausted entry resets failures to 0 via update: { value: queuePayload }.
    const qKeyA = 'solution-post-daily-publication:queue:a';
    states.set(qKeyA, JSON.stringify({ postId: 'a', queuedAt: '2026-11-16T00:00:00Z', failures: 4 }));
    states.set(DAILY_PUBLICATION_STATE_KEY, JSON.stringify({ nextAt: Date.now() + 60_000 }));
    const queued = await publishDailyPost('a');
    expect(queued.lastError).toBe('DAILY_PUBLICATION_COOLDOWN');
    expect(JSON.parse(states.get(qKeyA)!).failures).toBe(0);

    // 3. When the single remaining queued post publishes and enters 60m cooldown, stopQueueKeepAlive must be called immediately!
    states.set(DAILY_PUBLICATION_STATE_KEY, JSON.stringify({ nextAt: 0 }));
    await processDailyPublicationQueue();
    expect(states.has(qKeyA)).toBe(false);
    expect(startKeepAlive).toHaveBeenCalledTimes(2);
    expect(stopKeepAlive).toHaveBeenCalledTimes(2);
  });
});

describe('router.ts Sage cooldown, multi-key 429 rotation, and remainingTime bounding', () => {
  it('preserves HTTP_429 over cooled-down models for multi-key rotation, honors deferRateLimit, and bounds sageBlockedUntil sleeps', async () => {
    vi.resetModules();
    const { AIModelRouter } = await import('../src/solutionPosts/router');

    const api1 = {
      models: { list: vi.fn(async () => ({ data: [{ id: 'sage-broken' }, { id: 'sage-rate-limited' }] })) },
      chat: { completions: { create: vi.fn() } },
    };
    const api2 = {
      models: { list: vi.fn(async () => ({ data: [{ id: 'sage-broken' }, { id: 'sage-rate-limited' }] })) },
      chat: { completions: { create: vi.fn() } },
    };
    const sleep = vi.fn(async () => {});
    const rotate = vi.fn(async () => {});

    // Put 'sage-broken' into Sage model cooldown (2 consecutive 500s).
    api1.chat.completions.create
      .mockRejectedValueOnce(new OpenAI.InternalServerError(500, {}, 'err1', undefined))
      .mockRejectedValueOnce(new OpenAI.InternalServerError(500, {}, 'err2', undefined))
      .mockResolvedValueOnce({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] });

    await new AIModelRouter(
      {
        apiKey: 'k1',
        baseUrl: 'https://discovery-api.intern-ai.org.cn/v1',
        models: ['sage-broken', 'sage-rate-limited'],
        timeoutMs: 1000,
        retries: 1,
        maxTokens: 100,
        minRequestIntervalMs: 0,
      },
      api1 as never,
      sleep,
    ).generate([], t => t);

    // Put 'sage-rate-limited' first so it hits 429 on key 1, then 'sage-broken' is skipped as MODEL_TEMPORARILY_UNAVAILABLE.
    // Key 1 must STILL rotate to Key 2 because lastFailureReason remained 'HTTP_429'!
    api1.chat.completions.create.mockRejectedValueOnce(
      new OpenAI.RateLimitError(429, {}, 'rate limited', { 'retry-after': '1' }),
    );
    api2.chat.completions.create.mockResolvedValueOnce({
      choices: [{ finish_reason: 'stop', message: { content: 'recovered-from-key-2' } }],
    });

    const rotated = await new AIModelRouter(
      {
        apiKey: 'k1',
        apiKeys: ['k1', 'k2'],
        baseUrl: 'https://discovery-api.intern-ai.org.cn/v1',
        models: ['sage-rate-limited', 'sage-broken'],
        timeoutMs: 1000,
        retries: 0,
        maxTokens: 100,
        minRequestIntervalMs: 0,
      },
      undefined,
      sleep,
      undefined,
      rotate,
      key => (key === 'k1' ? api1 : api2) as never,
    ).generate([], t => t);

    expect(rotated.value).toBe('recovered-from-key-2');
    expect(rotate).toHaveBeenCalledWith('k1', 'HTTP_429');

    // Now trigger a 60s sageBlockedUntil cooldown (429 without Retry-After) and verify:
    // 1. deferRateLimit immediately throws HTTP_429 without sleeping.
    // 2. Without deferRateLimit, sleep is bounded by remainingTime(deadlineAt) and throws ARTICLE_TIME_BUDGET_EXCEEDED.
    api1.chat.completions.create.mockRejectedValueOnce(new OpenAI.RateLimitError(429, {}, 'rpm limit', undefined));
    const boundedSleep = vi.fn(async () => {});
    await expect(
      new AIModelRouter(
        {
          apiKey: 'k1',
          baseUrl: 'https://discovery-api.intern-ai.org.cn/v1',
          models: ['sage-rate-limited'],
          timeoutMs: 1000,
          retries: 0,
          maxTokens: 100,
          deferOnRateLimit: true,
        },
        api1 as never,
        boundedSleep,
      ).generate([], t => t),
    ).rejects.toMatchObject({ lastFailure: 'HTTP_429' });
    expect(boundedSleep).not.toHaveBeenCalled();

    // Deferred check stops immediately on a new router too.
    await expect(
      new AIModelRouter(
        {
          apiKey: 'k1',
          baseUrl: 'https://discovery-api.intern-ai.org.cn/v1',
          models: ['sage-rate-limited'],
          timeoutMs: 1000,
          retries: 0,
          maxTokens: 100,
          deferOnRateLimit: true,
          minRequestIntervalMs: 1500,
        },
        api1 as never,
        boundedSleep,
      ).generate([], t => t),
    ).rejects.toMatchObject({ lastFailure: 'HTTP_429' });
    expect(boundedSleep).not.toHaveBeenCalled();

    // Non-deferred router with tight deadlineAt bounds the 60s sageBlockedUntil sleep by remainingTime.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now());
    await expect(
      new AIModelRouter(
        {
          apiKey: 'k1',
          baseUrl: 'https://discovery-api.intern-ai.org.cn/v1',
          models: ['sage-rate-limited'],
          timeoutMs: 1000,
          retries: 0,
          maxTokens: 100,
          minRequestIntervalMs: 1500,
          deadlineAt: Date.now() + 2500,
        },
        api1 as never,
        boundedSleep,
      ).generate([], t => t),
    ).rejects.toMatchObject({ lastFailure: 'ARTICLE_TIME_BUDGET_EXCEEDED' });
    expect(boundedSleep).toHaveBeenCalledWith(2500);
  });
});

describe('routes.ts POST /admin/solutions/api-keys/test validation', () => {
  it('accepts Sage Inkstone models via validateSolutionPostModels and rejects invalid models with 400', async () => {
    vi.resetModules();
    const testKey = vi.fn(async (_key?: string, model?: string) => ({ ok: true, chatModel: model }));
    mockModule('../src/solutionPosts/keyPool', () => ({
      appendSolutionApiKeys: vi.fn(),
      solutionKeyPoolStatus: vi.fn(),
      testSolutionApiKey: testKey,
    }));
    mockModule('../src/database/prisma', () => ({
      prisma: {
        solutionPost: { findMany: vi.fn(async () => []) },
        solutionPostPreference: { findMany: vi.fn(async () => []) },
        systemState: { findUnique: vi.fn(async () => null) },
      },
    }));

    const { registerSolutionPostRoutes } = await import('../src/solutionPosts/routes');
    const app = Fastify();
    registerSolutionPostRoutes(app, h => h === 'Bearer admin-test');
    try {
      const sageRes = await app.inject({
        method: 'POST',
        url: '/admin/solutions/api-keys/test',
        headers: { authorization: 'Bearer admin-test' },
        payload: { model: 'deepseek-v4.1-flash-1017' },
      });
      expect(sageRes.statusCode).toBe(200);
      expect(testKey).toHaveBeenCalledWith(undefined, 'deepseek-v4.1-flash-1017');

      const badRes = await app.inject({
        method: 'POST',
        url: '/admin/solutions/api-keys/test',
        headers: { authorization: 'Bearer admin-test' },
        payload: { model: 'gpt-6-sol' },
      });
      expect(badRes.statusCode).toBe(400);

      const multiRes = await app.inject({
        method: 'POST',
        url: '/admin/solutions/api-keys/test',
        headers: { authorization: 'Bearer admin-test' },
        payload: { model: 'gpt-5.6-luna,gpt-5.6-terra' },
      });
      expect(multiRes.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe('contestSolver.ts session cleanup on checkSession failure', () => {
  it('closes the opened contest session when checkSessionFn throws before and after refresh', async () => {
    const { solveAndSubmitContestQuestion } = await import('../src/solutionPosts/contestSolver');
    const close1 = vi.fn(async () => undefined);
    const close2 = vi.fn(async () => undefined);
    const openSession = vi.fn()
      .mockResolvedValueOnce({ api: { submitSolution: vi.fn(), awaitSubmission: vi.fn() }, close: close1 })
      .mockResolvedValueOnce({ api: { submitSolution: vi.fn(), awaitSubmission: vi.fn() }, close: close2 });

    const deps = {
      prisma: {
        dailyRun: { findUnique: vi.fn(async () => null), upsert: vi.fn() },
        account: {
          findUnique: vi.fn(async () => ({
            id: 'acc-1',
            label: 'main',
            username: 'u1',
            status: AccountStatus.ACTIVE,
            storageState: '{"cookies":[{"name":"LEETCODE_SESSION","value":"s","domain":".leetcode.com"}],"origins":[]}',
            consecutiveFailures: 0,
            lastError: null,
            lastSuccessAt: null,
            lastCheckedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          })),
        },
      },
      openSession,
      checkSession: vi.fn()
        .mockRejectedValueOnce(new Error('network reset during check'))
        .mockResolvedValueOnce({ authenticated: false, cause: 'signed-out' as const })
        .mockRejectedValueOnce(new Error('network reset during recheck')),
      refreshAccount: vi.fn(async () => ({ status: 'refreshed' })),
    };

    const baseParams = {
      accountId: 'acc-1',
      contestSlug: 'weekly-contest-528',
      contestTitle: 'Weekly Contest 528',
      question: { index: 0 as const, label: 'Q1' as const, title: 'Demo', titleSlug: 'demo', questionId: '1', credit: 3 },
      istDate: '2026-11-15',
    };

    await expect(solveAndSubmitContestQuestion(baseParams, deps as never)).rejects.toThrow('network reset during check');
    expect(close1).toHaveBeenCalledTimes(1);

    const close3 = vi.fn(async () => undefined);
    openSession.mockResolvedValueOnce({ api: { submitSolution: vi.fn(), awaitSubmission: vi.fn() }, close: close3 });
    await expect(solveAndSubmitContestQuestion(baseParams, deps as never)).rejects.toThrow('network reset during recheck');
    expect(close2).toHaveBeenCalledTimes(1);
    expect(close3).toHaveBeenCalledTimes(1);
  });
});

describe('coarena.ts and implementation.ts fixes', () => {
  it('does not cache single-post ARTICLE_TIME_BUDGET_EXCEEDED into shared Coarena cooldowns and uses parseJSON in enableCoarena', async () => {
    vi.resetModules();
    mockModule('../src/database/models', () => ({
      getSystemState: vi.fn(async () => null),
      setSystemState: vi.fn(async () => undefined),
    }));
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      data: { free: true, usd_per_day: 5, today: { used_usd: 0, left_usd: 5, resets_at: Date.now() + 3600_000, requests_left: null } },
    })));

    const { AIModelRouter, RoutingError } = await import('../src/solutionPosts/router');
    const { CoarenaRouter, COARENA_WRITER, enableCoarena } = await import('../src/solutionPosts/coarena');

    const generateSpy = vi.spyOn(AIModelRouter.prototype, 'generate')
      .mockRejectedValueOnce(new RoutingError([], 'ARTICLE_TIME_BUDGET_EXCEEDED'))
      .mockResolvedValueOnce({ value: 'second-post-ok', model: COARENA_WRITER, attempts: [] })
      .mockImplementationOnce(async (_m, validate) => ({ value: validate('```json\r\n{"ready":true}\r\n```'), model: COARENA_WRITER, attempts: [] }))
      .mockImplementationOnce(async (_m, validate) => ({ value: validate('```\r\n{"ready":true}\r\n```'), model: COARENA_WRITER, attempts: [] }));

    const key = 'coa_shared_key_1234567890';
    const r1 = new CoarenaRouter(key, async () => { throw new Error('no fallback'); });
    await expect(r1.generatePrimary([{ role: 'user', content: 'hi' }], t => t)).rejects.toMatchObject({ code: 'COARENA_CAPACITY' });

    // A second router with the exact same key must NOT inherit a process-wide cooldown from r1's single-post time budget!
    const r2 = new CoarenaRouter(key, async () => { throw new Error('no fallback'); });
    const ok = await r2.generatePrimary([{ role: 'user', content: 'hi' }], t => t);
    expect(ok.value).toBe('second-post-ok');

    // enableCoarena accepts fenced CRLF JSON replies via parseJSON.
    const enabled = await enableCoarena(key);
    expect(enabled.enabled).toBe(true);
    expect(generateSpy).toHaveBeenCalledTimes(4);
  });

  it('implementation.ts parses fenced CRLF JSON and treats # as comment for python3/python/pythondata/ruby/bash', async () => {
    const { contextSchema } = await import('../src/solutionPosts/article');
    const { generateImplementation, implementationFingerprint } = await import('../src/solutionPosts/implementation');
    const { AIModelRouter } = await import('../src/solutionPosts/router');

    for (const lang of ['python3', 'python', 'pythondata', 'ruby', 'bash'] as const) {
      const a = lang === 'ruby'
        ? 'def solve(x)\n  x + 1\nend'
        : lang === 'bash'
          ? 'echo "$1"'
          : 'def solve(nums):\n    return nums[0] // 2';
      const b = `${a}  # trailing comment`;
      expect(implementationFingerprint(a, lang)).toBe(implementationFingerprint(b, lang));
    }
    // Python variants keep // floor division distinct from /
    expect(implementationFingerprint('def f(a):\n  return a // 2', 'python')).not.toBe(
      implementationFingerprint('def f(a):\n  return a / 2', 'python'),
    );
    // C++ does NOT treat # as a comment
    expect(implementationFingerprint('#define X 1\nint f() { return X; }', 'cpp')).not.toBe(
      implementationFingerprint('int f() { return X; }', 'cpp'),
    );

    const ctx = contextSchema.parse({
      accountId: 'a',
      username: 'alice',
      problemId: '1',
      slug: 'demo',
      title: 'Demo',
      difficulty: 'Easy',
      problem: 'Return doubled value.',
      submissionId: '123',
      language: 'python',
      code: 'def solve(x):\n    return x + x',
      challengeDate: '2026-11-17',
    });

    const router = new AIModelRouter({ apiKey: 'k', baseUrl: 'https://example.test', models: ['m'], timeoutMs: 1000, retries: 0, maxTokens: 512 });
    const responses = [
      '```json\r\n{"code":"def solve(x):\\n    return 2 * x","approach":"Multiply directly."}\r\n```',
      '```json\r\n{"issues":[]}\r\n```',
    ];
    vi.spyOn(router, 'generate').mockImplementation(async (_m, validate) => ({
      value: validate(responses.shift()!),
      model: 'm',
      attempts: [{ model: 'm', attempt: 1, elapsedMs: 1, outcome: 'SUCCESS' }],
    }));
    const res = await generateImplementation(router, ctx, [], async () => true);
    expect(res.value.code).toBe('def solve(x):\n    return 2 * x');
  });
});

describe('keyPool.ts removeSolutionApiKey fix', () => {
  it('preserves exhausted activeIndex and lastFailure when trailing slot is deleted after earlier keys retired', async () => {
    vi.resetModules();
    let stored: string | null = null;
    mockModule('../src/config', () => ({
      config: {
        api: { setupToken: 'test-token' },
        schedule: { timezone: 'Asia/Kolkata' },
        solutionPosts: { apiKeys: [], baseUrl: 'https://codecraftapi.com/v1', models: ['gpt-5.6-terra'] },
      },
    }));
    mockModule('../src/database/models', () => ({
      getSystemState: vi.fn(async () => stored),
      setSystemState: vi.fn(async (_k: string, v: string) => { stored = v; }),
    }));

    const {
      loadSolutionKeyPool,
      removeSolutionApiKey,
      replaceSolutionApiKeys,
      rotateSolutionApiKey,
    } = await import('../src/solutionPosts/keyPool');

    await replaceSolutionApiKeys('dead_key_0001,trailing_key_0002');
    await rotateSolutionApiKey('dead_key_0001', 'HTTP_401');

    const { pool } = await removeSolutionApiKey(2);
    expect(pool.keys).toEqual(['dead_key_0001']);
    expect(pool.activeIndex).toBe(1);
    expect(pool.lastFailure).toBe('HTTP_401');

    // Reloading must NOT revive the retired key.
    const reloaded = await loadSolutionKeyPool();
    expect(reloaded.activeIndex).toBe(1);
    expect(reloaded.lastFailure).toBe('HTTP_401');
  });
});

describe('visualStore.ts and SVG escaping / code-point slicing fixes', () => {
  it('returns false when response.arrayBuffer() throws in verifyHostedVisualAssets', async () => {
    const { verifyHostedVisualAssets } = await import('../src/solutionPosts/visualStore');
    const h1 = 'a'.repeat(64);
    const h2 = 'b'.repeat(64);
    const assets = [
      { id: 'visual-1', url: `https://assets.example.test/solution-assets/${h1}.gif`, alt: 'one' },
      { id: 'visual-2', url: `https://assets.example.test/solution-assets/${h2}.gif`, alt: 'two' },
    ];
    const fetcher = vi.fn(async () => ({
      ok: true,
      headers: new Headers({ 'content-type': 'image/gif' }),
      arrayBuffer: async () => { throw new Error('stream aborted'); },
    })) as unknown as typeof fetch;

    await expect(verifyHostedVisualAssets(assets, 'https://assets.example.test', fetcher)).resolves.toBe(false);
  });

  it('strips XML 1.0 illegal control characters in all SVG renderers and avoids lone surrogates in visualRenderer.ts', async () => {
    const { visualPlanSchema, renderVisualFrame } = await import('../src/solutionPosts/visuals');
    const { renderAccountVisualFrame } = await import('../src/solutionPosts/visualRenderer');
    const { renderAnimatedScene } = await import('../src/solutionPosts/animatedScenes');
    const { renderQuestionIllustration } = await import('../src/solutionPosts/questionIllustration');

    const dirtyText = 'Ok\x00\x07\x0B\x0C\x1F\uFFFE\uFFFF!';
    const emojiWrap = '🚀🔥💡🎯📌✨🧮🔍';

    const basePlan = visualPlanSchema.parse({
      id: 'visual-1',
      after: 'intuition',
      title: `Title ${dirtyText}`,
      caption: 'Watch items update.',
      theme: 'aurora',
      frames: [
        { label: `L1 ${dirtyText}`, items: ['A', 'B'], active: [0], state: `${emojiWrap} ${emojiWrap} ${dirtyText}`, metric: `M${dirtyText}`, note: `N${dirtyText}` },
        { label: 'L2', items: ['A', 'B'], active: [1], state: 'done', metric: '2', note: 'end' },
      ],
    });

    const svgs = [
      renderVisualFrame(basePlan, 0),
      renderAccountVisualFrame({ ...basePlan, layout: 'storyboard' }, 0, 0.5),
      renderAnimatedScene({ ...basePlan, scene: 'orbit' }, 0, 0.5),
      renderQuestionIllustration(basePlan, 'sequence', 0, 0.5),
    ];

    for (const svg of svgs) {
      expect(XML_ILLEGAL_CONTROL_RE.test(svg)).toBe(false);
      // Verify no lone UTF-16 surrogates (toWellFormed or regex check)
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(svg)).toBe(false);
    }

    // Exercise narrow box wrapping with astral emojis in visualRenderer.ts
    const narrow = renderAccountVisualFrame(
      {
        ...basePlan,
        layout: 'timeline',
        frames: [
          {
            label: 'Emoji wrap',
            items: ['🚀🔥💡🎯📌✨🧮🔍', '🚀🔥💡🎯📌✨🧮🔍'],
            active: [0],
            state: '🚀🔥💡🎯📌✨🧮🔍🚀🔥💡🎯📌✨🧮🔍',
            metric: '🚀🔥💡🎯',
            note: '🚀🔥💡🎯📌✨🧮🔍',
          },
          basePlan.frames[1]!,
        ],
      },
      0,
      0.5,
    );
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(narrow)).toBe(false);
    expect(XML_ILLEGAL_CONTROL_RE.test(narrow)).toBe(false);
  });
});

describe('serverTest.ts and providerDiagnostics.ts fixes', () => {
  it('serverTest requires approvedHash === contentHash on DRAFT_READY before publishing', async () => {
    vi.resetModules();
    vi.stubEnv('RENDER_INSTANCE_ID', 'render-1');

    const rows = new Map<string, string>();
    const generateForRun = vi.fn();
    const approvePost = vi.fn();
    const publishPost = vi.fn();

    mockModule('../src/database/prisma', () => ({
      prisma: {
        account: { findUniqueOrThrow: async () => ({ id: 'a', status: 'ACTIVE' }) },
        dailyRun: { findUniqueOrThrow: async () => ({ accountId: 'a', problemSlug: 'example', state: 'SUCCESS', submissionStatus: 'Accepted', submissionId: '123' }) },
        solutionPost: { findUniqueOrThrow: async () => ({}), findUnique: async () => null },
        systemState: {
          findUnique: async ({ where }: any) => (rows.has(where.key) ? { value: rows.get(where.key) } : null),
          findUniqueOrThrow: async ({ where }: any) => ({ value: rows.get(where.key) }),
          create: async ({ data }: any) => { rows.set(data.key, data.value); },
          upsert: async ({ where, create, update }: any) => rows.set(where.key, rows.has(where.key) ? update.value : create.value),
          updateMany: async ({ where, data }: any) => {
            if (rows.get(where.key) !== where.value) return { count: 0 };
            rows.set(where.key, data.value);
            return { count: 1 };
          },
          deleteMany: async ({ where }: any) => { rows.delete(where.key); return { count: 1 }; },
        },
      },
    }));
    mockModule('../src/solutionPosts/service', () => ({
      generateForRun,
      loadContext: vi.fn(),
      createPostRouter: vi.fn(),
      withAccount: vi.fn(),
      PostError: class extends Error { constructor(public readonly code: string) { super(code); } },
    }));
    mockModule('../src/solutionPosts/store', () => ({ approvePost }));
    mockModule('../src/solutionPosts/publisher', async orig => ({ ...(await orig() as object), publishPost }));
    mockModule('../src/solutionPosts/dailyPublication', () => ({ publishDailyPost: publishPost, dailyPublicationStatus: vi.fn() }));
    mockModule('../src/solutionPosts/scheduler', () => ({ acquireDailyLease: async () => async () => {} }));

    const { configureServerTest, readServerTest, startServerTest } = await import('../src/solutionPosts/serverTest');
    await configureServerTest('a');

    // DRAFT_READY with mismatched approvedHash triggers approvePost -> if still mismatched, refuses to publish with REVIEW_REQUIRED.
    generateForRun.mockResolvedValueOnce({ id: 'post-1', status: 'DRAFT_READY', contentHash: 'hash-a', approvedHash: 'stale-hash' });
    approvePost.mockResolvedValueOnce({ id: 'post-1', status: 'DRAFT_READY', contentHash: 'hash-a', approvedHash: 'stale-hash' });
    const job1 = await startServerTest('run-1');
    await vi.waitFor(async () => expect((await readServerTest(job1.id)).status).toBe('FAILED'));
    expect((await readServerTest(job1.id)).lastError).toBe('REVIEW_REQUIRED');
    expect(approvePost).toHaveBeenCalledWith('post-1', 'hash-a');
    expect(publishPost).not.toHaveBeenCalled();

    // DRAFT_READY with null approvedHash gets approved and published when hashes match.
    approvePost.mockClear();
    generateForRun.mockResolvedValueOnce({ id: 'post-2', status: 'DRAFT_READY', contentHash: 'hash-b', approvedHash: null });
    approvePost.mockResolvedValueOnce({ id: 'post-2', status: 'DRAFT_READY', contentHash: 'hash-b', approvedHash: 'hash-b' });
    publishPost.mockResolvedValueOnce({ id: 'post-2', status: 'PUBLISHED', publishedUrl: 'https://leetcode.com/p/2', lastError: null });
    const job2 = await startServerTest('run-2');
    await vi.waitFor(async () => expect((await readServerTest(job2.id)).status).toBe('PUBLISHED'));
    expect(approvePost).toHaveBeenCalledWith('post-2', 'hash-b');
    expect(publishPost).toHaveBeenCalledWith('post-2');
  });

  it('providerDiagnostics wraps Firecrawl credit-usage fetch in try/catch with logger.warn', async () => {
    vi.resetModules();
    vi.stubEnv('SOLUTION_POST_VERIFY_ON_BOOT', 'true');
    const info = vi.fn();
    const warn = vi.fn();

    mockModule('../src/config', () => ({
      config: {
        solutionPosts: {
          aiProvider: 'firecrawl',
          firecrawlApiKey: 'fc-secret-credit-key-123456',
          agentMaxCredits: 300,
        },
      },
    }));
    mockModule('../src/logger', () => ({ logger: { info, warn } }));
    mockModule('../src/database/models', () => ({ setSystemState: vi.fn() }));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('dns failure fc-secret-credit-key-123456'); }));

    const { verifySolutionProviderOnBoot } = await import('../src/solutionPosts/providerDiagnostics');
    await expect(verifySolutionProviderOnBoot()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('fc-secret-credit-key-123456');
  });
});
