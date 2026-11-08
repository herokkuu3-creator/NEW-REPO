import { Account } from '@prisma/client';
import { Page } from 'playwright';
import { z } from 'zod';
import { prisma } from '../database/prisma';
import { LeetCodeApi } from '../leetcode/apiClient';
import { logger } from '../logger';
import { editTelegramMessage, sendTelegramMessage, sendTelegramMessageWithId } from '../notifications/telegram';
import { startArticleWorkKeepAlive } from './keepAlive';
import { PostError, withAccount } from './service';

export const UPVOTE_INITIAL_DELAY_MS = 5 * 60 * 1000; // 5 minutes before other accounts start
export const UPVOTE_ACCOUNT_GAP_MS = 60 * 1000;       // 1 minute gap between each account

export const UGC_ARTICLE_REACTION_STATE_QUERY = `
  query ugcArticleSolutionArticle($articleId: ID, $topicId: ID) {
    ugcArticleSolutionArticle(articleId: $articleId, topicId: $topicId) {
      uuid
      topicId
      title
      slug
      myReactionType
      reactions {
        count
        reactionType
      }
    }
  }
`;

export const UGC_ARTICLE_ADD_REACTION_MUTATION = `
  mutation ugcArticleAddReaction($articleId: ID!, $reactionType: ReactionTypeEnum!) {
    ugcArticleAddReaction(articleId: $articleId, reactionType: $reactionType) {
      ok
    }
  }
`;

const reactionStateSchema = z.object({
  ugcArticleSolutionArticle: z
    .object({
      uuid: z.string().min(1),
      topicId: z.number(),
      title: z.string().optional(),
      slug: z.string().optional(),
      myReactionType: z.string().nullable().optional(),
      reactions: z
        .array(
          z.object({
            count: z.number(),
            reactionType: z.string(),
          }),
        )
        .nullable()
        .optional(),
    })
    .nullable(),
});

const addReactionSchema = z.object({
  ugcArticleAddReaction: z
    .object({
      ok: z.boolean().nullable().optional(),
    })
    .nullable(),
});

export interface UpvoteTarget {
  id: string;
  publishedUrl?: string | null;
  accountId: string;
  problemSlug: string;
}

export interface ArticleReactionState {
  uuid: string;
  topicId: number;
  myReactionType: string | null;
  upvotedByMe: boolean;
  upvoteCount: number;
}

export interface AccountUpvoteResult {
  verified: boolean;
  alreadyUpvoted: boolean;
  upvoteCount: number;
  username: string;
  method: 'already_upvoted' | 'graphql_uuid' | 'graphql_topic_id' | 'browser_dom';
}

const activeUpvoteJobs = new Set<string>();

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function extractTopicIdFromUrl(url: string): number | null {
  try {
    const match = /\/solutions\/(\d+)\//i.exec(url);
    if (match?.[1]) {
      const id = parseInt(match[1], 10);
      return Number.isFinite(id) ? id : null;
    }
  } catch {
    // ignore
  }
  return null;
}

export async function fetchArticleReactionState(api: LeetCodeApi, topicId: number): Promise<ArticleReactionState> {
  const res = await api.graphql(
    UGC_ARTICLE_REACTION_STATE_QUERY,
    { topicId: String(topicId) },
    reactionStateSchema,
  );
  const article = res.ugcArticleSolutionArticle;
  if (!article) {
    throw new Error(`ARTICLE_NOT_FOUND:${topicId}`);
  }
  const upvoteReaction = article.reactions?.find((r) => r.reactionType === 'UPVOTE');
  const upvoteCount = upvoteReaction?.count ?? 0;
  const myReactionType = article.myReactionType ?? null;
  return {
    uuid: article.uuid,
    topicId: article.topicId,
    myReactionType,
    upvotedByMe: myReactionType === 'UPVOTE',
    upvoteCount,
  };
}

