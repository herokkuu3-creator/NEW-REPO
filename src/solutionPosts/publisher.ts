import { Page } from 'playwright';
import { z } from 'zod';
import { prisma } from '../database/prisma';
import { LeetCodeApi } from '../leetcode/apiClient';
import { contextSchema, hash, SubmissionContext } from './article';
import { move } from './store';
import { PostError, withAccount } from './service';
import { UGC_SOLUTION_ARTICLE_QUERY } from '../solutions/communitySolutions';
import { logger } from '../logger';

// LeetCode's My Solution filter scopes the list to the authenticated account.
// A global HOT scan can never prove absence on problems with >1000 articles.
export const ACCOUNT_SOLUTION_ARTICLES_QUERY = `query ugcArticleSolutionArticles($questionSlug: String!, $skip: Int, $first: Int) {
  ugcArticleSolutionArticles(questionSlug: $questionSlug, isMine: true, skip: $skip, first: $first) {
    pageInfo { hasNextPage }
    edges { node { topicId title slug author { userName } } }
  }
}`;

const listSchema = z.object({ ugcArticleSolutionArticles: z.object({
  pageInfo: z.object({ hasNextPage: z.boolean() }), edges: z.array(z.object({ node: z.object({
    topicId: z.number(), title: z.string(), slug: z.string(),
    author: z.object({ userName: z.string() }).nullable(),
  }) })),
}) });

/** Bounded scan. If the full list cannot be checked, publication requires manual reconciliation. */
async function existingPost(api: LeetCodeApi, context: SubmissionContext) {
  for (let page = 0; page < 10; page++) {
    const result = await api.graphql(ACCOUNT_SOLUTION_ARTICLES_QUERY, { questionSlug: context.slug,
      skip: page * 100, first: 100 }, listSchema);
    if (result.ugcArticleSolutionArticles.edges.some(e => e.node.author?.userName.toLowerCase() !== context.username.toLowerCase())) {
      throw new PostError('ACCOUNT_SOLUTION_FILTER_UNVERIFIED');
    }
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
  const navigation = await page.goto(`https://leetcode.com/problems/${context.slug}/post-solution/?submissionId=${context.submissionId}`,
    { waitUntil: 'domcontentloaded', timeout: 30000 });
  const titleInput = page.getByPlaceholder('Enter your title', { exact: true });
  try { await titleInput.waitFor({ state: 'visible', timeout: 15000 }); }
  catch (error) {
    const document = await page.evaluate(() => ({ title: window.document.title,
      placeholders: Array.from(window.document.querySelectorAll('input,textarea')).map(e => e.getAttribute('placeholder')).filter(Boolean),
      verificationRequired: /just a moment|verify you are human|checking your browser/i.test(window.document.title + '\n' + (window.document.body?.innerText ?? '')) }));
    logger.warn({ accountId: context.accountId, submissionId: context.submissionId, url: page.url(),
      httpStatus: navigation?.status(), document }, 'LeetCode article editor unavailable');
    if (document.verificationRequired) throw new PostError('LEETCODE_BROWSER_VERIFICATION_REQUIRED');
    if (navigation?.status() === 403) throw new PostError('LEETCODE_EDITOR_ACCESS_DENIED');
    throw new PostError('LEETCODE_EDITOR_UNAVAILABLE');
  }
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
  await verifyPublishedContent(api, url, context, title, markdown);
}

async function verifyPublishedContent(api: LeetCodeApi, url: string, context: SubmissionContext, title: string, markdown: string) {
  if (!validSolutionUrl(url, context.slug)) throw new PostError('POST_URL_UNVERIFIED');
  const topicId = new URL(url).pathname.split('/')[4]!;
  const content = await api.graphql(UGC_SOLUTION_ARTICLE_QUERY, { topicId },
    z.object({ ugcArticleSolutionArticle: z.object({ content: z.string(), title: z.string(), topicId: z.number() }) }));
  if (content.ugcArticleSolutionArticle.title !== title || content.ugcArticleSolutionArticle.content !== markdown ||
    String(content.ugcArticleSolutionArticle.topicId) !== topicId) throw new PostError('POST_CONTENT_UNVERIFIED');
  // Match the author to this specific topic; a profile link in the navbar is insufficient.
  let verified = false;
  for (let n = 0; n < 10; n++) {
    const list = await api.graphql(ACCOUNT_SOLUTION_ARTICLES_QUERY, { questionSlug: context.slug,
      skip: n * 100, first: 100 }, listSchema);
    const node = list.ugcArticleSolutionArticles.edges.find(e => String(e.node.topicId) === topicId)?.node;
    if (node) { verified = node.author?.userName.toLowerCase() === context.username.toLowerCase(); break; }
    if (!list.ugcArticleSolutionArticles.pageInfo.hasNextPage) break;
  }
  if (!verified) throw new PostError('POST_AUTHOR_UNVERIFIED');
}

/** Reserve an approved draft before the operator posts it in an authenticated local browser. */
export async function reserveBrowserPublication(id: string, approvedHash: string) {
  const post = await prisma.solutionPost.findUniqueOrThrow({ where: { id } });
  if (post.status !== 'DRAFT_READY' || !post.title || !post.markdown || !post.approvedHash ||
    approvedHash !== post.approvedHash || approvedHash !== hash(`${post.title}\n${post.markdown}`)) throw new PostError('REVIEW_REQUIRED');
  const context = contextSchema.parse(JSON.parse(post.context));
  if (hash(context.code) !== post.codeHash || context.accountId !== post.accountId || context.slug !== post.problemSlug ||
    context.submissionId !== post.submissionId) throw new PostError('SOURCE_INTEGRITY_FAILED');
  const account = await prisma.account.findUniqueOrThrow({ where: { id: post.accountId } });
  return withAccount(account, async (api, _page, username) => {
    await checkEligibility(api, context, username);
    const duplicate = await existingPost(api, context);
    if (duplicate) return move(post, 'SKIPPED', { lastError: 'EXISTING_ACCOUNT_SOLUTION', publishedUrl: duplicate });
    return move(post, 'PUBLISHING', { lastError: 'LOCAL_BROWSER_PUBLICATION_PENDING' });
  });
}

export async function publishPost(id: string) {
  let preparationStage = 'load';
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
    preparationStage = 'eligibility';
    await checkEligibility(api, context, username);
    preparationStage = 'duplicate-check';
    const duplicate = await existingPost(api, context);
    if (duplicate) return move(post, 'SKIPPED', { lastError: 'EXISTING_ACCOUNT_SOLUTION', publishedUrl: duplicate });
    preparationStage = 'editor';
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
    logger.warn({ postId: id, stage: preparationStage, errorName: error instanceof Error ? error.name : 'Unknown',
      error: error instanceof Error ? error.message.replace(/(?:fc-|sk-|cc_)[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 1500) : 'Unknown' },
      'solution article publishing preparation failed');
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
    // The operator's local browser may be able to open the UI while Render's
    // browser is blocked. Exact content, topic and authenticated author must
    // still be independently verified through LeetCode's API.
    await verifyPublishedContent(api, url, context, post.title!, post.markdown!);
    return move(post, 'PUBLISHED', { publishedUrl: url, publishedAt: new Date(), lastError: null });
  });
}
