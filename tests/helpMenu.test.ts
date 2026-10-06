import { describe, expect, it } from 'vitest';
import {
  HELP_TEXT,
  getPendingPromptType,
  setPendingPromptType,
} from '../src/notifications/telegramBot';

describe('HELP_TEXT command clickable formatting', () => {
  it('formats /cfrange, /ccrange, and /questionrangesubmission as clean clickable commands without inline argument placeholders', () => {
    expect(HELP_TEXT).toContain('├ <code>/cfrange</code> — Batch submit next N problems');
    expect(HELP_TEXT).toContain('├ <code>/ccrange</code> — Batch submit next N problems');
    expect(HELP_TEXT).toContain('├ <code>/questionrangesubmission</code> — Range solver');

    // Ensure placeholders like <i><count></i> are NOT directly attached to the command tags
    expect(HELP_TEXT).not.toContain('<code>/cfrange</code> <i>&lt;count&gt;</i>');
    expect(HELP_TEXT).not.toContain('<code>/ccrange</code> <i>&lt;count&gt;</i>');
    expect(HELP_TEXT).not.toContain('<code>/questionrangesubmission</code> <i>&lt;range&gt;</i>');
  });

  it('formats /removeproxy as clean clickable command without number argument placeholder', () => {
    expect(HELP_TEXT).toContain('├ <code>/removeproxy</code> — Blacklist &amp; remove dead proxy in DB');
    expect(HELP_TEXT).not.toContain('<code>/removeproxy</code> <i>&lt;number&gt;</i>');
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
