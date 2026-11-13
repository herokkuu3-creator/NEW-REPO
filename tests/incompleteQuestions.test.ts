import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountRecord } from '../src/database/accounts';
import type { RangeJobInfo, QuestionRange } from '../src/scheduler/rangeSubmission';
import {
  fetchIncompleteQuestions,
  INCOMPLETE_QUESTION_LIST_QUERY,
} from '../src/leetcode/incompleteQuestions';
import {
  buildQuickIncompleteButtons,
  buildIncompletePicker,
  getPendingPromptType,
  handleIncompleteButton,
  handleIncompleteQuestionsCommand,
  lcIncompleteSelections,
  RemovalDeps,
  RangeUiDeps,
} from '../src/notifications/telegramBot';
import { StartRangeResult, StartRangeOptions } from '../src/scheduler/rangeSubmission';

const acc = (id: string, label = id): AccountRecord =>
  ({ id, label, username: label, status: 'ACTIVE' }) as unknown as AccountRecord;

function makeDeps(accounts: AccountRecord[]) {
  const sentViews: Array<{ text: string; buttons?: { text: string; callback_data: string }[][] }> = [];
  const edits: Array<{ chatId: number | string; messageId: number; text: string; buttons?: unknown }> = [];
  const answers: Array<{ id: string; text?: string }> = [];
  const deps: RemovalDeps = {
    listAccounts: async () => accounts,
    deleteAccountById: async () => true,
    deleteAllAccounts: async () => 0,
    clearLegacySession: async () => undefined,
    isRunInProgress: () => false,
    send: async (text, buttons) => void sentViews.push({ text, buttons }),
    edit: async (chatId, messageId, text, buttons) => void edits.push({ chatId, messageId, text, buttons }),
    answer: async (id, text) => void answers.push({ id, text }),
  };
  return { deps, sentViews, edits, answers };
}

function makeUi(startResult: StartRangeResult, current: RangeJobInfo | null = null) {
  const calls: Array<{ range: QuestionRange; target: string | 'all' | readonly string[]; options?: StartRangeOptions }> = [];
  const ui: RangeUiDeps = {
    start: async (range, target, options) => {
      calls.push({ range, target, options });
      return startResult;
    },
    current: vi.fn(() => current),
    cancel: vi.fn(() => true),
    now: () => 1_000_000,
  };
  return { ui, calls };
}

const startedResult = (labels: string[]): StartRangeResult => ({
  started: true,
  accounts: labels.map((l) => acc(l)),
  done: Promise.resolve([]),
});

