import cron from 'node-cron';
import { AccountStatus, CodeforcesAccountStatus } from '@prisma/client';
import { listAccounts, patchAccount, saveAccount, AccountRecord, parseStoredStorageState } from '../database/accounts';
import { listCodeforcesAccounts, patchCodeforcesAccount, saveCodeforcesAccount, CodeforcesAccountRecord } from '../codeforces/storage';
import { validateCodeforcesStorageState } from '../codeforces/session';
import { checkSession } from '../browser/sessionCheck';
import { LeetCodeApi } from '../leetcode/apiClient';
import { launchWithStorageStateObject } from '../browser/playwright';
import { findCredentialsForAccount } from './credentialStore';
import { loginToLeetCode } from '../leetcode/auth';
import { loginToCodeforces } from '../codeforces/auth';
import { sendTelegramMessage } from '../notifications/telegram';
import { config } from '../config';
import { logger } from '../logger';

export interface AccountRefreshOutcome {
  site: 'leetcode' | 'codeforces';
  label: string;
  username?: string | null;
  status: 'valid' | 'refreshed' | 'missing-credentials' | 'failed';
  error?: string;
}

export interface SessionRefreshSummary {
  totalLeetCode: number;
  totalCodeforces: number;
  refreshed: number;
  valid: number;
  expiredWithoutCreds: number;
  failed: number;
  outcomes: AccountRefreshOutcome[];
}

async function checkLeetCodeSessionLive(account: AccountRecord): Promise<{ authenticated: boolean; username?: string | null; cause?: string }> {
  const parsed = parseStoredStorageState(account.storageState);
  if (!parsed.ok) return { authenticated: false, cause: 'invalid-storage-state' };
  let session = null;
  try {
    session = await launchWithStorageStateObject(parsed.state, account.label);
    if (!session) return { authenticated: false, cause: 'browser-launch-failed' };
    const api = new LeetCodeApi(session.context);
    const result = await checkSession(api);
    return result;
  } catch (err) {
    return { authenticated: false, cause: err instanceof Error ? err.message : String(err) };
  } finally {
    if (session) {
      await Promise.resolve(session.close?.()).catch(() => undefined);
    }
  }
}

/**
 * Checks a LeetCode account session; if expired/signed out and encrypted credentials exist,
 * automatically re-authenticates and updates storageState in DB.
 */
export async function refreshLeetCodeAccount(account: AccountRecord): Promise<AccountRefreshOutcome> {
  const check = await checkLeetCodeSessionLive(account);
  if (check.authenticated) {
    if (account.status !== AccountStatus.ACTIVE) {
      await patchAccount(account.id, { status: AccountStatus.ACTIVE, lastError: null, checked: true });
    }
    return {
      site: 'leetcode',
      label: account.label,
      username: check.username ?? account.username,
      status: 'valid',
    };
  }

  if (check.cause !== 'signed-out' && check.cause !== 'invalid-storage-state') {
    logger.warn({ label: account.label, cause: check.cause }, 'Session verification unavailable; preserving account status and skipping re-login');
    return { site: 'leetcode', label: account.label, username: account.username, status: 'failed',
      error: 'Session verification unavailable. Existing session retained; retry the check later.' };
  }

  logger.warn({ label: account.label, cause: check.cause }, 'LeetCode session invalid/signed-out; checking for stored credentials');

  const creds = await findCredentialsForAccount('leetcode', account);
  if (!creds) {
    await patchAccount(account.id, {
      status: AccountStatus.EXPIRED,
      lastError: 'Session expired; no stored credentials available for auto-relogin',
      checked: true,
    });
    return {
      site: 'leetcode',
      label: account.label,
      username: account.username,
      status: 'missing-credentials',
      error: 'Session expired and no encrypted credentials stored',
    };
  }

  logger.info({ label: account.label, username: creds.username }, 'Attempting automated LeetCode re-login with stored credentials');
  const loginRes = await loginToLeetCode(creds.username, creds.password);

  if (loginRes.ok && loginRes.storageState) {
    await saveAccount(account.label, JSON.stringify(loginRes.storageState), {
      username: loginRes.username ?? creds.username,
      status: AccountStatus.ACTIVE,
    });
    logger.info({ label: account.label }, 'LeetCode auto-relogin succeeded; storageState updated in DB');
    return {
      site: 'leetcode',
      label: account.label,
      username: loginRes.username ?? creds.username,
      status: 'refreshed',
    };
  }

  const errDetail = loginRes.error ?? 'Auto-relogin failed';
  await patchAccount(account.id, {
    // Verification/network/browser failures are not rejected credentials.
    status: loginRes.code === 'LOGIN_REJECTED' ? AccountStatus.REJECTED : AccountStatus.EXPIRED,
    lastError: `Auto-relogin failed: ${errDetail}`,
    checked: true,
  });
  return {
    site: 'leetcode',
    label: account.label,
    username: account.username,
    status: 'failed',
    error: errDetail,
  };
}

