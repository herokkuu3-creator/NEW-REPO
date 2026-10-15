import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ row: null as any, rows: [] as any[], generation: vi.fn(), verifyVisuals: vi.fn(),
  checkSession: vi.fn(), launch: vi.fn(), browser: { newContext: vi.fn(), close: vi.fn() },
  question: vi.fn(), verdict: vi.fn(), run: null as any, account: null as any }));
vi.mock('../src/database/prisma', () => ({ prisma: {
  solutionPost: {
    upsert: vi.fn(async ({ create }: any) => {
      h.row ??= { ...create, id: 'post1', status: 'PENDING', retryCount: 0, updatedAt: new Date(1) };
      return structuredClone(h.row);
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      if (!h.row || h.row.id !== where.id || h.row.status !== where.status || h.row.updatedAt.getTime() !== where.updatedAt.getTime()) return { count: 0 };
      for (const [k, v] of Object.entries(data)) h.row[k] = typeof v === 'object' && v && 'increment' in v ? h.row[k] + v.increment : v;
      h.row.updatedAt = new Date(h.row.updatedAt.getTime() + 1);
      return { count: 1 };
    }),
    findUniqueOrThrow: vi.fn(async () => structuredClone(h.row)),
    findUnique: vi.fn(async () => h.row ? structuredClone(h.row) : null),
    findMany: vi.fn(async () => h.rows),
  },
  dailyRun: { findUniqueOrThrow: vi.fn(async () => h.run), findFirst: vi.fn(async () => h.run) },
  account: { findUniqueOrThrow: vi.fn(async () => h.account) },
  systemState: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})) },
} }));
vi.mock('../src/solutionPosts/article', async orig => ({ ...(await orig() as object), generateArticle: h.generation }));
vi.mock('../src/solutionPosts/visualStore', () => ({ storeVisualAssets: vi.fn(), verifyHostedVisualAssets: h.verifyVisuals }));
vi.mock('playwright', () => ({ chromium: { launch: h.launch } }));
vi.mock('../src/browser/sessionCheck', () => ({ checkSession: h.checkSession }));
vi.mock('../src/leetcode/apiClient', () => ({ LeetCodeApi: class { awaitSubmission = h.verdict; } }));
vi.mock('../src/leetcode/dailyChallenge', () => ({ fetchQuestionData: h.question, fetchDailyChallenge: vi.fn() }));
import { generateForRun, generatePost, loadContext, withAccount } from '../src/solutionPosts/service';
import { assertTransition, approvePost, move } from '../src/solutionPosts/store';
import { ArticleReviewError, contextSchema, hash } from '../src/solutionPosts/article';
import { RoutingError } from '../src/solutionPosts/router';
const context = contextSchema.parse({ accountId: 'a', username: 'alice', problemId: '1', slug: 'example',
  title: 'Example', difficulty: 'Easy', problem: 'An example problem', submissionId: '123', language: 'cpp', code: 'source\r\n', challengeDate: '2026-10-15' });
const output = { title: 'Example title', markdown: 'verified exact source\r\n', model: 'terra', reviewModel: 'luna', style: 'visual storytelling',
  attempts: [], visuals: [{ id: 'visual-1' }, { id: 'visual-2' }], assets: [{ id: 'visual-1' }, { id: 'visual-2' }], visualFallback: false };
beforeEach(() => {
  vi.clearAllMocks(); h.row = null; h.rows = [];
  h.generation.mockResolvedValue(output);
  h.verifyVisuals.mockResolvedValue(true);
  h.account = { id: 'a', username: 'alice', status: 'ACTIVE', storageState: '{"cookies":[{"name":"fake"}],"origins":[]}' };
  h.run = { id: 'run1', accountId: 'a', state: 'SUCCESS', solution: context.code, submissionId: '123', submissionStatus: 'Accepted',
    problemSlug: 'example', title: 'Example', difficulty: 'Easy', language: 'cpp', date: '2026-10-15' };
  h.launch.mockResolvedValue(h.browser); h.browser.newContext.mockResolvedValue({ newPage: async () => ({}) });
  h.checkSession.mockResolvedValue({ authenticated: true, username: 'alice' });
  h.verdict.mockResolvedValue({ classification: 'ACCEPTED' });
  h.question.mockResolvedValue({ questionId: '1', slug: 'example', contentHtml: 'An example problem', isPaidOnly: false });
});

