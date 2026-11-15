import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountRecord } from '../src/database/accounts';

/**
 * Tests for `/contestsolution` 3-step interactive picker, callback routing,
 * live progress card, HELP_TEXT formatting, and 64-byte callback_data limit.
 */

const h = vi.hoisted(() => ({
  sentReplies: [] as string[],
  tgCalls: [] as Array<{ method: string; body: Record<string, unknown> }>,
  accounts: [] as AccountRecord[],
  savedAccountIds: [] as string[],
  weeklyContests: [] as any[],
  biweeklyContests: [] as any[],
  fetchRecentContestsByType: vi.fn(),
  selectStartingContestQuestions: vi.fn(),
  runContestSolutionWorkflow: vi.fn(),
  resetFailedSolutionPostRetries: vi.fn(async () => 0),
  resetSolutionApiKeyPool: vi.fn(async () => null),
}));

vi.mock('../src/config', async (orig) => {
  const real = (await orig()) as { config: Record<string, unknown> };
  return {
    config: {
      ...real.config,
      telegram: {
        ...(real.config.telegram as object),
        chatId: '555',
        enabled: true,
        commands: true,
        botToken: 'TEST_TOKEN',
      },
    },
  };
});

vi.mock('../src/notifications/telegram', () => ({
  sendTelegramMessage: vi.fn(async (text: string) => {
    h.sentReplies.push(text);
    return true;
  }),
}));

vi.mock('../src/database/accounts', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    listEnabledAccounts: vi.fn(async () => h.accounts),
  };
});

vi.mock('../src/solutionPosts/scheduler', () => ({
  runCombined: vi.fn(async () => []),
  runManualQuestion: vi.fn(async () => []),
  selectedAccountIds: vi.fn(async () => h.savedAccountIds),
  setSelectedAccounts: vi.fn(async () => undefined),
}));

vi.mock('../src/solutionPosts/service', () => ({
  resetFailedSolutionPostRetries: h.resetFailedSolutionPostRetries,
}));

vi.mock('../src/solutionPosts/keyPool', () => ({
  resetSolutionApiKeyPool: h.resetSolutionApiKeyPool,
}));

vi.mock('../src/leetcode/contest', () => ({
  fetchRecentContestsByType: h.fetchRecentContestsByType,
  selectStartingContestQuestions: h.selectStartingContestQuestions,
}));

vi.mock('../src/solutionPosts/contestScheduler', () => ({
  runContestSolutionWorkflow: h.runContestSolutionWorkflow,
}));

import {
  HELP_TEXT,
  buildContestAccountPicker,
  buildContestPicker,
  buildContestQuestionPicker,
  contestSolutionSelections,
  contestStageText,
  handleCallbackQuery,
  handleContestSolutionButton,
  handleContestSolutionCommand,
  handleMessage,
  renderContestWorkflowProgress,
  startContestSolutionWorkflow,
  type ContestQuestionWorkflowState,
  type ContestSolutionPickerState,
  type ContestSolutionUiDeps,
  type InlineButton,
} from '../src/notifications/telegramBot';

type ContestKind = 'weekly' | 'biweekly';

interface ContestQuestionSummary {
  index: 0 | 1 | 2 | 3;
  label: 'Q1' | 'Q2' | 'Q3' | 'Q4';
  title: string;
  titleSlug: string;
  questionId: string;
  credit: number;
}

interface ContestSummary {
  title: string;
  titleSlug: string;
  kind: ContestKind;
  startTimeSec: number;
  endTimeSec: number;
  questions: ContestQuestionSummary[];
}

function makeAccount(id: string, label: string, username: string | null = label): AccountRecord {
  return { id, label, username, status: 'ACTIVE' } as unknown as AccountRecord;
}

