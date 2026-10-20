import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AccountStatus, CodeforcesAccountStatus } from '@prisma/client';
import {
  refreshLeetCodeAccount,
  refreshCodeforcesAccount,
  verifyAndRefreshAllSessions,
} from '../src/security/sessionAutoRefresh';
import * as credentialStore from '../src/security/credentialStore';
import * as leetcodeAuth from '../src/leetcode/auth';
import * as codeforcesAuth from '../src/codeforces/auth';
import * as accountsDb from '../src/database/accounts';
import * as codeforcesStorage from '../src/codeforces/storage';
import * as sessionCheck from '../src/browser/sessionCheck';
import * as codeforcesSession from '../src/codeforces/session';
import * as playwright from '../src/browser/playwright';

vi.mock('../src/browser/playwright', () => ({
  launchWithStorageStateObject: vi.fn(),
}));

vi.mock('../src/browser/sessionCheck', () => ({
  checkSession: vi.fn(),
}));

vi.mock('../src/codeforces/session', () => ({
  validateCodeforcesStorageState: vi.fn(),
}));

vi.mock('../src/leetcode/auth', () => ({
  loginToLeetCode: vi.fn(),
}));

vi.mock('../src/codeforces/auth', () => ({
  loginToCodeforces: vi.fn(),
}));

vi.mock('../src/database/accounts', () => ({
  listAccounts: vi.fn(),
  patchAccount: vi.fn(),
  saveAccount: vi.fn(),
  parseStoredStorageState: vi.fn((raw: string) => {
    try {
      return { ok: true, state: JSON.parse(raw) };
    } catch {
      return { ok: false, error: 'invalid json' };
    }
  }),
}));

vi.mock('../src/codeforces/storage', () => ({
  listCodeforcesAccounts: vi.fn(),
  patchCodeforcesAccount: vi.fn(),
  saveCodeforcesAccount: vi.fn(),
}));

vi.mock('../src/notifications/telegram', () => ({
  sendTelegramMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
}));

