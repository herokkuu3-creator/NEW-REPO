import { randomUUID } from 'node:crypto';

/** One browser job at a time. The payload exists only in this process and is
 * released as soon as the runner claims it. No cookies or source enter Actions
 * inputs, logs, artifacts, or the repository. */
interface Job {
  id: string;
  payload: unknown;
  createdAt: number;
  claimed: boolean;
  result: unknown | null;
}

const JOB_LIFETIME_MS = 15 * 60_000;

export class ActionBroker {
  private job: Job | null = null;

  constructor(
    private readonly dispatch: (id: string) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  get busy(): boolean {
    this.expire();
    return this.job !== null && this.job.result === null;
  }

  async enqueue(payload: unknown, requestedId?: string): Promise<string> {
    if (requestedId && this.job?.id === requestedId) return requestedId;
    if (this.busy) throw new Error('a Codeforces submission is already running');
    const id = requestedId && /^[a-f0-9-]{36}$/.test(requestedId) ? requestedId : randomUUID();
    this.job = { id, payload, createdAt: this.now(), claimed: false, result: null };
    try {
      await this.dispatch(id);
    } catch (err) {
      this.job = null;
      throw err;
    }
    return id;
  }

  /** The browser can claim the source and session only once. */
  claim(id: string): unknown | null {
    this.expire();
    if (!this.job || this.job.id !== id || this.job.claimed) return null;
    this.job.claimed = true;
    const payload = this.job.payload;
    this.job.payload = null;
    return payload;
  }

  finish(id: string, result: unknown): boolean {
    this.expire();
    if (!this.job || this.job.id !== id || !this.job.claimed) return false;
    if (this.job.result !== null) return JSON.stringify(this.job.result) === JSON.stringify(result);
    this.job.result = result;
    return true;
  }

  status(id: string): { pending: true } | { pending: false; result: unknown } | null {
    this.expire();
    if (!this.job || this.job.id !== id) return null;
    return this.job.result === null ? { pending: true } : { pending: false, result: this.job.result };
  }

  private expire(): void {
    if (this.job && this.now() - this.job.createdAt >= JOB_LIFETIME_MS) this.job = null;
  }
}

export async function dispatchAction(repository: string, token: string, id: string): Promise<void> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('CODEFORCES_RUNNER_REPOSITORY must be owner/repo');
  if (!token) throw new Error('GITHUB_DISPATCH_TOKEN is missing');
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/codeforces-submit.yml/dispatches`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'codeforces-submit-browser',
    },
    body: JSON.stringify({ ref: 'main', inputs: { job_id: id } }),
    signal: AbortSignal.timeout(30_000),
  });
  // GitHub returned 204 historically and now documents 200 with a run URL.
  if (response.status !== 200 && response.status !== 204) {
    throw new Error(`GitHub Actions dispatch failed with HTTP ${response.status}`);
  }
}
