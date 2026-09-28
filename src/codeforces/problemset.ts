import type { CodeforcesProblem } from './types';

const MIN_API_GAP_MS = 2_100;
let nextAllowedAt = 0;

export interface CfSubmission {
  id: number;
  contestId?: number;
  problem?: { index?: string; name?: string };
  verdict?: string;
  programmingLanguage?: string;
}

async function cfGet<T>(url: string): Promise<T> {
  const wait = Math.max(0, nextAllowedAt - Date.now());
  if (wait) await sleep(wait);
  nextAllowedAt = Date.now() + MIN_API_GAP_MS;

  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'leetcode-daily-agent' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(\`Codeforces API HTTP \${response.status}\`);

  const body = (await response.json()) as {
    status?: string;
    comment?: string;
    result?: T;
  };
  if (body.status !== 'OK') {
    throw new Error(\`Codeforces API failed: \${body.comment ?? 'unknown error'}\`);
  }
  return body.result as T;
}

export async function fetchProblemset(): Promise<Map<string, CodeforcesProblem>> {
  const body = await cfGet<{ problems?: CodeforcesProblem[] }>(
    'https://codeforces.com/api/problemset.problems',
  );
  const map = new Map<string, CodeforcesProblem>();

  for (const raw of body.problems ?? []) {
    if (!Number.isSafeInteger(raw.contestId) || !raw.index || !raw.name) continue;
    map.set(\`\${raw.contestId}\${raw.index.toUpperCase()}\`, {
      ...raw,
      index: raw.index.toUpperCase(),
      gym: false,
    });
  }

  return map;
}

export async function fetchUserSubmissions(handle: string, count = 20): Promise<CfSubmission[]> {
  return cfGet<CfSubmission[]>(
    \`https://codeforces.com/api/user.status?handle=\${encodeURIComponent(handle)}&from=1&count=\${count}\`,
  );
}

export async function fetchContestSubmissions(
  contestId: number,
  handle: string,
  count = 20,
): Promise<CfSubmission[]> {
  return cfGet<CfSubmission[]>(
    \`https://codeforces.com/api/contest.status?contestId=\${contestId}&handle=\${encodeURIComponent(handle)}&from=1&count=\${count}\`,
  );
}

export function resetCodeforcesApiLimiterForTests(): void {
  nextAllowedAt = 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