function makeContest(kind: ContestKind, num: number, startIso: string): ContestSummary {
  const startTimeSec = Math.floor(new Date(startIso).getTime() / 1000);
  const title = kind === 'weekly' ? `Weekly Contest ${num}` : `Biweekly Contest ${num}`;
  const titleSlug = kind === 'weekly' ? `weekly-contest-${num}` : `biweekly-contest-${num}`;
  return {
    title,
    titleSlug,
    kind,
    startTimeSec,
    endTimeSec: startTimeSec + 5400,
    questions: [
      { index: 0, label: 'Q1', title: `Minimum Sum Trick ${num}`, titleSlug: `min-sum-${num}`, questionId: `${num}1`, credit: 4 },
      { index: 1, label: 'Q2', title: `Count Balanced Pairs ${num}`, titleSlug: `count-pairs-${num}`, questionId: `${num}2`, credit: 4 },
      { index: 2, label: 'Q3', title: `Hard Graph Optimization ${num}`, titleSlug: `hard-graph-${num}`, questionId: `${num}3`, credit: 5 },
      { index: 3, label: 'Q4', title: `Segment Tree Extreme ${num}`, titleSlug: `seg-tree-${num}`, questionId: `${num}4`, credit: 6 },
    ],
  };
}

function makeUiDeps(overrides: Partial<ContestSolutionUiDeps> = {}) {
  const sent: Array<{ text: string; buttons?: InlineButton[][] }> = [];
  const edits: Array<{ chatId: number | string; messageId: number; text: string; buttons?: InlineButton[][] }> = [];
  const answers: Array<{ id: string; text?: string }> = [];
  const replies: string[] = [];

  const deps: ContestSolutionUiDeps = {
    listEnabledAccounts: async () => h.accounts,
    selectedAccountIds: async () => h.savedAccountIds,
    fetchRecentContestsByType: h.fetchRecentContestsByType,
    selectStartingContestQuestions: h.selectStartingContestQuestions,
    runContestSolutionWorkflow: h.runContestSolutionWorkflow,
    resetFailedSolutionPostRetries: h.resetFailedSolutionPostRetries,
    resetSolutionApiKeyPool: h.resetSolutionApiKeyPool,
    send: async (text, buttons) => {
      sent.push({ text, buttons });
      return sent.length + 100;
    },
    edit: async (chatId, messageId, text, buttons) => {
      edits.push({ chatId, messageId, text, buttons });
    },
    answer: async (id, text) => {
      answers.push({ id, text });
    },
    reply: async (text) => {
      replies.push(text);
    },
    ...overrides,
  };

  return { deps, sent, edits, answers, replies };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  contestSolutionSelections.clear();
  h.sentReplies.length = 0;
  h.tgCalls.length = 0;
  h.accounts = [
    makeAccount('acc_1', 'alpha', 'alice'),
    makeAccount('acc_2', 'beta', 'bob'),
    makeAccount('acc_3', 'gamma', null),
  ];
  h.savedAccountIds = ['acc_1', 'acc_3'];
  h.weeklyContests = [
    makeContest('weekly', 528, '2026-11-15T08:00:00+05:30'),
    makeContest('weekly', 527, '2026-11-08T08:00:00+05:30'),
    makeContest('weekly', 526, '2026-11-01T08:00:00+05:30'),
    makeContest('weekly', 525, '2026-10-25T08:00:00+05:30'),
    makeContest('weekly', 524, '2026-10-18T08:00:00+05:30'),
  ];
  h.biweeklyContests = [
    makeContest('biweekly', 195, '2026-11-07T20:00:00+05:30'),
    makeContest('biweekly', 194, '2026-10-24T20:00:00+05:30'),
    makeContest('biweekly', 193, '2026-10-10T20:00:00+05:30'),
    makeContest('biweekly', 192, '2026-09-26T20:00:00+05:30'),
    makeContest('biweekly', 191, '2026-09-12T20:00:00+05:30'),
  ];
  h.fetchRecentContestsByType.mockImplementation(async (kind: ContestKind, limit = 5) => {
    const src = kind === 'biweekly' ? h.biweeklyContests : h.weeklyContests;
    return src.slice(0, limit);
  });
  h.selectStartingContestQuestions.mockImplementation(
    (contest: ContestSummary, indices: readonly (0 | 1)[] = [0, 1]) =>
      contest.questions.filter((q) => indices.includes(q.index as 0 | 1)),
  );
  h.runContestSolutionWorkflow.mockResolvedValue([]);
});

