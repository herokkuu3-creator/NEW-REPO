import { isoLocal } from '../time';

export type CodeforcesOutcomeKind = 'solved' | 'failed' | 'expired' | 'rejected' | 'skipped';

export interface CodeforcesAccountOutcome {
  label: string;
  username?: string | null;
  kind: CodeforcesOutcomeKind;
  problem?: string | null;
  problemUrl?: string | null;
  submissionId?: string | null;
  verdict?: string | null;
  error?: string | null;
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
  return `${t.accounts} Codeforces account(s): ${t.solved} solved, ${t.failed} failed, ${t.skipped} skipped`;
}

export function formatCodeforcesOutcomeLine(outcome: CodeforcesAccountOutcome): string {
  const who = outcome.username ? `${outcome.label} (${outcome.username})` : outcome.label;
  if (outcome.kind === 'solved') return `✅ ${who} — ${outcome.problem ?? 'problem'} — OK${outcome.submissionId ? ` · #${outcome.submissionId}` : ''}`;
  if (outcome.kind === 'skipped') return `⏭️ ${who} — ${outcome.error ?? 'already attempted today'}`;
  if (outcome.kind === 'expired') return `⏰ ${who} — ${outcome.error ?? 'Codeforces session expired or signed out'}`;
  if (outcome.kind === 'rejected') return `🚫 ${who} — ${outcome.error ?? 'Codeforces session rejected'}`;
  return `❌ ${who} — ${outcome.problem ?? 'next problem'} — ${outcome.verdict ?? outcome.error ?? 'submission failed'}`;
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
  if (outcome.submissionId) lines.push(`🆔 Submission ID: ${outcome.submissionId}`);
  if (outcome.problemUrl) lines.push(`🔗 ${outcome.problemUrl}`);
  return lines.join('\n');
}
