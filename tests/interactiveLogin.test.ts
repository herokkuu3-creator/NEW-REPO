import { describe, expect, it } from 'vitest';
import {
  getActiveLoginPrompt,
  setActiveLoginPrompt,
  extractTelegramCommand,
} from '../src/notifications/telegramBot';

describe('Interactive Telegram Login State & Command Parsing', () => {
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
