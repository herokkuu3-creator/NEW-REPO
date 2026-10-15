import { Page } from 'playwright';
import { z } from 'zod';
import { prisma } from '../database/prisma';
import { LeetCodeApi } from '../leetcode/apiClient';
import { contextSchema, hash, SubmissionContext } from './article';
import { move } from './store';
import { PostError, withAccount } from './service';
import { UGC_SOLUTION_ARTICLES_QUERY, UGC_SOLUTION_ARTICLE_QUERY } from '../solutions/communitySolutions';

const listSchema = z.object({ ugcArticleSolutionArticles: z.object({
  pageInfo: z.object({ hasNextPage: z.boolean() }), edges: z.array(z.object({ node: z.object({
    topicId: z.number(), title: z.string(), slug: z.string(),
    author: z.object({ userName: z.string() }).nullable(),
  }) })),
}) });

/** Bounded scan. If the full list cannot be checked, publication requires manual reconciliation. */
async function existingPost(api: LeetCodeApi, context: SubmissionContext) {
  for (let page = 0; page < 10; page++) {
    const result = await api.graphql(UGC_SOLUTION_ARTICLES_QUERY, { questionSlug: context.slug,
      orderBy: 'HOT', skip: page * 100, first: 100, tagSlugs: [] }, listSchema);
    const found = result.ugcArticleSolutionArticles.edges.find(e => e.node.author?.userName.toLowerCase() === context.username.toLowerCase());
    if (found) return `https://leetcode.com/problems/${context.slug}/solutions/${found.node.topicId}/${found.node.slug}/`;
    if (!result.ugcArticleSolutionArticles.pageInfo.hasNextPage) return null;
  }
  throw new PostError('EXISTING_POST_SCAN_INCOMPLETE');
}

export function validSolutionUrl(url: string, slug: string): boolean {
  try { const u = new URL(url); return u.protocol === 'https:' && u.hostname === 'leetcode.com' &&
    new RegExp(`^/problems/${slug}/solutions/\\d+/[^/]+/?$`).test(u.pathname) && !u.search && !u.hash; }
  catch { return false; }
}

async function checkEligibility(api: LeetCodeApi, context: SubmissionContext, username: string) {
  if (username.toLowerCase() !== context.username.toLowerCase()) throw new PostError('ACCOUNT_IDENTITY_MISMATCH');
  const result = await api.awaitSubmission(context.submissionId, context.slug, 30000, { firstPollDelayMs: 0 });
  if (result.classification !== 'ACCEPTED') throw new PostError('ACCEPTED_SUBMISSION_REQUIRED');
}

