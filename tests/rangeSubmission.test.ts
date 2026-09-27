import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountRecord } from '../src/database/accounts';
import { LeetCodeHttpError } from '../src/leetcode/apiClient';
import { WalkcccError, WalkcccProblem } from '../src/solutions/walkccc';
import {
  countResults,
  estimateAccountMs,
  formatAccountRangeSummary,
  formatDuration,
  parseQuestionRange,
  QuestionResult,
  RangeDeps,
  RangeSession,
  RangeSolutionCache,
  startRangeJob,
  cancelRangeJob,
  __resetRangeJobForTests,
} from '../src/scheduler/rangeSubmission';

/**
 * Question-range engine — fully offline: fake accounts, a fake LeetCode
 * session, fake walkccc, fake sleeps. Verifies the Cloudflare-safe pacing
 * (30 s gap), retry + cool-down on blocks, one-job-at-a-time, cancellation,
 * and the per-account summary format.
 */

const acc = (id: string, label = id): AccountRecord =>
  ({ id, label, username: label, status: 'ACTIVE', storageState: '{}' }) as unknown as AccountRecord;
const sol = (n: number): WalkcccProblem => ({
  // contains the fake starter's method name ("main") so the signature guard passes
  code: 'class Solution { public: int main() { return 0; } };',
  sourceUrl: 'u',
  slug: `slug-${n}`,
  title: `T${n}`,
});

type Verdict = 'accepted' | 'wrong' | 'tle' | 'block403' | 'submitFail' | 'premium';

function makeSession(verdict: (n: number) => Verdict, log: string[]): RangeSession {
  return {
    api: {
      checkSession: async () => ({ authenticated: true, username: 'userX' }),
      question: async (slug: string) => {
        const n = Number(slug.slice(5));
        const premium = verdict(n) === 'premium';
        return {
          questionId: String(n),
          frontendId: String(n),
          title: `T${n}`,
          slug,
          difficulty: 'Easy',
          contentHtml: 'x',
          exampleTestcases: '',
          metaData: null,
          codeSnippets: premium ? [] : [{ lang: 'C++', langSlug: 'cpp', code: 'int main(){}' }],
        };
      },
      submit: async (p) => {
        log.push(`submit:${p.slug}`);
        const n = Number(p.slug.slice(5));
        if (verdict(n) === 'submitFail') throw new Error('submit HTTP 500');
        return `s${n}`;
      },
      awaitResult: async (id: string, slug: string) => {
        const n = Number(slug.slice(5));
        const v = verdict(n);
        if (v === 'block403') throw new LeetCodeHttpError('GraphQL HTTP 403', 403);
        if (v === 'wrong')
          return { submissionId: id, classification: 'WRONG_ANSWER' as const, statusDisplay: 'Wrong Answer', runtime: null, memory: null, rawStatusMsg: 'Wrong Answer' };
        if (v === 'tle')
          return { submissionId: id, classification: 'TIME_LIMIT_EXCEEDED' as const, statusDisplay: 'Time Limit Exceeded', runtime: null, memory: null, rawStatusMsg: 'Time Limit Exceeded' };
        return { submissionId: id, classification: 'ACCEPTED' as const, statusDisplay: 'Accepted', runtime: '0 ms', memory: '8 MB', rawStatusMsg: 'Accepted' };
      },
    },
    close: async () => log.push('closed'),
  };
}

function makeDeps(session: RangeSession, accounts: AccountRecord[], overrides: Partial<RangeDeps> = {}) {
  const sleeps: number[] = [];
  const notes: string[] = [];
  let t = 0;
  const deps: RangeDeps = {
    listAccounts: async () => accounts,
    getAccount: async (id) => accounts.find((a) => a.id === id) ?? null,
    openSession: async () => session,
    getSolution: async (n) => sol(n),
    notify: async (text) => void notes.push(text),
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      if (signal?.aborted) return;
    },
    isDailyRunInProgress: () => false,
    now: () => (t += 1000),
    questionGapMs: 30_000,
    blockedBackoffMs: [10, 20, 40],
    blockedStreakLimit: 3,
    blockedCooldownMs: 600_000,
    dailyRunPollMs: 15_000,
    progressEvery: 0,
    keepAlive: () => () => undefined,
    ...overrides,
  };
  return { deps, sleeps, notes };
}

