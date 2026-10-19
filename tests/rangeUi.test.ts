import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountRecord } from '../src/database/accounts';
import type { RangeJobInfo, QuestionRange } from '../src/scheduler/rangeSubmission';

/** Telegram wiring of /questionrangesubmission — the engine is faked via RangeUiDeps. */

const sent = vi.hoisted(() => [] as string[]);
vi.mock('../src/config', async (orig) => {
  const real = (await orig()) as { config: Record<string, unknown> };
  return { config: { ...real.config, telegram: { ...(real.config.telegram as object), chatId: '555', enabled: true, commands: true, botToken: 'T' } } };
});
vi.mock('../src/notifications/telegram', () => ({
  sendTelegramMessage: vi.fn(async (t: string) => {
    sent.push(t);
    return true;
  }),
}));

import {
  buildQuickRangeButtons,
  buildRangePicker,
  getPendingPromptType,
  handleCallbackQuery,
  handleCancelRange,
  handleQuestionRangeCommand,
  handleRangeStatus,
  RemovalDeps,
  RangeUiDeps,
} from '../src/notifications/telegramBot';
import { StartRangeResult } from '../src/scheduler/rangeSubmission';

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

function makeUi(startResult: StartRangeResult, current: RangeJobInfo | null = null, cancelOk = true) {
  const calls: Array<{ range: QuestionRange; target: string | 'all' }> = [];
  const ui: RangeUiDeps = {
    start: async (range, target) => {
      calls.push({ range, target });
      return startResult;
    },
    current: vi.fn(() => current),
    cancel: vi.fn(() => cancelOk),
    now: () => 1_000_000,
  };
  return { ui, calls };
}

const started = (labels: string[]): StartRangeResult => ({
  started: true,
  accounts: labels.map((l) => acc(l)),
  done: Promise.resolve([]),
});

const job = (over: Partial<RangeJobInfo> = {}): RangeJobInfo => ({
  range: { from: 200, to: 400 },
  accountLabels: ['a1', 'a2'],
  accountIndex: 1,
  currentLabel: 'a1',
  currentQuestion: 205,
  doneInAccount: 5,
  counts: { accepted: 3, failed: 1, error: 1, premium: 0 },
  startedAt: 900_000,
  cancelling: false,
  pausedReason: null,
  ...over,
});

beforeEach(() => {
  sent.length = 0;
});

describe('/questionrangesubmission', () => {
  it('with a range sends the account picker: one button per account, then All, then Cancel', async () => {
    const { deps, sentViews } = makeDeps([acc('a1'), acc('a2', 'dom4429')]);
    const { ui } = makeUi(started(['a1']));
    await handleQuestionRangeCommand('200-400', deps, ui);
    expect(sentViews[0]!.text).toContain('🎯 Question range #200–#400 (201');
    expect(sentViews[0]!.text).toContain('30 s break');
    expect(sentViews[0]!.buttons).toEqual([
      [{ text: '👤 a1', callback_data: 'qr:200-400:a1' }],
      [{ text: '👤 dom4429', callback_data: 'qr:200-400:a2' }],
      [{ text: '⚡ All accounts (2, Parallel - Fast)', callback_data: 'qr:200-400:all:parallel' }],
      [{ text: '👥 All accounts (2, one by one)', callback_data: 'qr:200-400:all' }],
      [{ text: '✖️ Cancel', callback_data: 'qr:x' }],
    ]);
  });

  it('without a range it asks for one and includes quick-selection buttons', async () => {
    const { deps, sentViews } = makeDeps([acc('a1')]);
    await handleQuestionRangeCommand('', deps, makeUi(started(['a1'])).ui);
    expect(sentViews[0]!.text).toMatch(/Which questions\? Send the range, e\.g\. 200-400/);
    expect(sentViews[0]!.text).toContain('How many questions do you want to submit?');
    expect(sentViews[0]!.buttons).toEqual(buildQuickRangeButtons());
    expect(getPendingPromptType()).toBe('leetcode');
  });

  it('without a range and no accounts it warns and does not set pending prompt', async () => {
    const { deps, sentViews } = makeDeps([]);
    await handleQuestionRangeCommand('', deps, makeUi(started([])).ui);
    expect(sentViews[0]!.text).toMatch(/📭 No accounts configured/);
    expect(getPendingPromptType()).toBeNull();
  });

  it('a malformed range is answered with the example', async () => {
    const { deps, sentViews } = makeDeps([acc('a1')]);
    await handleQuestionRangeCommand('potato', deps, makeUi(started(['a1'])).ui);
    expect(sentViews[0]!.text).toMatch(/^⚠️ Send the range as two question numbers/);
  });

  it('when a range process is already running it still shows the picker for queuing', async () => {
    const { deps, sentViews } = makeDeps([acc('a1')]);
    const { ui } = makeUi(started(['a1']), job());
    await handleQuestionRangeCommand('200-400', deps, ui);
    expect(sentViews[0]!.text).toContain('🎯 Question range #200–#400');
    expect(sentViews[0]!.text).toContain('This request will be queued');
  });

  it('with no accounts there is nothing to pick', async () => {
    const { deps, sentViews } = makeDeps([]);
    await handleQuestionRangeCommand('200-400', deps, makeUi(started([])).ui);
    expect(sentViews[0]!.text).toMatch(/📭 No accounts configured/);
  });
});

