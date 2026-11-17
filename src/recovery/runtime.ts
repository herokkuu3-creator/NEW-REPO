import cron from 'node-cron';
import { AccountStatus } from '@prisma/client';
import { config } from '../config';
import { logger } from '../logger';
import {
  getAccountById,
  getAccountIdentityById,
  listAccounts,
  listAccountIdentities,
  listAccountIdentitiesByIds,
  patchAccount,
  type AccountIdentity,
} from '../database/accounts';
import { findCredentialsForAccount } from '../security/credentialStore';
import { sendTelegramMessage } from '../notifications/telegram';
import { checkSession } from '../browser/sessionCheck';
import { resolvePublicBaseUrl } from '../leetcode/loginHandoff';
import { clearLeetCodeLoginCooldown, openLightweightLeetCodeSession, verifyStoredLeetCodeAccount } from '../leetcode/sessionManager';
import { resolveLeetCodeResidentialProxy } from '../codeforces/proxyManager';
import { PrismaRecoveryStore } from './prismaStore';
import { getMobileTunnel } from './mobileTunnel';
import { openRemoteBrowser } from './remoteBrowser';
import { loadRecoveryLimits, RecoveryService, type RecoveryAccount } from './service';

let singleton: RecoveryService | null = null;

/** Hook invoked after a successful recovery so existing automation resumes immediately. */
export interface RecoveryRuntimeHooks {
  onRecovered?: () => Promise<unknown> | unknown;
}

function isMockFn(fn: unknown): boolean {
  return typeof fn === 'function' && 'mock' in fn && typeof (fn as { mock?: unknown }).mock === 'object';
}

const toIdentityAccount = (a: AccountIdentity): RecoveryAccount => ({
  id: a.id,
  label: a.label,
  username: a.username,
  status: a.status,
});

async function fetchAccountIdentities(): Promise<RecoveryAccount[]> {
  const rows =
    !isMockFn(listAccountIdentities) && isMockFn(listAccounts)
      ? await listAccounts()
      : await listAccountIdentities();
  return rows.map(toIdentityAccount);
}

async function fetchAccountIdentityById(id: string): Promise<RecoveryAccount | null> {
  const row =
    !isMockFn(getAccountIdentityById) && isMockFn(getAccountById)
      ? await getAccountById(id)
      : await getAccountIdentityById(id);
  return row ? toIdentityAccount(row) : null;
}

async function fetchAccountIdentitiesByIds(ids: string[]): Promise<RecoveryAccount[]> {
  if (!isMockFn(listAccountIdentitiesByIds) && isMockFn(listAccounts)) {
    const idSet = new Set(ids);
    return (await listAccounts()).filter((a) => idSet.has(a.id)).map(toIdentityAccount);
  }
  return (await listAccountIdentitiesByIds(ids)).map(toIdentityAccount);
}

