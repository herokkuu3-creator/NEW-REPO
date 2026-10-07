import { describe, expect, it } from 'vitest';
import {
  HELP_TEXT,
  getPendingPromptType,
  setPendingPromptType,
} from '../src/notifications/telegramBot';

describe('HELP_TEXT command clickable formatting', () => {
  it('formats commands as bare clickable slash commands without <code> wrapping so Telegram treats them as executable bot commands', () => {
    expect(HELP_TEXT).toContain('├ /cfrange — Batch submit next N problems');
    expect(HELP_TEXT).toContain('├ /ccrange — Batch submit next N problems');
    expect(HELP_TEXT).toContain('├ /questionrangesubmission — Range solver');
    expect(HELP_TEXT).toContain('├ /useproxy — Select &amp; switch active Codeforces proxy');
    expect(HELP_TEXT).toContain('├ /removeproxy — Blacklist &amp; remove dead proxy in DB');

    // Ensure commands are not wrapped in <code>/cmd</code> which causes Telegram to only copy to clipboard on click
    expect(HELP_TEXT).not.toContain('<code>/cfrange</code>');
    expect(HELP_TEXT).not.toContain('<code>/ccrange</code>');
    expect(HELP_TEXT).not.toContain('<code>/questionrangesubmission</code>');
    expect(HELP_TEXT).not.toContain('<code>/useproxy</code>');
    expect(HELP_TEXT).not.toContain('<code>/removeproxy</code>');
  });

  it('contains pro tip guiding users to tap commands directly', () => {
    expect(HELP_TEXT).toContain('Tap any command above to run it instantly!');
  });
});

describe('PendingPromptType state management', () => {
  it('manages pendingPromptType correctly', () => {
    setPendingPromptType(null);
    expect(getPendingPromptType()).toBeNull();

    setPendingPromptType('codeforces');
    expect(getPendingPromptType()).toBe('codeforces');

    setPendingPromptType('codechef');
    expect(getPendingPromptType()).toBe('codechef');

    setPendingPromptType('leetcode');
    expect(getPendingPromptType()).toBe('leetcode');

    setPendingPromptType(null);
    expect(getPendingPromptType()).toBeNull();
  });
});
