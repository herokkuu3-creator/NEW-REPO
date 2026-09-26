import { Page } from 'playwright';
import { z } from 'zod';
import { logger } from '../logger';
import { leetcodeGraphQL } from '../leetcode/graphql';

/**
 * Session verification. Primary signal is the `userStatus` GraphQL query —
 * far more stable than any DOM selector. The /profile navigation doubles as
 * the warm-up navigation requested by the architecture spec.
 */

const userStatusSchema = z.object({
  userStatus: z.object({
    isSignedIn: z.boolean(),
    username: z.string().nullable().optional(),
    realName: z.string().nullable().optional(),
  }),
});

const USER_STATUS_QUERY = `
  query userStatus {
    userStatus {
      isSignedIn
      username
      realName
    }
  }
`;

export interface SessionCheckResult {
  authenticated: boolean;
  username?: string;
}

export async function checkSession(page: Page): Promise<SessionCheckResult> {
  // Warm-up navigation to an authenticated surface (also verifies the page
  // actually loads — a network failure here means nothing else will work).
  await page.goto('https://leetcode.com/profile', {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });

  try {
    const data = await leetcodeGraphQL(page, USER_STATUS_QUERY, {}, userStatusSchema);
    if (data.userStatus.isSignedIn && data.userStatus.username) {
      logger.info({ username: data.userStatus.username }, 'session authenticated');
      return { authenticated: true, username: data.userStatus.username };
    }
    logger.info('session check: not signed in');
    return { authenticated: false };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'session check query failed — treating as unauthenticated',
    );
    return { authenticated: false };
  }
}
