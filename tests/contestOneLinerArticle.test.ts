import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SolutionPost } from '@prisma/client';

const mocks = vi.hoisted(() => {
  type PostRow = Record<string, any>;
  type RunRow = Record<string, any>;
  type AccountRow = Record<string, any>;
  type StateRow = { key: string; value: string; updatedAt: Date };

  const state = {
    posts: [] as PostRow[],
    runs: [] as RunRow[],
    accounts: [] as AccountRow[],
    systemState: new Map<string, StateRow>(),
    seq: 0,
  };

  function matchesWhere(row: Record<string, any>, where: Record<string, any>): boolean {
    for (const [key, val] of Object.entries(where)) {
      if (key === 'OR' && Array.isArray(val)) {
        if (!val.some(clause => matchesWhere(row, clause))) return false;
        continue;
      }
      if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)) {
        if ('not' in val) {
          if (row[key] === val.not) return false;
        } else if ('in' in val && Array.isArray(val.in)) {
          if (!val.in.includes(row[key])) return false;
        } else if ('lte' in val) {
          if (!(row[key] <= val.lte)) return false;
        } else if ('startsWith' in val) {
          if (typeof row[key] !== 'string' || !row[key].startsWith(val.startsWith)) return false;
        }
        continue;
      }
      if (row[key] !== val) return false;
    }
    return true;
  }

  function applyUpdate(row: PostRow, data: Record<string, any>): PostRow {
    const next = { ...row };
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('increment' in v) next[k] = Number(next[k] ?? 0) + Number(v.increment);
        else if ('decrement' in v) next[k] = Number(next[k] ?? 0) - Number(v.decrement);
        else next[k] = v;
      } else {
        next[k] = v;
      }
    }
    next.updatedAt = new Date();
    return next;
  }

  return {
    state,
    reset() {
      state.posts = [];
      state.runs = [];
      state.accounts = [];
      state.systemState.clear();
      state.seq = 0;
      this.storeVisualAssets.mockReset();
      this.awaitSubmission.mockReset();
      this.fetchQuestionData.mockReset();
      this.loadCoarenaKey.mockReset();
      this.loadSolutionKeyPool.mockReset();
      this.checkSession.mockReset();
    },
    storeVisualAssets: vi.fn(),
    awaitSubmission: vi.fn(),
    fetchQuestionData: vi.fn(),
    loadCoarenaKey: vi.fn(),
    loadSolutionKeyPool: vi.fn(),
    checkSession: vi.fn(),
    prisma: {
      dailyRun: {
        findUniqueOrThrow: vi.fn(async ({ where }: any) => {
          const hit = state.runs.find(r => matchesWhere(r, where));
          if (!hit) throw new Error(`DailyRun not found: ${JSON.stringify(where)}`);
          return hit;
        }),
        findFirst: vi.fn(async ({ where }: any) => state.runs.find(r => matchesWhere(r, where)) ?? null),
      },
      account: {
        findUniqueOrThrow: vi.fn(async ({ where }: any) => {
          const hit = state.accounts.find(a => matchesWhere(a, where));
          if (!hit) throw new Error(`Account not found: ${JSON.stringify(where)}`);
          return hit;
        }),
      },
      solutionPost: {
        findUnique: vi.fn(async ({ where }: any) => {
          if (where.id) return state.posts.find(p => p.id === where.id) ?? null;
          if (where.accountId_problemSlug_intent) {
            const k = where.accountId_problemSlug_intent;
            return state.posts.find(p =>
              p.accountId === k.accountId && p.problemSlug === k.problemSlug && (p.intent ?? 'community-solution') === k.intent) ?? null;
          }
          return null;
        }),
        findUniqueOrThrow: vi.fn(async ({ where }: any) => {
          const hit = state.posts.find(p => matchesWhere(p, where));
          if (!hit) throw new Error(`SolutionPost not found: ${JSON.stringify(where)}`);
          return hit;
        }),
        findMany: vi.fn(async ({ where, take }: any) => {
          const filtered = state.posts.filter(p => !where || matchesWhere(p, where));
          return typeof take === 'number' ? filtered.slice(0, take) : filtered;
        }),
        create: vi.fn(async ({ data }: any) => {
          const dup = state.posts.find(p =>
            p.accountId === data.accountId &&
            p.problemSlug === data.problemSlug &&
            (p.intent ?? 'community-solution') === (data.intent ?? 'community-solution'));
          if (dup) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
          state.seq += 1;
          const now = new Date();
          const row: PostRow = {
            id: `post-${state.seq}`,
            status: 'PENDING',
            intent: 'community-solution',
            retryCount: 0,
            lastError: null,
            leaseUntil: null,
            title: null,
            markdown: null,
            style: null,
            model: null,
            reviewModel: null,
            attempts: null,
            contentHash: null,
            approvedHash: null,
            createdAt: now,
            updatedAt: now,
            ...data,
          };
          state.posts.push(row);
          return row;
        }),
        upsert: vi.fn(async ({ where, create, update }: any) => {
          const k = where.accountId_problemSlug_intent;
          const existing = k
            ? state.posts.find(p =>
              p.accountId === k.accountId &&
              p.problemSlug === k.problemSlug &&
              (p.intent ?? 'community-solution') === k.intent)
            : undefined;
          if (existing) {
            if (update && Object.keys(update).length) {
              return applyUpdate(existing, update);
            }
            return existing;
          }
          return mocks.prisma.solutionPost.create({ data: create });
        }),
        updateMany: vi.fn(async ({ where, data }: any) => {
          let count = 0;
          state.posts = state.posts.map(p => {
            if (!matchesWhere(p, where)) return p;
            count += 1;
            return applyUpdate(p, data);
          });
          return { count };
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const idx = state.posts.findIndex(p => matchesWhere(p, where));
          if (idx === -1) throw new Error('SolutionPost update miss');
          state.posts[idx] = applyUpdate(state.posts[idx]!, data);
          return state.posts[idx]!;
        }),
      },
      systemState: {
        findUnique: vi.fn(async ({ where }: any) => state.systemState.get(where.key) ?? null),
        upsert: vi.fn(async ({ where, create, update }: any) => {
          const existing = state.systemState.get(where.key);
          const next = {
            key: where.key,
            value: existing ? update.value : create.value,
            updatedAt: new Date(),
          };
          state.systemState.set(where.key, next);
          return next;
        }),
        create: vi.fn(async ({ data }: any) => {
          if (state.systemState.has(data.key)) throw Object.assign(new Error('Duplicate'), { code: 'P2002' });
          const row = { key: data.key, value: data.value, updatedAt: new Date() };
          state.systemState.set(data.key, row);
          return row;
        }),
        updateMany: vi.fn(async ({ where, data }: any) => {
          const cur = state.systemState.get(where.key);
          if (!cur || (where.value !== undefined && cur.value !== where.value)) return { count: 0 };
          state.systemState.set(where.key, { ...cur, ...data, updatedAt: new Date() });
          return { count: 1 };
        }),
        deleteMany: vi.fn(async ({ where }: any) => {
          let count = 0;
          for (const [k, v] of [...state.systemState.entries()]) {
            if (where.key?.startsWith && k.startsWith(where.key.startsWith)) {
              state.systemState.delete(k); count += 1;
            } else if (typeof where.key === 'string' && k === where.key && (!where.value || v.value === where.value)) {
              state.systemState.delete(k); count += 1;
            }
          }
          return { count };
        }),
      },
    },
  };
});

