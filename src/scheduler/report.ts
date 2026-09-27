/**
 * Pure report logic for the multi-account daily run.
 *
 * No I/O, no Prisma, no Playwright — every function here is unit-testable in
 * isolation (tests/report.test.ts). The scheduler builds the outcomes, this
 * module counts and formats them; the notifier ships them to Telegram.
 *
 * Cookie values are never part of an outcome — only labels, usernames, and
 * run results.
 */

export type AccountOutcomeKind = 'solved' | 'failed' | 'expired' | 'rejected' | 'skipped';

export interface AccountOutcome {
  /** The account label (user-chosen, e.g. "main"). */
  label: string;
  /** LeetCode username, when a session check could resolve one. */
  username?: string | null;
  kind: AccountOutcomeKind;
  /** RunState value when a run row was written (e.g. SUBMISSION_REJECTED). */
  state?: string;
  /** LeetCode submission id, when a submission was made. */
  submissionId?: string | null;
  submissionStatus?: string | null;
  runtime?: string | null;
  memory?: string | null;
  error?: string | null;
}

export interface RunReport {
  date: string; // YYYY-MM-DD in the configured timezone
  reason: string; // 'cron' | 'boot' | 'admin-api' | 'manual-cli' | ...
  startedAt: string; // ISO
  finishedAt: string; // ISO
  totals: {
    accounts: number;
    solved: number;
    failed: number;
    expired: number;
    rejected: number;
    skipped: number;
  };
  accounts: AccountOutcome[];
}

/** Builds the finished report and computes the totals from the outcomes. */
export function buildReport(input: {
  date: string;
  reason: string;
  startedAt: string;
  outcomes: AccountOutcome[];
}): RunReport {
  const totals: RunReport['totals'] = {
    accounts: 0,
    solved: 0,
    failed: 0,
    expired: 0,
    rejected: 0,
    skipped: 0,
  };
  for (const outcome of input.outcomes) {
    totals.accounts += 1;
    totals[outcome.kind] += 1;
  }
  return {
    date: input.date,
    reason: input.reason,
    startedAt: input.startedAt,
    finishedAt: new Date().toISOString(),
    totals,
    accounts: input.outcomes,
  };
}

/** One-line summary, e.g. "3 account(s): 2 solved, 1 expired". */
export function summarizeReport(report: RunReport): string {
  const t = report.totals;
  if (t.accounts === 0) return 'no accounts configured';
  const parts: string[] = [`${t.solved} solved`];
  if (t.expired > 0) parts.push(`${t.expired} expired`);
  if (t.rejected > 0) parts.push(`${t.rejected} rejected`);
  if (t.failed > 0) parts.push(`${t.failed} failed`);
  if (t.skipped > 0) parts.push(`${t.skipped} skipped`);
  return `${t.accounts} account(s): ${parts.join(', ')}`;
}

const MAX_ERROR_CHARS = 200;

function firstLine(s: string | null | undefined): string | undefined {
  if (!s) return undefined;
  const line = s.replace(/[\r\n]+/g, ' ').trim();
  return line.length > MAX_ERROR_CHARS ? `${line.slice(0, MAX_ERROR_CHARS)}...` : line || undefined;
}

/**
 * Plain-text Telegram rendering of the report. One line per account:
 *   [OK] main (userA) — Accepted · 45 ms · 9.2 MB
 *   [EXPIRED] second — session expired — re-upload fresh cookies
 *   [FAIL] third — SUBMISSION_REJECTED: judge verdict: Wrong Answer
 *   [SKIP] fourth — already handled today
 */
export function formatReportForTelegram(report: RunReport): string {
  const lines = [
    `LeetCode Daily Report — ${report.date}`,
    summarizeReport(report),
    '',
  ];
  for (const o of report.accounts) {
    lines.push(formatOutcomeLine(o));
  }
  return lines.join('\n');
}

/** One report line for one account (shared by the report and per-account messages). */
export function formatOutcomeLine(o: AccountOutcome): string {
  const who = o.username ? `${o.label} (${o.username})` : o.label;
  switch (o.kind) {
    case 'solved': {
      const parts = [o.submissionStatus ?? 'done'];
      if (o.runtime) parts.push(o.runtime);
      if (o.memory) parts.push(o.memory);
      return `[OK] ${who} — ${parts.filter(Boolean).join(' · ')}`;
    }
    case 'expired':
      return `[EXPIRED] ${who} — ${firstLine(o.error) ?? 'session token itself is expired — re-capture fresh cookies'}`;
    case 'rejected':
      return `[REJECTED] ${who} — ${firstLine(o.error) ?? 'LeetCode rejected the transferred session; token expiry is not established'}`;
    case 'failed': {
      const detail = firstLine(o.error);
      return `[FAIL] ${who} — ${o.state ?? 'error'}${detail ? `: ${detail}` : ''}`;
    }
    case 'skipped':
      return `[SKIP] ${who} — ${firstLine(o.error) ?? 'already handled today'}`;
  }
}

/**
 * Standalone Telegram message for ONE account's result, sent as soon as that
 * account finishes during /triggersubmission, e.g.
 *   Account 2/9 — [OK] dom4429 (dom4429) — Accepted · 0 ms · 8.6 MB
 *   Submission ID: 2154720128
 */
export function formatAccountMessage(o: AccountOutcome, index: number, total: number): string {
  const lines = [`Account ${index}/${total} — ${formatOutcomeLine(o)}`];
  if (o.submissionId) lines.push(`Submission ID: ${o.submissionId}`);
  return lines.join('\n');
}
