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
    expect(saveAccount).toHaveBeenCalledWith('black_sheep_7', expect.any(String), expect.objectContaining({
      username: 'black_sheep_7',
      status: AccountStatus.ACTIVE,
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
    expect(result.stored).toBe(false);
    expect(result.text).toContain('stored session retained');
    expect(saveAccount).not.toHaveBeenCalled();
    expect(getPendingLeetCodeVerificationHandoff()).not.toBeNull();
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

  it('validates with the reusable API transport and disposes it', async () => {
    const sessions = await import('../src/leetcode/sessionManager');
    const sessionCheck = await import('../src/browser/sessionCheck');
    const { validateCookiesAgainstLeetcode } = await import('../src/browser/sessionRenewal');
    const close = vi.fn(async () => undefined);
    const open = vi.spyOn(sessions, 'openLightweightLeetCodeSession').mockResolvedValueOnce({ api: {}, close } as any);
    const check = vi.spyOn(sessionCheck, 'checkSession').mockResolvedValueOnce({authenticated: true, username: 'black_sheep_7'});
    const state = { cookies: [], origins: [] };
    expect(await validateCookiesAgainstLeetcode(state)).toEqual({ok: true, username: 'black_sheep_7'});
    expect(open).toHaveBeenCalledWith(state);
    expect(close).toHaveBeenCalledOnce();
    open.mockRestore(); check.mockRestore();
  });

  it('clears login cooldown for target label when pairing or cookie handoff succeeds with ACTIVE status', async () => {
    const {
      getLeetCodeLoginCooldown,
      recordLeetCodeLoginCooldown,
      clearLeetCodeLoginCooldownsForTests,
    } = await import('../src/leetcode/sessionManager');
    clearLeetCodeLoginCooldownsForTests();
    await recordLeetCodeLoginCooldown('sks7501', 'VERIFICATION_REQUIRED', 'Browser verification required');
    expect((await getLeetCodeLoginCooldown('sks7501')).coolingDown).toBe(true);

    setPendingRenewalLabel('sks7501');
    setPendingLeetCodeVerificationHandoff({
      label: 'sks7501',
      identifier: 'sks7501@example.com',
      password: 'pw123',
      createdAt: Date.now(),
    });
    vi.mocked(saveAccount).mockResolvedValue({ id: 'acc-sks', label: 'sks7501', username: 'sks7501', status: AccountStatus.ACTIVE } as any);
    vi.mocked(listAccounts).mockResolvedValue([{ id: 'acc-sks', label: 'sks7501', username: 'sks7501', status: AccountStatus.EXPIRED } as any]);

    const validator = vi.fn(async () => ({ ok: true as const, username: 'sks7501' }));
    const cookiePayload = 'LEETCODE_SESSION=eyJhbGciOiJIUzI1NiJ9.eyJ1c2VybmFtZSI6InNrczc1MDEiLCJyZWZyZXNoZWRfYXQiOjE3OTM5MzAwMDAsIl9zZXNzaW9uX2V4cGlyeSI6MTIwOTYwMH0.sig; csrftoken=csrf12345';
    const result = await processCookieMessage(cookiePayload, {
      label: getPendingRenewalLabel(),
      validator,
    });

    expect(result.stored).toBe(true);
    expect((await getLeetCodeLoginCooldown('sks7501')).coolingDown).toBe(false);
  });

  it('handles /lclogin black_sheep_7 with detailed sanitized diagnostics and no generic session-expired text', async () => {
    vi.mocked(loginToLeetCode).mockResolvedValue({
      ok: false,
      code: 'VERIFICATION_REQUIRED',
      error: 'Cloudflare verification required on /accounts/login/',
      diagnostic: {
        challengeType: 'turnstile',
        adapterInitialized: true,
        selectedAdapter: 'capzy',
        solverAttempted: true,
        solverResult: 'failed',
        manualVerificationRequired: true,
        continuationStatus: 'awaiting_user',
        sessionPersisted: false,
      },
    });

    const reply = vi.fn(async (_text: string) => undefined);
    await handleExecuteLogin('leetcode', 'black_sheep_7', 'black_sheep_7', 'secret_pass_123', reply);

    const lastReply = reply.mock.calls.at(-1)?.[0] ?? '';
    // Must NOT jump to generic session expired
    expect(lastReply).not.toContain('LeetCode Session Expired');
    // Must NOT leak passwords or raw tokens
    expect(lastReply).not.toContain('secret_pass_123');

    // Must output structured diagnostics
    expect(lastReply).toContain('Detected Challenge');
    expect(lastReply).toContain('turnstile');
    expect(lastReply).toContain('CAPZY');
    expect(lastReply).toContain('Solver Test Attempted');
    expect(lastReply).toContain('Manual Verification Required');
    expect(lastReply).toContain('Continuation Status');
    expect(lastReply).toContain('Session Persisted');

    // Handoff must be armed for black_sheep_7
    expect(getPendingRenewalLabel()).toBe('black_sheep_7');
    expect(getPendingLeetCodeVerificationHandoff()).toMatchObject({
      label: 'black_sheep_7',
      identifier: 'black_sheep_7',
      password: 'secret_pass_123',
    });
  });

  it('completes /renew black_sheep_7 after legitimate verification, persists ACTIVE session, and enables GraphQL reuse', async () => {
    const {
      getLeetCodeLoginCooldown,
      recordLeetCodeLoginCooldown,
      clearLeetCodeLoginCooldownsForTests,
    } = await import('../src/leetcode/sessionManager');
    clearLeetCodeLoginCooldownsForTests();
    await recordLeetCodeLoginCooldown('black_sheep_7', 'VERIFICATION_REQUIRED', 'Browser verification required');
    expect((await getLeetCodeLoginCooldown('black_sheep_7')).coolingDown).toBe(true);

    setPendingRenewalLabel('black_sheep_7');
    setPendingLeetCodeVerificationHandoff({
      label: 'black_sheep_7',
      identifier: 'black_sheep_7',
      password: 'test_password_456',
      createdAt: Date.now(),
    });

    vi.mocked(saveAccount).mockResolvedValue({
      id: 'acc-bs7',
      label: 'black_sheep_7',
      username: 'black_sheep_7',
      status: AccountStatus.ACTIVE,
    } as any);
    vi.mocked(listAccounts).mockResolvedValue([
      { id: 'acc-bs7', label: 'black_sheep_7', username: 'black_sheep_7', status: AccountStatus.UNKNOWN } as any,
    ]);

    const validator = vi.fn(async () => ({ ok: true as const, username: 'black_sheep_7' }));
    const cookiePayload = 'LEETCODE_SESSION=verified_session_token_bs7; csrftoken=valid_csrf_token_bs7';
    const result = await processCookieMessage(cookiePayload, {
      label: getPendingRenewalLabel(),
      validator,
    });

    expect(result.stored).toBe(true);
    expect(validator).toHaveBeenCalledOnce();
    expect(saveEncryptedCredentials).toHaveBeenCalledWith('leetcode', 'black_sheep_7', expect.objectContaining({
      username: 'black_sheep_7',
      password: 'test_password_456',
      label: 'black_sheep_7',
    }));
    expect(saveAccount).toHaveBeenCalledWith('black_sheep_7', expect.any(String), expect.objectContaining({
      username: 'black_sheep_7',
      status: AccountStatus.ACTIVE,
    }));
    expect((await getLeetCodeLoginCooldown('black_sheep_7')).coolingDown).toBe(false);
  });

  it('rejects /lclogin when authenticated GraphQL username mismatches the target account and does NOT overwrite existing session', async () => {
    vi.mocked(loginToLeetCode).mockResolvedValue({
      ok: true,
      username: 'other_user_handle',
      storageState: { cookies: [{ name: 'LEETCODE_SESSION', value: 'wrong_sess' }] as any, origins: [] },
    });
    vi.mocked(listAccounts).mockResolvedValue([
      { id: 'acc-bs7', label: 'black_sheep_7', username: 'black_sheep_7', status: AccountStatus.EXPIRED } as any,
    ]);

    const reply = vi.fn(async (_text: string) => undefined);
    await handleExecuteLogin('leetcode', 'black_sheep_7', 'black_sheep_7', 'secret_pw', reply);

    expect(saveAccount).not.toHaveBeenCalled();
    expect(saveEncryptedCredentials).not.toHaveBeenCalled();
    const lastReply = reply.mock.calls.at(-1)?.[0] ?? '';
    expect(lastReply).toContain('USERNAME_MISMATCH');
    expect(lastReply).toContain('other_user_handle');
    expect(lastReply).not.toContain('LeetCode Login Successful');
  });

  it('never reports LeetCode Login Successful when PostgreSQL saveAccount or read-back verification fails', async () => {
    vi.mocked(loginToLeetCode).mockResolvedValue({
      ok: true,
      username: 'black_sheep_7',
      storageState: { cookies: [{ name: 'LEETCODE_SESSION', value: 'valid_sess' }] as any, origins: [] },
    });
    vi.mocked(saveAccount).mockRejectedValueOnce(new Error('PostgreSQL connection terminated'));

    const reply = vi.fn(async (_text: string) => undefined);
    await handleExecuteLogin('leetcode', 'black_sheep_7', 'black_sheep_7', 'secret_pw', reply);

    const lastReply = reply.mock.calls.at(-1)?.[0] ?? '';
    expect(lastReply).toContain('LeetCode Login Persistence Failed');
    expect(lastReply).toContain('SESSION_PERSISTENCE_FAILED');
    expect(lastReply).not.toContain('LeetCode Login Successful');
  });
});