vi.mock('../src/database/prisma', () => ({ prisma: mocks.prisma }));
vi.mock('../src/database/models', () => ({
  getSystemState: vi.fn(async (key: string) => mocks.state.systemState.get(key)?.value ?? null),
  setSystemState: vi.fn(async (key: string, value: string) => {
    mocks.state.systemState.set(key, { key, value, updatedAt: new Date() });
  }),
}));
vi.mock('../src/database/accounts', () => ({
  parseStoredStorageState: vi.fn(() => ({ ok: true, state: { cookies: [] } })),
}));
vi.mock('../src/browser/sessionCheck', () => ({
  checkSession: mocks.checkSession,
}));
vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn(async () => ({
      newContext: async () => ({
        newPage: async () => ({}),
      }),
      close: async () => undefined,
    })),
  },
}));
vi.mock('../src/leetcode/apiClient', () => ({
  LeetCodeApi: class {
    awaitSubmission = mocks.awaitSubmission;
  },
}));
vi.mock('../src/leetcode/dailyChallenge', () => ({
  fetchDailyChallenge: vi.fn(),
  fetchQuestionData: mocks.fetchQuestionData,
}));
vi.mock('../src/solutionPosts/visualStore', () => ({
  storeVisualAssets: mocks.storeVisualAssets,
}));
vi.mock('../src/solutionPosts/coarena', async importOriginal => {
  const original = await importOriginal<typeof import('../src/solutionPosts/coarena')>();
  return {
    ...original,
    loadCoarenaKey: mocks.loadCoarenaKey,
    loadCoarenaModelOrder: vi.fn(async () => undefined),
  };
});
vi.mock('../src/solutionPosts/keyPool', () => ({
  loadSolutionKeyPool: mocks.loadSolutionKeyPool,
  maskSolutionApiKey: (k: string) => `${k.slice(0, 4)}***`,
  resetSolutionApiKeyPool: vi.fn(async () => ({ keys: ['sk-test-key'], activeIndex: 0, stored: false })),
  rotateSolutionApiKey: vi.fn(async () => ({ keys: ['sk-test-key'], activeIndex: 0, stored: false })),
}));

