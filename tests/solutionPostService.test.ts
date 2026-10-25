import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ row: null as any, rows: [] as any[], generation: vi.fn(), verifyVisuals: vi.fn(),
  pool: vi.fn(), checkSession: vi.fn(), launch: vi.fn(), browser: { newContext: vi.fn(), close: vi.fn() },
  question: vi.fn(), verdict: vi.fn(), daily: vi.fn(), refresh: vi.fn(), run: null as any, account: null as any }));
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
  systemState: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({ count: 1 })) },
} }));
vi.mock('../src/solutionPosts/article', async orig => ({ ...(await orig() as object), generateArticle: h.generation }));
vi.mock('../src/solutionPosts/visualStore', () => ({ storeVisualAssets: vi.fn(), verifyHostedVisualAssets: h.verifyVisuals }));
vi.mock('playwright', () => ({ chromium: { launch: h.launch } }));
vi.mock('../src/browser/sessionCheck', () => ({ checkSession: h.checkSession }));
vi.mock('../src/leetcode/apiClient', () => ({ LeetCodeApi: class { awaitSubmission = h.verdict; } }));
vi.mock('../src/leetcode/dailyChallenge', () => ({ fetchQuestionData: h.question, fetchDailyChallenge: h.daily }));
vi.mock('../src/security/sessionAutoRefresh', () => ({ refreshLeetCodeAccount: h.refresh }));
vi.mock('../src/solutionPosts/keyPool', async orig => ({ ...(await orig() as object), loadSolutionKeyPool: h.pool }));
import { activeSolutionApiKeys, generateForRun, generatePost, loadContext, resolveCurrentDaily, resetFailedSolutionPostRetries, retryPost, withAccount } from '../src/solutionPosts/service';
import { prisma } from '../src/database/prisma';
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
  h.pool.mockResolvedValue({ keys: [], activeIndex: 0, stored: false });
  h.verifyVisuals.mockResolvedValue(true);
  h.account = { id: 'a', username: 'alice', status: 'ACTIVE', storageState: '{"cookies":[{"name":"fake"}],"origins":[]}' };
  h.run = { id: 'run1', accountId: 'a', state: 'SUCCESS', solution: context.code, submissionId: '123', submissionStatus: 'Accepted',
    problemSlug: 'example', title: 'Example', difficulty: 'Easy', language: 'cpp', date: '2026-10-15' };
  h.launch.mockResolvedValue(h.browser); h.browser.newContext.mockResolvedValue({ newPage: async () => ({}) });
  h.checkSession.mockResolvedValue({ authenticated: true, username: 'alice' });
  h.verdict.mockResolvedValue({ classification: 'ACCEPTED' });
  h.question.mockResolvedValue({ questionId: '1', slug: 'example', contentHtml: 'An example problem', isPaidOnly: false });
  h.daily.mockResolvedValue({ date: '2026-10-15', slug: 'example' });
  h.refresh.mockResolvedValue({ status: 'refreshed' });
});

