import { AccountStatus, DailyRun, RunState } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildContestOneLinerSolvePrompt,
  buildJudgeRepairMessage,
  buildSolvePrompt,
} from '../src/ai/prompts';
import { LeetCodeHttpError } from '../src/leetcode/apiClient';
import { ContestQuestionSummary } from '../src/leetcode/contest';
import { RawQuestionData } from '../src/leetcode/dailyChallenge';
import { ParsedProblem } from '../src/leetcode/parser';
import {
  ContestAccountStore,
  ContestDailyRunStore,
  ContestSessionLike,
  ContestSolverDeps,
  ContestSolveProgress,
  solveAndSubmitContestQuestion,
} from '../src/solutionPosts/contestSolver';
import { PostError } from '../src/solutionPosts/service';

function sampleParsedProblem(): ParsedProblem {
  return {
    questionId: '3901',
    frontendId: '3500',
    title: 'Minimum Array Score',
    slug: 'minimum-array-score',
    difficulty: 'Medium',
    descriptionText: 'Given an integer array nums, return the minimum score.',
    examples: [{ input: 'nums = [1,2,3]', output: '6' }],
    constraints: ['1 <= nums.length <= 10^5'],
    starterCode: 'class Solution {\npublic:\n    int minScore(vector<int>& nums) {\n        \n    }\n};',
    starterCodeLanguage: 'cpp',
    tags: ['Array'],
    hints: [],
  };
}

function sampleRawQuestion(): RawQuestionData {
  return {
    questionId: '3901',
    frontendId: '3500',
    title: 'Minimum Array Score',
    slug: 'minimum-array-score',
    difficulty: 'Medium',
    isPaidOnly: false,
    contentHtml: '<p>Given an integer array nums, return the minimum score.</p><p><strong>Constraints:</strong></p><ul><li>1 &lt;= nums.length &lt;= 10^5</li></ul>',
    exampleTestcases: '[1,2,3]',
    metaData: { name: 'minScore' },
    codeSnippets: [
      {
        lang: 'C++',
        langSlug: 'cpp',
        code: 'class Solution {\npublic:\n    int minScore(vector<int>& nums) {\n        \n    }\n};',
      },
    ],
    topicTags: [{ name: 'Array', slug: 'array' }],
  };
}

function sampleContestQuestion(): ContestQuestionSummary {
  return {
    index: 0,
    label: 'Q1',
    title: 'Minimum Array Score',
    titleSlug: 'minimum-array-score',
    questionId: '3901',
    credit: 4,
  };
}