import {
  articleNeedsRefresh,
  compactArticlePrompt,
  contextSchema,
  generateArticle,
  renderArticle,
  validateArticle,
  type SubmissionContext,
} from '../src/solutionPosts/article';
import { generateImplementation } from '../src/solutionPosts/implementation';
import { CoarenaRouter } from '../src/solutionPosts/coarena';
import { ensurePost } from '../src/solutionPosts/store';
import {
  generateForRun,
  generatePost,
  loadContext,
  requeueInterruptedGeneration,
} from '../src/solutionPosts/service';
import { AIModelRouter, OutputValidationError, SOLUTION_ARTICLE_WORK_MS } from '../src/solutionPosts/router';
import { postPresentationVariant } from '../src/solutionPosts/presentation';
import { verifyArticleCode } from '../src/solutionPosts/publisher';

function baseContext(overrides: Partial<SubmissionContext> = {}): SubmissionContext {
  return {
    accountId: 'acc-1',
    username: 'alice',
    problemId: '9901',
    slug: 'sum-of-unique-pair-values',
    title: 'Sum of Unique Pair Values',
    difficulty: 'Easy',
    problem: 'Given integer array nums, return the sum of its maximum and minimum elements.',
    submissionId: '9001',
    language: 'python3',
    code: 'class Solution:\n    def minMaxSum(self, nums: List[int]) -> int:\n        return min(nums) + max(nums)',
    challengeDate: '2026-11-15',
    topicTags: [{ name: 'Array', slug: 'array' }],
    ...overrides,
  };
}

function humanOneLinerArticlePayload(overrides: Record<string, any> = {}) {
  return {
    title: '⚡ One-Line Min Plus Max Trick for Contest Q1',
    sections: [
      {
        kind: 'intuition',
        heading: 'Core Contest Trick',
        markdown: 'You only ever need two values from `nums`, so Python does both scans in one crisp expression.',
      },
      {
        kind: 'approach',
        heading: 'Breaking Down `min(nums) + max(nums)`',
        markdown: '- `min(nums)` grabs the smallest integer.\n- `max(nums)` grabs the largest integer.\n- Add them right away and return.',
      },
      {
        kind: 'correctness',
        heading: 'Why It Always Works',
        markdown: 'Any non-empty array always has well-defined extreme values, so adding `min` and `max` yields the exact answer.',
      },
      {
        kind: 'dryRun',
        heading: 'Quick Walk on `[3, 7]`',
        markdown: '**Input:** `nums = [3, 7]`\n\n`min(nums)` returns `3`, `max(nums)` returns `7`, and their sum is `10`.\n\n**Output:** `10`',
      },
      {
        kind: 'takeaways',
        heading: 'Contest Note',
        markdown: 'Skip sorting here because two linear scans keep it short, readable, and O(n) fast.',
      },
    ],
    time: { bound: 'O(n)', reason: 'Each built-in scans the n elements once.' },
    space: { bound: 'O(1)', reason: 'Only tracks two scalars with no extra array.' },
    visuals: [
      {
        id: 'visual-1',
        after: 'intuition',
        title: 'Spot Both Extremes',
        caption: 'Compare current minimum and maximum.',
        theme: 'aurora',
        frames: [
          { label: 'Scan start', items: ['3', '7', '2'], active: [0], state: 'min=3 max=3', metric: 'idx=0', note: 'Seed min and max' },
          { label: 'See larger', items: ['3', '7', '2'], active: [1], state: 'min=3 max=7', metric: 'idx=1', note: 'Update max to 7' },
          { label: 'See smaller', items: ['3', '7', '2'], active: [2], state: 'min=2 max=7', metric: 'idx=2', note: 'Update min to 2' },
        ],
      },
      {
        id: 'visual-2',
        after: 'dryRun',
        title: 'Evaluate 1-Liner',
        caption: 'Trace `[3, 7]` through both built-ins.',
        theme: 'ocean',
        frames: [
          { label: 'Find min', items: ['3', '7'], active: [0], state: 'min(nums) = 3', metric: 'step=1', note: 'Smallest item is 3' },
          { label: 'Find max', items: ['3', '7'], active: [1], state: 'max(nums) = 7', metric: 'step=2', note: 'Largest item is 7' },
          { label: 'Add result', items: ['3', '7'], active: [0, 1], state: '3 + 7 = 10', metric: 'ans=10', note: 'Return 10' },
        ],
      },
    ],
    ...overrides,
  };
}

function makeFakeGifAssets() {
  return [
    { id: 'visual-1', url: 'https://cdn.example.com/assets/v1.gif', alt: 'Concept visual showing min and max scan' },
    { id: 'visual-2', url: 'https://cdn.example.com/assets/v2.gif', alt: 'Walkthrough visual showing 1-liner result' },
  ];
}

