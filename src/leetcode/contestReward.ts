import { z } from 'zod';
import type { AccountRecord } from '../database/accounts';
import { parseStoredStorageState } from '../database/accounts';
import { checkSession } from '../browser/sessionCheck';
import { launchWithStorageStateObject } from '../browser/playwright';
import { LeetCodeApi } from './apiClient';
import { logger } from '../logger';

export interface ContestRewardResult {
  offered: boolean;
  claimed: boolean;
  error?: string;
}

const EASTER_EGG_QUERY = `
  query easterEgg {
    isEasterEggCollected
  }
`;

const COLLECT_EASTER_EGG_MUTATION = `
  mutation collectContestEasterEgg {
    collectContestEasterEgg {
      ok
    }
  }
`;

const easterEggSchema = z.object({
  isEasterEggCollected: z.boolean(),
});

const collectEasterEggSchema = z.object({
  collectContestEasterEgg: z.object({ ok: z.boolean() }).nullable(),
});

export type ContestRewardApi = Pick<LeetCodeApi, 'graphql'>;

/**
 * Checks and collects LeetCode's weekly contest-page reward through the same
 * authenticated GraphQL operations used by the contest frontend. This avoids
 * navigating to /contest/, whose HTML is challenged on cloud IPs even while
 * the authenticated GraphQL endpoint remains available.
 */
export async function claimContestReward(
  api: ContestRewardApi,
  label = 'account',
): Promise<ContestRewardResult> {
  try {
    const current = await api.graphql(EASTER_EGG_QUERY, {}, easterEggSchema);
    if (current.isEasterEggCollected) {
      logger.info({ label }, 'LeetCode contest reward already collected or not currently offered');
      return { offered: false, claimed: false };
    }

    const collected = await api.graphql(
      COLLECT_EASTER_EGG_MUTATION,
      {},
      collectEasterEggSchema,
    );
    if (collected.collectContestEasterEgg?.ok) {
      logger.info({ label }, 'LeetCode contest reward collected through GraphQL');
      return { offered: true, claimed: true };
    }

    return {
      offered: true,
      claimed: false,
      error: 'LeetCode offered the contest reward but did not confirm collection',
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn({ label, err: error }, 'LeetCode contest reward API failed without affecting submission');
    return { offered: false, claimed: false, error: `contest reward API failed: ${error}` };
  }
}

/** Runs one manual reward check from a stored account session. */
export async function claimContestRewardForAccount(account: AccountRecord): Promise<ContestRewardResult> {
  const parsed = parseStoredStorageState(account.storageState);
  if (!parsed.ok) return { offered: false, claimed: false, error: parsed.error };
  const session = await launchWithStorageStateObject(parsed.state, account.label);
  if (!session) return { offered: false, claimed: false, error: 'browser launch failed' };
  try {
    const api = new LeetCodeApi(session.context);
    const check = await checkSession(api);
    if (!check.authenticated) {
      return { offered: false, claimed: false, error: 'LeetCode session is not authenticated; renew this account first' };
    }
    return await claimContestReward(api, account.label);
  } catch (err) {
    return { offered: false, claimed: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await session.close().catch(() => undefined);
  }
}