describe('HELP_TEXT and command routing for /contestsolution', () => {
  it('includes bare clickable /contestsolution in HELP_TEXT without <code> wrapper', () => {
    expect(HELP_TEXT).toContain('✨ 𝗔𝗜 𝗦𝗢𝗟𝗨𝗧𝗜𝗢𝗡 𝗔𝗥𝗧𝗜𝗖𝗟𝗘𝗦');
    expect(HELP_TEXT).toContain('├ /contestsolution —');
    expect(HELP_TEXT).not.toContain('<code>/contestsolution</code>');
  });

  it('routes /contestsolution and its aliases via handleMessage and supports /contestsolution biweekly', async () => {
    for (const cmd of ['/contestsolution', '/contest_solution', '/contestarticle', '/contestsolutions@my_bot']) {
      contestSolutionSelections.clear();
      const { deps, sent } = makeUiDeps();
      await handleMessage({ message_id: 1, chat: { id: '555' }, text: cmd }, deps);
      expect(h.fetchRecentContestsByType).toHaveBeenCalledWith('weekly', 5);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.text).toContain('Contest Solution Articles (Last 5 Contests)');
      expect(contestSolutionSelections.get('555')?.step).toBe('contest');
      expect(contestSolutionSelections.get('555')?.kind).toBe('weekly');
    }

    contestSolutionSelections.clear();
    const { deps, sent } = makeUiDeps();
    await handleMessage({ message_id: 2, chat: { id: '555' }, text: '/contestsolution biweekly' }, deps);
    expect(h.fetchRecentContestsByType).toHaveBeenCalledWith('biweekly', 5);
    expect(contestSolutionSelections.get('555')?.kind).toBe('biweekly');
    expect(sent[0]!.buttons![0]).toEqual([
      { text: 'Weekly', callback_data: 'ccsol:t:w' },
      { text: '✅ Biweekly', callback_data: 'ccsol:t:b' },
    ]);
  });

  it('routes ccsol:* callbacks through handleCallbackQuery for authorized chat', async () => {
    const { deps, edits, answers } = makeUiDeps();
    await handleMessage({ message_id: 10, chat: { id: '555' }, text: '/contestsolution' }, deps);

    const removalDeps = {
      listAccounts: async () => [],
      deleteAccountById: async () => false,
      deleteAllAccounts: async () => 0,
      clearLegacySession: async () => undefined,
      isRunInProgress: () => false,
      send: async () => undefined,
      edit: async () => undefined,
      answer: async () => undefined,
    };

    await handleCallbackQuery(
      { id: 'cb-route-1', data: 'ccsol:t:b', message: { message_id: 10, chat: { id: '555' } } },
      removalDeps,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      deps,
    );
    expect(answers.at(-1)).toEqual({ id: 'cb-route-1', text: 'Biweekly contests' });
    expect(edits.at(-1)!.buttons![1]![0]!.text).toBe('1. Biweekly Contest 195 (7 Nov)');
  });

  it('warns when no active accounts are available', async () => {
    h.accounts = [];
    const { deps, replies, sent } = makeUiDeps();
    await handleContestSolutionCommand('', deps, '555');
    expect(sent).toHaveLength(0);
    expect(replies[0]).toContain('No active LeetCode accounts');
  });
});