/** Uses only the visible post-solution UI, with exact source comparison before replacing the template. */
export async function prepareEditor(page: Page, context: SubmissionContext, title: string, markdown: string) {
  await page.goto(`https://leetcode.com/problems/${context.slug}/post-solution/?submissionId=${context.submissionId}`,
    { waitUntil: 'domcontentloaded', timeout: 30000 });
  const titleInput = page.getByPlaceholder('Enter your title', { exact: true });
  await titleInput.waitFor({ state: 'visible', timeout: 15000 });
  const editor = page.getByRole('textbox', { name: 'Editor content', exact: true });
  await editor.waitFor({ state: 'visible', timeout: 15000 });
  // Read the model behind this observed editor, not an unrelated global editor.
  const original = await page.evaluate(() => {
    const m = (window as unknown as { monaco?: { editor: { getModels(): Array<{ getValue(): string }> } } }).monaco;
    const models = m?.editor.getModels() ?? [];
    return models.length === 1 ? models[0]!.getValue() : null;
  });
  if (!original) throw new PostError('EDITOR_SOURCE_UNAVAILABLE');
  const blocks = [...original.matchAll(/^(`{3,})[^\n]*\r?\n([\s\S]*?)\r?\n\1\s*$/gm)];
  if (blocks.length !== 1 || blocks[0]![2] !== context.code) throw new PostError('EDITOR_SOURCE_MISMATCH');
  await titleInput.fill(title);
  // Monaco's textarea is an input surface rather than its full document: fill() alone can
  // insert before the existing template. Clear the actual editor selection first.
  await editor.press('ControlOrMeta+A');
  await editor.press('Backspace');
  await editor.fill(markdown);
  const saved = await page.evaluate(() => {
    const m = (window as unknown as { monaco?: { editor: { getModels(): Array<{ getValue(): string }> } } }).monaco;
    const models = m?.editor.getModels() ?? [];
    return models.length === 1 ? models[0]!.getValue() : null;
  });
  if (saved !== markdown || await titleInput.inputValue() !== title) throw new PostError('EDITOR_CONTENT_MISMATCH');
  if (!await page.getByRole('button', { name: 'Post', exact: true }).isEnabled()) throw new PostError('PUBLISHING_UNAVAILABLE');
}

async function verifyPublished(api: LeetCodeApi, page: Page, url: string, context: SubmissionContext, title: string, markdown: string) {
  if (!validSolutionUrl(url, context.slug)) throw new PostError('POST_URL_UNVERIFIED');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // The live solution detail header renders the article title as plain text, not a heading.
  await page.getByText(title, { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
  const topicId = new URL(url).pathname.split('/')[4]!;
  const content = await api.graphql(UGC_SOLUTION_ARTICLE_QUERY, { topicId },
    z.object({ ugcArticleSolutionArticle: z.object({ content: z.string(), title: z.string(), topicId: z.number() }) }));
  if (content.ugcArticleSolutionArticle.title !== title || content.ugcArticleSolutionArticle.content !== markdown ||
    String(content.ugcArticleSolutionArticle.topicId) !== topicId) throw new PostError('POST_CONTENT_UNVERIFIED');
  // Match the author to this specific topic; a profile link in the navbar is insufficient.
  let verified = false;
  for (let n = 0; n < 10; n++) {
    const list = await api.graphql(UGC_SOLUTION_ARTICLES_QUERY, { questionSlug: context.slug,
      orderBy: 'HOT', skip: n * 100, first: 100, tagSlugs: [] }, listSchema);
    const node = list.ugcArticleSolutionArticles.edges.find(e => String(e.node.topicId) === topicId)?.node;
    if (node) { verified = node.author?.userName.toLowerCase() === context.username.toLowerCase(); break; }
    if (!list.ugcArticleSolutionArticles.pageInfo.hasNextPage) break;
  }
  if (!verified) throw new PostError('POST_AUTHOR_UNVERIFIED');
}

export async function publishPost(id: string) {
  let post = await prisma.solutionPost.findUniqueOrThrow({ where: { id } });
  if (post.status === 'PUBLISHED') return post;
  if (post.status === 'PUBLISHING') throw new PostError('PUBLICATION_UNCERTAIN_RECONCILE_FIRST');
  if (post.status !== 'DRAFT_READY' || !post.title || !post.markdown || !post.approvedHash ||
    post.approvedHash !== hash(`${post.title}\n${post.markdown}`)) throw new PostError('REVIEW_REQUIRED');
  const context = contextSchema.parse(JSON.parse(post.context));
  if (hash(context.code) !== post.codeHash || context.accountId !== post.accountId || context.slug !== post.problemSlug ||
    context.submissionId !== post.submissionId) throw new PostError('SOURCE_INTEGRITY_FAILED');
  const account = await prisma.account.findUniqueOrThrow({ where: { id: post.accountId } });
  return withAccount(account, async (api, page, username) => {
    await checkEligibility(api, context, username);
    const duplicate = await existingPost(api, context);
    if (duplicate) return move(post, 'SKIPPED', { lastError: 'EXISTING_ACCOUNT_SOLUTION', publishedUrl: duplicate });
    await prepareEditor(page, context, post.title!, post.markdown!);
    // CAS before the sole irreversible click. A crash after this point never repeats the click.
    post = await move(post, 'PUBLISHING');
    try {
      await page.getByRole('button', { name: 'Post', exact: true }).click({ timeout: 10000 });
      await page.waitForURL(url => validSolutionUrl(url.toString(), context.slug), { timeout: 30000 });
      post = await prisma.solutionPost.update({ where: { id }, data: { publishedUrl: page.url() } });
      await verifyPublished(api, page, post.publishedUrl!, context, post.title!, post.markdown!);
      return await move(post, 'PUBLISHED', { publishedAt: new Date(), lastError: null });
    } catch {
      // Do not transition to FAILED: a retry could produce a duplicate public post.
      return prisma.solutionPost.update({ where: { id }, data: { lastError: 'PUBLICATION_UNCERTAIN_RECONCILE_FIRST' } });
    }
  }).catch(async error => {
    await prisma.solutionPost.updateMany({ where: { id, status: 'DRAFT_READY' }, data: {
      lastError: error instanceof PostError ? error.code : 'PUBLISH_PREPARATION_FAILED',
    } });
    throw error;
  });
}

/** Operator supplies the candidate URL after an uncertain result. Only positive verification completes it. */
export async function reconcilePost(id: string, url: string) {
  const post = await prisma.solutionPost.findUniqueOrThrow({ where: { id } });
  if (post.status !== 'PUBLISHING' || !post.title) throw new PostError('NOT_A_PENDING_PUBLICATION');
  const context = contextSchema.parse(JSON.parse(post.context));
  if (!validSolutionUrl(url, context.slug)) throw new PostError('POST_URL_UNVERIFIED');
  const account = await prisma.account.findUniqueOrThrow({ where: { id: post.accountId } });
  return withAccount(account, async (api, page, username) => {
    await checkEligibility(api, context, username);
    await verifyPublished(api, page, url, context, post.title!, post.markdown!);
    return move(post, 'PUBLISHED', { publishedUrl: url, publishedAt: new Date(), lastError: null });
  });
}
