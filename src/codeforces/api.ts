import { logger } from '../logger';

const API_BASE = 'https://codeforces.com/api';
const MIN_GAP_MS = 2_100;

let apiChain: Promise<unknown> = Promise.resolve();
let nextAllowedAt = 0;

export class CodeforcesApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeforcesApiError';
  }
}

export interface CodeforcesProblem {
  contestId?: number;
  problemsetName?: string;
  index: string;
  name: string;
  type?: string;
  points?: number;
  rating?: number;
  tags?: string[];
}

export interface CodeforcesSubmission {
  id: number;
  contestId?: number;
  problem: {
    contestId?: number;
    index?: string;
    name?: string;
  };
  verdict?: string | null;
  creationTimeSeconds: number;
  programmingLanguage?: string;
  testset?: string;
}

async function callApi<T>(method: string, params: Record<string, string | number | undefined>): Promise<T> {
  const run = async (): Promise<T> => {
    const now = Date.now();
    const waitMs = Math.max(0, nextAllowedAt - now);
    if (waitMs > 0) await sleep(waitMs);

    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, String(value));
    }
    const url = `${API_BASE}/${method}${query.toString() ? `?${query}` : ''}`;
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    nextAllowedAt = Date.now() + MIN_GAP_MS;

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new CodeforcesApiError(`Codeforces API ${method} returned invalid JSON (HTTP ${response.status})`);
    }

    const payload = body as { status?: string; comment?: string; result?: T };
    if (!response.ok || payload.status !== 'OK') {
      throw new CodeforcesApiError(
        `Codeforces API ${method} failed: HTTP ${response.status}${payload.comment ? ` — ${payload.comment}` : ''}`,
      );
    }
    return payload.result as T;
  };

  const chained = apiChain.then(run, run);
  apiChain = chained.then(
    () => undefined,
    () => undefined,
  );
  return chained;
}

export async function fetchProblemsetProblems(): Promise<CodeforcesProblem[]> {
  const result = await callApi<{ problems?: CodeforcesProblem[] }>('problemset.problems', {});
  const problems = result.problems ?? [];
  logger.info({ count: problems.length }, 'Codeforces problemset fetched');
  return problems;
}

export async function fetchUserStatus(handle: string, count = 100): Promise<CodeforcesSubmission[]> {
  return callApi<CodeforcesSubmission[]>('user.status', {
    handle,
    from: 1,
    count,
  });
}

export async function fetchContestStatus(
  contestId: number,
  handle?: string,
  count = 100,
): Promise<CodeforcesSubmission[]> {
  return callApi<CodeforcesSubmission[]>('contest.status', {
    contestId,
    handle,
    from: 1,
    count,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
