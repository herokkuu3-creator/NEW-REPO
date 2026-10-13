import { describe, expect, it, vi } from 'vitest';
import type { AccountRecord } from '../src/database/accounts';
import type { QuestionRange } from '../src/scheduler/rangeSubmission';
import {
  handleQuestionRangeCommand,
  handleQuestionRangeTrigger,
  renderRangeProgressSections,
  RangeAccountSectionState,
  RangeTriggerDeps,
  RangeUiDeps,
} from '../src/notifications/telegramBot';

describe('renderRangeProgressSections', () => {
  it('renders progress tree with connectors and statuses', () => {
    const sections = new Map<number, RangeAccountSectionState>();
    sections.set(0, {
      accIndex: 0,
      label: 'user_a',
      username: 'alice',
      completedItems: [
        '✅ [1/2] <code>#3800 Minimum Cost</code> — <b>Accepted</b> · #1001',
      ],
      activeLine: '⏳ [2/2] <code>#3801 Subarray Beauty</code> — Processing…',
    });
    sections.set(1, {
      accIndex: 1,
      label: 'user_b',
      username: 'bob',
      completedItems: [],
      activeLine: '⏳ Queued…',
    });

    const rendered = renderRangeProgressSections(sections, 2);
    expect(rendered).toHaveLength(2);

    expect(rendered[0]).toContain('👤 <b>Account 1/2 · <code>alice</code></b>');
    expect(rendered[0]).toContain('├ ✅ [1/2] <code>#3800 Minimum Cost</code> — <b>Accepted</b> · #1001');
    expect(rendered[0]).toContain('└ ⏳ [2/2] <code>#3801 Subarray Beauty</code> — Processing…');

    expect(rendered[1]).toContain('👤 <b>Account 2/2 · <code>bob</code></b>');
    expect(rendered[1]).toContain('└ ⏳ Queued…');
  });

  it('prunes completed items if total length is very large', () => {
    const sections = new Map<number, RangeAccountSectionState>();
    const completedItems = Array.from({ length: 30 }, (_, i) =>
      `✅ [${i + 1}/30] <code>#${3000 + i} Very Long Problem Name Designed To Test Large Content Limits</code> — <b>Accepted</b> · #${10000 + i}`,
    );
    sections.set(0, {
      accIndex: 0,
      label: 'account1',
      username: 'acc1',
      completedItems,
      activeLine: '⏳ Waiting 30s (human pacing)…',
    });

    const rendered = renderRangeProgressSections(sections, 1);
    expect(rendered[0]).toContain('earlier completed question(s)');
  });
});

describe('handleQuestionRangeTrigger', () => {
  const fakeAccounts: AccountRecord[] = [
    {
      id: 'acc-1',
      label: 'acc-one',
      username: 'user_one',
      status: 'ACTIVE',
      storageState: '{}',
      createdAt: new Date(),
      updatedAt: new Date(),
      lastRunAt: null,
      lastError: null,
    } as unknown as AccountRecord,
  ];

  it('initializes progress view, receives progress events and finishes with summary', async () => {
    const edits: string[] = [];
    const sends: string[] = [];
    let progressCallback: ((event: any) => Promise<void> | void) | undefined;

    const mockTriggerDeps: RangeTriggerDeps = {
      listAccounts: async () => fakeAccounts,
      getAccount: async () => fakeAccounts[0]!,
      send: async (text) => {
        sends.push(text);
      },
      edit: async (_chatId, _msgId, text) => {
        edits.push(text);
      },
      startJob: async (range, _target, deps) => {
        progressCallback = deps.onProgress;
        return {
          started: true,
          accounts: fakeAccounts,
          done: (async () => {
            // Simulate progression
            await progressCallback?.({
              phase: 'processing',
              label: 'acc-one',
              username: 'user_one',
              accIndex: 0,
              accTotal: 1,
              stepIndex: 1,
              stepTotal: 2,
              questionNumber: 3800,
              questionTitle: 'Two Sum',
            });

            await progressCallback?.({
              phase: 'submitting',
              label: 'acc-one',
              username: 'user_one',
              accIndex: 0,
              accTotal: 1,
              stepIndex: 1,
              stepTotal: 2,
              questionNumber: 3800,
              questionTitle: 'Two Sum',
            });

            await progressCallback?.({
              phase: 'accepted',
              label: 'acc-one',
              username: 'user_one',
              accIndex: 0,
              accTotal: 1,
              stepIndex: 1,
              stepTotal: 2,
              questionNumber: 3800,
              questionTitle: 'Two Sum',
              submissionId: '998877',
            });

            return [
              {
                label: 'acc-one',
                username: 'user_one',
                range,
                results: [
                  {
                    number: 3800,
                    status: 'accepted',
                    submissionId: '998877',
                  },
                ],
                notAttempted: [],
                startedAt: 1,
                finishedAt: 2,
              },
            ];
          })(),
        };
      },
    };

    const range: QuestionRange = { from: 3800, to: 3801 };
    const res = await handleQuestionRangeTrigger(range, 'all', mockTriggerDeps, '555');

    expect(res.started).toBe(true);
    expect(sends[0]).toContain('LEETCODE QUESTION RANGE (#3800–#3801)');

    if (res.started) {
      const results = await res.done;
      expect(results).toHaveLength(1);
      // Last edit should show Finished summary
      const lastEdit = edits.at(-1);
      expect(lastEdit).toContain('Finished:</b> 1 accepted');
      expect(lastEdit).toContain('✅ [1/2] <code>#3800 Two Sum</code> — <b>Accepted</b> · #998877');
    }
  });
});

describe('handleQuestionRangeCommand direct target', () => {
  it('starts immediately when range and target are provided (e.g. 3800-3801 all)', async () => {
    const startedCalls: Array<{ range: QuestionRange; target: string }> = [];
    const mockUi: RangeUiDeps = {
      start: async (range, target) => {
        startedCalls.push({ range, target });
        return {
          started: true,
          accounts: [],
          done: Promise.resolve([]),
        };
      },
      current: () => null,
      cancel: () => true,
      now: () => Date.now(),
    };

    const mockDeps = {
      listAccounts: async () => [{ id: '1', label: 'acc1', username: 'acc1' } as any],
      deleteAccountById: async () => true,
      deleteAllAccounts: async () => 0,
      clearLegacySession: async () => undefined,
      isRunInProgress: () => false,
      send: async () => undefined,
      edit: async () => undefined,
      answer: async () => undefined,
    };

    await handleQuestionRangeCommand('3800-3801 all', mockDeps, mockUi);

    expect(startedCalls).toHaveLength(1);
    expect(startedCalls[0]).toEqual({
      range: { from: 3800, to: 3801 },
      target: 'all',
    });
  });
});