function createMockStagedRouter(oneLinerPayload = humanOneLinerArticlePayload()) {
  const calls: Array<{ label: string; system: string; user: string }> = [];
  const sectionsByKind = new Map(oneLinerPayload.sections.map((s: any) => [s.kind, { heading: s.heading, markdown: s.markdown }]));
  const [v1, v2] = oneLinerPayload.visuals;

  const generate = vi.fn(async (messages: any[], validate: (text: string) => any, _maxTokens: number, _strict: boolean, label = '') => {
    const system = String(messages[0]?.content ?? '');
    const user = String(messages[1]?.content ?? '');
    calls.push({ label, system, user });
    let raw: unknown;
    if (label === 'title and intuition') {
      raw = { title: oneLinerPayload.title, section: sectionsByKind.get('intuition') };
    } else if (label === 'approach and complexity') {
      raw = { section: sectionsByKind.get('approach'), time: oneLinerPayload.time, space: oneLinerPayload.space };
    } else if (label === 'correctness callout') {
      raw = sectionsByKind.get('correctness');
    } else if (label === 'dry run') {
      raw = sectionsByKind.get('dryRun');
    } else if (label === 'takeaway callout') {
      raw = sectionsByKind.get('takeaways');
    } else if (label === 'concept animation first frame') {
      raw = { title: v1.title, caption: v1.caption, theme: v1.theme, frame: v1.frames[0] };
    } else if (label === 'concept animation next frame') {
      raw = { frame: v1.frames[1] };
    } else if (label === 'dry-run animation first frame') {
      raw = { title: v2.title, caption: v2.caption, theme: v2.theme, frame: v2.frames[0] };
    } else if (label === 'dry-run animation next frame') {
      raw = { frame: v2.frames[1] };
    } else if (label === 'technical review') {
      raw = { approved: true, issues: [] };
    } else {
      throw new Error(`Unexpected staged router call: ${label}`);
    }
    const serialized = JSON.stringify(raw);
    return {
      value: validate(serialized),
      model: 'mock-model',
      attempts: [{ model: 'mock-model', provider: 'discovery' as const, attempt: 1, elapsedMs: 5, outcome: 'SUCCESS' as const }],
    };
  });

  return {
    router: { generate } as unknown as AIModelRouter,
    calls,
    generate,
  };
}

