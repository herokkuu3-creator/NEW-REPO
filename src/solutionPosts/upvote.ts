import { prisma } from '../database/prisma';
import { logger } from '../logger';
import { withAccount } from './service';
import { sendTelegramMessage } from '../notifications/telegram';

export const UPVOTE_INITIAL_DELAY_MS = 5 * 60 * 1000; // 5 minutes
export const UPVOTE_ACCOUNT_GAP_MS = 60 * 1000;       // 1 minute

export interface UpvoteTarget {
  id: string;
  publishedUrl?: string | null;
  accountId: string;
  problemSlug: string;
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

/**
 * Schedules other accounts to upvote a newly published solution article.
 * - Starts 5 minutes after publication
 * - Upvotes sequentially across other accounts at a gap of 1 minute each
 */
export async function scheduleSolutionArticleUpvotes(
  post: UpvoteTarget,
  options: { initialDelayMs?: number; accountGapMs?: number } = {},
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

  // Find all other enabled accounts
  const otherAccounts = await prisma.account.findMany({
    where: {
      id: { not: post.accountId },
      status: { not: 'DISABLED' },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (otherAccounts.length === 0) {
    logger.info({ postId: post.id }, 'no other accounts available to upvote solution');
    return { scheduled: false, count: 0, initialDelayMs: initialDelay, accountGapMs: gap };
  }

  const stateKey = `solution-post-upvotes:${post.id}`;
  const jobState = {
    postId: post.id,
    topicId,
    publishedUrl: post.publishedUrl,
    authorAccountId: post.accountId,
    accountIds: otherAccounts.map((a) => a.id),
    status: 'SCHEDULED',
    scheduledAt: new Date().toISOString(),
    startAt: new Date(Date.now() + initialDelay).toISOString(),
  };

  await prisma.systemState.upsert({
    where: { key: stateKey },
    create: { key: stateKey, value: JSON.stringify(jobState) },
    update: { value: JSON.stringify(jobState) },
  });

  logger.info(
    { postId: post.id, topicId, accountCount: otherAccounts.length, initialDelayMs: initialDelay, gapMs: gap },
    'coordinated solution upvoting scheduled',
  );

  // Background execution
  void (async () => {
    try {
      await sendTelegramMessage(
        `👍 <b>Coordinated Upvoting Scheduled:</b> ${otherAccounts.length} account(s) will upvote this solution starting in 5 minutes (1 min gap).\n🔗 <a href="${post.publishedUrl}">${post.problemSlug}</a>`,
        { parseMode: 'HTML' },
      ).catch(() => undefined);

      if (initialDelay > 0) {
        await new Promise((r) => setTimeout(r, initialDelay));
      }

      for (let i = 0; i < otherAccounts.length; i++) {
        const account = otherAccounts[i]!;
        try {
          logger.info({ accountId: account.id, label: account.label, index: i + 1, total: otherAccounts.length }, 'executing coordinated upvote');
          await withAccount(account, async (_api, page, username) => {
            await page.goto(post.publishedUrl!, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(2000);

            const upvoteBtn = page.locator(
              'button:has([data-icon="thumbs-up"]), button[aria-label*="upvote" i], button:has(svg.fa-thumbs-up), button:has-text("Upvote")',
            ).first();

            const isVisible = await upvoteBtn.isVisible({ timeout: 5000 }).catch(() => false);
            if (!isVisible) {
              logger.warn({ accountId: account.id, username }, 'upvote button not located on solution page');
              return;
            }

            const ariaPressed = await upvoteBtn.getAttribute('aria-pressed').catch(() => null);
            const className = (await upvoteBtn.getAttribute('class').catch(() => '')) || '';
            const alreadyUpvoted = ariaPressed === 'true' || /active|voted|text-blue/i.test(className);

            if (alreadyUpvoted) {
              logger.info({ accountId: account.id, username }, 'solution already upvoted by this account');
            } else {
              await upvoteBtn.click({ timeout: 5000 });
              await page.waitForTimeout(2000);
              logger.info({ accountId: account.id, username, topicId }, 'successfully clicked upvote');
            }

            await sendTelegramMessage(
              `👍 <b>Upvote Recorded:</b> ${account.label} upvoted article (${i + 1}/${otherAccounts.length})`,
              { parseMode: 'HTML' },
            ).catch(() => undefined);
          });
        } catch (accountErr) {
          logger.warn(
            { accountId: account.id, label: account.label, err: accountErr instanceof Error ? accountErr.message : String(accountErr) },
            'failed to upvote with account; proceeding to next',
          );
        }

        if (i < otherAccounts.length - 1 && gap > 0) {
          await new Promise((r) => setTimeout(r, gap));
        }
      }

      await sendTelegramMessage(
        `🎉 <b>Coordinated Upvotes Completed:</b> all ${otherAccounts.length} account(s) have finished upvoting.\n🔗 <a href="${post.publishedUrl}">${post.problemSlug}</a>`,
        { parseMode: 'HTML' },
      ).catch(() => undefined);

      await prisma.systemState.updateMany({
        where: { key: stateKey },
        data: { value: JSON.stringify({ ...jobState, status: 'COMPLETED', finishedAt: new Date().toISOString() }) },
      });
    } catch (err) {
      logger.error({ postId: post.id, err: err instanceof Error ? err.message : String(err) }, 'coordinated upvote worker failed');
    }
  })();

  return { scheduled: true, count: otherAccounts.length, initialDelayMs: initialDelay, accountGapMs: gap };
}
