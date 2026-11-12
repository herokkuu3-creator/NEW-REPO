import cron from 'node-cron';
import { AccountStatus } from '@prisma/client';
import { config } from '../config';
import { logger } from '../logger';
import { getAccountById, listAccounts, patchAccount } from '../database/accounts';
import { findCredentialsForAccount } from '../security/credentialStore';
import { sendTelegramMessage } from '../notifications/telegram';
import { checkSession } from '../browser/sessionCheck';
import { resolvePublicBaseUrl } from '../leetcode/loginHandoff';
import { clearLeetCodeLoginCooldown, openLightweightLeetCodeSession, verifyStoredLeetCodeAccount } from '../leetcode/sessionManager';
import { resolveLeetCodeResidentialProxy } from '../codeforces/proxyManager';
import { PrismaRecoveryStore } from './prismaStore';
import { openRemoteBrowser } from './remoteBrowser';
import { loadRecoveryLimits, RecoveryService, type RecoveryAccount } from './service';

let singleton: RecoveryService | null = null;

/** Hook invoked after a successful recovery so existing automation resumes immediately. */
export interface RecoveryRuntimeHooks {
  onRecovered?: () => Promise<unknown> | unknown;
}

export function createProductionRecoveryService(hooks: RecoveryRuntimeHooks = {}): RecoveryService {
  const toAccount = (a: { id: string; label: string; username: string | null; status: AccountStatus; storageState: string }): RecoveryAccount => ({
    id: a.id,
    label: a.label,
    username: a.username,
    status: a.status,
    storageState: a.storageState,
  });
  return new RecoveryService({
    store: new PrismaRecoveryStore(),
    now: () => new Date(),
    chatId: () => config.telegram.chatId,
    baseUrl: () => resolvePublicBaseUrl(),
    listAccounts: async () => (await listAccounts()).map(toAccount),
    getAccount: async (id) => {
      const a = await getAccountById(id);
      return a ? toAccount(a) : null;
    },
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
        return { authenticated: res.authenticated, username: res.username ?? null };
      } finally {
        await session.close();
      }
    },
    getCredentials: async (account) => {
      const full = await getAccountById(account.id);
      if (!full) return null;
      const creds = await findCredentialsForAccount('leetcode', full);
      return creds ? { username: creds.username, password: creds.password } : null;
    },
    openBrowser: async () => {
      const lcProxy = await resolveLeetCodeResidentialProxy();
      return openRemoteBrowser({ headless: true, proxyUrl: lcProxy?.url });
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
    const account = await getAccountById(accountId);
    if (!account || account.status === AccountStatus.DISABLED) return;
    await getRecoveryService().openRecovery(
      { id: account.id, label: account.label, username: account.username, status: account.status, storageState: account.storageState },
      'REJECTED',
    );
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
