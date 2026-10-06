import { isoLocal } from '../time';

export type CodeforcesOutcomeKind = 'solved' | 'failed' | 'expired' | 'rejected' | 'skipped' | 'pending';

export interface CodeforcesAccountOutcome {
  label: string;
  username?: string | null;
  kind: CodeforcesOutcomeKind;
  problem?: string | null;
  problemUrl?: string | null;
  submissionId?: string | null;
  verdict?: string | null;
  error?: string | null;
  note?: string;
  /** A Codeforces submission was accepted by the form and reached a final verdict, or was already present. */
  performed?: boolean;
  /** The account reached the proxied browser during this run. Used only to bound automatic daily retries. */
  browserAttempted?: boolean;
}

export interface CodeforcesRunReport {
  date: string;
  reason: string;
  startedAt: string;
  finishedAt: string;
  totals: {
    accounts: number;
    solved: number;
    failed: number;
    expired: number;
    rejected: number;
    skipped: number;
    pending: number;
  };
  accounts: CodeforcesAccountOutcome[];
}

export function buildCodeforcesReport(input: {
  date: string;
  reason: string;
  startedAt: string;
  outcomes: CodeforcesAccountOutcome[];
}): CodeforcesRunReport {
  const totals: CodeforcesRunReport['totals'] = {
    accounts: input.outcomes.length,
    solved: 0,
    failed: 0,
    expired: 0,
    rejected: 0,
    skipped: 0,
    pending: 0,
  };
  for (const outcome of input.outcomes) totals[outcome.kind] += 1;
  return {
    ...input,
    accounts: input.outcomes,
    finishedAt: isoLocal(),
    totals,
  };
}

export function summarizeCodeforcesReport(report: CodeforcesRunReport): string {
  const t = report.totals;
  const pending = t.pending ? `, ${t.pending} sent to you` : '';
  return `${t.accounts} Codeforces account(s): ${t.solved} solved${pending}, ${t.failed} failed, ${t.skipped} skipped`;
}

export function formatCodeforcesOutcomeLine(outcome: CodeforcesAccountOutcome): string {
  const who = outcome.username ? `${outcome.label} (${outcome.username})` : outcome.label;
  if (outcome.kind === 'solved') return `✅ ${who} — ${outcome.problem ?? 'problem'} — OK${outcome.submissionId ? ` · #${outcome.submissionId}` : ''}`;
  if (outcome.kind === 'pending') return `📨 ${who} — ${outcome.problem ?? 'problem'} — solution sent to you; submit it and I'll detect the verdict and move on`;
  if (outcome.kind === 'skipped') return `⏭️ ${who} — ${outcome.error ?? 'already attempted today'}`;
  if (outcome.kind === 'expired') return `⏰ ${who} — ${outcome.error ?? 'Codeforces session expired or signed out'}`;
  if (outcome.kind === 'rejected') return `🚫 ${who} — ${outcome.error ?? 'Codeforces session rejected'}`;
  const detail = outcome.error ?? outcome.verdict ?? 'submission failed';
  const suffix =
    outcome.verdict && outcome.error && outcome.verdict !== outcome.error
      ? `${outcome.verdict} — ${outcome.error}`
      : detail;
  return `❌ ${who} — ${outcome.problem ?? 'next problem'} — ${suffix}`;
}

export function formatCodeforcesReport(report: CodeforcesRunReport): string {
  const lines = [
    `🏆 Codeforces Daily — 📅 ${report.date}`,
    `📊 ${summarizeCodeforcesReport(report)}`,
    '',
    ...report.accounts.map(formatCodeforcesOutcomeLine),
  ];
  return lines.join('\n');
}

export function formatCodeforcesAccountMessage(
  outcome: CodeforcesAccountOutcome,
  index: number,
  total: number,
): string {
  const lines = [`👤 Codeforces account ${index}/${total} — ${formatCodeforcesOutcomeLine(outcome)}`];
  if (outcome.note) lines.push(outcome.note);
  if (outcome.error && outcome.kind !== 'solved' && outcome.kind !== 'pending') lines.push(`⚠️ ${outcome.error}`);
  if (outcome.submissionId) lines.push(`🆔 Submission ID: ${outcome.submissionId}`);
  if (outcome.problemUrl) lines.push(`🔗 ${outcome.problemUrl}`);
  return lines.join('\n');
}