describe('LeetCode incomplete questions fetching', () => {
  it('retrieves only unsolved and attempted-not-accepted questions, skipping ac and premium', async () => {
    const mockGraphQL = vi.fn(async () => ({
      problemsetQuestionList: {
        total: 6,
        questions: [
          { frontendQuestionId: '1', titleSlug: 'two-sum', title: 'Two Sum', paidOnly: false, status: 'ac' },
          { frontendQuestionId: '2', titleSlug: 'add-two-numbers', title: 'Add Two Numbers', paidOnly: false, status: 'notac' },
          { frontendQuestionId: '3', titleSlug: 'longest-substring', title: 'Longest Substring', paidOnly: true, status: null },
          { frontendQuestionId: '4', titleSlug: 'median-of-arrays', title: 'Median of Arrays', paidOnly: false, status: null },
          { frontendQuestionId: '5', titleSlug: 'longest-palindrome', title: 'Longest Palindrome', paidOnly: false, status: 'solved' },
          { frontendQuestionId: '6', titleSlug: 'zigzag', title: 'Zigzag Conversion', paidOnly: false, status: 'ATTEMPTED' },
        ],
      },
    }));

    const result = await fetchIncompleteQuestions({ graphql: mockGraphQL }, 10);
    expect(result).toHaveLength(3);
    // #2 (attempted not ac), #4 (unsolved null), #6 (attempted)
    expect(result.map((q) => q.number)).toEqual([2, 4, 6]);
    expect(result[0]!.slug).toBe('add-two-numbers');
    expect(result[1]!.slug).toBe('median-of-arrays');
    expect(result[2]!.slug).toBe('zigzag');
  });

  it('paginates until the requested count is satisfied', async () => {
    let call = 0;
    const mockGraphQL = vi.fn(async () => {
      call++;
      if (call === 1) {
        return {
          problemsetQuestionList: {
            total: 100,
            questions: [
              { frontendQuestionId: '1', titleSlug: 'q1', title: 'Q1', paidOnly: false, status: 'ac' },
              { frontendQuestionId: '2', titleSlug: 'q2', title: 'Q2', paidOnly: false, status: null },
            ],
          },
        };
      }
      return {
        problemsetQuestionList: {
          total: 100,
          questions: [
            { frontendQuestionId: '3', titleSlug: 'q3', title: 'Q3', paidOnly: false, status: 'notac' },
            { frontendQuestionId: '4', titleSlug: 'q4', title: 'Q4', paidOnly: false, status: null },
          ],
        },
      };
    });

    const result = await fetchIncompleteQuestions({ graphql: mockGraphQL }, 3, 2);
    expect(result).toHaveLength(3);
    expect(result.map((q) => q.number)).toEqual([2, 3, 4]);
    expect(call).toBe(2);
  });

  it('requests ascending order by FRONTEND_ID and sorts scrambled questions ascending', async () => {
    let capturedVars: any;
    const mockGraphQL = vi.fn(async (_query: string, vars: any) => {
      capturedVars = vars;
      return {
        problemsetQuestionList: {
          total: 10,
          questions: [
            { frontendQuestionId: '42', titleSlug: 'q42', title: 'Q42', paidOnly: false, status: null },
            { frontendQuestionId: '5', titleSlug: 'q5', title: 'Q5', paidOnly: false, status: null },
            { frontendQuestionId: '17', titleSlug: 'q17', title: 'Q17', paidOnly: false, status: null },
          ],
        },
      };
    });

    const result = await fetchIncompleteQuestions({ graphql: mockGraphQL }, 3);
    expect(capturedVars?.filters).toEqual({
      orderBy: 'FRONTEND_ID',
      sortOrder: 'ASCENDING',
    });
    expect(result.map((q) => q.number)).toEqual([5, 17, 42]);
  });

  it('can paginate past 40 pages if needed without arbitrary cap', async () => {
    let call = 0;
    const mockGraphQL = vi.fn(async () => {
      call++;
      if (call === 42) {
        return {
          problemsetQuestionList: {
            total: 5000,
            questions: [
              { frontendQuestionId: '1000', titleSlug: 'q1000', title: 'Q1000', paidOnly: false, status: null },
            ],
          },
        };
      }
      return {
        problemsetQuestionList: {
          total: 5000,
          questions: [
            { frontendQuestionId: String(call), titleSlug: `q${call}`, title: `Q${call}`, paidOnly: false, status: 'ac' },
          ],
        },
      };
    });

    const result = await fetchIncompleteQuestions({ graphql: mockGraphQL }, 1, 1);
    expect(call).toBe(42);
    expect(result).toHaveLength(1);
    expect(result[0]!.number).toBe(1000);
  });

  it('queries all categories by default (empty categorySlug) to include database/mysql, shell, and other non-algorithm questions', async () => {
    const vars: Record<string, unknown>[] = [];
    const mockGraphQL = vi.fn(async (_query: string, variables: Record<string, unknown>) => {
      vars.push(variables);
      return {
        problemsetQuestionList: {
          total: 1,
          questions: [
            { frontendQuestionId: '175', titleSlug: 'combine-two-tables', title: 'Combine Two Tables', paidOnly: false, status: null },
          ],
        },
      };
    });

    const result = await fetchIncompleteQuestions({ graphql: mockGraphQL }, 5);
    expect(vars[0]).toMatchObject({ categorySlug: '' });
    expect(result.map((q) => q.number)).toEqual([175]);
  });
});

