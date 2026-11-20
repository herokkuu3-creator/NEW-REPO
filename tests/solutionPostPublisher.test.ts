import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ row: null as any, page: null as any, api: null as any, click: vi.fn(),
  upload: vi.fn(), readGif: vi.fn(),
  clicked: false, duplicate: false, verifyFailure: false, text: '', title: '',
  original: '# Code\n```cpp []\nclass Solution {};\n```', url: 'https://leetcode.com/problems/example/solutions/123/teach-with-sets/' }));
vi.mock('../src/database/prisma', () => ({ prisma: {
  solutionPost: { findUniqueOrThrow: vi.fn(async () => ({ ...h.row })),
    update: vi.fn(async ({ data }: any) => { Object.assign(h.row, data); return { ...h.row }; }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      if (where.status !== h.row.status || (where.updatedAt && where.updatedAt !== h.row.updatedAt)) return { count: 0 };
      Object.assign(h.row, data, { updatedAt: new Date() }); return { count: 1 };
    }) },
  account: { findUniqueOrThrow: vi.fn(async () => ({ id: 'a' })), findMany: vi.fn(async () => []) },
  systemState: { upsert: vi.fn(), updateMany: vi.fn(), findUnique: h.readGif },
} }));
vi.mock('../src/solutionPosts/service', () => ({ PostError: class extends Error { constructor(public readonly code: string) { super(code); } },
  withAccount: vi.fn(async (_account, action) => action(h.api, h.page, 'alice')) }));
vi.mock('../src/solutionPosts/nativeVisuals', async original => ({ ...await original<object>(), uploadArticleGif: h.upload }));
import { hash } from '../src/solutionPosts/article';
import { config } from '../src/config';
import { LeetCodeHttpError } from '../src/leetcode/apiClient';
import { postPresentationVariant } from '../src/solutionPosts/presentationStyles';
import { prepareEditor, publishPost, reconcilePost, reserveBrowserPublication, validSolutionUrl, inspectPublication } from '../src/solutionPosts/publisher';
const context = { accountId: 'a', username: 'alice', problemId: '1', slug: 'example', title: 'Example', difficulty: 'Easy',
  problem: 'Example problem', submissionId: '456', language: 'cpp', code: 'class Solution {};', challengeDate: '2026-10-15',
  presentation: postPresentationVariant(0, 0), articleImplementation: { code: 'class Solution { public: int count() { return 0; } };', approach: 'Return the only count.' } };
const markdown = `## Teach with sets\n\nAn educational explanation.\n\n\`\`\`cpp\n${context.articleImplementation.code}\n\`\`\`\n`;
const images = [Buffer.from('GIF89a-first-fixture'), Buffer.from('GIF89a-second-fixture')];
const nativeUrls = ['https://assets.leetcode.com/users/images/first.gif', 'https://assets.leetcode.com/users/images/second.gif'] as const;

