import { RunState } from '../database/models';
import { sendTelegramMessage, sendTelegramPhoto } from './telegram';
import { renewalUrl } from '../browser/remoteBrowser';

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

/**
 * Session-expired alert — the entry point of the /renew flow. Kept separate
 * from notifyRunFinished so the message can carry the renewal instructions
 * instead of a generic "attention needed".
 */
export async function notifySessionExpired(): Promise<void> {
  const link = await renewalUrl().catch(() => null);
  const lines = [
    '🔑 LeetCode session expired',
    '',
    'The stored cookies are no longer accepted — the daily run cannot start until you sign in again.',
    '',
  ];
  if (link) {
    lines.push(
      '👉 Tap to sign in (opens a live browser, ~2 min from your phone):',
      link,
      '',
      'Sign in inside that page; the moment LeetCode recognizes you, the new cookies are saved automatically and today\'s run starts.',
    );
  } else {
    lines.push('Send /renew to get a fresh sign-in link.');
  }
  await sendTelegramMessage(lines.join('\n'));
}

/** Minimal escaping — we send plain text, so only guard against confusing the API. */
function escape(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim();
}