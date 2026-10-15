import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ row: null as any, page: null as any, api: null as any, click: vi.fn(),
  clicked: false, duplicate: false, verifyFailure: false, text: '', title: '',
  original: '# Code\n```cpp []\nclass Solution {};\n```', url: 'https://leetcode.com/problems/example/solutions/123/teach-with-sets/' }));
vi.mock('../src/database/prisma', () => ({ prisma: {
  solutionPost: { findUniqueOrThrow: vi.fn(async () => ({ ...h.row })),
    update: vi.fn(async ({ data }: any) => { Object.assign(h.row, data); return { ...h.row }; }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      if (where.status !== h.row.status || where.updatedAt !== h.row.updatedAt) return { count: 0 };
      Object.assign(h.row, data, { updatedAt: new Date() }); return { count: 1 };
    }) },
  account: { findUniqueOrThrow: vi.fn(async () => ({ id: 'a' })) },
} }));
vi.mock('../src/solutionPosts/service', () => ({ PostError: class extends Error { constructor(code: string) { super(code); } },
  withAccount: vi.fn(async (_account, action) => action(h.api, h.page, 'alice')) }));
import { hash } from '../src/solutionPosts/article';
import { prepareEditor, publishPost, reconcilePost, validSolutionUrl } from '../src/solutionPosts/publisher';
const context = { accountId: 'a', username: 'alice', problemId: '1', slug: 'example', title: 'Example', difficulty: 'Easy',
  problem: 'Example problem', submissionId: '456', language: 'cpp', code: 'class Solution {};', challengeDate: '2026-10-15' };
const markdown = '## Teach with sets\n\nAn educational explanation.\n\n```cpp\nclass Solution {};\n```\n';
beforeEach(() => {
  vi.clearAllMocks(); h.text = h.original; h.title = ''; h.clicked = false; h.duplicate = false; h.verifyFailure = false;
  const digest = hash('Teach with sets\n' + markdown);
  h.row = { id: 'post1', accountId: 'a', problemSlug: 'example', submissionId: '456', context: JSON.stringify(context),
    codeHash: hash(context.code), contentHash: digest, approvedHash: digest, title: 'Teach with sets', markdown,
    status: 'DRAFT_READY', updatedAt: new Date() };
  const titleInput = { waitFor: vi.fn(), fill: vi.fn(async v => { h.title = v; }), inputValue: vi.fn(async () => h.title) };
  const editor = { waitFor: vi.fn(),
    press: vi.fn(async key => { if (key === 'Backspace') h.text = ''; }),
    // Simulate Monaco's insertion semantics, which a normal textarea replacement mock missed.
    fill: vi.fn(async v => { h.text += v; }) };
  const button = { isEnabled: vi.fn(async () => true), click: h.click };
  h.click.mockImplementation(async () => { h.clicked = true; });
  h.page = { goto: vi.fn(), evaluate: vi.fn(async () => h.text),
    getByText: vi.fn(() => ({ waitFor: vi.fn() })),
    getByPlaceholder: vi.fn(() => titleInput),
    getByRole: vi.fn((role: string) => role === 'textbox' ? editor : role === 'button' ? button : { waitFor: vi.fn() }),
    waitForURL: vi.fn(), url: vi.fn(() => h.url) };
  h.api = { awaitSubmission: vi.fn(async () => ({ classification: 'ACCEPTED' })),
    graphql: vi.fn(async (query: string) => query.includes('ugcArticleSolutionArticles(') ? {
      ugcArticleSolutionArticles: { pageInfo: { hasNextPage: false }, edges: h.clicked || h.duplicate ? [
        { node: { topicId: 123, title: 'Teach with sets', slug: 'teach-with-sets', author: { userName: 'alice' } } }] : [] },
    } : { ugcArticleSolutionArticle: { topicId: 123, title: 'Teach with sets', content: h.verifyFailure ? 'wrong' : markdown } }) };
});

describe('authorized solution publishing', () => {
  it('prepares and verifies exact source, clicks once, verifies article content and author', async () => {
    const post = await publishPost('post1');
    expect(post.status).toBe('PUBLISHED'); expect(post.publishedUrl).toBe(h.url);
    expect(h.click).toHaveBeenCalledTimes(1); expect(h.text).toBe(markdown);
    await publishPost('post1'); expect(h.click).toHaveBeenCalledTimes(1);
  });
  it('refuses an unapproved or subsequently changed draft', async () => {
    h.row.markdown += 'changed'; await expect(publishPost('post1')).rejects.toThrow('REVIEW_REQUIRED');
    expect(h.click).not.toHaveBeenCalled();
  });
  it('refuses mismatched editor source and never clicks Post', async () => {
    h.text = '# Code\n```cpp []\nwrong code\n```';
    await expect(publishPost('post1')).rejects.toThrow('EDITOR_SOURCE_MISMATCH');
    expect(h.click).not.toHaveBeenCalled(); expect(h.row.markdown).toBe(markdown);
  });
  it('reconciles uncertain verification rather than repeating the irreversible click', async () => {
    h.verifyFailure = true;
    const post = await publishPost('post1'); expect(post.status).toBe('PUBLISHING');
    expect(post.lastError).toBe('PUBLICATION_UNCERTAIN_RECONCILE_FIRST');
    await expect(publishPost('post1')).rejects.toThrow('PUBLICATION_UNCERTAIN');
    h.verifyFailure = false;
    expect((await reconcilePost('post1', h.url)).status).toBe('PUBLISHED');
    expect(h.click).toHaveBeenCalledTimes(1);
  });
  it('retains an uncertain state if clicking times out', async () => {
    h.click.mockRejectedValueOnce(new Error('timed out'));
    expect((await publishPost('post1')).status).toBe('PUBLISHING');
    await expect(publishPost('post1')).rejects.toThrow(); expect(h.click).toHaveBeenCalledTimes(1);
  });
  it('detects a previously published account solution before opening the editor', async () => {
    h.duplicate = true; expect((await publishPost('post1')).status).toBe('SKIPPED');
    expect(h.page.goto).not.toHaveBeenCalled(); expect(h.click).not.toHaveBeenCalled();
  });
  it('rejects mismatched account/code context', async () => {
    h.row.accountId = 'b'; await expect(publishPost('post1')).rejects.toThrow('SOURCE_INTEGRITY_FAILED');
    expect(h.click).not.toHaveBeenCalled();
  });
  it('verifies a prepopulated accepted code block before editing', async () => {
    await prepareEditor(h.page, context as any, 'Teach with sets', markdown);
    expect(h.text).toBe(markdown);
  });
  it.each(['https://evil.test/problems/example/solutions/123/name/',
    'http://leetcode.com/problems/example/solutions/123/name/',
    'https://leetcode.com/problems/other/solutions/123/name/',
    'https://leetcode.com/problems/example/solutions/123/name/?x=1'])('rejects invalid publication URL %s', url => {
    expect(validSolutionUrl(url, 'example')).toBe(false);
  });
});