function useStoredGifDraft() {
  const digests = images.map(image => hash(image.toString()));
  const sourceUrls = digests.map(digest => `https://bot.example.test/solution-assets/${digest}.gif`);
  const withImages = (urls: readonly string[]) => markdown + `\n![First \\] step](${urls[0]})\n\n![Second step](${urls[1]})\n`;
  const draft = withImages(sourceUrls);
  const attached = withImages(nativeUrls);
  const contentHash = hash(h.row.title + '\n' + draft);
  Object.assign(h.row, { markdown: draft, contentHash, approvedHash: contentHash });
  h.readGif.mockImplementation(async ({ where }: any) => {
    const index = digests.indexOf(where.key.replace('solution-visual:', ''));
    return index < 0 ? null : { value: images[index]!.toString('base64') };
  });
  h.upload.mockImplementation(async (_page, _gif, index: number) => nativeUrls[index]);
  const cdn = vi.fn(async (url: string) => new Response(Uint8Array.from(images[nativeUrls.indexOf(url as typeof nativeUrls[number])]!),
    { headers: { 'Content-Type': 'image/gif' } }));
  vi.stubGlobal('fetch', cdn);
  return { draft, attached, contentHash, cdn };
}

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  config.solutionPosts.publishTransport = 'browser';
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
  it('uploads both stored GIFs for API publication and saves the exact attached payload before dispatch', async () => {
    const { draft, attached, contentHash, cdn } = useStoredGifDraft();
    config.solutionPosts.publishTransport = 'api';
    h.api.graphql.mockResolvedValueOnce({ ugcArticleSolutionArticles: { pageInfo: { hasNextPage: false }, edges: [] } })
      .mockImplementationOnce(async (_query, variables) => {
        expect(h.row).toMatchObject({ status: 'PUBLISHING', publicationMarkdown: attached, markdown: draft, approvedHash: contentHash });
        expect(variables.data.content).toBe(attached);
        h.clicked = true;
        throw new Error('response lost after creation');
      })
      .mockResolvedValueOnce({ ugcArticleSolutionArticles: { pageInfo: { hasNextPage: false }, edges: [
        { node: { topicId: 123, title: h.row.title, slug: 'teach-with-sets', author: { userName: 'alice' } } },
      ] } })
      .mockResolvedValueOnce({ ugcArticleSolutionArticle: { topicId: 123, title: h.row.title, content: attached } });
    expect(await publishPost('post1')).toMatchObject({ status: 'PUBLISHED', publicationMarkdown: attached, markdown: draft });
    expect(h.upload.mock.calls.map(call => call[1].bytes)).toEqual(images);
    expect(cdn.mock.calls.map(call => call[0])).toEqual(nativeUrls);
    expect(h.page.goto).toHaveBeenCalledTimes(1);
    expect(h.click).not.toHaveBeenCalled();
  });

  it('keeps the draft ready if the uploaded bytes differ', async () => {
    const { draft, cdn } = useStoredGifDraft();
    cdn.mockResolvedValueOnce(new Response('GIF89a-wrong-fixture', { headers: { 'Content-Type': 'image/gif' } }));
    await expect(publishPost('post1')).rejects.toThrow('ARTICLE_GIF_UPLOAD_UNVERIFIED');
    expect(h.row).toMatchObject({ status: 'DRAFT_READY', markdown: draft, lastError: 'ARTICLE_GIF_UPLOAD_UNVERIFIED' });
    expect(h.click).not.toHaveBeenCalled();
    expect(h.api.graphql.mock.calls.some(([query]: [string]) => query.includes('mutation '))).toBe(false);
  });

  it('fills the browser editor with both verified attachments and clicks Post once', async () => {
    const { draft, attached } = useStoredGifDraft();
    h.api.graphql.mockResolvedValueOnce({ ugcArticleSolutionArticles: { pageInfo: { hasNextPage: false }, edges: [] } })
      .mockResolvedValueOnce({ ugcArticleSolutionArticle: { topicId: 123, title: h.row.title, content: attached } });
    expect(await publishPost('post1')).toMatchObject({ status: 'PUBLISHED', publicationMarkdown: attached, markdown: draft });
    expect(h.text).toBe(attached);
    expect(h.page.goto).toHaveBeenCalledTimes(2); // Editor, then published article.
    expect(h.click).toHaveBeenCalledTimes(1);
  });

  it('loads both original files before starting an upload and refuses foreign CDN URLs', async () => {
    const { cdn } = useStoredGifDraft();
    h.readGif.mockResolvedValueOnce(null);
    await expect(publishPost('post1')).rejects.toThrow('ARTICLE_GIF_MISSING_OR_INVALID');
    expect(h.upload).not.toHaveBeenCalled();
    h.upload.mockResolvedValueOnce('https://assets.leetcode.com.other.test/users/images/file.gif');
    await expect(publishPost('post1')).rejects.toThrow('ARTICLE_GIF_UPLOAD_UNVERIFIED');
    expect(cdn).not.toHaveBeenCalled();
    expect(h.click).not.toHaveBeenCalled();
  });

  it('reserves the exact attached draft for local browser publication without opening a remote editor', async () => {
    const { attached, contentHash } = useStoredGifDraft();
    await expect(reserveBrowserPublication('post1', contentHash)).rejects.toThrow('LEETCODE_IMAGE_ATTACHMENTS_REQUIRED');
    expect(h.row.status).toBe('DRAFT_READY');
    expect(await reserveBrowserPublication('post1', contentHash, nativeUrls)).toMatchObject({ status: 'PUBLISHING', publicationMarkdown: attached });
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.page.goto).not.toHaveBeenCalled();
    h.duplicate = true;
    h.api.graphql.mockResolvedValueOnce({ ugcArticleSolutionArticle: { topicId: 123, title: h.row.title, content: attached } });
    expect(await reconcilePost('post1', h.url)).toMatchObject({ status: 'PUBLISHED', publicationMarkdown: attached });
  });

  it('publishes through the authenticated API and verifies exact content and author without page navigation', async () => {
    config.solutionPosts.publishTransport = 'api';
    h.api.graphql.mockResolvedValueOnce({ ugcArticleSolutionArticles: { pageInfo: { hasNextPage: false }, edges: [] } })
      .mockImplementationOnce(async () => { h.clicked = true;
        return { ugcArticlePublishSolution: { article: { topicId: 123, slug: 'teach-with-sets' }, error: null } }; });
    const result = await publishPost('post1');
    expect(result.status).toBe('PUBLISHED'); expect(result.publishedUrl).toBe(h.url);
    const mutation = h.api.graphql.mock.calls.find((call: any[]) => call[0].includes('mutation ugcArticlePublishSolution'));
    expect(mutation[1].data).toEqual({ questionSlug: context.slug, title: h.row.title, content: markdown,
      summary: h.row.title, thumbnail: '', tags: ['cpp'] });
    expect(h.page.goto).not.toHaveBeenCalled(); expect(h.click).not.toHaveBeenCalled();
    await publishPost('post1');
    expect(h.api.graphql.mock.calls.filter((call: any[]) => call[0].includes('mutation '))).toHaveLength(1);
  });
  it('publishes the reviewed implementation while verifying the original accepted submission', async () => {
    config.solutionPosts.publishTransport = 'api';
    const articleImplementation = { code: 'class Solution { public: int size() { return 1; } };', approach: 'Return the fixed size.' };
    const rewritten = markdown.replace(context.articleImplementation.code, articleImplementation.code);
    const digest = hash(h.row.title + '\n' + rewritten);
    Object.assign(h.row, { context: JSON.stringify({ ...context, articleImplementation }),
      markdown: rewritten, contentHash: digest, approvedHash: digest });
    h.api.graphql.mockResolvedValueOnce({ ugcArticleSolutionArticles: { pageInfo: { hasNextPage: false }, edges: [] } })
      .mockImplementationOnce(async () => {
        h.clicked = true;
        return { ugcArticlePublishSolution: { article: { topicId: 123, slug: 'teach-with-sets' }, error: null } };
      })
      .mockResolvedValueOnce({ ugcArticleSolutionArticle: { topicId: 123, title: h.row.title, content: rewritten } });
    const result = await publishPost('post1');
    expect(result.status).toBe('PUBLISHED');
    expect(h.api.awaitSubmission).toHaveBeenCalledWith(context.submissionId, context.slug, expect.any(Number), expect.anything());
    expect(h.api.graphql.mock.calls[1]![1].data.content).toBe(rewritten);
  });
  it('rejects a draft whose code block differs from the reviewed implementation', async () => {
    h.row.context = JSON.stringify({ ...context, articleImplementation: { code: 'class Different {};', approach: 'A reviewed approach.' } });
    await expect(publishPost('post1')).rejects.toThrow('SOURCE_INTEGRITY_FAILED');
    expect(h.api.graphql).not.toHaveBeenCalled();
  });
  it('requires a new layout before a legacy draft can publish', async () => {
    h.row.context = JSON.stringify({ ...context, presentation: undefined });
    await expect(publishPost('post1')).rejects.toThrow('ARTICLE_LAYOUT_REFRESH_REQUIRED');
    expect(h.api.graphql).not.toHaveBeenCalled();
  });
  it('closes a definitive contest-rules posting refusal without retrying the mutation', async () => {
    config.solutionPosts.publishTransport = 'api';
    h.api.graphql.mockResolvedValueOnce({ ugcArticleSolutionArticles: { pageInfo: { hasNextPage: false }, edges: [] } })
      .mockRejectedValueOnce(new LeetCodeHttpError('GraphQL error: You have been banned from posting due to violating our contest rules.', 200));
    expect(await publishPost('post1')).toMatchObject({ status: 'SKIPPED', lastError: 'LEETCODE_POSTING_RESTRICTED', markdown });
    expect(h.api.graphql.mock.calls.filter((call: any[]) => call[0].includes('mutation '))).toHaveLength(1);
  });
  it('closes an earlier confirmed refusal after checking that no matching article exists', async () => {
    Object.assign(h.row, { status: 'PUBLISHING', lastError: 'PUBLICATION_UNCERTAIN_RECONCILE_FIRST', publishedUrl: null });
    expect(await reconcilePost('post1', undefined, true)).toMatchObject({ status: 'SKIPPED', lastError: 'LEETCODE_POSTING_RESTRICTED', markdown });
    expect(h.api.graphql.mock.calls.every((call: any[]) => !call[0].includes('mutation '))).toBe(true);
  });
  it('never retries an uncertain publication API request or falls back to a Post click', async () => {
    config.solutionPosts.publishTransport = 'api';
    h.api.graphql.mockResolvedValueOnce({ ugcArticleSolutionArticles: { pageInfo: { hasNextPage: false }, edges: [] } })
      .mockRejectedValueOnce(new Error('connection lost after request'));
    expect((await publishPost('post1')).status).toBe('PUBLISHING');
    await expect(publishPost('post1')).rejects.toThrow('PUBLICATION_UNCERTAIN');
    expect(h.api.graphql.mock.calls.filter((call: any[]) => call[0].includes('mutation '))).toHaveLength(1);
    expect(h.page.goto).not.toHaveBeenCalled(); expect(h.click).not.toHaveBeenCalled();
  });
  it('recovers a lost publication response through exact read-only verification without a second mutation', async () => {
    config.solutionPosts.publishTransport = 'api';
    h.api.graphql.mockResolvedValueOnce({ ugcArticleSolutionArticles: { pageInfo: { hasNextPage: false }, edges: [] } })
      .mockImplementationOnce(async () => { h.clicked = true; throw Error('response lost after creation'); });
    expect(await publishPost('post1')).toMatchObject({ status: 'PUBLISHED', publishedUrl: h.url, lastError: null });
    expect(h.api.graphql.mock.calls.filter((call: any[]) => call[0].includes('mutation '))).toHaveLength(1);
    expect(h.page.goto).not.toHaveBeenCalled(); expect(h.click).not.toHaveBeenCalled();
  });
  it('reserves local browser publication atomically and verifies it through the API without opening Render UI', async () => {
    expect((await reserveBrowserPublication('post1', h.row.approvedHash)).status).toBe('PUBLISHING');
    await expect(reserveBrowserPublication('post1', h.row.approvedHash)).rejects.toThrow();
    await expect(publishPost('post1')).rejects.toThrow();
    h.duplicate = true;
    expect((await reconcilePost('post1', h.url)).status).toBe('PUBLISHED');
    expect(h.page.goto).not.toHaveBeenCalled();
    expect(h.click).not.toHaveBeenCalled();
  });
  it('rejects an altered draft when reserving local publication', async () => {
    await expect(reserveBrowserPublication('post1', '0'.repeat(64))).rejects.toThrow('REVIEW_REQUIRED');
    expect(h.row.status).toBe('DRAFT_READY');
  });
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
  it('finds an uncertain article by exact title on the server and verifies its body without republishing', async () => {
    h.row.status = 'PUBLISHING'; h.duplicate = true;
    const post = await reconcilePost('post1');
    expect(post.status).toBe('PUBLISHED'); expect(post.publishedUrl).toBe(h.url);
    expect(h.click).not.toHaveBeenCalled();
    expect(h.api.graphql.mock.calls.every((call: any[]) => !call[0].includes('mutation '))).toBe(true);
  });
  it('inspects the authenticated account articles without any mutation', async () => {
    h.duplicate = true;
    const check = await inspectPublication('post1');
    expect(check).toMatchObject({ username: 'alice', scanComplete: true, articles: [{ title: 'Teach with sets', url: h.url }] });
    expect(h.api.graphql.mock.calls.every((call: any[]) => !call[0].includes('mutation '))).toBe(true);
    expect(h.row.status).toBe('DRAFT_READY'); expect(h.click).not.toHaveBeenCalled();
  });
  it('checks basic verification status when schema discovery is unavailable', async () => {
    h.api.graphql.mockResolvedValueOnce({ ugcArticleSolutionArticles: { pageInfo: { hasNextPage: false }, edges: [] } })
      .mockRejectedValueOnce(Error('schema discovery unavailable'))
      .mockResolvedValueOnce({ userStatus: { isSignedIn: true, username: 'alice', isVerified: false } });
    expect(await inspectPublication('post1')).toMatchObject({ scanComplete: true, accountStatus: { isVerified: false } });
    expect(h.api.graphql.mock.calls.every((call: any[]) => !call[0].includes('mutation '))).toBe(true);
  });
  it('retains uncertainty when its exact article cannot be found or its content differs', async () => {
    h.row.status = 'PUBLISHING';
    await expect(reconcilePost('post1')).rejects.toThrow('PUBLICATION_NOT_FOUND');
    h.duplicate = true; h.verifyFailure = true;
    await expect(reconcilePost('post1')).rejects.toThrow();
    expect(h.row.status).toBe('PUBLISHING'); expect(h.click).not.toHaveBeenCalled();
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
  it('checks the authenticated account list instead of scanning global HOT articles', async () => {
    await publishPost('post1');
    const lists = h.api.graphql.mock.calls.filter((c: any[]) => c[0].includes('ugcArticleSolutionArticles('));
    expect(lists.length).toBeGreaterThan(0);
    expect(lists.every((c: any[]) => c[0].includes('isMine: true'))).toBe(true);
  });
  it('refuses to post if the account filter returns another author', async () => {
    h.api.graphql.mockResolvedValueOnce({ ugcArticleSolutionArticles: { pageInfo: { hasNextPage: false }, edges: [
      { node: { topicId: 789, title: 'Other post', slug: 'other', author: { userName: 'bob' } } }] } });
    await expect(publishPost('post1')).rejects.toThrow('ACCOUNT_SOLUTION_FILTER_UNVERIFIED');
    expect(h.click).not.toHaveBeenCalled();
  });
  it('rejects mismatched account/code context', async () => {
    h.row.accountId = 'b'; await expect(publishPost('post1')).rejects.toThrow('SOURCE_INTEGRITY_FAILED');
    expect(h.click).not.toHaveBeenCalled();
  });
  it('verifies a prepopulated accepted code block before editing', async () => {
    await prepareEditor(h.page, context as any, 'Teach with sets', markdown);
    expect(h.text).toBe(markdown);
  });
  it('reports a 403 verification page without editing or posting', async () => {
    h.page.goto.mockResolvedValueOnce({ status: () => 403 });
    h.page.getByPlaceholder.mockReturnValueOnce({ waitFor: vi.fn().mockRejectedValue(new Error('timeout')) });
    h.page.evaluate.mockResolvedValueOnce({ title: 'Just a moment...', placeholders: [], verificationRequired: true });
    await expect(prepareEditor(h.page, context as any, 'Teach with sets', markdown))
      .rejects.toThrow('LEETCODE_BROWSER_VERIFICATION_REQUIRED');
    expect(h.click).not.toHaveBeenCalled();
    expect(h.text).toBe(h.original);
  });
  it.each(['https://evil.test/problems/example/solutions/123/name/',
    'http://leetcode.com/problems/example/solutions/123/name/',
    'https://leetcode.com/problems/other/solutions/123/name/',
    'https://leetcode.com/problems/example/solutions/123/name/?x=1'])('rejects invalid publication URL %s', url => {
    expect(validSolutionUrl(url, 'example')).toBe(false);
  });
});