describe('solution workflow and persistence', () => {
  it('turns an existing accepted run into an awaiting-review draft and reuses it', async () => {
    const loaded = await loadContext('a', 'run1');
    expect(loaded.code).toBe(context.code);
    const first = await generatePost(loaded, {} as never);
    expect(first.status).toBe('AWAITING_APPROVAL'); expect(first.codeHash).toBe(hash(context.code));
    const again = await generateForRun('a', 'run1');
    expect(again.id).toBe(first.id); expect(h.generation).toHaveBeenCalledTimes(1);
    expect(h.verdict).toHaveBeenCalledTimes(1);
  });
  it('persists all-model failure without changing the accepted run', async () => {
    h.generation.mockRejectedValue(new RoutingError([{ model: 'terra', attempt: 1, outcome: 'TIMEOUT', elapsedMs: 1000 }]));
    const post = await generatePost(context, {} as never);
    expect(post.status).toBe('FAILED'); expect(post.lastError).toBe('AI_MODELS_EXHAUSTED');
    expect(post.attempts).toContain('TIMEOUT'); expect(h.run.state).toBe('SUCCESS'); expect(h.run.submissionId).toBe('123');
  });
  it('refuses a public post when either mandatory GIF cannot be verified', async () => {
    h.verifyVisuals.mockResolvedValue(false);
    const post = await generatePost(context, {} as never);
    expect(post.status).toBe('FAILED'); expect(post.lastError).toBe('TWO_PUBLIC_GIFS_REQUIRED');
  });
  it('persists missing AI configuration as a retryable failure with source context', async () => {
    const post = await generatePost(context);
    expect(post.status).toBe('FAILED'); expect(post.lastError).toBe('AI_CONFIGURATION_REQUIRED');
    expect(JSON.parse(post.context).code).toBe(context.code); expect(h.generation).not.toHaveBeenCalled();
  });
  it('preserves a generated draft and usage if technical review fails', async () => {
    h.generation.mockRejectedValue(new ArticleReviewError([{ model: 'terra', attempt: 1, outcome: 'INVALID_OUTPUT', elapsedMs: 1 }],
      { title: output.title, markdown: output.markdown, style: output.style, model: output.model }));
    const post = await generatePost(context, {} as never);
    expect(post.status).toBe('FAILED'); expect(post.lastError).toBe('TECHNICAL_REVIEW_FAILED');
    expect(post.markdown).toBe(output.markdown); expect(post.approvedHash).toBeNull();
    expect(post.attempts).toContain('terra');
  });
  it('uses CAS to permit one generation when triggered simultaneously', async () => {
    const results = await Promise.allSettled([generatePost(context, {} as never), generatePost(context, {} as never)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(h.generation).toHaveBeenCalledTimes(1);
  });
  it('requires a matching content hash before approval', async () => {
    await generatePost(context, {} as never);
    await expect(approvePost('post1', 'bad')).rejects.toThrow();
    const approved = await approvePost('post1', hash(output.title + '\n' + output.markdown));
    expect(approved.status).toBe('DRAFT_READY'); expect(approved.approvedHash).toBe(approved.contentHash);
  });
  it('enforces state transitions and refuses publishing retries', () => {
    expect(() => assertTransition('FAILED', 'PUBLISHING')).toThrow();
    expect(() => assertTransition('PUBLISHING', 'FAILED')).toThrow();
    expect(() => assertTransition('PUBLISHED', 'PUBLISHING')).toThrow();
  });
  it('does not overwrite a concurrently changed record', async () => {
    const saved = await generatePost(context, {} as never); h.row.updatedAt = new Date(100);
    await expect(move(saved, 'DRAFT_READY')).rejects.toThrow('another worker');
  });
  it('refuses missing accepted code, wrong owner, and rejected submissions', async () => {
    h.run.accountId = 'b'; await expect(loadContext('a', 'run1')).rejects.toThrow('ACCEPTED_SUBMISSION_REQUIRED');
    h.run.accountId = 'a'; h.verdict.mockResolvedValue({ classification: 'WRONG_ANSWER' });
    await expect(loadContext('a', 'run1')).rejects.toThrow('ACCEPTED_SUBMISSION_REQUIRED');
  });
  it('isolates expired or wrong-account sessions and always closes the browser', async () => {
    const action = vi.fn(); h.checkSession.mockResolvedValueOnce({ authenticated: false });
    await expect(withAccount(h.account, action)).rejects.toThrow('AUTHENTICATION_REQUIRED');
    h.checkSession.mockResolvedValueOnce({ authenticated: true, username: 'bob' });
    await expect(withAccount(h.account, action)).rejects.toThrow('ACCOUNT_IDENTITY_MISMATCH');
    expect(action).not.toHaveBeenCalled(); expect(h.browser.close).toHaveBeenCalledTimes(2);
  });
});