describe('Step 1: Contest Type & Last 5 Contest Selection', () => {
  it('opens with Weekly selected by default, lists 5 contests with IST dates, and supports Biweekly toggle', async () => {
    const { deps, sent, edits, answers } = makeUiDeps();
    await handleContestSolutionCommand('', deps, '555');

    expect(sent).toHaveLength(1);
    const view1 = sent[0]!;
    expect(view1.text).toContain('🏆 <b>Contest Solution Articles (Last 5 Contests)</b>');
    expect(view1.buttons![0]).toEqual([
      { text: '✅ Weekly', callback_data: 'ccsol:t:w' },
      { text: 'Biweekly', callback_data: 'ccsol:t:b' },
    ]);
    expect(view1.buttons!.slice(1, 6)).toEqual([
      [{ text: '1. Weekly Contest 528 (15 Nov)', callback_data: 'ccsol:c:0' }],
      [{ text: '2. Weekly Contest 527 (8 Nov)', callback_data: 'ccsol:c:1' }],
      [{ text: '3. Weekly Contest 526 (1 Nov)', callback_data: 'ccsol:c:2' }],
      [{ text: '4. Weekly Contest 525 (25 Oct)', callback_data: 'ccsol:c:3' }],
      [{ text: '5. Weekly Contest 524 (18 Oct)', callback_data: 'ccsol:c:4' }],
    ]);
    expect(view1.buttons![6]).toEqual([{ text: '✖️ Cancel', callback_data: 'ccsol:x' }]);

    // Toggle to Biweekly
    await handleContestSolutionButton('555', 101, 'cb-bw', 'ccsol:t:b', deps);
    expect(h.fetchRecentContestsByType).toHaveBeenCalledWith('biweekly', 5);
    expect(answers.at(-1)).toEqual({ id: 'cb-bw', text: 'Biweekly contests' });
    const editBw = edits.at(-1)!;
    expect(editBw.buttons![0]).toEqual([
      { text: 'Weekly', callback_data: 'ccsol:t:w' },
      { text: '✅ Biweekly', callback_data: 'ccsol:t:b' },
    ]);
    expect(editBw.buttons![1]![0]!.text).toBe('1. Biweekly Contest 195 (7 Nov)');

    // Switching back to Weekly reuses cached contests without re-fetching
    const callsBefore = h.fetchRecentContestsByType.mock.calls.length;
    await handleContestSolutionButton('555', 101, 'cb-w', 'ccsol:t:w', deps);
    expect(h.fetchRecentContestsByType).toHaveBeenCalledTimes(callsBefore);
    expect(edits.at(-1)!.buttons![1]![0]!.text).toBe('1. Weekly Contest 528 (15 Nov)');
  });

  it('shows Retry button when contest fetch fails and recovers on ccsol:retry', async () => {
    h.fetchRecentContestsByType.mockRejectedValueOnce(new Error('LeetCode GraphQL timeout'));
    const { deps, sent, edits } = makeUiDeps();
    await handleContestSolutionCommand('', deps, '555');

    expect(sent[0]!.text).toContain('Could not load Weekly contests');
    expect(sent[0]!.text).toContain('LeetCode GraphQL timeout');
    expect(sent[0]!.buttons!.flat()).toContainEqual({ text: '🔄 Retry loading contests', callback_data: 'ccsol:retry' });

    await handleContestSolutionButton('555', 101, 'cb-retry', 'ccsol:retry', deps);
    expect(edits.at(-1)!.text).toContain('Showing last <b>5</b> Weekly contests');
    expect(edits.at(-1)!.buttons![1]![0]!.callback_data).toBe('ccsol:c:0');
  });
});

