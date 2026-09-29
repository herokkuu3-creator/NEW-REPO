import { sendTelegramDocument } from '../notifications/telegram';
import { SourceIndexEntry } from './sourceRepo';

export const HANDOFF_VERDICT = 'SENT_TO_USER';

/** Where the next unsolved problem sits, skipping everything the account already solved. */
export function firstUnsolvedIndex(queue: SourceIndexEntry[], start: number, solved: Set<string>): number {
  let i = Math.max(0, start);
  while (i < queue.length && solved.has(`${queue[i]!.contestId}/${queue[i]!.problemIndex}`)) i += 1;
  return i;
}

export function submitPageUrl(entry: SourceIndexEntry): string {
  return entry.gym
    ? `https://codeforces.com/gym/${entry.contestId}/submit`
    : `https://codeforces.com/problemset/submit/${entry.contestId}/${entry.problemIndex}`;
}

export function handoffCaption(entry: SourceIndexEntry, handle: string): string {
  const language = entry.language === 'python' ? 'PyPy 3' : 'GNU G++23 (or any GNU G++)';
  return [
    `🏆 ${entry.contestId}${entry.problemIndex} — ${entry.problemName ?? entry.fileName} (${handle})`,
    'Cloudflare blocks submissions from the server, so this one is for you:',
    `1️⃣ Open ${submitPageUrl(entry)}`,
    `2️⃣ Language: ${language}`,
    '3️⃣ Choose this file (or paste it) and Submit',
    'After it is Accepted, the next /submitnextsolution (or the daily run) sees the OK verdict through the Codeforces API and moves to the next problem.',
  ].join('\n');
}

export async function sendHandoff(entry: SourceIndexEntry, handle: string, code: string): Promise<boolean> {
  const ext = entry.language === 'python' ? 'py' : 'cpp';
  const fileName = `${entry.contestId}${entry.problemIndex}.${ext}`;
  return sendTelegramDocument(fileName, code, handoffCaption(entry, handle));
}