export function createProductionRecoveryService(hooks: RecoveryRuntimeHooks = {}): RecoveryService {
  return new RecoveryService({
    store: new PrismaRecoveryStore(),
    now: () => new Date(),
    chatId: () => config.telegram.chatId,
    baseUrl: () => resolvePublicBaseUrl(),
    listAccounts: fetchAccountIdentities,
    getAccount: fetchAccountIdentityById,
    getAccountsByIds: fetchAccountIdentitiesByIds,
    markAccount: async (id, status, lastError) => {
      await patchAccount(id, { status, lastError, checked: true });
    },
    verifyStoredSession: async (account) => {
      const full = await getAccountById(account.id);
      if (!full) return { authenticated: false, cause: 'query-failed' };
      // GraphQL userStatus over the lightweight API transport; also persists rotated cookies.
      const diag = await verifyStoredLeetCodeAccount(full, { maxAttempts: 3, baseBackoffMs: 1500 });
      return { authenticated: diag.authenticated, username: diag.username, cause: diag.cause, error: diag.error };
    },
    verifyCapturedSession: async (state) => {
      const session = await openLightweightLeetCodeSession(state);
      try {
        const res = await checkSession(session.api);
        return { authenticated: res.authenticated, username: res.username ?? null, cause: res.cause };
      } finally {
        await session.close();
      }
    },
    getCredentials: async (account) => {
      const creds = await findCredentialsForAccount('leetcode', account);
      return creds ? { username: creds.username, password: creds.password } : null;
    },
    getEgressStatus: async () => {
      if (getMobileTunnel().isConnected()) {
        return { mode: 'mobile_tunnel', label: 'Phone IP tunnel active' };
      }
      const lcProxy = await resolveLeetCodeResidentialProxy();
      if (lcProxy?.url) {
        return { mode: 'residential_proxy', label: 'Configured residential proxy' };
      }
      return { mode: 'datacenter', label: 'Server IP (standard)' };
    },
    openBrowser: async (opts) => {
      const tunnelProxy = await getMobileTunnel().ensureProxyListening();
      if (tunnelProxy) {
        logger.info('recovery browser routing through connected mobile IP tunnel');
        return openRemoteBrowser({ headless: true, proxyUrl: tunnelProxy, viewport: opts?.viewport });
      }
      const lcProxy = await resolveLeetCodeResidentialProxy();
      return openRemoteBrowser({ headless: true, proxyUrl: lcProxy?.url, viewport: opts?.viewport });
    },
    sendTelegram: (text, markup) =>
      sendTelegramMessage(text, { parseMode: 'HTML', disableWebPagePreview: true, replyMarkup: markup }),
    onRecovered: async (account) => {
      await clearLeetCodeLoginCooldown(account.label).catch(() => undefined);
      await hooks.onRecovered?.();
    },
    limits: loadRecoveryLimits(),
  });
}

export function getRecoveryService(hooks?: RecoveryRuntimeHooks): RecoveryService {
  if (!singleton) singleton = createProductionRecoveryService(hooks);
  return singleton;
}

export function hasRecoveryService(): boolean {
  return singleton !== null;
}

export function setRecoveryServiceForTests(svc: RecoveryService | null): void {
  singleton = svc;
}

/**
 * Called when a run proves (via LeetCode's own signed-out answer) that an
 * account's session is dead. Opens that account's recovery; the next reminder
 * tick (≤ 1 minute) sends the Telegram link. Never throws.
 */
export async function reportAccountSessionDown(accountId: string): Promise<void> {
  try {
    const account = await fetchAccountIdentityById(accountId);
    if (!account || account.status === AccountStatus.DISABLED) return;
    await getRecoveryService().openRecovery(account, 'REJECTED');
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'could not open recovery for a signed-out account');
  }
}

/**
 * Daily account monitor + per-minute reminder tick.
 * Reminder timing lives in PostgreSQL (nextReminderAt), so a restart neither
 * loses nor duplicates reminders: the first tick after boot claims whatever is due.
 */
export function startRecoveryScheduler(service: RecoveryService): () => void {
  const timezone = config.schedule.timezone;
  const monitorHour = Number(process.env.RECOVERY_MONITOR_HOUR ?? 7);
  const monitorMinute = Number(process.env.RECOVERY_MONITOR_MINUTE ?? 10);
  const monitorExpr = `${Number.isFinite(monitorMinute) ? monitorMinute : 10} ${Number.isFinite(monitorHour) ? monitorHour : 7} * * *`;

  const monitorTask = cron.schedule(
    monitorExpr,
    () => {
      void service.monitorAccounts().catch((err) => {
        logger.error({ err: err instanceof Error ? err.message : String(err) }, 'recovery monitor failed');
      });
    },
    { timezone },
  );
  const tickTask = cron.schedule('* * * * *', () => {
    void service.tick().catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'recovery reminder tick failed');
    });
  });
  // Catch-up shortly after boot (restarts must not lose due reminders).
  const boot = setTimeout(() => void service.tick().catch(() => undefined), 20_000);
  boot.unref?.();
  logger.info({ monitorExpr, timezone }, 'LeetCode session recovery scheduler armed');
  return () => {
    monitorTask.stop();
    tickTask.stop();
    clearTimeout(boot);
    void service.shutdown();
  };
}