describe('Step 2: Q1 & Q2 Selection', () => {
  it('selects a contest, pre-checks Q1 & Q2 only, allows toggling Q1/Q2, and enforces >= 1 question', async () => {
    const { deps, edits, answers } = makeUiDeps();
    await handleContestSolutionCommand('', deps, '555');

    // Select Weekly Contest 528
    await handleContestSolutionButton('555', 101, 'cb-c0', 'ccsol:c:0', deps);
    expect(h.selectStartingContestQuestions).toHaveBeenCalledWith(h.weeklyContests[0], [0, 1]);
    const step2 = edits.at(-1)!;
    expect(step2.text).toContain('Weekly Contest 528');
    expect(step2.text).toContain('Focusing on Q1 &amp; Q2 (easy/starter 1-liner articles + GIFs; Q3–Q4 disabled for now).');
    expect(step2.buttons).toEqual([
      [{ text: '✅ Q1 · Minimum Sum Trick 528', callback_data: 'ccsol:q:0' }],
      [{ text: '✅ Q2 · Count Balanced Pairs 528', callback_data: 'ccsol:q:1' }],
      [{ text: 'Next: Select Accounts →', callback_data: 'ccsol:next' }],
      [
        { text: '← Contests', callback_data: 'ccsol:back:c' },
        { text: '✖️ Cancel', callback_data: 'ccsol:x' },
      ],
    ]);
    // Q3 & Q4 never appear as toggle buttons
    expect(step2.buttons!.flat().some((b) => b.callback_data.includes('q:2') || b.callback_data.includes('q:3'))).toBe(false);

    // Toggle Q1 off -> Q2-only
    await handleContestSolutionButton('555', 101, 'cb-q0-off', 'ccsol:q:0', deps);
    expect(answers.at(-1)!.text).toBe('Q1 unselected');
    expect(edits.at(-1)!.buttons![0]![0]!.text).toContain('▫️ Q1 ·');
    expect(edits.at(-1)!.buttons![1]![0]!.text).toContain('✅ Q2 ·');

    // Toggle Q2 off -> 0 selected; tapping Next must block
    await handleContestSolutionButton('555', 101, 'cb-q1-off', 'ccsol:q:1', deps);
    const editCountBeforeNext = edits.length;
    await handleContestSolutionButton('555', 101, 'cb-next-empty', 'ccsol:next', deps);
    expect(answers.at(-1)!.text).toBe('Select at least one question (Q1 or Q2)');
    expect(edits).toHaveLength(editCountBeforeNext);

    // Re-select Q2 and advance to Step 3
    await handleContestSolutionButton('555', 101, 'cb-q1-on', 'ccsol:q:1', deps);
    await handleContestSolutionButton('555', 101, 'cb-next', 'ccsol:next', deps);
    expect(contestSolutionSelections.get('555')?.step).toBe('accounts');
    expect(edits.at(-1)!.text).toContain('Q2 (Count Balanced Pairs 528)');
    expect(edits.at(-1)!.text).not.toContain('Q1 (Minimum Sum Trick 528)');
  });

  it('navigates back from Step 2 to Step 1 without losing fetched contests', async () => {
    const { deps, edits } = makeUiDeps();
    await handleContestSolutionCommand('', deps, '555');
    await handleContestSolutionButton('555', 101, 'cb-c0', 'ccsol:c:0', deps);
    await handleContestSolutionButton('555', 101, 'cb-back-c', 'ccsol:back:c', deps);

    expect(contestSolutionSelections.get('555')?.step).toBe('contest');
    expect(edits.at(-1)!.text).toContain('Contest Solution Articles (Last 5 Contests)');
  });
});

