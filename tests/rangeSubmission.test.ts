import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountRecord } from '../src/database/accounts';
import { LeetCodeHttpError } from '../src/leetcode/apiClient';
import { WalkcccError, WalkcccPage } from '../src/solutions/walkccc';
import type { CommunitySolution } from '../src/solutions/communitySolutions';
import {
  calculateSafeRangeConcurrency,
  countResults,
  estimateAccountMs,
  formatAccountRangeSummary,
  formatDuration,
  formatRangeJobStatus,
  parseQuestionRange,
  QuestionResult,
  RangeDeps,
  RangeSession,
  RangeSolutionCache,
  startRangeJob,
  rangeQueueLength,
  cancelRangeJob,
  isRangeJobActive,
  submitSingleQuestionDirectly,
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
const sol = (n: number): WalkcccPage => ({
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
          isPaidOnly: premium,
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
    getPage: async (n) => sol(n),
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
    expect(countResults(results[0]!.results)).toEqual({ accepted: 3, failed: 0, error: 0, premium: 0 });
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
    expect(s).toContain('🔒 Premium (locked): 1 — #202');
    expect(s).toContain('⚠️ Error: 1');
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

  it('queues later jobs FIFO and starts each one only after its predecessor completes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const log: string[] = [];
    const session = makeSession(() => 'accepted', log);
    session.api.awaitResult = async (id: string, slug: string) => {
      await gate;
      return { submissionId: id, classification: 'ACCEPTED' as const, statusDisplay: 'Accepted', runtime: null, memory: null, rawStatusMsg: 'Accepted' };
    };
    const { deps } = makeDeps(session, [acc('a1')]);

    const first = await startRangeJob({ from: 200, to: 200 }, 'a1', deps);
    expect(first.started).toBe(true);

    const second = await startRangeJob({ from: 201, to: 201 }, 'a1', deps);
    const third = await startRangeJob({ from: 202, to: 202 }, 'a1', deps);

    expect(second.started).toBe(false);
    expect(third.started).toBe(false);
    if (!second.started && !third.started) {
      expect(second.queued).toBe(true);
      expect(second.position).toBe(1);
      expect(third.queued).toBe(true);
      expect(third.position).toBe(2);
    }
    expect(rangeQueueLength()).toBe(2);
    // The queued runner starts asynchronously; wait for the first submit
    // before asserting that the remaining jobs are still blocked behind it.
    await vi.waitFor(() => {
      expect(log.filter((x) => x.startsWith('submit:'))).toEqual(['submit:slug-200']);
    });

    release();
    await first.done;
    await second.done;
    await third.done;

    expect(rangeQueueLength()).toBe(0);
  });

  it('starts the next queued job after the active job is cancelled', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const session = makeSession(() => 'accepted', []);
    session.api.awaitResult = async (id: string) => {
      await gate;
      return { submissionId: id, classification: 'ACCEPTED' as const, statusDisplay: 'Accepted', runtime: null, memory: null, rawStatusMsg: 'Accepted' };
    };
    const { deps } = makeDeps(session, [acc('a1')]);

    const first = await startRangeJob({ from: 200, to: 200 }, 'a1', deps);
    const second = await startRangeJob({ from: 201, to: 201 }, 'a1', deps);

    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    if (!second.started) expect(second.queued).toBe(true);
    expect(cancelRangeJob()).toBe(true);

    release();
    await first.done;
    const nextResults = await second.done;

    expect(nextResults[0]!.results.map((r) => r.number)).toEqual([201]);
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

  it('premium-locked questions (1500-style) are skipped directly: no submit, Premium not Error', async () => {
    const log: string[] = [];
    // 1500/1501-style: the walkccc page exists but holds a locked notice, no C++.
    const page = (n: number): WalkcccPage => (n <= 1501 ? { ...sol(n), code: null } : sol(n));
    const session = makeSession(() => 'premium', log);
    const { deps } = makeDeps(session, [acc('broZEdex')], { getPage: async (n) => page(n) });
    const r = await startRangeJob({ from: 1500, to: 1502 }, 'broZEdex', deps);
    const results = await r.done;
    expect(countResults(results[0]!.results)).toEqual({ accepted: 0, failed: 0, error: 0, premium: 3 });
    expect(log).toEqual(['closed']); // nothing reached the judge
    const s = formatAccountRangeSummary(results[0]!, 1, 1);
    expect(s).toContain('🔒 Premium (locked): 3 — #1500, #1501, #1502');
    expect(s).toContain('⚠️ Error: 0');
    expect(s).not.toContain('⚠️ Error: 3');
  });

  it('a FREE question with no walkccc C++ solution stays an error (not premium)', async () => {
    const log: string[] = [];
    const session = makeSession(() => 'accepted', log);
    const { deps } = makeDeps(session, [acc('a1')], { getPage: async (n) => ({ ...sol(n), code: null }) });
    const r = await startRangeJob({ from: 200, to: 200 }, 'a1', deps);
    const results = await r.done;
    expect(results[0]!.results[0]).toMatchObject({ status: 'error', detail: 'no walkccc C++ solution for this question' });
    expect(log).toEqual(['closed']);
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

  it('auto-refreshes session via credentials when signed out and continues range job', async () => {
    const log: string[] = [];
    const session1 = makeSession(() => 'accepted', log);
    session1.api.checkSession = async () => ({ authenticated: false, cause: 'signed-out' });
    const session2 = makeSession(() => 'accepted', log);
    session2.api.checkSession = async () => ({ authenticated: true, username: 'userRefreshed' });

    let opened = 0;
    const refreshAccount = vi.fn(async () => ({ status: 'refreshed' as const, site: 'leetcode' as const, label: 'a1' }));
    const { deps } = makeDeps(session1, [acc('a1')], {
      openSession: async () => {
        opened++;
        return opened === 1 ? session1 : session2;
      },
      refreshAccount,
    });

    const r = await startRangeJob({ from: 200, to: 200 }, 'a1', deps);
    const results = await r.done;
    expect(refreshAccount).toHaveBeenCalledTimes(1);
    expect(results[0]!.fatal).toBeUndefined();
    expect(countResults(results[0]!.results)).toEqual({ accepted: 1, failed: 0, error: 0, premium: 0 });
    expect(log).toContain('submit:slug-200');
  });

  it('emits error phase with session detail instead of failed phase when session check fails', async () => {
    const log: string[] = [];
    const session = makeSession(() => 'accepted', log);
    session.api.checkSession = async () => ({ authenticated: false, cause: 'signed-out' });
    const progressEvents: any[] = [];
    const { deps } = makeDeps(session, [acc('a1')], {
      onProgress: (ev) => {
        progressEvents.push(ev);
      },
    });

    const r = await startRangeJob({ from: 200, to: 200 }, 'a1', deps);
    await r.done;
    const errorEv = progressEvents.find((e) => e.phase === 'error');
    expect(errorEv).toBeDefined();
    expect(errorEv.detail).toMatch(/signed out/);
    // Crucial: Must NOT emit phase: 'failed' (which would cause telegramBot to display "Wrong Answer")
    expect(progressEvents.some((e) => e.phase === 'failed')).toBe(false);
  });

  it('submitSingleQuestionDirectly runs independently without setting activeJob or queue', async () => {
    const log: string[] = [];
    const session = makeSession(() => 'accepted', log);
    const { deps } = makeDeps(session, [acc('a1')]);
    const res = await submitSingleQuestionDirectly(acc('a1'), 200, deps);
    expect(res.outcome.status).toBe('accepted');
    expect(res.capture?.code).toContain('main');
    expect(isRangeJobActive()).toBe(false);
    expect(rangeQueueLength()).toBe(0);
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


describe('Community solutions and slug resolution in range submission', () => {
  it('resolves slug via resolveSlug and solves via fetchCommunity when walkccc has no page', async () => {
    const log: string[] = [];
    const submittedCodes: string[] = [];
    const session = makeSession(() => 'accepted', log);
    const origSubmit = session.api.submit;
    session.api.submit = async (p) => {
      submittedCodes.push(p.code);
      return origSubmit(p);
    };

    const commSolution: CommunitySolution = {
      code: 'class Solution { public: int main() { /* comment */ return 42; } };',
      sourceUrl: 'https://leetcode.com/solutions/test',
      title: 'Optimal C++ Solution',
      uuid: 'uuid-3800',
      rankIndex: 3,
    };

    const resolveSlug = vi.fn(async (n: number) => `slug-${n}`);
    const fetchCommunity = vi.fn(async () => commSolution);

    const { deps } = makeDeps(session, [acc('a1')], {
      getPage: async (n) => {
        throw new WalkcccError(`no walkccc page for problem ${n}`);
      },
      resolveSlug,
      fetchCommunity,
    });

    const r = await startRangeJob({ from: 3800, to: 3800 }, 'a1', deps);
    const results = await r.done;

    expect(resolveSlug).toHaveBeenCalledWith(3800);
    expect(fetchCommunity).toHaveBeenCalledWith(
      'slug-3800',
      expect.anything(),
      expect.objectContaining({ language: 'cpp', randomize: true }),
    );
    expect(countResults(results[0]!.results)).toEqual({ accepted: 1, failed: 0, error: 0, premium: 0 });
    expect(results[0]!.results[0]!.number).toBe(3800);
    expect(results[0]!.results[0]!.status).toBe('accepted');
    // Check comment stripping was applied:
    expect(submittedCodes[0]).not.toContain('/* comment */');
  });

  it('diversifies community solution candidates across multiple accounts (excludeUuids)', async () => {
    const session = makeSession(() => 'accepted', []);
    const excludedSeenByAccount: Array<string[]> = [];

    const fetchCommunity = vi.fn(async (slug: string, problem: unknown, options?: { excludeUuids?: Set<string> }) => {
      const excluded = Array.from(options?.excludeUuids ?? []);
      excludedSeenByAccount.push(excluded);
      const uuid = excluded.includes('uuid-cand-1') ? 'uuid-cand-2' : 'uuid-cand-1';
      return {
        code: `class Solution { public: int main() { return ${uuid === 'uuid-cand-1' ? 1 : 2}; } };`,
        sourceUrl: `https://leetcode.com/solutions/${uuid}`,
        title: `Solution ${uuid}`,
        uuid,
      };
    });

    const { deps } = makeDeps(session, [acc('user1'), acc('user2')], {
      getPage: async (n) => {
        throw new WalkcccError(`no walkccc page for problem ${n}`);
      },
      resolveSlug: async (n) => `slug-${n}`,
      fetchCommunity,
    });

    const r = await startRangeJob({ from: 3800, to: 3800 }, 'all', deps);
    const results = await r.done;

    expect(results).toHaveLength(2);
    expect(results[0]!.results[0]!.status).toBe('accepted');
    expect(results[1]!.results[0]!.status).toBe('accepted');

    // First account had empty excludeUuids:
    expect(excludedSeenByAccount[0]).toEqual([]);
    // Second account had first account's chosen UUID in excludeUuids:
    expect(excludedSeenByAccount[1]).toContain('uuid-cand-1');
  });

  it('falls back to walkccc when community solution is rejected with wrong answer', async () => {
    let callCount = 0;
    const session = makeSession(() => 'accepted', []);
    session.api.awaitResult = async (id: string) => {
      callCount++;
      if (callCount === 1) {
        return {
          submissionId: id,
          classification: 'WRONG_ANSWER' as const,
          statusDisplay: 'Wrong Answer',
          runtime: null,
          memory: null,
          rawStatusMsg: 'Wrong Answer',
        };
      }
      return {
        submissionId: id,
        classification: 'ACCEPTED' as const,
        statusDisplay: 'Accepted',
        runtime: '4 ms',
        memory: '10 MB',
        rawStatusMsg: 'Accepted',
      };
    };

    const commSolution: CommunitySolution = {
      code: 'class Solution { public: int main() { return 1; } };',
      sourceUrl: 'https://leetcode.com/solutions/comm',
      title: 'Community Code',
      uuid: 'uuid-wrong',
    };

    const walkcccCode = 'class Solution { public: int main() { return 999; } };';

    const { deps } = makeDeps(session, [acc('a1')], {
      getPage: async (n) => ({
        code: walkcccCode,
        sourceUrl: 'https://walkccc.me',
        slug: `slug-${n}`,
        title: `T${n}`,
      }),
      fetchCommunity: async () => commSolution,
    });

    const r = await startRangeJob({ from: 200, to: 200 }, 'a1', deps);
    const results = await r.done;

    expect(callCount).toBe(2);
    expect(results[0]!.results[0]!.status).toBe('accepted');
  });
});

describe('calculateSafeRangeConcurrency', () => {
  it('returns concurrency 1 for single account or sequential mode', () => {
    const single = calculateSafeRangeConcurrency(1, { mode: 'parallel' });
    expect(single.concurrency).toBe(1);
    expect(single.mode).toBe('parallel');

    const seq = calculateSafeRangeConcurrency(10, { mode: 'sequential' });
    expect(seq.concurrency).toBe(1);
    expect(seq.mode).toBe('sequential');
  });

  it('calculates safe concurrency on 512MB container with 180MB used', () => {
    // 512MB limit, 180MB used => 332MB available => 212MB usable => 4 accounts
    const budget = calculateSafeRangeConcurrency(16, {
      mode: 'parallel',
      overrideTotalMb: 512,
      overrideUsedMb: 180,
    });
    expect(budget.concurrency).toBe(4);
    expect(budget.availableMb).toBe(332);
    expect(budget.mode).toBe('parallel');
  });

  it('caps concurrency at maxCap or maxConcurrency', () => {
    // High memory available:
    const budget = calculateSafeRangeConcurrency(16, {
      mode: 'parallel',
      overrideTotalMb: 4096,
      overrideUsedMb: 200,
      maxConcurrency: 3,
    });
    expect(budget.concurrency).toBe(3);
  });

  it('falls back safely to 1 when available RAM is below the safety buffer', () => {
    // 512MB limit, 450MB used => 62MB available (< 120MB safety buffer)
    const budget = calculateSafeRangeConcurrency(10, {
      mode: 'parallel',
      overrideTotalMb: 512,
      overrideUsedMb: 450,
    });
    expect(budget.concurrency).toBe(1);
  });
});

describe('parallel range submission', () => {
  it('executes multiple accounts concurrently when mode is parallel', async () => {
    const activeConcurrentAccounts: number[] = [];
    let currentConcurrent = 0;

    const session = makeSession(() => 'accepted', []);
    const accounts = [acc('u1'), acc('u2'), acc('u3'), acc('u4')];

    const { deps } = makeDeps(session, accounts, {
      sleep: async () => {
        await new Promise((r) => setTimeout(r, 10));
      },
      getPage: async (n) => {
        currentConcurrent++;
        activeConcurrentAccounts.push(currentConcurrent);
        await new Promise((r) => setTimeout(r, 20));
        currentConcurrent--;
        return sol(n);
      },
    });

    const r = await startRangeJob({ from: 100, to: 100 }, 'all', deps, {
      mode: 'parallel',
      maxConcurrency: 4,
      overrideTotalMb: 1024,
      overrideUsedMb: 100,
    });

    const results = await r.done;
    expect(results).toHaveLength(4);
    for (const res of results) {
      expect(res.results[0]!.status).toBe('accepted');
    }
    const peak = Math.max(...activeConcurrentAccounts);
    expect(peak).toBeGreaterThan(1);
  });

  it('formats range status with parallel badge and active accounts', () => {
    const status = formatRangeJobStatus(
      {
        range: { from: 100, to: 200 },
        accountLabels: ['a1', 'a2', 'a3'],
        accountIndex: 2,
        currentLabel: 'a1, a2',
        currentQuestion: 105,
        doneInAccount: 12,
        counts: { accepted: 10, failed: 1, error: 1, premium: 0 },
        startedAt: 1000,
        cancelling: false,
        pausedReason: null,
        mode: 'parallel',
        concurrency: 3,
        activeAccounts: ['a1', 'a2'],
      },
      5000,
      0,
    );
    expect(status).toContain('⚡ Parallel (3x)');
    expect(status).toContain('Active accounts (2/3): a1, a2');
  });
});