describe('range picker buttons', () => {
  it('a single account starts only that account', async () => {
    const { deps } = makeDeps([acc('a1')]);
    const { ui, calls } = makeUi(started(['a1']));
    await handleCallbackQuery({ id: 'c1', data: 'qr:200-400:a1', message: { message_id: 7, chat: { id: '555' } } }, deps, ui);
    expect(calls).toEqual([{ range: { from: 200, to: 400 }, target: 'a1' }]);
  });

  it('All accounts starts every account one by one', async () => {
    const { deps } = makeDeps([acc('a1'), acc('a2')]);
    const { ui, calls } = makeUi(started(['a1', 'a2']));
    await handleCallbackQuery({ id: 'c2', data: 'qr:200-400:all', message: { message_id: 7, chat: { id: '555' } } }, deps, ui);
    expect(calls).toEqual([{ range: { from: 200, to: 400 }, target: 'all' }]);
  });

  it('the confirmation message shows the plan and the cancel/status commands', async () => {
    const { deps, edits, answers } = makeDeps([acc('a1')]);
    await handleCallbackQuery({ id: 'c3', data: 'qr:200-201:a1', message: { message_id: 7, chat: { id: '555' } } }, deps, makeUi(started(['a1'])).ui);
    expect(answers[0]).toEqual({ id: 'c3', text: 'Started 🚀' });
    expect(edits[0]!.text).toContain('🚀 Started: questions #200–#201 (2)');
    expect(edits[0]!.text).toContain('Account: a1');
    expect(edits[0]!.text).toContain('📍 /rangestatus');
    expect(edits[0]!.text).toContain('🛑 /cancelrange');
  });

  it('starting a second job reports its queue position', async () => {
    const { deps, sentViews, answers } = makeDeps([acc('a1')]);
    const queued: StartRangeResult = {
      started: false,
      queued: true,
      position: 1,
      accounts: [acc('a1')],
      done: Promise.resolve([]),
    };
    await handleCallbackQuery(
      { id: 'c4', data: 'qr:200-400:a1', message: { message_id: 7, chat: { id: '555' } } },
      deps,
      makeUi(queued, job()).ui,
    );
    expect(answers[0]!.text).toBe('Queued #1 🗂️');
    expect(sentViews).toEqual([]);
  });

  it('Cancel closes the picker without starting anything', async () => {
    const { deps, edits, answers } = makeDeps([acc('a1')]);
    const { ui, calls } = makeUi(started(['a1']));
    await handleCallbackQuery({ id: 'c5', data: 'qr:x', message: { message_id: 7, chat: { id: '555' } } }, deps, ui);
    expect(calls).toEqual([]);
    expect(edits[0]!.text).toMatch(/✖️ Question-range submission cancelled/);
    expect(answers[0]!.text).toBe('Cancelled');
  });

  it('tapping a quick range button (qr:r:1-25) opens the account picker for that range', async () => {
    const { deps, edits, answers } = makeDeps([acc('a1')]);
    await handleCallbackQuery(
      { id: 'c-quick', data: 'qr:r:1-25', message: { message_id: 7, chat: { id: '555' } } },
      deps,
      makeUi(started(['a1'])).ui,
    );
    expect(answers[0]).toEqual({ id: 'c-quick', text: 'Range #1–#25' });
    expect(edits[0]!.text).toContain('🎯 Question range #1–#25 (25 questions)');
    expect(edits[0]!.buttons).toEqual([
      [{ text: '👤 a1', callback_data: 'qr:1-25:a1' }],
      [{ text: '👥 All accounts (1, one by one)', callback_data: 'qr:1-25:all' }],
      [{ text: '✖️ Cancel', callback_data: 'qr:x' }],
    ]);
  });

  it('stale buttons are answered honestly', async () => {
    const { deps, answers } = makeDeps([acc('a1')]);
    await handleCallbackQuery({ id: 'c6', data: 'qr:garbage', message: { message_id: 7, chat: { id: '555' } } }, deps, makeUi(started(['a1'])).ui);
    expect(answers[0]!.text).toBe('This button is no longer valid');
  });

  it('taps from another chat are ignored', async () => {
    const { deps } = makeDeps([acc('a1')]);
    const { ui, calls } = makeUi(started(['a1']));
    await handleCallbackQuery({ id: 'c7', data: 'qr:200-400:a1', message: { message_id: 7, chat: { id: '999' } } }, deps, ui);
    expect(calls).toEqual([]);
  });
});

describe('/cancelrange and /rangestatus', () => {
  it('cancel says so when nothing runs', async () => {
    await handleCancelRange(makeUi(null, null, false).ui);
    expect(sent.at(-1)).toMatch(/No question-range process is running/);
  });

  it('cancel confirms the stop', async () => {
    await handleCancelRange(makeUi(null, job(), true).ui);
    expect(sent.at(-1)).toMatch(/🛑 Cancelling the question-range job \(#200–#400\)/);
    expect(sent.at(-1)).toMatch(/a1/);
  });

  it('status shows progress, or the idle hint', async () => {
    await handleRangeStatus(makeUi(null).ui);
    expect(sent.at(-1)).toMatch(/💤 No question-range process is running/);
    vi.mocked(await import('../src/notifications/telegram')).sendTelegramMessage.mockClear();
    sent.length = 0;
    await handleRangeStatus(makeUi(null, job({ pausedReason: 'the daily run is in progress' })).ui);
    expect(sent.at(-1)).toMatch(/⏳ Question-range job in progress/);
    expect(sent.at(-1)).toMatch(/⏸️ Paused: the daily run is in progress/);
  });
});

describe('buildRangePicker', () => {
  it('keeps callback_data within Telegram\'s 64-byte limit', () => {
    const picker = buildRangePicker({ from: 1, to: 9999 }, [acc('cmg3x9k2v0000qz8l5y7abcde')]);
    expect(picker.buttons[0]![0]!.callback_data).toBe('qr:1-9999:cmg3x9k2v0000qz8l5y7abcde');
    expect(picker.buttons[1]![0]!.callback_data).toBe('qr:1-9999:all');
    for (const row of picker.buttons) for (const b of row) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
  });
});