describe('Contest one-liner article pipeline', () => {
  beforeEach(() => {
    mocks.reset();
    mocks.loadCoarenaKey.mockResolvedValue(null);
    mocks.loadSolutionKeyPool.mockResolvedValue({ keys: ['sk-test-key'], activeIndex: 0, stored: false });
    mocks.checkSession.mockResolvedValue({ authenticated: true, username: 'alice' });
    mocks.awaitSubmission.mockResolvedValue({ classification: 'ACCEPTED' });
    mocks.fetchQuestionData.mockResolvedValue({
      questionId: '9901',
      slug: 'sum-of-unique-pair-values',
      isPaidOnly: false,
      contentHtml: '<p>Given integer array nums, return the sum of its maximum and minimum elements.</p>',
      topicTags: [{ name: 'Array', slug: 'array' }],
    });
    mocks.storeVisualAssets.mockImplementation(async () => makeFakeGifAssets());
  });

  it('keeps contextSchema backward-compatible without new default keys and parses contest one-liner fields', () => {
    const plain = contextSchema.parse({
      accountId: 'a',
      username: 'u',
      problemId: '1',
      slug: 'two-sum',
      title: 'Two Sum',
      difficulty: 'Easy',
      problem: 'Find indices',
      submissionId: '1001',
      language: 'python3',
      code: 'class Solution: pass',
      challengeDate: '2026-11-15',
    });

    expect('intent' in plain).toBe(false);
    expect('articleStyle' in plain).toBe(false);
    expect(Object.keys(plain)).not.toContain('intent');
    expect(Object.keys(plain)).not.toContain('articleStyle');

    const contest = contextSchema.parse(baseContext({
      intent: 'contest-solution',
      articleStyle: 'one-liner',
    }));
    expect(contest.intent).toBe('contest-solution');
    expect(contest.articleStyle).toBe('one-liner');

    expect(() => contextSchema.parse(baseContext({ intent: 'invalid-intent' as any }))).toThrow();
    expect(() => contextSchema.parse(baseContext({ articleStyle: 'poem' as any }))).toThrow();
  });

  it('evaluates articleNeedsRefresh without marking verified one-liner primary drafts stale', () => {
    const withFormat = postPresentationVariant(0, 0, 0);

    expect(articleNeedsRefresh(baseContext({ presentation: withFormat }))).toBe(true);
    expect(articleNeedsRefresh(baseContext({
      articleStyle: 'standard',
      presentation: withFormat,
    }))).toBe(true);

    expect(articleNeedsRefresh(baseContext({
      articleStyle: 'one-liner',
      presentation: withFormat,
    }))).toBe(false);

    expect(articleNeedsRefresh(baseContext({
      articleStyle: 'one-liner',
      presentation: { ...withFormat, format: undefined },
    }))).toBe(true);
  });

  it('isolates contest-solution from community-solution in ensurePost and generateForRun', async () => {
    mocks.state.accounts.push({ id: 'acc-1', username: 'alice', status: 'ACTIVE', storageState: '{}' });
    mocks.state.runs.push(
      {
        id: 'run-daily',
        accountId: 'acc-1',
        date: '2026-11-15',
        problemSlug: 'sum-of-unique-pair-values',
        title: 'Sum of Unique Pair Values',
        difficulty: 'Easy',
        language: 'python3',
        solution: 'class Solution:\n    def minMaxSum(self, nums):\n        return min(nums) + max(nums)',
        submissionId: '100101',
        submissionStatus: 'Accepted',
        state: 'SUCCESS',
      },
      {
        id: 'run-contest',
        accountId: 'acc-1',
        date: 'contest:weekly-contest-450:sum-of-unique-pair-values:2026-11-15',
        problemSlug: 'sum-of-unique-pair-values',
        title: 'Sum of Unique Pair Values',
        difficulty: 'Easy',
        language: 'python3',
        solution: 'class Solution:\n    def minMaxSum(self, nums):\n        return min(nums) + max(nums)',
        submissionId: '100102',
        submissionStatus: 'Accepted',
        state: 'SUCCESS',
      },
    );

    const communityPost = await ensurePost(baseContext({ submissionId: '100101' }));
    expect(communityPost.intent).toBe('community-solution');
    const lastUpsertCall = mocks.prisma.solutionPost.upsert.mock.calls.at(-1)?.[0];
    expect('intent' in (lastUpsertCall?.create ?? {})).toBe(false);

    // Move existing community post to AWAITING_APPROVAL to confirm generateForRun doesn't return it for contest intent.
    await mocks.prisma.solutionPost.update({
      where: { id: communityPost.id },
      data: { status: 'AWAITING_APPROVAL' },
    });

    const contestCreated = await ensurePost(baseContext({
      submissionId: '100102',
      intent: 'contest-solution',
      articleStyle: 'one-liner',
    }));
    expect(contestCreated.id).not.toBe(communityPost.id);
    expect(contestCreated.intent).toBe('contest-solution');

    // Remove contest post and test generateForRun creating a distinct contest-solution post & persisting intent + articleStyle.
    mocks.state.posts = mocks.state.posts.filter(p => p.id === communityPost.id);
    const { generate: spyGenerate } = createMockStagedRouter();
    const routerSpy = vi.spyOn(AIModelRouter.prototype, 'generate').mockImplementation(spyGenerate as any);
    try {
      const generated = await generateForRun('acc-1', 'run-contest', false, undefined, 'manual', {
        intent: 'contest-solution',
        articleStyle: 'one-liner',
      });
      expect(generated.id).not.toBe(communityPost.id);
      expect(generated.intent).toBe('contest-solution');
      expect(generated.status).toBe('AWAITING_APPROVAL');
      const savedCtx = contextSchema.parse(JSON.parse(generated.context));
      expect(savedCtx.intent).toBe('contest-solution');
      expect(savedCtx.articleStyle).toBe('one-liner');
      expect(savedCtx.challengeDate).toBe('2026-11-15');
      expect(savedCtx.articleImplementation).toBeUndefined();
      expect(generated.markdown).toContain(savedCtx.code);
      expect(generated.markdown).toContain('https://cdn.example.com/assets/v1.gif');
      expect(generated.markdown).toContain('https://cdn.example.com/assets/v2.gif');
    } finally {
      routerSpy.mockRestore();
    }
  });

  it('loadContext extracts challengeDate from contest DailyRun keys', async () => {
    mocks.state.accounts.push({ id: 'acc-1', username: 'alice', status: 'ACTIVE', storageState: '{}' });
    mocks.state.runs.push({
      id: 'run-c1',
      accountId: 'acc-1',
      date: 'contest:biweekly-contest-155:sum-of-unique-pair-values:2026-11-14',
      problemSlug: 'sum-of-unique-pair-values',
      title: 'Sum of Unique Pair Values',
      difficulty: 'Easy',
      language: 'python3',
      solution: 'class Solution:\n    def solve(self, nums): return min(nums) + max(nums)',
      submissionId: '999',
      submissionStatus: 'Accepted',
      state: 'SUCCESS',
    });

    const ctx = await loadContext('acc-1', 'run-c1');
    expect(ctx.challengeDate).toBe('2026-11-14');
    expect(ctx.slug).toBe('sum-of-unique-pair-values');
  });

  it('requeueInterruptedGeneration clears contest-post-job lock without deleting solution-post-job lock', async () => {
    const staleUpdatedAt = new Date(Date.now() - SOLUTION_ARTICLE_WORK_MS - 10_000);
    mocks.state.runs.push({
      id: 'run-c2',
      accountId: 'acc-1',
      date: 'contest:weekly-contest-451:sum-of-unique-pair-values:2026-11-15',
      problemSlug: 'sum-of-unique-pair-values',
      title: 'Sum of Unique Pair Values',
      difficulty: 'Easy',
      language: 'python3',
      solution: 'class Solution:\n    def solve(self, nums): return sum(nums)',
      submissionId: '888',
      submissionStatus: 'Accepted',
      state: 'SUCCESS',
    });
    const dailyKey = `solution-post-job:acc-1:${staleUpdatedAt.toISOString().slice(0, 10)}`;
    const contestKey = 'contest-post-job:weekly-contest-451';
    mocks.state.systemState.set(dailyKey, { key: dailyKey, value: 'daily-token', updatedAt: new Date(staleUpdatedAt.getTime() - 1000) });
    mocks.state.systemState.set(contestKey, { key: contestKey, value: 'contest-token', updatedAt: new Date(staleUpdatedAt.getTime() - 1000) });

    mocks.state.posts.push({
      id: 'post-c2',
      accountId: 'acc-1',
      problemSlug: 'sum-of-unique-pair-values',
      intent: 'contest-solution',
      submissionId: '888',
      status: 'GENERATING',
      retryCount: 1,
      lastError: null,
      context: JSON.stringify(baseContext({ intent: 'contest-solution', articleStyle: 'one-liner', submissionId: '888' })),
      updatedAt: staleUpdatedAt,
    } as Partial<SolutionPost>);

    const recovered = await requeueInterruptedGeneration('post-c2', staleUpdatedAt);
    expect(recovered.status).toBe('RETRY_PENDING');
    expect(mocks.state.systemState.has(contestKey)).toBe(false);
    expect(mocks.state.systemState.has(dailyKey)).toBe(true);
  });

  it('generatePost keeps primary 1-liner verbatim, enforces 2 GIFs, uses oneLiner variation for 2nd account, and preserves recent titles', async () => {
    const primaryCtx = baseContext({
      accountId: 'acc-1',
      username: 'alice',
      intent: 'contest-solution',
      articleStyle: 'one-liner',
    });
    const mockPrimary = createMockStagedRouter();
    const post1 = await generatePost(primaryCtx, mockPrimary.router);

    expect(post1.status).toBe('AWAITING_APPROVAL');
    expect(mocks.storeVisualAssets).toHaveBeenCalledTimes(1);
    const savedPrimaryCtx = contextSchema.parse(JSON.parse(post1.context));
    expect(savedPrimaryCtx.articleImplementation).toBeUndefined();
    expect(post1.markdown).toContain(primaryCtx.code);
    expect(() => verifyArticleCode(post1.markdown!, savedPrimaryCtx)).not.toThrow();
    expect(mockPrimary.calls.some(c => c.label.includes('implementation'))).toBe(false);

    mocks.storeVisualAssets.mockResolvedValueOnce(makeFakeGifAssets().slice(0, 1));
    const failGifCtx = baseContext({
      accountId: 'acc-gif-fail',
      username: 'charlie',
      slug: 'another-contest-problem',
      submissionId: '9003',
      intent: 'contest-solution',
      articleStyle: 'one-liner',
    });
    const postFail = await generatePost(failGifCtx, createMockStagedRouter().router);
    expect(postFail.status).toBe('FAILED');
    expect(postFail.lastError).toBe('TWO_ARTICLE_GIFS_REQUIRED');

    // Second account on the same contest problem: runs generateImplementation(..., { oneLiner: true }) & sees primary's title in recent
    const secondaryPayload = humanOneLinerArticlePayload({
      title: '🎯 Sorted Ends One-Liner Without Extra Loops',
    });
    const altCode = 'class Solution:\n    def minMaxSum(self, nums: List[int]) -> int:\n        return (s := sorted(nums))[0] + s[-1]';
    const secondaryCalls: string[] = [];
    const seenRecentTitlesInPrompt: string[] = [];
    const secondaryRouter = {
      generate: vi.fn(async (messages: any[], validate: (t: string) => any, maxTokens: number, strict: boolean, label = '') => {
        secondaryCalls.push(label);
        const sys = String(messages[0]?.content ?? '');
        const user = String(messages[1]?.content ?? '');
        if (label === 'article implementation') {
          expect(sys).toContain('clean 1-liner');
          expect(sys).toContain('shortest minimal');
          expect(user).toContain('min(nums) + max(nums)');
          const impl = JSON.stringify({
            approach: 'One-line walrus sort indexing',
            code: altCode,
          });
          return {
            value: validate(impl),
            model: 'mock-impl',
            attempts: [{ model: 'mock-impl', provider: 'discovery' as const, attempt: 1, elapsedMs: 5, outcome: 'SUCCESS' as const }],
          };
        }
        if (label === 'technical review implementation') {
          expect(sys).toContain('clean 1-liner or shortest minimal solution');
          const verdict = JSON.stringify({ issues: [] });
          return {
            value: validate(verdict),
            model: 'mock-impl-review',
            attempts: [{ model: 'mock-impl-review', provider: 'discovery' as const, attempt: 1, elapsedMs: 5, outcome: 'SUCCESS' as const }],
          };
        }
        seenRecentTitlesInPrompt.push(sys + '\n' + user);
        return createMockStagedRouter(secondaryPayload).router.generate(messages, validate, maxTokens, strict, label);
      }),
    } as unknown as AIModelRouter;

    const secondaryCtx = baseContext({
      accountId: 'acc-2',
      username: 'bob',
      submissionId: '9002',
      intent: 'contest-solution',
      articleStyle: 'one-liner',
    });
    const post2 = await generatePost(secondaryCtx, secondaryRouter);

    expect(post2.status).toBe('AWAITING_APPROVAL');
    expect(secondaryCalls).toContain('article implementation');
    expect(secondaryCalls).toContain('technical review implementation');
    const savedSecondaryCtx = contextSchema.parse(JSON.parse(post2.context));
    expect(savedSecondaryCtx.articleImplementation?.code).toBe(altCode);
    expect(post2.markdown).toContain(altCode);
    expect(() => verifyArticleCode(post2.markdown!, savedSecondaryCtx)).not.toThrow();
    expect(seenRecentTitlesInPrompt.some(text => text.includes(post1.title!))).toBe(true);
  });

  it('generateImplementation supports { oneLiner: true } distinctness and preserves standard mode', async () => {
    const oneLinerCalls: Array<{ label: string; system: string }> = [];
    const alt = 'class Solution:\n    def minMaxSum(self, nums: List[int]) -> int:\n        return (a := sorted(nums))[0] + a[-1]';
    const router = {
      generate: vi.fn(async (messages: any[], validate: (t: string) => any, _max: number, _strict: boolean, label = '') => {
        oneLinerCalls.push({ label, system: String(messages[0]?.content ?? '') });
        const raw = label === 'article implementation'
          ? JSON.stringify({
            approach: 'Single-expression sorted index',
            code: alt,
          })
          : JSON.stringify({ issues: [] });
        return {
          value: validate(raw),
          model: 'm1',
          attempts: [{ model: 'm1', provider: 'discovery' as const, attempt: 1, elapsedMs: 5, outcome: 'SUCCESS' as const }],
        };
      }),
    } as unknown as AIModelRouter;

    const res = await generateImplementation(
      router,
      baseContext(),
      [{ code: baseContext().code, approach: 'Two linear scans' }],
      async () => true,
      { oneLiner: true },
    );
    expect(res.value.code).toBe(alt);
    expect(oneLinerCalls.find(c => c.label === 'article implementation')?.system).toContain('clean 1-liner');
    expect(oneLinerCalls.find(c => c.label === 'technical review implementation')?.system).toContain('clean 1-liner or shortest minimal solution');

    const standardCalls: Array<{ label: string; system: string }> = [];
    const standardRouter = {
      generate: vi.fn(async (messages: any[], validate: (t: string) => any, _max: number, _strict: boolean, label = '') => {
        standardCalls.push({ label, system: String(messages[0]?.content ?? '') });
        const raw = label === 'article implementation'
          ? JSON.stringify({
            approach: 'Standard iterative scan across elements',
            code: 'class Solution:\n    def minMaxSum(self, nums: List[int]) -> int:\n        lo = hi = nums[0]\n        for x in nums:\n            lo = min(lo, x)\n            hi = max(hi, x)\n        return lo + hi',
          })
          : JSON.stringify({ issues: [] });
        return {
          value: validate(raw),
          model: 'm1',
          attempts: [{ model: 'm1', provider: 'discovery' as const, attempt: 1, elapsedMs: 5, outcome: 'SUCCESS' as const }],
        };
      }),
    } as unknown as AIModelRouter;

    await generateImplementation(standardRouter, baseContext(), [], async () => true);
    expect(standardCalls.find(c => c.label === 'article implementation')?.system).not.toContain('clean 1-liner');
  });

  it('validates casual human 1-liner articles, blocks robotic AI openings, and renders clean headings + both GIFs', () => {
    const ctx = baseContext({
      intent: 'contest-solution',
      articleStyle: 'one-liner',
      presentation: postPresentationVariant(0, 0, 0),
    });

    const validPayload = humanOneLinerArticlePayload();
    const article = validateArticle(JSON.stringify(validPayload), ctx, []);
    const markdown = renderArticle(article, ctx, makeFakeGifAssets());

    expect(markdown).toContain('Core Contest Trick');
    expect(markdown).toContain('One-Liner Code');
    expect(markdown).toContain('https://cdn.example.com/assets/v1.gif');
    expect(markdown).toContain('https://cdn.example.com/assets/v2.gif');
    expect(() => verifyArticleCode(markdown, ctx)).not.toThrow();

    for (const roboticOpening of [
      'In this problem, we find both extremes in nums and sum them cleanly.',
      "Let's delve into how finding min and max gives us the answer here.",
      'Here we are tasked with computing the sum of the minimum and maximum.',
    ]) {
      const badPayload = humanOneLinerArticlePayload({
        sections: [
          { kind: 'intuition', heading: 'Core Idea', markdown: roboticOpening },
          ...validPayload.sections.slice(1),
        ],
      });
      let caught: unknown;
      try { validateArticle(JSON.stringify(badPayload), ctx, []); }
      catch (err) { caught = err; }
      expect(caught).toBeInstanceOf(OutputValidationError);
      expect((caught as OutputValidationError).category).toBe('ROBOTIC_TONE_FORBIDDEN');
    }

    // Standard community-solution posts do not trigger ROBOTIC_TONE_FORBIDDEN
    const standardPayload = humanOneLinerArticlePayload({
      sections: [
        { kind: 'intuition', heading: 'Core Idea', markdown: 'In this problem, tracking both min and max gives the sum cleanly.' },
        ...validPayload.sections.slice(1),
      ],
    });
    expect(() => validateArticle(JSON.stringify(standardPayload), baseContext(), [])).not.toThrow();
  });

  it('tailors staged, Coarena, and compactArticlePrompt prompts for contest 1-liners while keeping 2 GIFs', async () => {
    const presentation = postPresentationVariant(0, 0, 0);
    if (presentation.format) presentation.format.optimization = true;
    const ctx = baseContext({
      intent: 'contest-solution',
      articleStyle: 'one-liner',
      presentation,
    });

    const fullPrompt = compactArticlePrompt(ctx, 'minimal and clear', []);
    expect(fullPrompt).toContain('100-180 words');
    expect(fullPrompt).toContain('GIFS ARE MANDATORY');
    expect(fullPrompt).toContain('In this problem');
    expect(fullPrompt).not.toContain('comparison.acceptedSource');

    const { router: stagedRouter, calls: stagedCalls } = createMockStagedRouter();
    const stagedResult = await generateArticle(
      stagedRouter,
      ctx,
      [],
      async () => makeFakeGifAssets(),
    );
    expect(stagedResult.visuals).toHaveLength(2);
    expect(stagedResult.assets).toHaveLength(2);
    expect(stagedCalls.find(c => c.label === 'title and intuition')?.system).toContain('casual human');
    expect(stagedCalls.find(c => c.label === 'technical review')?.system).toContain('robotic AI openings');

    const coarenaCalls: Array<{ stage: string; system: string; user: string }> = [];
    const coarenaRouter = Object.create(CoarenaRouter.prototype) as CoarenaRouter;
    coarenaRouter.generatePrimary = vi.fn(async (messages: any[], validate: (t: string) => any, _max: number, _strict: boolean, stage = '') => {
      const system = String(messages[0]?.content ?? '');
      const user = String(messages[1]?.content ?? '');
      coarenaCalls.push({ stage, system, user });
      const raw = stage.includes('review')
        ? JSON.stringify({ issues: [] })
        : JSON.stringify(humanOneLinerArticlePayload());
      return {
        value: validate(raw),
        model: 'coarena-mock',
        attempts: [{ model: 'coarena-mock', provider: 'coarena' as const, attempt: 1, elapsedMs: 5, outcome: 'SUCCESS' as const }],
      };
    }) as any;

    const coarenaResult = await generateArticle(
      coarenaRouter,
      ctx,
      [],
      async () => makeFakeGifAssets(),
    );
    expect(coarenaResult.visuals).toHaveLength(2);
    expect(coarenaResult.assets).toHaveLength(2);
    const draftCall = coarenaCalls.find(c => c.stage.includes('storyboards'));
    expect(draftCall?.system).toContain('100–180 words');
    expect(draftCall?.system).toContain('In this problem');
    expect(JSON.parse(draftCall!.user).comparison).toBeUndefined();
    expect(coarenaCalls.find(c => c.stage.includes('review'))?.system).toContain('casual human');
  });
});