describe('Step 3: Account Selection & Launch', () => {
  it('pre-seeds accounts from saved preferences, toggles accounts/All, goes back, and launches workflow', async () => {
    h.savedAccountIds = ['acc_2', 'disabled_old_id'];
    const { deps, edits, answers, sent, replies } = makeUiDeps();
    await handleContestSolutionCommand('', deps, '555');
    await handleContestSolutionButton('555', 101, 'cb-c0', 'ccsol:c:0', deps);
    await handleContestSolutionButton('555', 101, 'cb-next', 'ccsol:next', deps);

    const step3 = edits.at(-1)!;
    expect(step3.text).toContain('Weekly Contest 528');
    expect(step3.text).toContain('Selected accounts: <b>1/3</b>');
    expect(step3.buttons).toEqual([
      [{ text: '▫️ alpha (alice)', callback_data: 'ccsol:a:acc_1' }],
      [{ text: '✅ beta (bob)', callback_data: 'ccsol:a:acc_2' }],
      [{ text: '▫️ gamma', callback_data: 'ccsol:a:acc_3' }],
      [{ text: '👥 All accounts (3)', callback_data: 'ccsol:all' }],
      [{ text: '🚀 Run Contest Article Workflow', callback_data: 'ccsol:run' }],
      [
        { text: '← Questions', callback_data: 'ccsol:back:q' },
        { text: '✖️ Cancel', callback_data: 'ccsol:x' },
      ],
    ]);

    // Back to Questions preserves account selection
    await handleContestSolutionButton('555', 101, 'cb-bq', 'ccsol:back:q', deps);
    expect(contestSolutionSelections.get('555')?.step).toBe('questions');
    await handleContestSolutionButton('555', 101, 'cb-next2', 'ccsol:next', deps);
    expect(edits.at(-1)!.text).toContain('Selected accounts: <b>1/3</b>');

    // Select All, then Clear All, then select acc_1 & acc_3
    await handleContestSolutionButton('555', 101, 'cb-all1', 'ccsol:all', deps);
    expect(edits.at(-1)!.text).toContain('Selected accounts: <b>3/3</b>');
    await handleContestSolutionButton('555', 101, 'cb-all2', 'ccsol:all', deps);
    expect(edits.at(-1)!.text).toContain('Selected accounts: <b>0/3</b>');

    // Run with 0 selected blocks cleanly
    await handleContestSolutionButton('555', 101, 'cb-run0', 'ccsol:run', deps);
    expect(answers.at(-1)!.text).toBe('Select at least one account');
    expect(h.runContestSolutionWorkflow).not.toHaveBeenCalled();

    // Select acc_1 and launch
    await handleContestSolutionButton('555', 101, 'cb-a1', 'ccsol:a:acc_1', deps);
    await handleContestSolutionButton('555', 101, 'cb-run', 'ccsol:run', deps);

    expect(contestSolutionSelections.has('555')).toBe(false);
    expect(h.resetFailedSolutionPostRetries).toHaveBeenCalledTimes(1);
    expect(h.resetSolutionApiKeyPool).toHaveBeenCalledTimes(1);
    expect(h.runContestSolutionWorkflow).toHaveBeenCalledTimes(1);
    expect(h.runContestSolutionWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        contest: h.weeklyContests[0],
        questionIndices: [0, 1],
        accountIds: ['acc_1'],
        force: true,
        onProgress: expect.any(Function),
      }),
    );

    // Wait a tick for the background done promise to finish
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.some((m) => m.text.includes('CONTEST SOLUTION ARTICLES'))).toBe(true);
    expect(replies.some((r) => r.startsWith('🏁 Contest Workflow finished:'))).toBe(true);
  });
});

