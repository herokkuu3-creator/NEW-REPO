import { describe, expect, it } from 'vitest';
import {
  AccountOutcome,
  buildReport,
  formatReportForTelegram,
  summarizeReport,
} from '../src/scheduler/report';

/**
 * Pure report-logic tests for the multi-account daily run — no browser,
 * no database, no network. The fixtures use fake labels/usernames only.
 */

const solved: AccountOutcome = {
  label: 'main',
  username: 'userA',
  kind: 'solved',
  state: 'SUCCESS',
  submissionStatus: 'Accepted',
  runtime: '45 ms',
  memory: '9.2 MB',
};

const expired: AccountOutcome = {
  label: 'second',
  username: 'userB',
  kind: 'expired',
  error: 'session expired — re-upload fresh cookies for this account',
};

const failed: AccountOutcome = {
  label: 'third',
  kind: 'failed',
  state: 'SUBMISSION_REJECTED',
  error: 'judge verdict: Wrong Answer',
};


const rejected: AccountOutcome = {
  label: 'fifth',
  username: 'userC',
  kind: 'rejected',
  error: 'LeetCode rejected the transferred session',
};

const skipped: AccountOutcome = {
  label: 'fourth',
  kind: 'skipped',
};

const STARTED = '2026-09-26T10:00:00.000Z';

function reportOf(...outcomes: AccountOutcome[]) {
  return buildReport({ date: '2026-09-26', reason: 'cron', startedAt: STARTED, outcomes });
}

describe('buildReport', () => {
  it('counts the totals from mixed outcomes', () => {
    const report = reportOf(solved, expired, failed, skipped, { ...solved, label: 'fifth' });
    expect(report.totals).toEqual({ accounts: 5, solved: 2, failed: 1, expired: 1, skipped: 1 });
    expect(report.accounts).toHaveLength(5);
  });

  it('keeps the date/reason and stamps finishedAt after startedAt', () => {
    const report = reportOf(solved);
    expect(report.date).toBe('2026-09-26');
    expect(report.reason).toBe('cron');
    expect(new Date(report.finishedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(STARTED).getTime(),
    );
  });

  it('produces a valid zero report when no accounts are configured', () => {
    const report = reportOf();
    expect(report.totals).toEqual({ accounts: 0, solved: 0, failed: 0, expired: 0, skipped: 0 });
    expect(summarizeReport(report)).toBe('no accounts configured');
  });
});

describe('summarizeReport', () => {
  it('mentions solved first and only non-zero buckets', () => {
    expect(summarizeReport(reportOf(solved, { ...solved, label: 'x' }))).toBe(
      '2 account(s): 2 solved',
    );
    expect(summarizeReport(reportOf(solved, expired, failed))).toBe(
      '3 account(s): 1 solved, 1 expired, 1 failed',
    );
  });
});

describe('formatReportForTelegram', () => {
  it('renders one line per account with the right markers', () => {
    const text = formatReportForTelegram(reportOf(solved, expired, rejected, skipped));
    expect(text).toContain('LeetCode Daily Report — 2026-09-26');
    expect(text).toContain('[OK] main (userA) — Accepted · 45 ms · 9.2 MB');
    expect(text).toContain('[EXPIRED] second (userB) — session expired');
    expect(text).toContain('[REJECTED] fifth (userC) — LeetCode rejected the transferred session');
    expect(text).toContain('[FAIL] third — SUBMISSION_REJECTED: judge verdict: Wrong Answer');
    expect(text).toContain('[SKIP] fourth — already handled today');
  });

  it('shows the label without a username when none is known', () => {
    const text = formatReportForTelegram(reportOf({ ...expired, username: null }));
    expect(text).toContain('[EXPIRED] second — ');
  });

  it('never leaks cookie material into the message', () => {
    const text = formatReportForTelegram(reportOf(solved, expired, rejected, failed, skipped));
    expect(text).not.toMatch(/LEETCODE_SESSION/);
    expect(text).not.toMatch(/csrftoken/);
  });

  it('truncates very long error details to keep the message readable', () => {
    const noisy: AccountOutcome = {
      ...failed,
      error: 'x'.repeat(500),
    };
    const text = formatReportForTelegram(reportOf(noisy));
    expect(text.length).toBeLessThan(600);
    expect(text).toContain('...');
  });
});