describe('Telegram UI for /solveincomplete command', () => {
  beforeEach(() => {
    lcIncompleteSelections.clear();
  });

  it('builds quick selection buttons with standard presets', () => {
    const buttons = buildQuickIncompleteButtons();
    expect(buttons).toHaveLength(3);
    expect(buttons[0]![0]!.text).toBe('5 Questions');
    expect(buttons[0]![1]!.text).toBe('10 Questions');
    expect(buttons[2]![0]!.text).toBe('✖️ Cancel');
    expect(buttons[0]![1]!.callback_data).toBe('lcincomp:cnt:10');
  });

  it('prompts with quick buttons when invoked without arguments', async () => {
    const { deps, sentViews } = makeDeps([acc('a1', 'acc-one')]);
    const { ui } = makeUi(startedResult(['a1']));

    await handleIncompleteQuestionsCommand('', deps, ui, 'chat-1');

    expect(getPendingPromptType()).toBe('incomplete');
    expect(sentViews).toHaveLength(1);
    expect(sentViews[0]!.text).toContain('How many incomplete questions would you like to solve?');
    expect(sentViews[0]!.buttons).toBeDefined();
  });

  it('opens account picker directly when invoked with count', async () => {
    const { deps, sentViews } = makeDeps([acc('a1', 'acc-one'), acc('a2', 'acc-two')]);
    const { ui } = makeUi(startedResult(['a1', 'a2']));

    await handleIncompleteQuestionsCommand('10', deps, ui, 'chat-1');

    expect(sentViews).toHaveLength(1);
    expect(sentViews[0]!.text).toContain('First 10 incomplete questions');
    const flatCallbacks = sentViews[0]!.buttons!.flat().map((b) => b.callback_data);
    expect(flatCallbacks).toContain('lcincomp:a:a1');
    expect(flatCallbacks).toContain('lcincomp:a:a2');
    expect(flatCallbacks).toContain('lcincomp:all');
  });

  it('starts immediately when target argument is provided', async () => {
    const { deps, sentViews } = makeDeps([acc('a1', 'acc-one')]);
    const { ui, calls } = makeUi(startedResult(['a1']));

    await handleIncompleteQuestionsCommand('10 all', deps, ui, 'chat-1');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.range).toEqual({ from: 1, to: 10 });
    expect(calls[0]!.target).toBe('all');
    expect(calls[0]!.options?.jobType).toBe('incomplete');
    expect(calls[0]!.options?.incompleteCount).toBe(10);
    expect(calls[0]!.options?.mode).toBe('parallel');
  });

  it('handles button interactions: select count, toggle account, and run', async () => {
    const accounts = [acc('a1', 'acc-one'), acc('a2', 'acc-two')];
    const { deps, edits, answers } = makeDeps(accounts);
    const { ui, calls } = makeUi(startedResult(['a1']));

    // Step 1: User tapped count 10
    await handleIncompleteButton('chat-1', 100, 'cb-1', 'lcincomp:cnt:10', deps, ui);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.text).toContain('First 10 incomplete questions');

    // Step 2: User tapped account a1
    await handleIncompleteButton('chat-1', 100, 'cb-2', 'lcincomp:a:a1', deps, ui);
    expect(edits).toHaveLength(2);
    expect(edits[1]!.text).toContain('Selected: 1 of 2 accounts');

    // Step 3: User tapped run
    await handleIncompleteButton('chat-1', 100, 'cb-3', 'lcincomp:run', deps, ui);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.target).toEqual(['a1']);
    expect(calls[0]!.options?.jobType).toBe('incomplete');
    expect(calls[0]!.options?.incompleteCount).toBe(10);
    expect(calls[0]!.options?.mode).toBe('sequential');
    expect(edits[2]!.text).toContain('Starting incomplete question solver');
  });

  it('handles cancel button cleanly', async () => {
    const { deps, edits, answers } = makeDeps([acc('a1')]);
    const { ui } = makeUi(startedResult(['a1']));

    await handleIncompleteButton('chat-1', 100, 'cb-cancel', 'lcincomp:x', deps, ui);
    expect(answers[0]!.text).toBe('Cancelled');
    expect(edits[0]!.text).toContain('Incomplete question solver cancelled');
  });

  it('supports 500 or more questions without artificial limit', async () => {
    const { deps, sentViews } = makeDeps([acc('a1', 'acc-one'), acc('a2', 'acc-two')]);
    const { ui } = makeUi(startedResult(['a1']));

    await handleIncompleteQuestionsCommand('500', deps, ui, 'chat-1');

    expect(sentViews).toHaveLength(1);
    expect(sentViews[0]!.text).toContain('First 500 incomplete questions');
    const state = lcIncompleteSelections.get('chat-1');
    expect(state?.count).toBe(500);
  });

  it('runs parallel when user selects parallel with multiple accounts', async () => {
    const accounts = [acc('a1', 'acc-one'), acc('a2', 'acc-two'), acc('a3', 'acc-three')];
    const { deps, edits } = makeDeps(accounts);
    const { ui, calls } = makeUi(startedResult(['a1', 'a2']));

    // Select 500 questions
    await handleIncompleteButton('chat-1', 100, 'cb-cnt', 'lcincomp:cnt:500', deps, ui);
    // Select a1 and a2
    await handleIncompleteButton('chat-1', 100, 'cb-a1', 'lcincomp:a:a1', deps, ui);
    await handleIncompleteButton('chat-1', 100, 'cb-a2', 'lcincomp:a:a2', deps, ui);

    const pickerEdit = edits[edits.length - 1]!;
    const buttonTexts = (pickerEdit.buttons as any).flat().map((b: any) => b.text);
    expect(buttonTexts).toContain('⚡ Solve 500 Parallel (2 accounts)');
    expect(buttonTexts).toContain('🐢 Solve 500 Sequential (2 accounts)');

    // Tap parallel
    await handleIncompleteButton('chat-1', 100, 'cb-par', 'lcincomp:run:parallel', deps, ui);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.range).toEqual({ from: 1, to: 500 });
    expect(calls[0]!.target).toEqual(['a1', 'a2']);
    expect(calls[0]!.options?.mode).toBe('parallel');
    expect(calls[0]!.options?.incompleteCount).toBe(500);
  });
});
