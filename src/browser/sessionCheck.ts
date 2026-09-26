import { z } from 'zod';
import { logger } from '../logger';
import { LeetCodeApi } from '../leetcode/apiClient';

/**
 * Session verification — API-only.
 *
 * Deliberately performs NO page navigation: navigating to an HTML page is
 * what invites Cloudflare's interstitial on datacenter IPs, and the GraphQL
 * endpoint answers the same question without it.
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

export async function checkSession(api: LeetCodeApi): Promise<SessionCheckResult> {
  try {
    const data = await api.graphql(USER_STATUS_QUERY, {}, userStatusSchema);
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
