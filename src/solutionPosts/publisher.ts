import { Page } from 'playwright';
import { z } from 'zod';
import { prisma } from '../database/prisma';
import { LeetCodeApi, LeetCodeHttpError } from '../leetcode/apiClient';
import { contextSchema, hash, SubmissionContext, titleIncludesQuestionName, buildArticleTags } from './article';
import { scheduleSolutionArticleUpvotes } from './upvote';
import { move } from './store';
import { PostError, withAccount } from './service';
import { UGC_SOLUTION_ARTICLE_QUERY } from '../solutions/communitySolutions';
import { logger } from '../logger';
import { config } from '../config';

// LeetCode's authenticated mutation. Request shape was validated against its
// live GraphQL schema without executing a publication during discovery.
export const PUBLISH_SOLUTION_MUTATION = `mutation ugcArticlePublishSolution($data: UgcArticlePublishSolutionInput!) {
  ugcArticlePublishSolution(data: $data) { article { topicId slug } error }
}`;
const publishSchema = z.object({ ugcArticlePublishSolution: z.object({
  article: z.object({ topicId: z.number(), slug: z.string().min(1) }).nullable(),
  error: z.string().nullable().optional(),
}) });

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
async function existingPost(api: LeetCodeApi, context: SubmissionContext, expectedTitle?: string) {
  for (let page = 0; page < 10; page++) {
    const result = await api.graphql(ACCOUNT_SOLUTION_ARTICLES_QUERY, { questionSlug: context.slug,
      skip: page * 100, first: 100 }, listSchema);
    if (result.ugcArticleSolutionArticles.edges.some(e => e.node.author?.userName.toLowerCase() !== context.username.toLowerCase())) {
      throw new PostError('ACCOUNT_SOLUTION_FILTER_UNVERIFIED');
    }
    const found = result.ugcArticleSolutionArticles.edges.find(e => e.node.author?.userName.toLowerCase() === context.username.toLowerCase() &&
      (expectedTitle === undefined || e.node.title === expectedTitle));
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

export async function checkEligibility(api: LeetCodeApi, context: SubmissionContext, username: string) {
  if (username.toLowerCase() !== context.username.toLowerCase()) throw new PostError('ACCOUNT_IDENTITY_MISMATCH');
  const result = await api.awaitSubmission(context.submissionId, context.slug, 30000, { firstPollDelayMs: 0 });
  if (result.classification !== 'ACCEPTED') throw new PostError('ACCEPTED_SUBMISSION_REQUIRED');
  return result;
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
  try {
    const tagBtn = page.getByRole('button', { name: /tag/i }).first();
    if (await tagBtn.isVisible({ timeout: 1500 })) {
      await tagBtn.click();
      await page.waitForTimeout(400);
      const tagOptions = page.locator('div[role="option"], div[role="menuitem"], li, button');
      const langOption = tagOptions.filter({ hasText: /^c\+\+$/i }).first();
      if (await langOption.isVisible({ timeout: 1000 })) {
        await langOption.click();
      }
      const relatedOptions = tagOptions.filter({ hasText: /related/i });
      const count = await relatedOptions.count();
      for (let i = 0; i < Math.min(count, 5); i++) {
        await relatedOptions.nth(i).click().catch(() => undefined);
      }
      await page.keyboard.press('Escape');
    }
  } catch (err) {
    logger.debug({ err }, 'browser tag selection skipped or completed');
  }
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
  verifyArticleCode(post.markdown, context);
  const account = await prisma.account.findUniqueOrThrow({ where: { id: post.accountId } });
  return withAccount(account, async (api, _page, username) => {
    await checkEligibility(api, context, username);
    const duplicate = await existingPost(api, context);
    if (duplicate) return move(post, 'SKIPPED', { lastError: 'EXISTING_ACCOUNT_SOLUTION', publishedUrl: duplicate });
    return move(post, 'PUBLISHING', { lastError: 'LOCAL_BROWSER_PUBLICATION_PENDING' });
  });
}

export function verifyArticleCode(markdown: string, context: SubmissionContext): void {
  const blocks = [...markdown.matchAll(/^(`{3,})[^\r\n]*\n([\s\S]*?)\n\1[ \t]*$/gm)];
  const reviewedCode = context.articleImplementation?.code ?? context.code;
  if (blocks.length !== 1 || blocks[0]?.[2] !== reviewedCode) throw new PostError('SOURCE_INTEGRITY_FAILED');
}

export async function publishPost(id: string) {
  let preparationStage = 'load';
  let post = await prisma.solutionPost.findUniqueOrThrow({ where: { id } });
  if (post.status === 'PUBLISHED') return post;
  if (post.status === 'PUBLISHING') throw new PostError('PUBLICATION_UNCERTAIN_RECONCILE_FIRST');
  if (post.status !== 'DRAFT_READY' || !post.title || !post.markdown || !post.approvedHash ||
    post.approvedHash !== hash(`${post.title}\n${post.markdown}`)) throw new PostError('REVIEW_REQUIRED');
  const context = contextSchema.parse(JSON.parse(post.context));
  if (titleIncludesQuestionName(post.title, context)) throw new PostError('QUESTION_NAME_IN_TITLE');
  if (hash(context.code) !== post.codeHash || context.accountId !== post.accountId || context.slug !== post.problemSlug ||
    context.submissionId !== post.submissionId) throw new PostError('SOURCE_INTEGRITY_FAILED');
  verifyArticleCode(post.markdown, context);
  const account = await prisma.account.findUniqueOrThrow({ where: { id: post.accountId } });
  return withAccount(account, async (api, page, username) => {
    preparationStage = 'eligibility';
    await checkEligibility(api, context, username);
    preparationStage = 'duplicate-check';
    const duplicate = await existingPost(api, context);
    if (duplicate) return move(post, 'SKIPPED', { lastError: 'EXISTING_ACCOUNT_SOLUTION', publishedUrl: duplicate });
    if (config.solutionPosts.publishTransport === 'api') {
      preparationStage = 'publication-api';
      // Claim BEFORE the sole irreversible request. An error never causes an
      // automatic repeat or a second attempt through the browser transport.
      post = await move(post, 'PUBLISHING');
      try {
        const tags = buildArticleTags(context, post.markdown!);
        logger.info({ postId: id, tags }, 'publishing solution article with tags');
        const result = await api.graphql(PUBLISH_SOLUTION_MUTATION, { data: {
          questionSlug: context.slug, title: post.title!, content: post.markdown!,
          summary: post.title!, thumbnail: '', tags,
        } }, publishSchema);
        const response = result.ugcArticlePublishSolution;
        if (response.error || !response.article) {
          logger.warn({ postId: id, reason: String(response.error ?? 'NO_ARTICLE_RETURNED')
            .replace(/(?:fc-|sk-|cc_)[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 500) }, 'solution article publication API rejected');
          throw new PostError('POST_API_REJECTED');
        }
        const url = `https://leetcode.com/problems/${context.slug}/solutions/${response.article.topicId}/${response.article.slug}/`;
        if (!validSolutionUrl(url, context.slug)) throw new PostError('POST_URL_UNVERIFIED');
        post = await prisma.solutionPost.update({ where: { id }, data: { publishedUrl: url } });
        await verifyPublishedContent(api, url, context, post.title!, post.markdown!);
        post = await move(post, 'PUBLISHED', { publishedAt: new Date(), lastError: null });
        logger.info({ postId: id, url, transport: 'api', executionHost: process.env.RENDER_INSTANCE_ID ? 'render' : 'local',
          revision: process.env.RENDER_GIT_COMMIT ?? null }, 'solution article publication verified');
        void scheduleSolutionArticleUpvotes(post).catch((upErr) => logger.warn({ postId: id, err: upErr }, 'failed to schedule article upvotes'));
        return post;
      } catch (error) {
        logger.warn({ postId: id, errorName: error instanceof Error ? error.name : 'Unknown',
          httpStatus: error instanceof LeetCodeHttpError ? error.status : undefined,
          reason: error instanceof LeetCodeHttpError ? error.message.replace(/(?:fc-|sk-|cc_)[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 500) : undefined,
          failure: error instanceof PostError ? error.code : error instanceof z.ZodError ? 'PUBLICATION_RESPONSE_SCHEMA' : 'PUBLICATION_REQUEST_OR_VERIFICATION_FAILED',
          paths: error instanceof z.ZodError ? error.issues.map(issue => issue.path.join('.')) : undefined },
        'solution article publication outcome uncertain');
        const uncertain = await prisma.solutionPost.update({ where: { id }, data: { lastError: 'PUBLICATION_UNCERTAIN_RECONCILE_FIRST' } });
        // A lost mutation response can still have created the article. Recover
        // only through positive read-only evidence; never send another mutation.
        try {
          const candidate = uncertain.publishedUrl ?? await existingPost(api, context, post.title!);
          if (candidate) {
            await verifyPublishedContent(api, candidate, context, post.title!, post.markdown!);
            const reconciled = await move(uncertain, 'PUBLISHED', { publishedUrl: candidate, publishedAt: new Date(), lastError: null });
            logger.info({ postId: id, url: candidate, executionHost: process.env.RENDER_INSTANCE_ID ? 'render' : 'local',
              revision: process.env.RENDER_GIT_COMMIT ?? null }, 'solution article publication reconciled after response failure');
            void scheduleSolutionArticleUpvotes(reconciled).catch((upErr) => logger.warn({ postId: id, err: upErr }, 'failed to schedule article upvotes'));
            return reconciled;
          }
        } catch { /* retain the protected result when the article cannot be positively verified */ }
        return uncertain;
      }
    }
    preparationStage = 'editor';
    await prepareEditor(page, context, post.title!, post.markdown!);
    // CAS before the sole irreversible click. A crash after this point never repeats the click.
    post = await move(post, 'PUBLISHING');
    try {
      await page.getByRole('button', { name: 'Post', exact: true }).click({ timeout: 10000 });
      await page.waitForURL(url => validSolutionUrl(url.toString(), context.slug), { timeout: 30000 });
      post = await prisma.solutionPost.update({ where: { id }, data: { publishedUrl: page.url() } });
      await verifyPublished(api, page, post.publishedUrl!, context, post.title!, post.markdown!);
      post = await move(post, 'PUBLISHED', { publishedAt: new Date(), lastError: null });
      void scheduleSolutionArticleUpvotes(post).catch((upErr) => logger.warn({ postId: id, err: upErr }, 'failed to schedule article upvotes'));
      return post;
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
export async function reconcilePost(id: string, url?: string) {
  const post = await prisma.solutionPost.findUniqueOrThrow({ where: { id } });
  if (post.status !== 'PUBLISHING' || !post.title) throw new PostError('NOT_A_PENDING_PUBLICATION');
  const context = contextSchema.parse(JSON.parse(post.context));
  if (url && !validSolutionUrl(url, context.slug)) throw new PostError('POST_URL_UNVERIFIED');
  const account = await prisma.account.findUniqueOrThrow({ where: { id: post.accountId } });
  return withAccount(account, async (api, page, username) => {
    await checkEligibility(api, context, username);
    // The operator's local browser may be able to open the UI while Render's
    // browser is blocked. Exact content, topic and authenticated author must
    // still be independently verified through LeetCode's API.
    const candidate = url ?? await existingPost(api, context, post.title!);
    if (!candidate) throw new PostError('PUBLICATION_NOT_FOUND_RECONCILE_LATER');
    await verifyPublishedContent(api, candidate, context, post.title!, post.markdown!);
    logger.info({ postId: id, url: candidate, executionHost: process.env.RENDER_INSTANCE_ID ? 'render' : 'local',
      revision: process.env.RENDER_GIT_COMMIT ?? null }, 'solution article publication reconciled');
    const reconciled = await move(post, 'PUBLISHED', { publishedUrl: candidate, publishedAt: new Date(), lastError: null });
    void scheduleSolutionArticleUpvotes(reconciled).catch((upErr) => logger.warn({ postId: id, err: upErr }, 'failed to schedule article upvotes'));
    return reconciled;
  });
}

/** Read-only server diagnostics; never repeats a mutation or exposes session cookies. */
export async function inspectPublication(id: string) {
  const post = await prisma.solutionPost.findUniqueOrThrow({ where: { id } });
  const context = contextSchema.parse(JSON.parse(post.context));
  const account = await prisma.account.findUniqueOrThrow({ where: { id: post.accountId } });
  return withAccount(account, async (api, _page, username) => {
    if (username.toLowerCase() !== context.username.toLowerCase()) throw new PostError('ACCOUNT_IDENTITY_MISMATCH');
    const articles: Array<{ title: string; url: string }> = [];
    let scanComplete = false;
    for (let page = 0; page < 10; page++) {
      const result = await api.graphql(ACCOUNT_SOLUTION_ARTICLES_QUERY, { questionSlug: context.slug, skip: page * 100, first: 100 }, listSchema);
      for (const { node } of result.ugcArticleSolutionArticles.edges) {
        if (node.author?.userName.toLowerCase() !== username.toLowerCase()) throw new PostError('ACCOUNT_SOLUTION_FILTER_UNVERIFIED');
        articles.push({ title: node.title, url: `https://leetcode.com/problems/${context.slug}/solutions/${node.topicId}/${node.slug}/` });
      }
      if (!result.ugcArticleSolutionArticles.pageInfo.hasNextPage) { scanComplete = true; break; }
    }
    let accountStatus: Record<string, unknown> = {};
    let statusFields: string[] = [];
    let statusProbeError: string | undefined;
    try {
      const root = await api.graphql('query { __schema { queryType { fields { name type { name ofType { name } } } } } }', {}, z.object({ __schema: z.any() }));
      const status = root.__schema?.queryType?.fields?.find((field: { name: string }) => field.name === 'userStatus');
      const name = status?.type?.name ?? status?.type?.ofType?.name;
      if (typeof name === 'string') {
        const type = await api.graphql('query($name:String!) { __type(name:$name) { fields { name } } }', { name }, z.object({ __type: z.any() }));
        statusFields = (type.__type?.fields ?? []).map((field: { name: string }) => field.name);
        const allowed = ['isSignedIn', 'username', 'isVerified', 'isEmailVerified', 'isBanned', 'isBlocked'].filter(field => statusFields.includes(field));
        if (allowed.length) accountStatus = (await api.graphql(`query { userStatus { ${allowed.join(' ')} } }`, {}, z.object({ userStatus: z.record(z.unknown()) }))).userStatus;
      }
    } catch { /* account article evidence remains available if schema discovery is disabled */ }
    if (!statusFields.length) {
      try {
        accountStatus = (await api.graphql('query { userStatus { isSignedIn username isVerified } }', {},
          z.object({ userStatus: z.object({ isSignedIn: z.boolean(), username: z.string().nullable(), isVerified: z.boolean() }) }))).userStatus ?? {};
      } catch (error) {
        statusProbeError = error instanceof LeetCodeHttpError ? error.message.slice(0, 500) : 'ACCOUNT_STATUS_QUERY_UNAVAILABLE';
      }
    }
    return { executionHost: process.env.RENDER_INSTANCE_ID ? 'render' : 'local', revision: process.env.RENDER_GIT_COMMIT ?? null,
      postId: id, status: post.status, username, articles, scanComplete, accountStatus, statusFields, statusProbeError };
  });
}