/**
 * Checks a Codeforces account session; if expired/signed out and encrypted credentials exist,
 * automatically re-authenticates and updates storageState in DB.
 */
export async function refreshCodeforcesAccount(account: CodeforcesAccountRecord): Promise<AccountRefreshOutcome> {
  const parsed = parseStoredStorageState(account.storageState);
  let isValid = false;
  let username = account.username;

  if (parsed.ok) {
    const val = await validateCodeforcesStorageState(parsed.state).catch(() => ({
      ok: false as const,
      reason: 'unknown' as const,
      error: 'validation failed',
    }));
    if (val.ok) {
      isValid = true;
      username = val.username;
    }
  }

  if (isValid) {
    if (account.status !== CodeforcesAccountStatus.ACTIVE) {
      await patchCodeforcesAccount(account.id, { status: CodeforcesAccountStatus.ACTIVE, lastError: null, checked: true });
    }
    return {
      site: 'codeforces',
      label: account.label,
      username,
      status: 'valid',
    };
  }

  logger.warn({ label: account.label }, 'Codeforces session invalid/signed-out; checking for stored credentials');

  const creds = await findCredentialsForAccount('codeforces', account);
  if (!creds) {
    await patchCodeforcesAccount(account.id, {
      status: CodeforcesAccountStatus.EXPIRED,
      lastError: 'Session expired; no stored credentials available for auto-relogin',
      checked: true,
    });
    return {
      site: 'codeforces',
      label: account.label,
      username: account.username,
      status: 'missing-credentials',
      error: 'Session expired and no encrypted credentials stored',
    };
  }

  logger.info({ label: account.label, username: creds.username }, 'Attempting automated Codeforces re-login with stored credentials');
  const loginRes = await loginToCodeforces(creds.username, creds.password);

  if (loginRes.ok && loginRes.storageState) {
    await saveCodeforcesAccount(account.label, JSON.stringify(loginRes.storageState), {
      username: loginRes.handle ?? creds.username,
      status: CodeforcesAccountStatus.ACTIVE,
    });
    logger.info({ label: account.label }, 'Codeforces auto-relogin succeeded; storageState updated in DB');
    return {
      site: 'codeforces',
      label: account.label,
      username: loginRes.handle ?? creds.username,
      status: 'refreshed',
    };
  }

  const errDetail = loginRes.error ?? 'Auto-relogin failed';
  await patchCodeforcesAccount(account.id, {
    status: CodeforcesAccountStatus.REJECTED,
    lastError: `Auto-relogin failed: ${errDetail}`,
    checked: true,
  });
  return {
    site: 'codeforces',
    label: account.label,
    username: account.username,
    status: 'failed',
    error: errDetail,
  };
}

/**
 * Verifies all LeetCode and Codeforces accounts. If sessions are expired and credentials exist,
 * automatically re-logs in and updates the database.
 */