describe('Session Auto-Refresh & Verification Engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('LeetCode Account Auto-Refresh', () => {
    it('preserves account status and credentials when the session query fails', async () => {
      vi.mocked(playwright.launchWithStorageStateObject).mockResolvedValue({ context: {}, close: vi.fn() } as any);
      vi.mocked(sessionCheck.checkSession).mockResolvedValue({ authenticated: false, cause: 'query-failed' });
      const outcome = await refreshLeetCodeAccount({ id: 'network-failure', label: 'main', username: 'user',
        storageState: JSON.stringify({ cookies: [], origins: [] }), status: AccountStatus.ACTIVE } as any);
      expect(outcome.status).toBe('failed');
      expect(accountsDb.patchAccount).not.toHaveBeenCalled();
      expect(leetcodeAuth.loginToLeetCode).not.toHaveBeenCalled();
    });

    it('does not label credentials rejected when a login requires browser verification', async () => {
      vi.mocked(playwright.launchWithStorageStateObject).mockResolvedValue({ context: {}, close: vi.fn() } as any);
      vi.mocked(sessionCheck.checkSession).mockResolvedValue({ authenticated: false, cause: 'signed-out' });
      vi.spyOn(credentialStore, 'findCredentialsForAccount').mockResolvedValue({ username: 'user', password: 'secret' });
      vi.mocked(leetcodeAuth.loginToLeetCode).mockResolvedValue({ ok: false, code: 'VERIFICATION_REQUIRED', error: 'Use /renew' });
      await refreshLeetCodeAccount({ id: 'requires-verification', label: 'main', username: 'user',
        storageState: JSON.stringify({ cookies: [], origins: [] }), status: AccountStatus.ACTIVE } as any);
      expect(accountsDb.patchAccount).toHaveBeenCalledWith('requires-verification', expect.objectContaining({ status: AccountStatus.EXPIRED }));
      expect(accountsDb.saveAccount).not.toHaveBeenCalled();
    });

    it('returns status "valid" when active session is authenticated', async () => {
      vi.mocked(playwright.launchWithStorageStateObject).mockResolvedValue({
        context: {} as any,
        page: {} as any,
        close: vi.fn(),
      } as any);

      vi.mocked(sessionCheck.checkSession).mockResolvedValue({
        authenticated: true,
        username: 'user_active',
      });

      const outcome = await refreshLeetCodeAccount({
        id: 'acc-1',
        label: 'main',
        username: 'user_active',
        storageState: JSON.stringify({ cookies: [], origins: [] }),
        status: AccountStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastError: null,
        lastCheckedAt: null,
        lastRunAt: null,
        lastResult: null,
      });

      expect(outcome.status).toBe('valid');
      expect(outcome.username).toBe('user_active');
    });

    it('returns status "missing-credentials" when session expired and no stored credentials exist', async () => {
      vi.mocked(playwright.launchWithStorageStateObject).mockResolvedValue({
        context: {} as any,
        page: {} as any,
        close: vi.fn(),
      } as any);

      vi.mocked(sessionCheck.checkSession).mockResolvedValue({
        authenticated: false,
        cause: 'signed-out',
      });

      vi.spyOn(credentialStore, 'findCredentialsForAccount').mockResolvedValue(null);

      const outcome = await refreshLeetCodeAccount({
        id: 'acc-2',
        label: 'expired_label',
        username: 'user_expired',
        storageState: JSON.stringify({ cookies: [], origins: [] }),
        status: AccountStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastError: null,
        lastCheckedAt: null,
        lastRunAt: null,
        lastResult: null,
      });

      expect(outcome.status).toBe('missing-credentials');
      expect(accountsDb.patchAccount).toHaveBeenCalledWith('acc-2', expect.objectContaining({
        status: AccountStatus.EXPIRED,
      }));
    });

    it('auto-relogins and updates DB when session expired and encrypted credentials exist', async () => {
      vi.mocked(playwright.launchWithStorageStateObject).mockResolvedValue({
        context: {} as any,
        page: {} as any,
        close: vi.fn(),
      } as any);

      vi.mocked(sessionCheck.checkSession).mockResolvedValue({
        authenticated: false,
        cause: 'signed-out',
      });

      vi.spyOn(credentialStore, 'findCredentialsForAccount').mockResolvedValue({
        username: 'stored_user',
        password: 'stored_password',
        label: 'auto_refresh_label',
      });

      const newStorageState = { cookies: [{ name: 'LEETCODE_SESSION', value: 'new_token_123', domain: 'leetcode.com', path: '/' }], origins: [] };
      vi.mocked(leetcodeAuth.loginToLeetCode).mockResolvedValue({
        ok: true,
        username: 'stored_user',
        storageState: newStorageState as any,
      });

      const outcome = await refreshLeetCodeAccount({
        id: 'acc-3',
        label: 'auto_refresh_label',
        username: 'stored_user',
        storageState: JSON.stringify({ cookies: [], origins: [] }),
        status: AccountStatus.EXPIRED,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastError: null,
        lastCheckedAt: null,
        lastRunAt: null,
        lastResult: null,
      });

      expect(outcome.status).toBe('refreshed');
      expect(outcome.username).toBe('stored_user');
      expect(accountsDb.saveAccount).toHaveBeenCalledWith(
        'auto_refresh_label',
        JSON.stringify(newStorageState),
        expect.objectContaining({
          username: 'stored_user',
          status: AccountStatus.ACTIVE,
        }),
      );
    });
  });

  describe('Codeforces Account Auto-Refresh', () => {
    it('returns status "valid" when Codeforces session is valid', async () => {
      vi.mocked(codeforcesSession.validateCodeforcesStorageState).mockResolvedValue({
        ok: true,
        username: 'tourist',
      });

      const outcome = await refreshCodeforcesAccount({
        id: 'cf-1',
        label: 'main_cf',
        username: 'tourist',
        storageState: JSON.stringify({ cookies: [], origins: [] }),
        status: CodeforcesAccountStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastError: null,
        lastCheckedAt: null,
        lastSubmissionDate: null,
        lastSubmissionId: null,
        lastVerdict: null,
      });

      expect(outcome.status).toBe('valid');
      expect(outcome.username).toBe('tourist');
    });

    it('auto-relogins to Codeforces when expired and credentials exist', async () => {
      vi.mocked(codeforcesSession.validateCodeforcesStorageState).mockResolvedValue({
        ok: false,
        reason: 'signed-out',
        error: 'signed out',
      });

      vi.spyOn(credentialStore, 'findCredentialsForAccount').mockResolvedValue({
        username: 'cf_hero',
        password: 'cf_password',
        label: 'cf_label',
      });

      const newCfStorageState = { cookies: [{ name: 'JSESSIONID', value: 'sess_999', domain: '.codeforces.com', path: '/' }], origins: [] };
      vi.mocked(codeforcesAuth.loginToCodeforces).mockResolvedValue({
        ok: true,
        handle: 'cf_hero',
        storageState: newCfStorageState as any,
      });

      const outcome = await refreshCodeforcesAccount({
        id: 'cf-2',
        label: 'cf_label',
        username: 'cf_hero',
        storageState: JSON.stringify({ cookies: [], origins: [] }),
        status: CodeforcesAccountStatus.EXPIRED,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastError: null,
        lastCheckedAt: null,
        lastSubmissionDate: null,
        lastSubmissionId: null,
        lastVerdict: null,
      });

      expect(outcome.status).toBe('refreshed');
      expect(outcome.username).toBe('cf_hero');
      expect(codeforcesStorage.saveCodeforcesAccount).toHaveBeenCalledWith(
        'cf_label',
        JSON.stringify(newCfStorageState),
        expect.objectContaining({
          username: 'cf_hero',
          status: CodeforcesAccountStatus.ACTIVE,
        }),
      );
    });
  });

  describe('Full Verification Summary', () => {
    it('aggregates outcomes across both platforms', async () => {
      vi.mocked(accountsDb.listAccounts).mockResolvedValue([
        {
          id: 'acc-1',
          label: 'lc1',
          username: 'lc_user1',
          storageState: JSON.stringify({ cookies: [], origins: [] }),
          status: AccountStatus.ACTIVE,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastError: null,
          lastCheckedAt: null,
          lastRunAt: null,
          lastResult: null,
        },
      ]);

      vi.mocked(codeforcesStorage.listCodeforcesAccounts).mockResolvedValue([
        {
          id: 'cf-1',
          label: 'cf1',
          username: 'cf_user1',
          storageState: JSON.stringify({ cookies: [], origins: [] }),
          status: CodeforcesAccountStatus.ACTIVE,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastError: null,
          lastCheckedAt: null,
          lastSubmissionDate: null,
          lastSubmissionId: null,
          lastVerdict: null,
        },
      ]);

      vi.mocked(playwright.launchWithStorageStateObject).mockResolvedValue({
        context: {} as any,
        page: {} as any,
        close: vi.fn(),
      } as any);

      vi.mocked(sessionCheck.checkSession).mockResolvedValue({
        authenticated: true,
        username: 'lc_user1',
      });

      vi.mocked(codeforcesSession.validateCodeforcesStorageState).mockResolvedValue({
        ok: true,
        username: 'cf_user1',
      });

      const summary = await verifyAndRefreshAllSessions({ notifyTelegram: false });
      expect(summary.totalLeetCode).toBe(1);
      expect(summary.totalCodeforces).toBe(1);
      expect(summary.valid).toBe(2);
      expect(summary.refreshed).toBe(0);
      expect(summary.failed).toBe(0);
      expect(summary.expiredWithoutCreds).toBe(0);
    });
  });
});