beforeEach(() => __resetRangeJobForTests());

describe('parseQuestionRange', () => {
  it('accepts 200-400, en-dashes, "to", and a single number', () => {
    expect(parseQuestionRange('200-400')).toEqual({ ok: true, range: { from: 200, to: 400 } });
    expect(parseQuestionRange(' 200 - 400 ')).toEqual({ ok: true, range: { from: 200, to: 400 } });
    expect(parseQuestionRange('200–400')).toEqual({ ok: true, range: { from: 200, to: 400 } });
    expect(parseQuestionRange('200 to 400')).toEqual({ ok: true, range: { from: 200, to: 400 } });
    expect(parseQuestionRange('#200')).toEqual({ ok: true, range: { from: 200, to: 200 } });
  });

  it('rejects junk, reversed, oversized and out-of-range input', () => {
    expect(parseQuestionRange('hello')).toMatchObject({ ok: false });
    expect(parseQuestionRange('400-200')!.error).toMatch(/must not be after/);
    expect(parseQuestionRange('1-1001')!.error).toMatch(/at most 1000/);
    expect(parseQuestionRange('1-99999')!.error).toMatch(/up to 9999/);
    expect(parseQuestionRange('0-5')!.error).toMatch(/start at 1/);
  });
});

describe('range engine', () => {
  it('submits every question with a 30 s pause between (none after the last)', async () => {
    const log: string[] = [];
    const session = makeSession(() => 'accepted', log);
    const { deps, sleeps, notes } = makeDeps(session, [acc('a1')]);
    const r = await startRangeJob({ from: 200, to: 202 }, 'a1', deps);
    expect(r.started).toBe(true);
    const results = await r.done;
    expect(countResults(results[0]!.results)).toEqual({ accepted: 3, failed: 0, error: 0 });
    expect(sleeps).toEqual([30_000, 30_000]);
    expect(results[0]!.notAttempted).toEqual([]);
    expect(results[0]!.fatal).toBeUndefined();
    expect(notes[0]).toMatch(/👤 Account 1\/1: a1/);
    expect(notes[0]).toMatch(/#200–#202 \(3/);
    expect(notes.at(-1)).toMatch(/🎉 Question-range job finished/);
    expect(log).toEqual(['submit:slug-200', 'submit:slug-201', 'submit:slug-202', 'closed']);
  });

  it('runs accounts one by one with a gap between accounts', async () => {
    const session = makeSession(() => 'accepted', []);
    const { deps, sleeps, notes } = makeDeps(session, [acc('a1'), acc('a2')]);
    const r = await startRangeJob({ from: 200, to: 201 }, 'all', deps);
    const results = await r.done;
    expect(results).toHaveLength(2);
    expect(notes.some((n) => n.includes('👤 Account 1/2: a1'))).toBe(true);
    expect(notes.some((n) => n.includes('👤 Account 2/2: a2'))).toBe(true);
    // gap after q200 of a1, the account gap, gap after q200 of a2 — none after the very last question
    expect(sleeps).toEqual([30_000, 30_000, 30_000]);
  });

  it('per-account summary lists Accepted / Failed (with numbers) / Error (with numbers)', async () => {
    const verdict = (n: number): Verdict =>
      n === 200 ? 'accepted' : n === 201 ? 'wrong' : n === 202 ? 'premium' : 'block403';
    const session = makeSession(verdict, []);
    const { deps } = makeDeps(session, [acc('a1')], { blockedStreakLimit: 99 });
    const r = await startRangeJob({ from: 200, to: 203 }, 'a1', deps);
    const results = await r.done;
    const s = formatAccountRangeSummary(results[0]!, 1, 1);
    expect(s).toContain('🏁 Account 1/1: a1');
    expect(s).toContain('🎯 Questions #200–#203');
    expect(s).toContain('✅ Accepted: 1');
    expect(s).toContain('❌ Failed: 1');
    expect(s).toContain('• Wrong Answer: #201');
    expect(s).toContain('⚠️ Error: 2');
    expect(s).toContain('• premium-only question: #202');
    expect(s).toContain('• blocked by LeetCode: #203');
    expect(s).toMatch(/⏱️ Took /);
  });

  it('retries blocked questions with back-off, cools down, then stops the account early', async () => {
    const session = makeSession(() => 'block403', []);
    const { deps, sleeps } = makeDeps(session, [acc('a1')], {
      blockedStreakLimit: 2,
      blockedCooldownMs: 600_000,
    });
    const r = await startRangeJob({ from: 200, to: 205 }, 'a1', deps);
    const results = await r.done;
    expect(results[0]!.stoppedEarly).toBe('blocked');
    expect(results[0]!.results.map((x) => x.number)).toEqual([200, 201, 202, 203]);
    expect(results[0]!.notAttempted).toEqual([204, 205]);
    // 3 back-offs before the first question's final "blocked" result…
    expect(sleeps.slice(0, 3)).toEqual([10, 20, 40]);
    // …and exactly one long cool-down once two in a row were blocked.
    expect(sleeps.filter((ms) => ms === 600_000)).toHaveLength(1);
  });

  it('transient LeetCode errors (500) are plain errors, never blocks', async () => {
    const session = makeSession((n) => (n === 200 ? 'submitFail' : 'accepted'), []);
    const { deps, sleeps } = makeDeps(session, [acc('a1')]);
    const r = await startRangeJob({ from: 200, to: 201 }, 'a1', deps);
    const results = await r.done;
    expect(results[0]!.results[0]).toMatchObject({ number: 200, status: 'error', detail: 'submit HTTP 500' });
    expect(sleeps).toEqual([30_000]); // still paced: the request touched LeetCode
  });

  it('cancelling stops right after the current question', async () => {
    const session = makeSession(() => 'accepted', []);
    const { deps } = makeDeps(session, [acc('a1')], {
      sleep: async (ms, signal) => {
        if (!signal?.aborted) cancelRangeJob();
      },
    });
    const r = await startRangeJob({ from: 200, to: 202 }, 'a1', deps);
    const results = await r.done;
    expect(results[0]!.results.map((x) => x.number)).toEqual([200]);
    expect(results[0]!.stoppedEarly).toBe('cancelled');
    expect(results[0]!.notAttempted).toEqual([201, 202]);
  });

  it('refuses a second job while one runs, with live progress', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const session = makeSession(() => 'accepted', []);
    session.api.awaitResult = async (id: string) => {
      await gate;
      return { submissionId: id, classification: 'ACCEPTED' as const, statusDisplay: 'Accepted', runtime: null, memory: null, rawStatusMsg: 'Accepted' };
    };
    const { deps } = makeDeps(session, [acc('a1'), acc('a2')]);
    const first = await startRangeJob({ from: 200, to: 200 }, 'all', deps);
    expect(first.started).toBe(true);
    const second = await startRangeJob({ from: 200, to: 200 }, 'all', deps);
    expect(second.started).toBe(false);
    if (!second.started && second.reason === 'busy') {
      expect(second.job.currentLabel).toBe('a1');
      expect(second.job.accountLabels).toEqual(['a1', 'a2']);
    } else {
      expect.unreachable('second start must be refused as busy');
    }
    release();
    await first.done;
  });

  it('pauses while the daily run is in progress', async () => {
    let busyChecks = 0;
    const session = makeSession(() => 'accepted', []);
    const { deps, sleeps } = makeDeps(session, [acc('a1')], {
      isDailyRunInProgress: () => busyChecks++ < 2,
      dailyRunPollMs: 1_000,
    });
    const r = await startRangeJob({ from: 200, to: 200 }, 'a1', deps);
    await r.done;
    expect(sleeps).toEqual([1_000]);
  });

  it('reports an unusable session as fatal without submitting anything', async () => {
    const log: string[] = [];
    const session = makeSession(() => 'accepted', log);
    session.api.checkSession = async () => ({ authenticated: false, cause: 'signed-out' });
    const { deps } = makeDeps(session, [acc('a1')]);
    const r = await startRangeJob({ from: 200, to: 201 }, 'a1', deps);
    const results = await r.done;
    expect(results[0]!.fatal).toMatch(/signed out/);
    expect(results[0]!.results).toEqual([]);
    expect(results[0]!.notAttempted).toEqual([200, 201]);
    expect(log).not.toContain('submit:slug-200');
  });
});

