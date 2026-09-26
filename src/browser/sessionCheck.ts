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
  /**
   * Only when authenticated === false:
   *   'signed-out'   — LeetCode ANSWERED the query and reports the session
   *                    logged out: a reliable expiry signal.
   *   'query-failed' — the request itself failed (network error, Cloudflare
   *                    403): NOT proof of expiry, must not mark a cookie expired.
   */
  cause?: 'signed-out' | 'query-failed';
}

export async function checkSession(api: LeetCodeApi): Promise<SessionCheckResult> {
  try {
    const data = await api.graphql(USER_STATUS_QUERY, {}, userStatusSchema);
    if (data.userStatus.isSignedIn && data.userStatus.username) {
      logger.info({ username: data.userStatus.username }, 'session authenticated');
      return { authenticated: true, username: data.userStatus.username };
    }
    logger.info('session check: not signed in');
    return { authenticated: false, cause: 'signed-out' };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'session check query failed — treating as unauthenticated',
    );
    return { authenticated: false, cause: 'query-failed' };
  }
}
