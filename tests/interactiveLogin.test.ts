import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/leetcode/auth', () => ({ loginToLeetCode: vi.fn() }));
vi.mock('../src/database/accounts', async original => ({ ...await original() as object, saveAccount: vi.fn() }));
vi.mock('../src/security/credentialStore', async original => ({ ...await original() as object, saveEncryptedCredentials: vi.fn() }));
import { loginToLeetCode } from '../src/leetcode/auth';
import { saveAccount } from '../src/database/accounts';
import { saveEncryptedCredentials } from '../src/security/credentialStore';
import {
  getActiveLoginPrompt,
  setActiveLoginPrompt,
  extractTelegramCommand,
  handleExecuteLogin,
} from '../src/notifications/telegramBot';

describe('Interactive Telegram Login State & Command Parsing', () => {
  beforeEach(() => vi.clearAllMocks());
  it('stores exact credentials and the verified handle only after successful login', async () => {
    const state = { cookies: [], origins: [] };
    vi.mocked(loginToLeetCode).mockResolvedValue({ ok: true, username: 'verified_handle', storageState: state });
    const reply = vi.fn(async () => undefined);
    await handleExecuteLogin('leetcode', 'label', 'email@example.test', ' exact password ', reply);
    expect(loginToLeetCode).toHaveBeenCalledWith('email@example.test', ' exact password ', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(saveEncryptedCredentials).toHaveBeenCalledWith('leetcode', 'label', expect.objectContaining({ username: 'verified_handle', password: ' exact password ' }));
    expect(saveAccount).toHaveBeenCalledWith('label', JSON.stringify(state), expect.objectContaining({ username: 'verified_handle' }));
  });
  it('does not store a session or credentials when browser verification is required', async () => {
    vi.mocked(loginToLeetCode).mockResolvedValue({ ok: false, code: 'VERIFICATION_REQUIRED', error: 'Browser verification required' });
    const reply = vi.fn(async (_text: string) => undefined);
    await handleExecuteLogin('leetcode', 'label', 'user', 'secret', reply);
    expect(saveAccount).not.toHaveBeenCalled();
    expect(saveEncryptedCredentials).not.toHaveBeenCalled();
    expect(reply.mock.calls.at(-1)?.[0]).toContain('/renew');
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
});
