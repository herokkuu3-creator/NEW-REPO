import { z } from 'zod';
import type { AccountRecord } from '../database/accounts';
import { parseStoredStorageState } from '../database/accounts';
import { checkSession } from '../browser/sessionCheck';
import { launchWithStorageStateObject } from '../browser/playwright';
import { LeetCodeApi } from './apiClient';
import { persistRotatedCookiesFromContext } from './sessionManager';
import { logger } from '../logger';

export interface DailyCheckinResult {
  checkedIn: boolean;
  awarded?: boolean;
  error?: string;
}

export const CHECKIN_MUTATION = `
  mutation checkin {
    checkin {
      checkedIn
      ok
      error
    }
  }
`;

export const checkinSchema = z.object({
  checkin: z
    .object({
      checkedIn: z.boolean().optional(),
      ok: z.boolean().optional(),
      error: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

export type DailyCheckinApi = Pick<LeetCodeApi, 'graphql'>;

/**
 * Executes LeetCode's daily check-in mutation through the authenticated GraphQL endpoint.
 * Awards +1 LeetCoin on the first visit/check-in of the day.
 * Deliberately best-effort so it never interrupts the core submission pipeline.
 */
export async function claimDailyCheckin(
  api: DailyCheckinApi,
  label = 'account',
): Promise<DailyCheckinResult> {
  try {
    const data = await api.graphql(CHECKIN_MUTATION, {}, checkinSchema);
    const c = data?.checkin;
    if (!c) {
      logger.info({ label }, 'LeetCode daily check-in returned empty response');
      return { checkedIn: false, error: 'empty checkin response' };
    }

    if (c.checkedIn) {
      if (c.ok === true) {
        logger.info({ label }, 'LeetCode daily check-in claimed (+1 coin)');
        return { checkedIn: true, awarded: true };
      }
      logger.info({ label, error: c.error }, 'LeetCode daily check-in already done today');
      return { checkedIn: true, awarded: false };
    }

    if (c.ok === true) {
      logger.info({ label }, 'LeetCode daily check-in confirmed ok');
      return { checkedIn: true, awarded: true };
    }

    if (c.error && /already/i.test(c.error)) {
      logger.info({ label, error: c.error }, 'LeetCode daily check-in already recorded today');
      return { checkedIn: true, awarded: false };
    }

    if (c.error) {
      logger.warn({ label, error: c.error }, 'LeetCode daily check-in returned error');
      return { checkedIn: false, error: c.error };
    }

    return { checkedIn: false };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn({ label, err: error }, 'LeetCode daily check-in failed without affecting other operations');
    return { checkedIn: false, error: `checkin failed: ${error}` };
  }
}

/** Runs one manual check-in from a stored account session. */
export async function claimDailyCheckinForAccount(account: AccountRecord): Promise<DailyCheckinResult> {
  const parsed = parseStoredStorageState(account.storageState);
  if (!parsed.ok) return { checkedIn: false, error: parsed.error };
  const session = await launchWithStorageStateObject(parsed.state, account.label);
  if (!session) return { checkedIn: false, error: 'browser launch failed' };
  try {
    const api = new LeetCodeApi(session.context);
    const check = await checkSession(api);
    if (!check.authenticated) {
      return { checkedIn: false, error: 'LeetCode session is not authenticated; renew this account first' };
    }
    const res = await claimDailyCheckin(api, account.label);
    await persistRotatedCookiesFromContext(account, parsed.state, session.context);
    return res;
  } catch (err) {
    return { checkedIn: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await session.close().catch(() => undefined);
  }
}