describe('RangeSolutionCache (walkccc lookups shared across accounts)', () => {
  it('fetches each question once', async () => {
    const fetcher = vi.fn(async (n: number) => sol(n));
    const c = new RangeSolutionCache(fetcher);
    await c.get(200);
    await c.get(200);
    await c.get(201);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('caches definitive misses (no walkccc page) but not transient failures', async () => {
    const miss = vi.fn(async () => {
      throw new WalkcccError('no walkccc page for problem 999');
    });
    const c1 = new RangeSolutionCache(miss);
    await expect(c1.get(999)).rejects.toBeInstanceOf(WalkcccError);
    await expect(c1.get(999)).rejects.toBeInstanceOf(WalkcccError);
    expect(miss).toHaveBeenCalledTimes(1);

    const netErr = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    const c2 = new RangeSolutionCache(netErr);
    await expect(c2.get(5)).rejects.toThrow('socket hang up');
    await expect(c2.get(5)).rejects.toThrow('socket hang up');
    expect(netErr).toHaveBeenCalledTimes(2);
  });
});

describe('message formats', () => {
  it('formatDuration is human', () => {
    expect(formatDuration(30_000)).toBe('30s');
    expect(formatDuration(90_000)).toBe('1m 30s');
    expect(formatDuration(5_400_000)).toBe('1h 30m');
  });

  it('estimateAccountMs assumes judge time + the 30 s break per question', () => {
    expect(estimateAccountMs({ from: 200, to: 400 }, 30_000)).toBe(201 * 38_000);
  });

  it('the fatal summary explains why nothing ran', () => {
    const r: AccountRangeResult = {
      label: 'a1', username: null,
      range: { from: 200, to: 400 },
      results: [], notAttempted: [200], startedAt: 0, finishedAt: 38_000,
      fatal: 'could not open a session: boom',
    };
    const s = formatAccountRangeSummary(r, 2, 3);
    expect(s).toContain('🏁 Account 2/3: a1');
    expect(s).toContain('🚫 Not processed: could not open a session: boom');
    expect(s).toContain('⏭️ Not attempted: 1');
  });

  it('the cancelled summary lists what was not attempted', () => {
    const q = (n: number, status: QuestionResult['status'], detail?: string): QuestionResult => ({ number: n, status, detail });
    const r: AccountRangeResult = {
      label: 'a1', username: 'u',
      range: { from: 200, to: 205 },
      results: [q(200, 'accepted'), q(201, 'accepted'), q(202, 'failed', 'Wrong Answer'), q(203, 'error', 'no walkccc solution')],
      notAttempted: [204, 205], startedAt: 0, finishedAt: 1, stoppedEarly: 'cancelled',
    };
    const s = formatAccountRangeSummary(r, 1, 1);
    expect(s).toContain('✅ Accepted: 2');
    expect(s).toContain('❌ Failed: 1');
    expect(s).toContain('⚠️ Error: 1');
    expect(s).toContain('🛑 Cancelled — 2 question(s) not attempted');
  });
});