function makeAccount(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'acc-1',
    label: 'main',
    username: 'contest_user',
    status: AccountStatus.ACTIVE,
    storageState: JSON.stringify({
      cookies: [
        { name: 'LEETCODE_SESSION', value: 'sess', domain: '.leetcode.com', path: '/' },
        { name: 'csrftoken', value: 'csrf', domain: '.leetcode.com', path: '/' },
      ],
      origins: [],
    }),
    consecutiveFailures: 0,
    lastError: null,
    lastSuccessAt: null,
    lastCheckedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeRun(overrides: Partial<DailyRun> = {}): DailyRun {
  return {
    id: 'run-1',
    accountId: 'acc-1',
    date: 'contest:weekly-contest-432:minimum-array-score:2026-11-15',
    problemSlug: 'minimum-array-score',
    title: 'Minimum Array Score',
    difficulty: 'Medium',
    language: 'cpp',
    solution: 'class Solution { public: int minScore(vector<int>& n) { return accumulate(n.begin(), n.end(), 0); } };',
    submissionId: '9001',
    submissionStatus: 'Accepted',
    runtime: '4 ms',
    memory: '12 MB',
    state: RunState.SUCCESS,
    error: null,
    attempts: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeStores(initialRuns: DailyRun[] = []) {
  const runs = new Map<string, DailyRun>();
  for (const run of initialRuns) {
    runs.set(`${run.accountId}::${run.date}`, run);
  }

  const dailyRun: ContestDailyRunStore = {
    findUnique: vi.fn(async ({ where }) => {
      return runs.get(`${where.accountId_date.accountId}::${where.accountId_date.date}`) ?? null;
    }),
    upsert: vi.fn(async ({ where, create, update }) => {
      const key = `${where.accountId_date.accountId}::${where.accountId_date.date}`;
      const existing = runs.get(key);
      const saved: DailyRun = existing
        ? { ...existing, ...update, updatedAt: new Date() }
        : {
            id: `run-${runs.size + 1}`,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...create,
          };
      runs.set(key, saved);
      return saved;
    }),
  };

  const accountStore: ContestAccountStore = {
    findUnique: vi.fn(async () => makeAccount() as never),
  };

  return { prisma: { dailyRun, account: accountStore }, runs };
}

describe('contest prompt builders', () => {
  it('builds one-liner and relaxed fallback prompts without breaking buildSolvePrompt', () => {
    const problem = sampleParsedProblem();
    const regular = buildSolvePrompt(problem, 'cpp');
    expect(regular[1]?.content).toContain('Return ONLY the complete solution source code now.');

    const oneLiner = buildContestOneLinerSolvePrompt(problem, 'cpp', true);
    expect(oneLiner[0]?.content).toContain('helper-free 1-liner');
    expect(oneLiner[0]?.content).toContain('Do NOT use preprocessor macros');
    expect(oneLiner[1]?.content).toContain('1-liner contest solution');

    const relaxed = buildContestOneLinerSolvePrompt(problem, 'cpp', false);
    expect(relaxed[0]?.content).toContain('Shortest Clean Fallback');
    expect(relaxed[0]?.content).toContain('shortest, cleanest, beginner-friendly');
    expect(relaxed[1]?.content).toContain('shortest clean contest solution');
  });

  it('builds judge repair message including verdict, testcase, expected/actual output, and errors', () => {
    const msg = buildJudgeRepairMessage('class Solution {};', {
      statusMsg: 'Wrong Answer',
      compileError: 'missing return',
      runtimeError: 'heap-buffer-overflow',
      lastTestcase: '[1,2,3]',
      expectedOutput: '6',
      codeOutput: '0',
    });

    expect(msg.role).toBe('user');
    expect(msg.content).toContain('Wrong Answer');
    expect(msg.content).toContain('missing return');
    expect(msg.content).toContain('heap-buffer-overflow');
    expect(msg.content).toContain('[1,2,3]');
    expect(msg.content).toContain('Expected output:\n6');
    expect(msg.content).toContain('Your code output:\n0');
    expect(msg.content).toContain('class Solution {};');
  });
});

describe('solveAndSubmitContestQuestion', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns existing accepted DailyRun idempotently unless forceFreshSubmit is set', async () => {
    const existing = makeRun();
    const { prisma } = makeStores([existing]);
    const openSession = vi.fn();

    const result = await solveAndSubmitContestQuestion(
      {
        accountId: 'acc-1',
        contestSlug: 'weekly-contest-432',
        contestTitle: 'Weekly Contest 432',
        question: sampleContestQuestion(),
        istDate: '2026-11-15',
      },
      { prisma, openSession }
    );

    expect(result).toBe(existing);
    expect(openSession).not.toHaveBeenCalled();
  });

  it('retries unlock when question is null and throws CONTEST_PROBLEM_LOCKED after exhausting retries', async () => {
    const { prisma } = makeStores();
    const sleep = vi.fn(async () => undefined);
    const persistCookies = vi.fn(async () => false);
    const close = vi.fn(async () => undefined);
    const session: ContestSessionLike = {
      api: {
        submitSolution: vi.fn(),
        awaitSubmission: vi.fn(),
      },
      persistUpdatedCookiesIfChanged: persistCookies,
      close,
    };

    const fetchLocked = vi
      .fn()
      .mockRejectedValueOnce(new LeetCodeHttpError('GraphQL response failed validation: Expected object, received null', 200))
      .mockResolvedValue(null);

    await expect(
      solveAndSubmitContestQuestion(
        {
          accountId: 'acc-1',
          contestSlug: 'weekly-contest-432',
          contestTitle: 'Weekly Contest 432',
          question: sampleContestQuestion(),
          istDate: '2026-11-15',
        },
        {
          prisma,
          openSession: async () => session,
          checkSession: async () => ({ authenticated: true, username: 'contest_user' }),
          fetchQuestionData: fetchLocked,
          sleep,
          maxUnlockRetries: 2,
          unlockRetryWaitMs: 15000,
        }
      )
    ).rejects.toMatchObject({
      code: 'CONTEST_PROBLEM_LOCKED',
    });

    expect(fetchLocked).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(15000);
    expect(close).toHaveBeenCalledTimes(1);
    expect(PostError).toBeDefined();
  });

  it('unlocks on retry, emits progress stages, accepts on first attempt, and upserts DailyRun', async () => {
    const { prisma } = makeStores();
    const sleep = vi.fn(async () => undefined);
    const stages: ContestSolveProgress['stage'][] = [];
    const code =
      'class Solution {\npublic:\n    int minScore(vector<int>& nums) { return accumulate(nums.begin(), nums.end(), 0); }\n};';

    const fetchQuestionData = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(sampleRawQuestion());

    const submitSolution = vi.fn(async () => '777001');
    const awaitSubmission = vi.fn(async () => ({
      submissionId: '777001',
      classification: 'ACCEPTED' as const,
      statusDisplay: 'Accepted',
      runtime: '2 ms',
      memory: '11.4 MB',
      rawStatusMsg: 'Accepted',
    }));

    const session: ContestSessionLike = {
      api: { submitSolution, awaitSubmission },
      persistUpdatedCookiesIfChanged: vi.fn(async () => true),
      close: vi.fn(async () => undefined),
    };

    const generate = vi.fn(async (_messages, validate: (raw: string) => string) => ({
      value: validate(`\`\`\`cpp\n${code}\n\`\`\``),
      model: 'gemini-test',
    }));

    const run = await solveAndSubmitContestQuestion(
      {
        accountId: 'acc-1',
        contestSlug: 'weekly-contest-432',
        contestTitle: 'Weekly Contest 432',
        question: sampleContestQuestion(),
        istDate: '2026-11-15',
        forceFreshSubmit: true,
        onStage: (p) => {
          stages.push(p.stage);
        },
      },
      {
        prisma,
        openSession: async () => session,
        checkSession: async () => ({ authenticated: true, username: 'contest_user' }),
        fetchQuestionData,
        createRouter: async () => ({ generate }),
        sleep,
        language: 'cpp',
        unlockRetryWaitMs: 100,
      }
    );

    expect(stages).toEqual(['resolving_contest', 'solving_code', 'submitting', 'accepted']);
    expect(sleep).toHaveBeenCalledWith(100);
    expect(submitSolution).toHaveBeenCalledWith({
      slug: 'minimum-array-score',
      questionId: '3901',
      lang: 'cpp',
      code,
    });
    expect(run.date).toBe('contest:weekly-contest-432:minimum-array-score:2026-11-15');
    expect(run.state).toBe(RunState.SUCCESS);
    expect(run.submissionStatus).toBe('Accepted');
    expect(run.submissionId).toBe('777001');
    expect(run.attempts).toBe(1);
    expect(run.title).toBe('Minimum Array Score');
    expect(run.difficulty).toBe('Medium');
    expect(run.solution).toBe(code);
  });

  it('repairs code across 3 Judge attempts (preferOneLiner true on 1-2, false fallback on 3)', async () => {
    const { prisma } = makeStores();
    const stages: ContestSolveProgress['stage'][] = [];
    const promptSnapshots: Array<{ sys: string; lastUser: string }> = [];

    const code1 = 'class Solution { public: int minScore(vector<int>& n) { return 0; } };';
    const code2 = 'class Solution { public: int minScore(vector<int>& n) { return bad_fn(n); } };';
    const code3 = 'class Solution { public: int minScore(vector<int>& n) { int s = 0; for (int x : n) s += x; return s; } };';
    const outputs = [code1, code2, code3];
    let genIdx = 0;

    const generate = vi.fn(async (messages, validate: (raw: string) => string) => {
      promptSnapshots.push({
        sys: String(messages[0]?.content ?? ''),
        lastUser: String(messages[messages.length - 1]?.content ?? ''),
      });
      const candidate = outputs[genIdx++]!;
      return { value: validate(candidate), model: 'mock-model' };
    });

    let subIdx = 0;
    const submitSolution = vi.fn(async () => `sub-${++subIdx}`);
    const awaitSubmission = vi.fn(async (subId: string) => {
      if (subId === 'sub-1') {
        return {
          submissionId: subId,
          classification: 'WRONG_ANSWER' as const,
          statusDisplay: 'Wrong Answer',
          runtime: null,
          memory: null,
          rawStatusMsg: 'Wrong Answer',
        };
      }
      if (subId === 'sub-2') {
        return {
          submissionId: subId,
          classification: 'COMPILE_ERROR' as const,
          statusDisplay: 'Compile Error',
          runtime: null,
          memory: null,
          rawStatusMsg: 'Compile Error',
        };
      }
      return {
        submissionId: subId,
        classification: 'ACCEPTED' as const,
        statusDisplay: 'Accepted',
        runtime: '3 ms',
        memory: '10 MB',
        rawStatusMsg: 'Accepted',
      };
    });

    const session: ContestSessionLike = {
      api: { submitSolution, awaitSubmission },
      request: {
        get: vi.fn(async (url: string) => ({
          ok: () => true,
          status: () => 200,
          json: async () =>
            url.includes('sub-1')
              ? {
                  state: 'SUCCESS',
                  status_msg: 'Wrong Answer',
                  last_testcase: '[1,2,3]',
                  expected_output: '6',
                  code_output: '0',
                }
              : {
                  state: 'SUCCESS',
                  status_msg: 'Compile Error',
                  full_compile_error: "use of undeclared identifier 'bad_fn'",
                },
        })),
      },
    };

    const run = await solveAndSubmitContestQuestion(
      {
        accountId: 'acc-1',
        contestSlug: 'weekly-contest-432',
        contestTitle: 'Weekly Contest 432',
        question: sampleContestQuestion(),
        istDate: '2026-11-15',
        onStage: (p) => {
          stages.push(p.stage);
        },
      },
      {
        prisma,
        openSession: async () => session,
        checkSession: async () => ({ authenticated: true, username: 'contest_user' }),
        fetchQuestionData: async () => sampleRawQuestion(),
        createRouter: async () => ({ generate }),
        language: 'cpp',
      }
    );

    expect(run.attempts).toBe(3);
    expect(run.solution).toBe(code3);
    expect(stages).toEqual([
      'resolving_contest',
      'solving_code',
      'submitting',
      'retrying_judge',
      'submitting',
      'retrying_judge',
      'submitting',
      'accepted',
    ]);

    expect(promptSnapshots[0]?.sys).toContain('Contest 1-Liner');
    expect(promptSnapshots[1]?.sys).toContain('Contest 1-Liner');
    expect(promptSnapshots[1]?.lastUser).toContain('Wrong Answer');
    expect(promptSnapshots[1]?.lastUser).toContain('[1,2,3]');
    expect(promptSnapshots[2]?.sys).toContain('Shortest Clean Fallback');
    expect(promptSnapshots[2]?.lastUser).toContain("use of undeclared identifier 'bad_fn'");
  });

  it('throws descriptive error when all 3 Judge attempts fail', async () => {
    const { prisma } = makeStores();
    const generate = vi.fn(async () => ({
      value: 'class Solution { public: int minScore(vector<int>& n) { return -1; } };',
      model: 'mock-model',
    }));

    const session: ContestSessionLike = {
      api: {
        submitSolution: vi.fn(async () => 'sub-fail'),
        awaitSubmission: vi.fn(async () => ({
          submissionId: 'sub-fail',
          classification: 'WRONG_ANSWER' as const,
          statusDisplay: 'Wrong Answer',
          runtime: null,
          memory: null,
          rawStatusMsg: 'Wrong Answer',
        })),
      },
    };

    await expect(
      solveAndSubmitContestQuestion(
        {
          accountId: 'acc-1',
          contestSlug: 'weekly-contest-432',
          contestTitle: 'Weekly Contest 432',
          question: sampleContestQuestion(),
          istDate: '2026-11-15',
        },
        {
          prisma,
          openSession: async () => session,
          checkSession: async () => ({ authenticated: true, username: 'contest_user' }),
          fetchQuestionData: async () => sampleRawQuestion(),
          createRouter: async () => ({ generate }),
          language: 'cpp',
        }
      )
    ).rejects.toThrow(/rejected all 3 contest solve attempts.*minimum-array-score.*Wrong Answer/i);

    expect(prisma.dailyRun.upsert).not.toHaveBeenCalled();
  });

  it('falls back to submitViaGhostBrowser on Cloudflare 403 and falls back to direct LLMProvider when router unavailable', async () => {
    const { prisma } = makeStores();
    const code = 'class Solution:\n    def minScore(self, nums: List[int]) -> int:\n        return sum(nums)';

    const submitViaGhost = vi.fn(async () => ({
      submissionId: 'ghost-888',
      storageState: { cookies: [], origins: [] },
    }));

    const providerGenerate = vi.fn(async () => code);

    const session: ContestSessionLike = {
      api: {
        submitSolution: vi.fn(async () => {
          throw new LeetCodeHttpError('HTTP 403 <!DOCTYPE html>Just a moment', 403);
        }),
        awaitSubmission: vi.fn(async (id: string) => ({
          submissionId: id,
          classification: 'ACCEPTED' as const,
          statusDisplay: 'Accepted',
          runtime: '1 ms',
          memory: '18 MB',
          rawStatusMsg: 'Accepted',
        })),
      },
    };

    const run = await solveAndSubmitContestQuestion(
      {
        accountId: 'acc-1',
        contestSlug: 'biweekly-contest-150',
        contestTitle: 'Biweekly Contest 150',
        question: sampleContestQuestion(),
        istDate: '2026-11-15',
      },
      {
        prisma,
        openSession: async () => session,
        checkSession: async () => ({ authenticated: true, username: 'contest_user' }),
        fetchQuestionData: async () => ({
          ...sampleRawQuestion(),
          codeSnippets: [
            {
              lang: 'Python3',
              langSlug: 'python3',
              code: 'class Solution:\n    def minScore(self, nums: List[int]) -> int:\n        pass',
            },
          ],
        }),
        createRouter: async () => null,
        createProvider: () => ({
          name: 'direct-test',
          model: 'direct-gpt',
          generate: providerGenerate,
        }),
        submitViaGhost,
        language: 'python3',
      }
    );

    expect(submitViaGhost).toHaveBeenCalledTimes(1);
    expect(providerGenerate).toHaveBeenCalledTimes(1);
    expect(run.submissionId).toBe('ghost-888');
    expect(run.language).toBe('python3');
  });

  it('auto-refreshes signed-out LeetCode session before fetching contest problem', async () => {
    const { prisma } = makeStores();
    const refreshAccount = vi.fn(async () => ({ status: 'refreshed' }));
    const checkSession = vi
      .fn()
      .mockResolvedValueOnce({ authenticated: false, cause: 'signed-out' })
      .mockResolvedValueOnce({ authenticated: true, username: 'contest_user' });

    const closeInitial = vi.fn(async () => undefined);
    const openSession = vi
      .fn()
      .mockResolvedValueOnce({
        api: { submitSolution: vi.fn(), awaitSubmission: vi.fn() },
        close: closeInitial,
      })
      .mockResolvedValueOnce({
        api: {
          submitSolution: vi.fn(async () => 'sub-999'),
          awaitSubmission: vi.fn(async () => ({
            submissionId: 'sub-999',
            classification: 'ACCEPTED' as const,
            statusDisplay: 'Accepted',
            runtime: '0 ms',
            memory: '10 MB',
            rawStatusMsg: 'Accepted',
          })),
        },
        close: vi.fn(async () => undefined),
      });

    const run = await solveAndSubmitContestQuestion(
      {
        accountId: 'acc-1',
        contestSlug: 'weekly-contest-432',
        contestTitle: 'Weekly Contest 432',
        question: sampleContestQuestion(),
        istDate: '2026-11-15',
      },
      {
        prisma,
        openSession,
        checkSession,
        refreshAccount,
        fetchQuestionData: async () => sampleRawQuestion(),
        createRouter: async () => ({
          generate: async () => ({
            value: 'class Solution { public: int minScore(vector<int>& n) { return accumulate(n.begin(), n.end(), 0); } };',
            model: 'mock',
          }),
        }),
        language: 'cpp',
      } satisfies ContestSolverDeps
    );

    expect(closeInitial).toHaveBeenCalledTimes(1);
    expect(refreshAccount).toHaveBeenCalledTimes(1);
    expect(openSession).toHaveBeenCalledTimes(2);
    expect(run.submissionId).toBe('sub-999');
  });

  it('retries transient HTTP 429 submit rate-limit without falling back to ghost browser', async () => {
    const { prisma } = makeStores();
    const submitViaGhost = vi.fn(async () => ({
      submissionId: 'ghost-unused',
      storageState: { cookies: [], origins: [] },
    }));
    const submitSolution = vi
      .fn()
      .mockRejectedValueOnce(new LeetCodeHttpError('submit HTTP 429: 429 Too Many Requests', 429, 10))
      .mockResolvedValueOnce('sub-429-ok');
    const session: ContestSessionLike = {
      api: {
        submitSolution,
        awaitSubmission: vi.fn(async (id: string) => ({
          submissionId: id,
          classification: 'ACCEPTED' as const,
          statusDisplay: 'Accepted',
          runtime: '2 ms',
          memory: '18 MB',
          rawStatusMsg: 'Accepted',
        })),
      },
    };

    const run = await solveAndSubmitContestQuestion(
      {
        accountId: 'acc-1',
        contestSlug: 'weekly-contest-433',
        contestTitle: 'Weekly Contest 433',
        question: sampleContestQuestion(),
        istDate: '2026-11-15',
      },
      {
        prisma,
        openSession: async () => session,
        checkSession: async () => ({ authenticated: true, username: 'contest_user' }),
        fetchQuestionData: async () => sampleRawQuestion(),
        createRouter: async () => ({
          generate: async () => ({
            value: 'class Solution { public: int minScore(vector<int>& n) { return accumulate(n.begin(), n.end(), 0); } };',
            model: 'mock',
          }),
        }),
        submitViaGhost,
        language: 'cpp',
      } satisfies ContestSolverDeps
    );

    expect(submitSolution).toHaveBeenCalledTimes(2);
    expect(submitViaGhost).not.toHaveBeenCalled();
    expect(run.submissionId).toBe('sub-429-ok');
  });
});