export async function verifyAndRefreshAllSessions(options?: {
  notifyTelegram?: boolean;
}): Promise<SessionRefreshSummary> {
  logger.info('Starting full pre-run session verification and auto-refresh');
  const lcAccounts = await listAccounts().catch(() => []);
  const cfAccounts = await listCodeforcesAccounts().catch(() => []);

  const outcomes: AccountRefreshOutcome[] = [];

  for (const acc of lcAccounts) {
    if (acc.status === AccountStatus.DISABLED) continue;
    try {
      const outcome = await refreshLeetCodeAccount(acc);
      outcomes.push(outcome);
    } catch (err) {
      outcomes.push({
        site: 'leetcode',
        label: acc.label,
        username: acc.username,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const acc of cfAccounts) {
    if (acc.status === CodeforcesAccountStatus.DISABLED) continue;
    try {
      const outcome = await refreshCodeforcesAccount(acc);
      outcomes.push(outcome);
    } catch (err) {
      outcomes.push({
        site: 'codeforces',
        label: acc.label,
        username: acc.username,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const summary: SessionRefreshSummary = {
    totalLeetCode: lcAccounts.length,
    totalCodeforces: cfAccounts.length,
    refreshed: outcomes.filter((o) => o.status === 'refreshed').length,
    valid: outcomes.filter((o) => o.status === 'valid').length,
    expiredWithoutCreds: outcomes.filter((o) => o.status === 'missing-credentials').length,
    failed: outcomes.filter((o) => o.status === 'failed').length,
    outcomes,
  };

  logger.info(
    { refreshed: summary.refreshed, valid: summary.valid, missing: summary.expiredWithoutCreds, failed: summary.failed },
    'Session verification completed',
  );

  if (options?.notifyTelegram && config.telegram.enabled) {
    await sendSessionRefreshTelegramNotification(summary);
  }

  return summary;
}

async function sendSessionRefreshTelegramNotification(summary: SessionRefreshSummary): Promise<void> {
  const lines: string[] = ['🌅 <b>Morning Session Health Check (7:00 AM)</b>', '<code>━━━━━━━━━━━━━━━━━━━━</code>'];

  if (summary.refreshed === 0 && summary.expiredWithoutCreds === 0 && summary.failed === 0) {
    lines.push(`✅ All ${summary.valid} account session(s) are active and healthy.`);
  } else {
    if (summary.refreshed > 0) {
      lines.push(`🔄 <b>Auto-refreshed:</b> ${summary.refreshed} session(s) renewed using stored credentials:`);
      for (const o of summary.outcomes.filter((x) => x.status === 'refreshed')) {
        const siteTag = o.site === 'leetcode' ? 'LeetCode' : 'Codeforces';
        lines.push(`   • [${siteTag}] <code>${o.label}</code> (${o.username ?? '—'})`);
      }
      lines.push('');
    }

    if (summary.expiredWithoutCreds > 0) {
      lines.push(`⚠️ <b>Expired (no credentials):</b> ${summary.expiredWithoutCreds} account(s) need renewal:`);
      for (const o of summary.outcomes.filter((x) => x.status === 'missing-credentials')) {
        const cmd = o.site === 'leetcode' ? '/lclogin' : '/cflogin';
        lines.push(`   • [${o.site.toUpperCase()}] <code>${o.label}</code> — send ${cmd} or renew cookies`);
      }
      lines.push('');
    }

    if (summary.failed > 0) {
      lines.push(`❌ <b>Failed re-login:</b> ${summary.failed} account(s):`);
      for (const o of summary.outcomes.filter((x) => x.status === 'failed')) {
        lines.push(`   • [${o.site.toUpperCase()}] <code>${o.label}</code>: <i>${(o.error ?? 'error').slice(0, 100)}</i>`);
      }
      lines.push('');
    }

    lines.push(`📊 Status: ${summary.valid} valid · ${summary.refreshed} auto-refreshed · ${summary.expiredWithoutCreds + summary.failed} attention needed`);
  }

  await sendTelegramMessage(lines.join('\n')).catch(() => undefined);
}

/**
 * Starts the morning 7:00 AM session verification and auto-refresh cron job.
 */
export function startMorningSessionCheckScheduler(): () => void {
  const timezone = config.schedule.timezone;
  // Scheduled every day at 7:00 AM in configured timezone
  const expression = '0 7 * * *';

  const task = cron.schedule(
    expression,
    () => {
      logger.info({ timezone }, 'Starting scheduled 7:00 AM morning session check and auto-refresh...');
      void verifyAndRefreshAllSessions({ notifyTelegram: true }).catch((err) => {
        logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Morning session check failed');
      });
    },
    { timezone },
  );

  logger.info({ expression, timezone }, 'Morning 7:00 AM session check & auto-refresh scheduler armed');
  return () => task.stop();
}
