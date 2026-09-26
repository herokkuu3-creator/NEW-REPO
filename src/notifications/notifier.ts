import { RunState } from '../database/models';
import { sendTelegramMessage, sendTelegramPhoto } from './telegram';

/**
 * Notification composition. Channel-agnostic interface at the top,
 * Telegram implementation below — add email/Slack here later.
 */

export interface RunNotification {
  state: RunState;
  title: string;
  difficulty: string;
  language: string;
  slug: string;
  submissionStatus?: string | null;
  runtime?: string | null;
  memory?: string | null;
  error?: string | null;
  /** Optional diagnostics screenshot (sent as a Telegram photo) */
  screenshotPath?: string | null;
}

export async function notifyRunFinished(n: RunNotification): Promise<void> {
  const success = n.state === RunState.SUCCESS;
  const header = success
    ? '✅ LeetCode Daily Challenge Completed'
    : '⚠️ LeetCode Daily Challenge — Attention Needed';

  const lines = [
    header,
    '',
    `Problem: ${escape(n.title)}`,
    `Difficulty: ${escape(n.difficulty)}`,
    `Language: ${escape(n.language)}`,
    `Status: ${escape(n.submissionStatus ?? n.state)}`,
  ];
  if (n.runtime) lines.push(`Runtime: ${escape(n.runtime)}`);
  if (n.memory) lines.push(`Memory: ${escape(n.memory)}`);
  lines.push(`URL: https://leetcode.com/problems/${n.slug}/`);
  if (!success && n.error) {
    lines.push('', `Detail: ${escape(n.error.slice(0, 500))}`);
  }

  await sendTelegramMessage(lines.join('\n'));
  if (n.screenshotPath) {
    await sendTelegramPhoto(n.screenshotPath, `${n.state} — ${n.title}`);
  }
}

/** Minimal escaping — we send plain text, so only guard against confusing the API. */
function escape(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim();
}