export async function upvoteArticleWithSession(
  api: LeetCodeApi,
  page: Page | undefined,
  topicId: number,
  publishedUrl?: string | null,
  username = 'unknown',
): Promise<AccountUpvoteResult> {
  const before = await fetchArticleReactionState(api, topicId);
  if (before.upvotedByMe) {
    return {
      verified: true,
      alreadyUpvoted: true,
      upvoteCount: before.upvoteCount,
      username,
      method: 'already_upvoted',
    };
  }

  // Primary: LeetCode's GraphQL ugcArticleAddReaction mutation using article uuid
  try {
    await api.graphql(
      UGC_ARTICLE_ADD_REACTION_MUTATION,
      { articleId: before.uuid, reactionType: 'UPVOTE' },
      addReactionSchema,
    );
    const afterUuid = await fetchArticleReactionState(api, topicId);
    if (afterUuid.upvotedByMe) {
      return {
        verified: true,
        alreadyUpvoted: false,
        upvoteCount: afterUuid.upvoteCount,
        username,
        method: 'graphql_uuid',
      };
    }
  } catch (err) {
    logger.warn(
      { topicId, uuid: before.uuid, username, err: err instanceof Error ? err.message : String(err) },
      'ugcArticleAddReaction with uuid failed; trying topicId fallback',
    );
  }

  // Fallback 1: GraphQL ugcArticleAddReaction mutation using numeric topicId string
  try {
    await api.graphql(
      UGC_ARTICLE_ADD_REACTION_MUTATION,
      { articleId: String(before.topicId), reactionType: 'UPVOTE' },
      addReactionSchema,
    );
    const afterTopic = await fetchArticleReactionState(api, topicId);
    if (afterTopic.upvotedByMe) {
      return {
        verified: true,
        alreadyUpvoted: false,
        upvoteCount: afterTopic.upvoteCount,
        username,
        method: 'graphql_topic_id',
      };
    }
  } catch (err) {
    logger.warn(
      { topicId, username, err: err instanceof Error ? err.message : String(err) },
      'ugcArticleAddReaction with topicId failed; trying browser DOM fallback',
    );
  }

  // Fallback 2: Browser DOM upvote click followed by strict GraphQL verification
  if (page && typeof page.goto === 'function' && publishedUrl) {
    try {
      await page.goto(publishedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (typeof page.waitForTimeout === 'function') {
        await page.waitForTimeout(2000);
      }
      const upvoteBtn = page
        .locator(
          'button:has(svg[data-icon="up"]), button:has(svg.fa-up), button:has(svg[data-icon="arrow-up"]), button:has([data-icon="thumbs-up"]), button[aria-label*="upvote" i], button:has-text("Upvote")',
        )
        .first();
      const isVisible = await upvoteBtn.isVisible({ timeout: 5000 }).catch(() => false);
      if (isVisible) {
        await upvoteBtn.click({ timeout: 5000 });
        if (typeof page.waitForTimeout === 'function') {
          await page.waitForTimeout(2000);
        }
        const afterDom = await fetchArticleReactionState(api, topicId);
        if (afterDom.upvotedByMe) {
          return {
            verified: true,
            alreadyUpvoted: false,
            upvoteCount: afterDom.upvoteCount,
            username,
            method: 'browser_dom',
          };
        }
      }
    } catch (domErr) {
      logger.warn(
        { topicId, username, err: domErr instanceof Error ? domErr.message : String(domErr) },
        'browser DOM upvote fallback failed',
      );
    }
  }

  throw new Error('UPVOTE_NOT_VERIFIED_ON_LEETCODE');
}

export async function upvoteSolutionArticleWithAccount(
  account: Account,
  topicId: number,
  publishedUrl?: string | null,
): Promise<AccountUpvoteResult> {
  const execute = (target: Account) =>
    withAccount(target, async (api, page, username) => {
      if (!target.username && username && typeof prisma.account?.update === 'function') {
        await prisma.account.update({ where: { id: target.id }, data: { username } }).catch(() => undefined);
      }
      return upvoteArticleWithSession(api, page, topicId, publishedUrl, username);
    });

  try {
    return await execute(account);
  } catch (error) {
    if (
      error instanceof PostError &&
      ['AUTHENTICATION_REQUIRED', 'ACCOUNT_UNAVAILABLE'].includes(error.code) &&
      account.status !== 'DISABLED'
    ) {
      try {
        const { refreshLeetCodeAccount } = await import('../security/sessionAutoRefresh');
        const refreshed = await refreshLeetCodeAccount(account);
        if (['valid', 'refreshed'].includes(refreshed.status) && typeof prisma.account?.findUniqueOrThrow === 'function') {
          const updated = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
          return await execute(updated);
        }
      } catch {
        // Fall through to original error
      }
    }
    throw error;
  }
}

function renderUpvoteProgressBoard(params: {
  title: string;
  problemSlug: string;
  publishedUrl: string;
  topicId: number;
  verifiedCount: number;
  failedCount: number;
  totalAccounts: number;
  liveUpvoteCount: number;
  entries: string[];
  activeStep: string;
}): string {
  const lines = [
    `👍 <b>${escapeHtml(params.title)}</b>`,
    '<code>━━━━━━━━━━━━━━━━━━━━</code>',
    `🔗 <a href="${params.publishedUrl}">${escapeHtml(params.problemSlug)}</a> (Topic #${params.topicId})`,
    `📊 Verified: <b>${params.verifiedCount}/${params.totalAccounts}</b>${params.failedCount ? ` · Failed: <b>${params.failedCount}</b>` : ''} · ⬆️ Live Article Upvotes: <b>${params.liveUpvoteCount}</b>`,
    '',
  ];
  const maxVisible = 10;
  const visible = params.entries.length > maxVisible ? params.entries.slice(-maxVisible) : params.entries;
  if (params.entries.length > maxVisible) {
    lines.push(`├ … ${params.entries.length - maxVisible} earlier account(s) processed`);
  }
  for (const entry of visible) {
    lines.push(`├ ${entry}`);
  }
  lines.push(`└ ${params.activeStep}`);
  return lines.join('\n').slice(0, 3900);
}

/**
 * Schedules and verifies solution article upvotes across ALL enabled accounts:
 * 1. Author account (where the article is posted) upvotes IMMEDIATELY (0 delay) and verifies via GraphQL.
 * 2. All other enabled accounts start 5 minutes after publication, with a 1-minute gap between each account,
 *    verifying every single upvote via LeetCode's GraphQL `myReactionType === 'UPVOTE'` and live `reactions` count.
 */
export async function scheduleSolutionArticleUpvotes(
  post: UpvoteTarget,
  options: { initialDelayMs?: number; accountGapMs?: number; force?: boolean } = {},
): Promise<{ scheduled: boolean; count: number; initialDelayMs: number; accountGapMs: number }> {
  const initialDelay = options.initialDelayMs ?? UPVOTE_INITIAL_DELAY_MS;
  const gap = options.accountGapMs ?? UPVOTE_ACCOUNT_GAP_MS;

  if (!post.publishedUrl) {
    logger.warn({ postId: post.id }, 'cannot schedule upvotes: missing publishedUrl');
    return { scheduled: false, count: 0, initialDelayMs: initialDelay, accountGapMs: gap };
  }

  const topicId = extractTopicIdFromUrl(post.publishedUrl);
  if (!topicId) {
    logger.warn({ postId: post.id, url: post.publishedUrl }, 'cannot schedule upvotes: unable to extract topicId');
    return { scheduled: false, count: 0, initialDelayMs: initialDelay, accountGapMs: gap };
  }

  if (activeUpvoteJobs.has(post.id)) {
    logger.info({ postId: post.id, topicId }, 'coordinated upvote job already running in-memory for this post');
    return { scheduled: false, count: 0, initialDelayMs: initialDelay, accountGapMs: gap };
  }

  const stateKey = `solution-post-upvotes:${post.id}`;
  if (!options.force && typeof prisma.systemState?.findUnique === 'function') {
    const existingState = await prisma.systemState.findUnique({ where: { key: stateKey } }).catch(() => null);
    if (existingState) {
      try {
        const parsed = JSON.parse(existingState.value) as { status?: string; verified?: boolean; verifiedCount?: number };
        if (parsed.status === 'COMPLETED' && parsed.verified === true && (parsed.verifiedCount ?? 0) > 0) {
          logger.info({ postId: post.id, topicId, verifiedCount: parsed.verifiedCount }, 'upvotes already verified for this post');
          return { scheduled: false, count: 0, initialDelayMs: initialDelay, accountGapMs: gap };
        }
      } catch {
        // Proceed if corrupt
      }
    }
  }

  // Fetch author account (if enabled) and other enabled accounts
  let authorAccount: Account | null = null;
  if (typeof prisma.account?.findFirst === 'function') {
    authorAccount = await prisma.account
      .findFirst({
        where: { id: post.accountId, status: { not: 'DISABLED' } },
      })
      .catch(() => null);
  } else if (typeof prisma.account?.findUniqueOrThrow === 'function') {
    authorAccount = await prisma.account.findUniqueOrThrow({ where: { id: post.accountId } }).catch(() => null);
    if (authorAccount && (authorAccount.id !== post.accountId || authorAccount.status === 'DISABLED')) {
      authorAccount = null;
    }
  }

  const otherAccounts = await prisma.account.findMany({
    where: {
      id: { not: post.accountId },
      status: { not: 'DISABLED' },
    },
    orderBy: { createdAt: 'asc' },
  });

  const totalAccounts = (authorAccount ? 1 : 0) + otherAccounts.length;
  if (totalAccounts === 0 || (!options.initialDelayMs && otherAccounts.length === 0 && !authorAccount)) {
    logger.info({ postId: post.id }, 'no accounts available to upvote solution');
    return { scheduled: false, count: 0, initialDelayMs: initialDelay, accountGapMs: gap };
  }

  // Preserve backward compatibility for tests that pass no authorAccount in findFirst and 0 otherAccounts
  if (otherAccounts.length === 0 && !authorAccount) {
    logger.info({ postId: post.id }, 'no other accounts available to upvote solution');
    return { scheduled: false, count: 0, initialDelayMs: initialDelay, accountGapMs: gap };
  }

  const jobState = {
    postId: post.id,
    topicId,
    publishedUrl: post.publishedUrl,
    authorAccountId: post.accountId,
    accountIds: [...(authorAccount ? [authorAccount.id] : []), ...otherAccounts.map((a) => a.id)],
    status: 'SCHEDULED',
    verified: false,
    verifiedCount: 0,
    failedCount: 0,
    scheduledAt: new Date().toISOString(),
    startAt: new Date(Date.now() + initialDelay).toISOString(),
  };

  await prisma.systemState.upsert({
    where: { key: stateKey },
    create: { key: stateKey, value: JSON.stringify(jobState) },
    update: { value: JSON.stringify(jobState) },
  });

  logger.info(
    {
      postId: post.id,
      topicId,
      authorIncluded: Boolean(authorAccount),
      otherAccountCount: otherAccounts.length,
      initialDelayMs: initialDelay,
      gapMs: gap,
    },
    'coordinated solution upvoting scheduled',
  );

  activeUpvoteJobs.add(post.id);

  // Background execution with keep-alive so Render never spins down mid-schedule
  void (async () => {
    const stopKeepAlive = startArticleWorkKeepAlive();
    let verifiedCount = 0;
    let failedCount = 0;
    let liveUpvoteCount = 0;
    const entries: string[] = [];
    let progressMessageId: number | null = null;

    const updateProgressBoard = async (title: string, activeStep: string) => {
      const text = renderUpvoteProgressBoard({
        title,
        problemSlug: post.problemSlug,
        publishedUrl: post.publishedUrl!,
        topicId,
        verifiedCount,
        failedCount,
        totalAccounts,
        liveUpvoteCount,
        entries,
        activeStep,
      });
      if (progressMessageId) {
        await editTelegramMessage(progressMessageId, text, { parseMode: 'HTML' }).catch(() => undefined);
      } else if (typeof sendTelegramMessageWithId === 'function') {
        progressMessageId = await sendTelegramMessageWithId(text, { parseMode: 'HTML' }).catch(() => null);
        if (!progressMessageId) {
          await sendTelegramMessage(text, { parseMode: 'HTML' }).catch(() => undefined);
        }
      } else {
        await sendTelegramMessage(text, { parseMode: 'HTML' }).catch(() => undefined);
      }
    };

    try {
      await updateProgressBoard(
        'COORDINATED SOLUTION UPVOTING',
        authorAccount
          ? `⏳ Upvoting immediately with author account (${escapeHtml(authorAccount.label || authorAccount.id)})…`
          : `⏳ Scheduled ${otherAccounts.length} account(s) to start in ${Math.round(initialDelay / 60000)}m (1m gap)…`,
      );

      // Step 1: Immediate self-upvote by the author account (0 delay)
      if (authorAccount) {
        const authorLabel = authorAccount.label || authorAccount.username || authorAccount.id;
        try {
          logger.info({ accountId: authorAccount.id, label: authorLabel, topicId }, 'executing immediate author self-upvote');
          const res = await upvoteSolutionArticleWithAccount(authorAccount, topicId, post.publishedUrl);
          verifiedCount++;
          liveUpvoteCount = Math.max(liveUpvoteCount, res.upvoteCount);
          entries.push(
            `✅ <code>${escapeHtml(authorLabel)}</code> (Author · Immediate) — Verified (⬆️ ${res.upvoteCount})`,
          );
          logger.info(
            { accountId: authorAccount.id, label: authorLabel, topicId, upvoteCount: res.upvoteCount, method: res.method },
            'verified immediate author self-upvote',
          );
        } catch (authorErr) {
          failedCount++;
          const msg = authorErr instanceof Error ? authorErr.message : String(authorErr);
          entries.push(`❌ <code>${escapeHtml(authorLabel)}</code> (Author) — Failed (${escapeHtml(msg.slice(0, 60))})`);
          logger.warn({ accountId: authorAccount.id, label: authorLabel, topicId, err: msg }, 'immediate author upvote failed');
        }
      }

      // Step 2: Wait 5 minutes before other accounts start upvoting
      if (otherAccounts.length > 0 && initialDelay > 0) {
        await updateProgressBoard(
          'COORDINATED SOLUTION UPVOTING',
          `⏳ Waiting ${Math.round(initialDelay / 60000)}m before ${otherAccounts.length} remaining account(s) upvote (1m gap)…`,
        );
        await new Promise((r) => setTimeout(r, initialDelay));
      }

      // Step 3: Sequential upvoting across all other accounts with 1-minute gap
      for (let i = 0; i < otherAccounts.length; i++) {
        const account = otherAccounts[i]!;
        const label = account.label || account.username || account.id;
        await updateProgressBoard(
          'COORDINATED SOLUTION UPVOTING',
          `⏳ Upvoting & verifying with <code>${escapeHtml(label)}</code> (${i + 1}/${otherAccounts.length})…`,
        );

        try {
          logger.info(
            { accountId: account.id, label, index: i + 1, total: otherAccounts.length, topicId },
            'executing coordinated upvote',
          );
          const res = await upvoteSolutionArticleWithAccount(account, topicId, post.publishedUrl);
          verifiedCount++;
          liveUpvoteCount = Math.max(liveUpvoteCount, res.upvoteCount);
          entries.push(
            `✅ <code>${escapeHtml(label)}</code> (${i + 1}/${otherAccounts.length}) — Verified (⬆️ ${res.upvoteCount})`,
          );
          logger.info(
            { accountId: account.id, label, topicId, upvoteCount: res.upvoteCount, method: res.method },
            'verified coordinated account upvote',
          );
        } catch (accountErr) {
          failedCount++;
          const msg = accountErr instanceof Error ? accountErr.message : String(accountErr);
          entries.push(`❌ <code>${escapeHtml(label)}</code> (${i + 1}/${otherAccounts.length}) — Failed (${escapeHtml(msg.slice(0, 60))})`);
          logger.warn(
            { accountId: account.id, label, err: msg },
            'failed to upvote or verify with account; proceeding to next',
          );
        }

        if (i < otherAccounts.length - 1 && gap > 0) {
          const nextAccount = otherAccounts[i + 1]!;
          const nextLabel = nextAccount.label || nextAccount.username || nextAccount.id;
          await updateProgressBoard(
            'COORDINATED SOLUTION UPVOTING',
            `⏳ Waiting ${Math.round(gap / 60000)}m before next account (${i + 2}/${otherAccounts.length} · <code>${escapeHtml(nextLabel)}</code>)…`,
          );
          await new Promise((r) => setTimeout(r, gap));
        }
      }

      const allVerified = verifiedCount > 0 && failedCount === 0;
      const finalStep = allVerified
        ? `🎉 All ${verifiedCount}/${totalAccounts} upvote(s) verified on LeetCode (⬆️ ${liveUpvoteCount})`
        : `⚠️ Finished: ${verifiedCount}/${totalAccounts} verified · ${failedCount} failed (⬆️ ${liveUpvoteCount})`;

      await updateProgressBoard(
        allVerified ? 'COORDINATED UPVOTES VERIFIED' : 'COORDINATED UPVOTES FINISHED',
        finalStep,
      );

      await sendTelegramMessage(
        allVerified
          ? `🎉 <b>Coordinated Upvotes Verified:</b> ${verifiedCount}/${totalAccounts} account(s) verified · ⬆️ Live Article Upvotes: <b>${liveUpvoteCount}</b>\n🔗 <a href="${post.publishedUrl}">${escapeHtml(post.problemSlug)}</a>`
          : `⚠️ <b>Coordinated Upvotes Finished:</b> ${verifiedCount}/${totalAccounts} verified · ${failedCount} failed · ⬆️ Live Article Upvotes: <b>${liveUpvoteCount}</b>\n🔗 <a href="${post.publishedUrl}">${escapeHtml(post.problemSlug)}</a>`,
        { parseMode: 'HTML' },
      ).catch(() => undefined);

      await prisma.systemState.updateMany({
        where: { key: stateKey },
        data: {
          value: JSON.stringify({
            ...jobState,
            status: 'COMPLETED',
            verified: verifiedCount > 0 && failedCount === 0,
            verifiedCount,
            failedCount,
            liveUpvoteCount,
            finishedAt: new Date().toISOString(),
          }),
        },
      });
    } catch (err) {
      logger.error({ postId: post.id, err: err instanceof Error ? err.message : String(err) }, 'coordinated upvote worker failed');
    } finally {
      activeUpvoteJobs.delete(post.id);
      stopKeepAlive();
    }
  })();

  return { scheduled: true, count: otherAccounts.length || totalAccounts, initialDelayMs: initialDelay, accountGapMs: gap };
}

/**
 * Boot recovery: checks recently published solution articles (last 48 hours) and schedules
 * verified coordinated upvoting for any post whose upvotes have not yet been verified.
 */
export async function recoverUnverifiedArticleUpvotes(): Promise<void> {
  if (typeof prisma.solutionPost?.findMany !== 'function') return;
  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const recentPublished = await prisma.solutionPost.findMany({
      where: {
        status: 'PUBLISHED',
        publishedUrl: { not: null },
        publishedAt: { gte: cutoff },
      },
      orderBy: { publishedAt: 'asc' },
    });

    for (const post of recentPublished) {
      if (!post.publishedUrl || activeUpvoteJobs.has(post.id)) continue;
      const stateKey = `solution-post-upvotes:${post.id}`;
      const existing = await prisma.systemState.findUnique({ where: { key: stateKey } }).catch(() => null);
      if (existing) {
        try {
          const parsed = JSON.parse(existing.value) as { verified?: boolean; verifiedCount?: number };
          if (parsed.verified === true && (parsed.verifiedCount ?? 0) > 0) {
            continue;
          }
        } catch {
          // Re-run if corrupt
        }
      }
      logger.info(
        { postId: post.id, problemSlug: post.problemSlug, publishedUrl: post.publishedUrl },
        'recovering unverified coordinated upvotes for published solution article',
      );
      await scheduleSolutionArticleUpvotes(post, { force: true });
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'failed to inspect recently published articles for upvote recovery',
    );
  }
}