describe('Live Progress Card & Stage Rendering', () => {
  it('renders live HTML progress stages, clickable publishedUrl, and final summary', async () => {
    h.runContestSolutionWorkflow.mockImplementation(async ({ onProgress }) => {
      await onProgress?.({
        accountId: 'acc_1',
        questionIndex: 0,
        questionLabel: 'Q1',
        questionTitle: 'Minimum Sum Trick 528',
        stage: 'solving_code',
      });
      await onProgress?.({
        accountId: 'acc_1',
        questionIndex: 0,
        questionLabel: 'Q1',
        questionTitle: 'Minimum Sum Trick 528',
        stage: 'accepted',
      });
      await onProgress?.({
        accountId: 'acc_1',
        questionIndex: 0,
        questionLabel: 'Q1',
        questionTitle: 'Minimum Sum Trick 528',
        stage: 'generating_article',
      });
      await onProgress?.({
        accountId: 'acc_1',
        questionIndex: 0,
        questionLabel: 'Q1',
        questionTitle: 'Minimum Sum Trick 528',
        stage: 'published',
        publishedUrl: 'https://leetcode.com/problems/min-sum-528/solutions/999/',
      });
      await onProgress?.({
        accountId: 'acc_1',
        questionIndex: 1,
        questionLabel: 'Q2',
        questionTitle: 'Count Balanced Pairs 528',
        stage: 'failed',
        error: 'CONTEST_PROBLEM_LOCKED',
      });
      return [
        {
          accountId: 'acc_1',
          contestSlug: 'weekly-contest-528',
          questionLabel: 'Q1',
          questionSlug: 'min-sum-528',
          postId: 'p1',
          status: 'PUBLISHED',
          publishedUrl: 'https://leetcode.com/problems/min-sum-528/solutions/999/',
        },
        {
          accountId: 'acc_1',
          contestSlug: 'weekly-contest-528',
          questionLabel: 'Q2',
          questionSlug: 'count-pairs-528',
          status: 'FAILED',
          error: 'CONTEST_PROBLEM_LOCKED',
        },
      ];
    });

    const { deps, sent, edits, replies } = makeUiDeps();
    const run = await startContestSolutionWorkflow(h.weeklyContests[0], [0, 1], ['acc_1'], deps);
    const results = await run!.done;

    expect(results).toHaveLength(2);
    expect(h.resetFailedSolutionPostRetries).toHaveBeenCalledTimes(1);
    expect(h.resetSolutionApiKeyPool).toHaveBeenCalledTimes(1);
    expect(sent[0]!.text).toContain('CONTEST SOLUTION ARTICLES · Weekly Contest 528');

    const lastEditText = edits.at(-1)!.text;
    expect(lastEditText).toContain('Published ✅');
    expect(lastEditText).toContain('<a href="https://leetcode.com/problems/min-sum-528/solutions/999/">View Article</a>');
    expect(lastEditText).toContain('Contest problem not unlocked yet by LeetCode');
    expect(replies.at(-1)).toBe(
      '🏁 Contest Workflow finished: Weekly Contest 528 — 1 published · 1 failed · 0 skipped.',
    );
  });

  it('formats key contest stages clearly', () => {
    expect(contestStageText('solving_code')).toContain('Solving fresh 1-liner');
    expect(contestStageText('accepted')).toContain('Submitted & Accepted');
    expect(contestStageText('generating_article')).toContain('Generating human 1-liner article + GIFs');
    expect(contestStageText('published', undefined, undefined, 'https://example.com/p')).toContain(
      'Published ✅ · <a href="https://example.com/p">View Article</a>',
    );
  });

  it('truncates oversized progress cards cleanly without breaking HTML tags', () => {
    const manyAccounts = Array.from({ length: 30 }, (_, i) => makeAccount(`a_${i}`, `user_${i}_${'x'.repeat(20)}`));
    const states = new Map<string, ContestQuestionWorkflowState>();
    for (const a of manyAccounts) {
      states.set(`${a.id}:0`, {
        questionIndex: 0,
        questionLabel: 'Q1',
        questionTitle: 'Long Question Title',
        stage: 'published',
        publishedUrl: `https://leetcode.com/problems/test/solutions/${a.id}/`,
      });
    }
    const html = renderContestWorkflowProgress(h.weeklyContests[0], manyAccounts, [0, 1], states);
    expect(html.length).toBeLessThanOrEqual(3920);
  });
});

