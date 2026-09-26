import { RunState } from '../database/models';
import { sendTelegramMessage, sendTelegramPhoto } from './telegram';

/**
 * Notification composition. Channel-agnostic interface at the top,
 * Telegram implementation below â€” add email/Slack here later.
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
    ? 'âœ… LeetCode Daily Challenge Completed'
    : 'âš ï¸ LeetCode Daily Challenge â€” Attention Needed';

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
    await sendTelegramPhoto(n.screenshotPath, `${n.state} â€” ${n.title}`);
  }
}

/**
 * Session-expired alert â€” the entry point of the /renew flow. Kept separate
 * from notifyRunFinished so the message can carry the renewal instructions
 * instead of a generic "attention needed".
 */
export async function notifySessionExpired(): Promise<void> {
  await sendTelegramMessage([
    'ðŸ”‘ LeetCode session expired',
    '',
    'On Android: sign in to LeetCode in Chrome, open Termux in the agent folder, and run `npm run capture`.',
    '',
    'It creates Download/leetcode-session.json. Send that file here in Telegram; I validate it, save the session, and start today\'s run.',
  ].join('\n'));
}

/** Minimal escaping â€” we send plain text, so only guard against confusing the API. */
function escape(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim();
}