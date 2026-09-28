import type { CodeforcesProblem } from './types';
import { problemKey } from './sourceRepository';
import type { HttpLike } from './sourceRepository';

const MIN_API_GAP_MS = 2_100;
let nextAllowedAt = 0;

export async function cfGet<T>(http: HttpLike, url: string): Promise<T> {
  const delay = Math.max(0, nextAllowedAt - Date.now());
  if (delay > 0) await sleep(delay);
  nextAllowedAt = Date.now() + MIN_API_GAP_MS;

  const response = await http(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'leetcode-daily-agent-codeforces' },
  });
  if (!response.ok) throw new Error(`Codeforces API failed: HTTP ${response.status}`);
  const body = (await response.json()) as { status?: string; comment?: string; result?: T };
  if (body.status !== 'OK') throw new Error(`Codeforces API failed: ${body.comment ?? 'unknown error'}`);
  return body.result as T;
}

export async function fetchProblemset(http: HttpLike = fetch): Promise<Map<string, CodeforcesProblem>> {
  const data = await cfGet<{ problems?: CodeforcesProblem[] }>(http, 'https://codeforces.com/api/problemset.problems');
  const map = new Map<string, CodeforcesProblem>();
  for (const raw of data.problems ?? []) {
    if (!Number.isSafeInteger(raw.contestId) || !raw.index || !raw.name || raw.type !== 'PROGRAMMING') continue;
    const problem = { ...raw, index: raw.index.toUpperCase(), gym: false };
    map.set(problemKey(problem.contestId, problem.index), problem);
  }
  return map;
}

export interface ContestInfo { id: number; phase?: string; name?: string; }

export async function fetchContests(http: HttpLike = fetch): Promise<Map<number, ContestInfo>> {
  const data = await cfGet<ContestInfo[]>(http, 'https://codeforces.com/api/contest.list?gym=false');
  return new Map((data ?? []).map((contest) => [contest.id, contest]));
}

export function isLiveContest(phase?: string): boolean {
  return phase === 'BEFORE' || phase === 'CODING' || phase === 'PENDING_SYSTEM_TEST' || phase === 'SYSTEM_TEST';
}

export async function fetchUserSubmissions(
  http: HttpLike,
  handle: string,
  count = 20,
): Promise<Array<{ id: number; contestId?: number; problem?: { index?: string; name?: string }; verdict?: string; programmingLanguage?: string }>> {
  const url = `https://codeforces.com/api/user.status?handle=${encodeURIComponent(handle)}&from=1&count=${count}`;
  return cfGet(http, url);
}

export function keyForProblem(problem: CodeforcesProblem): string {
  return problemKey(problem.contestId, problem.index);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resetApiLimiterForTests(): void {
  nextAllowedAt = 0;
}