describe('Cancel, Expired Session, Message-Not-Modified, and 64-byte Limits', () => {
  it('handles ccsol:x cancellation and /cancel text command cleanly', async () => {
    const { deps, edits, answers } = makeUiDeps();
    await handleContestSolutionCommand('', deps, '555');
    expect(contestSolutionSelections.has('555')).toBe(true);

    await handleContestSolutionButton('555', 101, 'cb-x', 'ccsol:x', deps);
    expect(contestSolutionSelections.has('555')).toBe(false);
    expect(answers.at(-1)).toEqual({ id: 'cb-x', text: 'Cancelled' });
    expect(edits.at(-1)!.text).toContain('cancelled');

    // Also verify /cancel clears open contest picker state
    await handleContestSolutionCommand('', deps, '555');
    expect(contestSolutionSelections.has('555')).toBe(true);
    await handleMessage({ message_id: 20, chat: { id: '555' }, text: '/cancel' }, deps);
    expect(contestSolutionSelections.has('555')).toBe(false);
    expect(h.sentReplies.at(-1)).toContain('Contest solution selection cancelled');
  });

  it('answers gracefully when picker session is missing or expired', async () => {
    const { deps, answers, edits } = makeUiDeps();
    contestSolutionSelections.clear();
    await handleContestSolutionButton('555', 101, 'cb-exp', 'ccsol:c:0', deps);
    expect(answers.at(-1)).toEqual({
      id: 'cb-exp',
      text: 'Session expired — run /contestsolution again',
    });
    expect(edits.at(-1)!.text).toContain('Session expired');
  });

  it('swallows Telegram "message is not modified" errors on editMessageText', async () => {
    const { deps, answers } = makeUiDeps({
      edit: async () => {
        throw new Error('telegram editMessageText failed: HTTP 400 Bad Request: message is not modified');
      },
    });
    await handleContestSolutionCommand('', deps, '555');
    await expect(
      handleContestSolutionButton('555', 101, 'cb-same', 'ccsol:t:w', deps),
    ).resolves.toBeUndefined();
    expect(answers.at(-1)).toEqual({ id: 'cb-same', text: 'Weekly contests' });
  });

  it('ignores ccsol:* callback queries from unknown chats via handleCallbackQuery', async () => {
    const { deps, answers } = makeUiDeps();
    const removalDeps = {
      listAccounts: async () => [],
      deleteAccountById: async () => false,
      deleteAllAccounts: async () => 0,
      clearLegacySession: async () => undefined,
      isRunInProgress: () => false,
      send: async () => undefined,
      edit: async () => undefined,
      answer: async (id: string, text?: string) => void answers.push({ id, text }),
    };

    await handleCallbackQuery(
      { id: 'cb-unauth', data: 'ccsol:t:b', message: { message_id: 1, chat: { id: '999999' } } },
      removalDeps,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      deps,
    );
    expect(answers.at(-1)).toEqual({ id: 'cb-unauth', text: undefined });
    expect(h.fetchRecentContestsByType).not.toHaveBeenCalled();
  });

  it('keeps every callback_data <= 64 UTF-8 bytes across all 3 steps even for long IDs & titles', async () => {
    const longContest: ContestSummary = {
      title: 'Weekly Contest 999 With A Very Long Contest Title Beyond Normal Width',
      titleSlug: 'weekly-contest-999-very-long',
      kind: 'weekly',
      startTimeSec: 1794709800,
      endTimeSec: 1794715200,
      questions: [
        { index: 0, label: 'Q1', title: 'A'.repeat(120), titleSlug: 'q1-long', questionId: '1', credit: 4 },
        { index: 1, label: 'Q2', title: 'B'.repeat(120), titleSlug: 'q2-long', questionId: '2', credit: 5 },
      ],
    };
    const state: ContestSolutionPickerState = {
      step: 'contest',
      kind: 'weekly',
      contestsByKind: { weekly: [longContest, longContest, longContest, longContest, longContest] },
      selectedContestIndex: 0,
      selectedQuestions: new Set([0, 1]),
      selectedAccountIds: new Set(['cmg3x9k2v0000qz8l5y7abcde']),
    };

    const step1 = buildContestPicker(state);
    const step2 = buildContestQuestionPicker(longContest, state.selectedQuestions);
    const accounts = [
      makeAccount('cmg3x9k2v0000qz8l5y7abcde', 'cuid_account'),
      makeAccount('very-long-id-' + 'z'.repeat(80), 'pathologically_long_id_account'),
    ];
    const step3 = buildContestAccountPicker(longContest, state.selectedQuestions, accounts, state.selectedAccountIds);

    for (const view of [step1, step2, step3]) {
      for (const row of view.buttons) {
        for (const btn of row) {
          expect(Buffer.byteLength(btn.callback_data, 'utf8')).toBeLessThanOrEqual(64);
        }
      }
    }

    // Verify fallback ai:<index> button still toggles the oversized account ID properly
    const { deps, edits } = makeUiDeps({
      listEnabledAccounts: async () => accounts,
      fetchRecentContestsByType: async () => [longContest],
    });
    await handleContestSolutionCommand('', deps, '555');
    await handleContestSolutionButton('555', 101, 'c0', 'ccsol:c:0', deps);
    await handleContestSolutionButton('555', 101, 'next', 'ccsol:next', deps);
    const fallbackBtn = edits.at(-1)!.buttons![1]![0]!;
    expect(fallbackBtn.callback_data).toBe('ccsol:ai:1');
    await handleContestSolutionButton('555', 101, 'tog-ai', 'ccsol:ai:1', deps);
    expect(contestSolutionSelections.get('555')?.selectedAccountIds.has(accounts[1]!.id)).toBe(true);
  });
});
