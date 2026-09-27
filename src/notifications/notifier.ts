import { RunState } from '../database/models';
import { formatReportForTelegram, RunReport } from '../scheduler/report';
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
    ? '🎉 LeetCode Daily Challenge Completed'
    : '⚠️ LeetCode Daily Challenge: Attention Needed';

  const lines = [
    header,
    '',
    `📌 Problem: ${escape(n.title)}`,
    `🎯 Difficulty: ${escape(n.difficulty)}`,
    `💻 Language: ${escape(n.language)}`,
    `📊 Status: ${escape(n.submissionStatus ?? n.state)}`,
  ];
  if (n.runtime) lines.push(`⏱️ Runtime: ${escape(n.runtime)}`);
  if (n.memory) lines.push(`🧠 Memory: ${escape(n.memory)}`);
  lines.push(`🔗 URL: https://leetcode.com/problems/${n.slug}/`);
  if (!success && n.error) {
    lines.push('', `❗ Detail: ${escape(n.error.slice(0, 500))}`);
  }

  await sendTelegramMessage(lines.join('\n'));
  if (n.screenshotPath) {
    await sendTelegramPhoto(n.screenshotPath, `${n.state}: ${n.title}`);
  }
}

/**
 * Session-expired alert â€” the entry point of the /renew flow. Kept separate
 * from notifyRunFinished so the message can carry the renewal instructions
 * instead of a generic "attention needed".
 */
export async function notifySessionExpired(): Promise<void> {
  await sendTelegramMessage([
    '⏰ LeetCode session expired',
    '',
    '📱 Android renewal: no computer is required.',
    '',
    '1️⃣ Open Lemur Browser on Android -> sign in to LeetCode\n2️⃣ Open the LeetCode Session Capture extension -> capture/download leetcode-session.json\n3️⃣ Send that file here in Telegram',
    '',
    '✅ I will validate the session, save it securely, and start today\'s run automatically.',
  ].join('\n'));
}

/** Minimal escaping â€” we send plain text, so only guard against confusing the API. */
function escape(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Multi-account daily report — ONE summary message for the whole batch,
 * replacing the per-run notifications of the single-account era. Silent for
 * an empty batch (nothing ran) and when Telegram is not configured.
 */
export async function notifyMultiRunReport(report: RunReport): Promise<void> {
  if (report.totals.accounts === 0) return;
  await sendTelegramMessage(formatReportForTelegram(report));
}