describe('solution workflow and persistence', () => {
  it('renews an expired session before resolving the 06:00 daily, without waiting for the 07:00 session check', async () => {
    h.checkSession.mockResolvedValueOnce({ authenticated: false, cause: 'signed-out' });
    expect(await resolveCurrentDaily(h.account, new Date('2026-10-15T00:30:00Z'))).toMatchObject({ slug: 'example' });
    expect(h.refresh).toHaveBeenCalledWith(h.account);
    expect(h.browser.close).toHaveBeenCalledTimes(2);
  });
  it('clears both generation failures and the independent scheduled-attempt budget after a key repair', async () => {
    await resetFailedSolutionPostRetries();
    expect(prisma.systemState.deleteMany).toHaveBeenCalledWith({ where: { key: { startsWith: 'solution-post-schedule-budget:' } } });
  });
  it('does not retry keys already advanced past for the current month', () => {
    expect(activeSolutionApiKeys({ keys: ['spent', 'usable-a', 'usable-b'], activeIndex: 1 })).toEqual(['usable-a', 'usable-b']);
    expect(activeSolutionApiKeys({ keys: ['spent'], activeIndex: 1 })).toEqual([]);
  });
  it('turns an existing accepted run into an awaiting-review draft and reuses it', async () => {
    const loaded = await loadContext('a', 'run1');
    expect(loaded.code).toBe(context.code);
    const first = await generatePost(loaded, {} as never);
    expect(first.status).toBe('AWAITING_APPROVAL'); expect(first.codeHash).toBe(hash(context.code));
    const again = await generateForRun('a', 'run1');
    expect(again.id).toBe(first.id); expect(h.generation).toHaveBeenCalledTimes(1);
    expect(h.verdict).toHaveBeenCalledTimes(1);
  });
  it('normalizes the namespaced manual-run key to an ISO article date', async () => {
    h.run.date = 'manual:3820:2026-10-15';
    const loaded = await loadContext('a', 'run1');
    expect(loaded.challengeDate).toBe('2026-10-15');
  });
  it('persists all-model failure without changing the accepted run', async () => {
    h.generation.mockRejectedValue(new RoutingError([{ model: 'terra', attempt: 1, outcome: 'TIMEOUT', elapsedMs: 1000 }]));
    const post = await generatePost(context, {} as never);
    expect(post.status).toBe('FAILED'); expect(post.lastError).toBe('AI_MODELS_EXHAUSTED');
    expect(post.attempts).toContain('TIMEOUT'); expect(h.run.state).toBe('SUCCESS'); expect(h.run.submissionId).toBe('123');
  });
  it('reports the same authentication rejection for the first and all later accounts sharing the invalid pool', async () => {
    h.generation.mockRejectedValue(new RoutingError([{ model: 'discovery', attempt: 1, outcome: 'HTTP_401', elapsedMs: 1 }], 'HTTP_401'));
    expect(await generatePost(context, {} as never)).toMatchObject({ status: 'FAILED', lastError: 'AI_AUTHENTICATION_FAILED' });
    h.row = null;
    h.pool.mockResolvedValue({ keys: ['invalid_key_0001'], activeIndex: 1, stored: true, lastFailure: 'HTTP_401' });
    expect(await generatePost(context)).toMatchObject({ status: 'FAILED', lastError: 'AI_AUTHENTICATION_FAILED' });
    expect(h.run).toMatchObject({ state: 'SUCCESS', submissionId: '123' });
  });
  it('reports provider throttling as a retryable rate limit, including during technical review', async () => {
    h.generation.mockRejectedValue(new ArticleReviewError([{ model: 'qwen', attempt: 1,
      outcome: 'HTTP_429', httpStatus: 429, elapsedMs: 1 }],
    { title: output.title, markdown: output.markdown, style: output.style, model: output.model }, 'HTTP_429'));
    expect(await generatePost(context, {} as never)).toMatchObject({ status: 'FAILED', lastError: 'AI_RATE_LIMITED', markdown: output.markdown });
    expect(h.run).toMatchObject({ state: 'SUCCESS', submissionId: '123' });
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
  it('keeps the automatic four-attempt guard and exposes the original failure without altering it', async () => {
    await generatePost(context, {} as never);
    Object.assign(h.row, { status: 'FAILED', retryCount: 4, lastError: 'AI_PROVIDER_ACCESS_BLOCKED' });
    h.generation.mockClear();
    await expect(retryPost('post1')).rejects.toMatchObject({ code: 'GENERATION_RETRY_LIMIT', details: {
      postId: 'post1', retryCount: 4, previousError: 'AI_PROVIDER_ACCESS_BLOCKED',
    } });
    expect(h.row).toMatchObject({ status: 'FAILED', retryCount: 4, lastError: 'AI_PROVIDER_ACCESS_BLOCKED' });
    expect(h.generation).not.toHaveBeenCalled();
  });
  it('allows an explicit retry after four failures and reports the current configuration error', async () => {
    await generatePost(context, {} as never);
    Object.assign(h.row, { status: 'FAILED', retryCount: 4, lastError: 'OLD_PROVIDER_ERROR' });
    const post = await retryPost('post1', true);
    expect(post).toMatchObject({ status: 'FAILED', retryCount: 1, lastError: 'AI_CONFIGURATION_REQUIRED' });
    expect(h.run).toMatchObject({ state: 'SUCCESS', submissionId: '123', solution: context.code });
  });
  it('atomically renews an exhausted recovered post once under simultaneous explicit retries', async () => {
    await generatePost(context, {} as never);
    Object.assign(h.row, { status: 'RETRY_PENDING', retryCount: 4, lastError: 'TWO_PUBLIC_GIFS_REQUIRED' });
    h.generation.mockClear();
    const results = await Promise.allSettled([generatePost(context, {} as never, true), generatePost(context, {} as never, true)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(h.generation).toHaveBeenCalledTimes(1);
    expect(h.row).toMatchObject({ status: 'AWAITING_APPROVAL', retryCount: 1 });
  });
  it('does not reset an exhausted budget if the stored accepted source fails verification', async () => {
    await generatePost(context, {} as never);
    Object.assign(h.row, { status: 'FAILED', retryCount: 4 });
    h.run.solution = 'a different accepted source';
    await expect(retryPost('post1', true)).rejects.toThrow('SOURCE_INTEGRITY_FAILED');
    expect(h.row.retryCount).toBe(4);
  });
  it.each(['PUBLISHING', 'PUBLISHED', 'AWAITING_APPROVAL'])('never resets or replays a %s post on explicit retry', async status => {
    await generatePost(context, {} as never);
    Object.assign(h.row, { status, retryCount: 4 });
    h.generation.mockClear();
    await expect(retryPost('post1', true)).rejects.toThrow('NOT_RETRYABLE');
    expect(h.row).toMatchObject({ status, retryCount: 4 });
    expect(h.generation).not.toHaveBeenCalled();
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
