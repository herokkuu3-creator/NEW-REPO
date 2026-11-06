import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountStatus } from '@prisma/client';
vi.mock('../src/leetcode/auth', () => ({ loginToLeetCode: vi.fn() }));
vi.mock('../src/database/accounts', async original => ({
  ...await original() as object,
  saveAccount: vi.fn(),
  listAccounts: vi.fn(async () => []),
  patchAccount: vi.fn(),
}));
vi.mock('../src/security/credentialStore', async original => ({ ...await original() as object, saveEncryptedCredentials: vi.fn() }));
import { loginToLeetCode } from '../src/leetcode/auth';
import { listAccounts, patchAccount, saveAccount } from '../src/database/accounts';
import { saveEncryptedCredentials } from '../src/security/credentialStore';
import {
  getActiveLoginPrompt,
  setActiveLoginPrompt,
  getPendingRenewalLabel,
  setPendingRenewalLabel,
  getPendingLeetCodeVerificationHandoff,
  setPendingLeetCodeVerificationHandoff,
  extractTelegramCommand,
  handleExecuteLogin,
  processCookieMessage,
} from '../src/notifications/telegramBot';

describe('Interactive Telegram Login State & Command Parsing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActiveLoginPrompt(null);
    setPendingRenewalLabel(undefined);
    setPendingLeetCodeVerificationHandoff(null);
  });
  it('stores exact credentials and the verified handle only after successful login', async () => {
    const state = { cookies: [], origins: [] };
    vi.mocked(loginToLeetCode).mockResolvedValue({ ok: true, username: 'verified_handle', storageState: state });
    const reply = vi.fn(async () => undefined);
    await handleExecuteLogin('leetcode', 'label', 'email@example.test', ' exact password ', reply);
    expect(loginToLeetCode).toHaveBeenCalledWith('email@example.test', ' exact password ', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(saveEncryptedCredentials).toHaveBeenCalledWith('leetcode', 'label', expect.objectContaining({ username: 'verified_handle', password: ' exact password ' }));
    expect(saveAccount).toHaveBeenCalledWith('label', JSON.stringify(state), expect.objectContaining({ username: 'verified_handle' }));
  });
  it('does not store a session or credentials when browser verification is required, and arms user-assisted handoff', async () => {
    vi.mocked(loginToLeetCode).mockResolvedValue({ ok: false, code: 'VERIFICATION_REQUIRED', error: 'Browser verification required' });
    const reply = vi.fn(async (_text: string) => undefined);
    await handleExecuteLogin('leetcode', 'label', 'user', 'secret', reply);
    expect(saveAccount).not.toHaveBeenCalled();
    expect(saveEncryptedCredentials).not.toHaveBeenCalled();
    expect(reply.mock.calls.at(-1)?.[0]).toContain('/auth/leetcode/');
    expect(reply.mock.calls.at(-1)?.[0]).toContain('npm run auth:login');
    expect(reply.mock.calls.at(-1)?.[0]).toContain('/renew');
    expect(getPendingRenewalLabel()).toBe('label');
    expect(getPendingLeetCodeVerificationHandoff()).toMatchObject({
      label: 'label',
      identifier: 'user',
      password: 'secret',
    });
  });

  it('completes /lclogin user-assisted verification handoff by validating cookies live on server and persisting encrypted credentials', async () => {
    vi.mocked(loginToLeetCode).mockResolvedValue({ ok: false, code: 'VERIFICATION_REQUIRED', error: 'Browser verification required' });
    vi.mocked(saveAccount).mockResolvedValue({ id: 'acc-1', label: 'black_sheep_7', username: null, status: AccountStatus.UNKNOWN } as any);
    vi.mocked(listAccounts).mockResolvedValue([{ id: 'acc-1', label: 'black_sheep_7', username: 'black_sheep_7', status: AccountStatus.ACTIVE } as any]);

    const reply = vi.fn(async (_text: string) => undefined);
    await handleExecuteLogin('leetcode', 'black_sheep_7', 'black_sheep_7', 'my_secret_pw', reply);
    expect(getPendingLeetCodeVerificationHandoff()?.label).toBe('black_sheep_7');

    const validator = vi.fn(async () => ({ ok: true as const, username: 'black_sheep_7' }));
    const cookiePayload = 'LEETCODE_SESSION=eyJhbGciOiJIUzI1NiJ9.eyJ1c2VybmFtZSI6ImJsYWNrX3NoZWVwXzciLCJyZWZyZXNoZWRfYXQiOjE3OTM5MzAwMDAsIl9zZXNzaW9uX2V4cGlyeSI6MTIwOTYwMH0.sig; csrftoken=csrf12345';
    const result = await processCookieMessage(cookiePayload, {
      label: getPendingRenewalLabel(),
      validator,
    });

    expect(validator).toHaveBeenCalledOnce();
    expect(patchAccount).toHaveBeenCalledWith('acc-1', expect.objectContaining({
      username: 'black_sheep_7',
      status: AccountStatus.ACTIVE,
      checked: true,
    }));
    expect(saveEncryptedCredentials).toHaveBeenCalledWith('leetcode', 'black_sheep_7', {
      username: 'black_sheep_7',
      password: 'my_secret_pw',
      label: 'black_sheep_7',
    });
    expect(result.stored).toBe(true);
    expect(result.text).toContain('Status: ACTIVE');
    expect(result.text).toContain('Verified live on server & encrypted credentials saved for black_sheep_7');
    expect(getPendingLeetCodeVerificationHandoff()).toBeNull();
  });

  it('does not save encrypted credentials during /lclogin handoff when server validation rejects the transferred session', async () => {
    vi.mocked(loginToLeetCode).mockResolvedValue({ ok: false, code: 'VERIFICATION_REQUIRED', error: 'Browser verification required' });
    vi.mocked(saveAccount).mockResolvedValue({ id: 'acc-2', label: 'black_sheep_7', username: null, status: AccountStatus.UNKNOWN } as any);
    vi.mocked(listAccounts).mockResolvedValue([{ id: 'acc-2', label: 'black_sheep_7', username: 'black_sheep_7', status: AccountStatus.REJECTED } as any]);

    await handleExecuteLogin('leetcode', 'black_sheep_7', 'black_sheep_7', 'my_secret_pw', vi.fn(async () => undefined));
    const validator = vi.fn(async () => ({ ok: false as const, reason: 'signed-out' as const, error: 'not signed in' }));
    const cookiePayload = 'LEETCODE_SESSION=eyJhbGciOiJIUzI1NiJ9.eyJ1c2VybmFtZSI6ImJsYWNrX3NoZWVwXzciLCJyZWZyZXNoZWRfYXQiOjE3OTM5MzAwMDAsIl9zZXNzaW9uX2V4cGlyeSI6MTIwOTYwMH0.sig; csrftoken=csrf12345';
    const result = await processCookieMessage(cookiePayload, {
      label: getPendingRenewalLabel(),
      validator,
    });

    expect(validator).toHaveBeenCalledOnce();
    expect(saveEncryptedCredentials).not.toHaveBeenCalled();
    expect(result.text).toContain('Status: SESSION REJECTED');
    expect(getPendingLeetCodeVerificationHandoff()).toBeNull();
  });

  it('correctly parses login slash commands and arguments', () => {
    expect(extractTelegramCommand('/lclogin')).toEqual({ command: '/lclogin', arg: '' });
    expect(extractTelegramCommand('/lclogin user_label_1')).toEqual({ command: '/lclogin', arg: 'user_label_1' });
    expect(extractTelegramCommand('/lc_login my_account')).toEqual({ command: '/lc_login', arg: 'my_account' });
    expect(extractTelegramCommand('/cflogin')).toEqual({ command: '/cflogin', arg: '' });
    expect(extractTelegramCommand('/cf_login cf_account')).toEqual({ command: '/cf_login', arg: 'cf_account' });
    expect(extractTelegramCommand('/checksessions')).toEqual({ command: '/checksessions', arg: '' });
  });

  it('manages activeLoginPrompt state transitions', () => {
    setActiveLoginPrompt(null);
    expect(getActiveLoginPrompt()).toBeNull();

    // Step 1: Initiated
    setActiveLoginPrompt({
      site: 'leetcode',
      step: 'awaiting_identifier',
      label: 'custom_label',
    });
    expect(getActiveLoginPrompt()?.step).toBe('awaiting_identifier');
    expect(getActiveLoginPrompt()?.site).toBe('leetcode');
    expect(getActiveLoginPrompt()?.label).toBe('custom_label');

    // Step 2: Identifier received, awaiting password
    const current = getActiveLoginPrompt()!;
    current.identifier = 'my_username';
    current.step = 'awaiting_password';
    expect(getActiveLoginPrompt()?.step).toBe('awaiting_password');
    expect(getActiveLoginPrompt()?.identifier).toBe('my_username');

    // Step 3: Finished / cancelled
    setActiveLoginPrompt(null);
    expect(getActiveLoginPrompt()).toBeNull();
  });

  it('validateCookiesAgainstLeetcode honors config.browser.headless when validating sessions on the server', async () => {
    const { chromium } = await import('playwright');
    const { config } = await import('../src/config');
    const sessionCheck = await import('../src/browser/sessionCheck');
    const { validateCookiesAgainstLeetcode } = await import('../src/browser/sessionRenewal');

    const contextClose = vi.fn(async () => undefined);
    const browserClose = vi.fn(async () => undefined);
    const launchSpy = vi.spyOn(chromium, 'launch').mockResolvedValueOnce({
      newContext: vi.fn(async () => ({
        request: {} as any,
        cookies: vi.fn(async () => []),
        close: contextClose,
      })),
      close: browserClose,
    } as any);
    const checkSpy = vi.spyOn(sessionCheck, 'checkSession').mockResolvedValueOnce({
      authenticated: true,
      username: 'black_sheep_7',
    });

    const outcome = await validateCookiesAgainstLeetcode({ cookies: [], origins: [] });
    expect(outcome).toEqual({ ok: true, username: 'black_sheep_7' });
    expect(launchSpy).toHaveBeenCalledWith(expect.objectContaining({
      headless: config.browser.headless,
    }));
    expect(contextClose).toHaveBeenCalledOnce();
    expect(browserClose).toHaveBeenCalledOnce();

    checkSpy.mockRestore();
    launchSpy.mockRestore();
  });
});
