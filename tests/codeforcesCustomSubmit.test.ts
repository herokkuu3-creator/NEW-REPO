import { describe, expect, it, vi } from 'vitest';
import type { CodeforcesAccount } from '@prisma/client';
import {
  buildCodeforcesSubmitPicker,
  buildCodeforcesNetworkPicker,
  buildCodeforcesRangePicker,
  handleCodeforcesRangePickerCommand,
  handleCodeforcesRangeButton,
  cfRangeSelections,
  CodeforcesNetworkUiDeps,
  CodeforcesManualUiDeps,
  CodeforcesSubmitUiDeps,
  handleCallbackQuery,
  handleCodeforcesCustomSubmit,
  RemovalDeps,
  RangeUiDeps,
} from '../src/notifications/telegramBot';
import { buildCodeforcesReport } from '../src/codeforces/report';
import type { SourceIndexEntry } from '../src/codeforces/sourceRepo';

vi.mock('../src/config', async (orig) => {
  const real = (await orig()) as { config: Record<string, unknown> };
  return { config: { ...real.config, telegram: { ...(real.config.telegram as object), chatId: '555', enabled: true, commands: true, botToken: 'T' } } };
});

const account = (id: string, label = id): CodeforcesAccount => ({
  id,
  label,
  username: label,
  storageState: '{}',
  status: 'ACTIVE',
  lastCheckedAt: null,
  lastError: null,
  lastSubmissionDate: null,
  lastSubmissionId: null,
  lastVerdict: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

function makeCodeforcesUi(accounts: CodeforcesAccount[]) {
  const sent: Array<{ text: string; buttons?: unknown }> = [];
  const edits: string[] = [];
  const answers: Array<{ id: string; text?: string }> = [];
  const runner = vi.fn(async (_reason: string, options?: { accountIds?: readonly string[] }) =>
    buildCodeforcesReport({ date: '2026-10-05', reason: 'manual', startedAt: 'x', outcomes: [] }),
  );
  const ui: CodeforcesSubmitUiDeps = {
    listAccounts: async () => accounts,
    runner: runner as never,
    inProgress: () => false,
    send: async (text, buttons) => void sent.push({ text, buttons }),
    edit: async (_chatId, _messageId, text) => void edits.push(text),
    answer: async (id, text) => void answers.push({ id, text }),
  };
  return { ui, sent, edits, answers, runner };
}

const removalDeps: RemovalDeps = {
  listAccounts: async () => [],
  deleteAccountById: async () => false,
  deleteAllAccounts: async () => 0,
  clearLegacySession: async () => undefined,
  isRunInProgress: () => false,
  send: async () => undefined,
  edit: async () => undefined,
  answer: async () => undefined,
};

const rangeUi = {} as RangeUiDeps;

describe('/nextsubcustomaccount', () => {
  it('shows active accounts followed by All accounts and Cancel', async () => {
    const { ui, sent } = makeCodeforcesUi([account('a1'), account('a2', 'sks4401')]);
    await handleCodeforcesCustomSubmit(ui);
    expect(sent[0]).toEqual({
      text: expect.stringContaining('Only the selected account(s) will receive a submission.'),
      buttons: [
        [{ text: '👤 a1', callback_data: 'cfsub:a1' }],
        [{ text: '👤 sks4401', callback_data: 'cfsub:a2' }],
        [{ text: '👥 All accounts (2, one by one)', callback_data: 'cfsub:all' }],
        [{ text: '✖️ Cancel', callback_data: 'cfsub:x' }],
      ],
    });
  });

  it('submits only the tapped account', async () => {
    const { ui, runner, answers, edits } = makeCodeforcesUi([account('a1'), account('a2')]);
    await handleCallbackQuery(
      { id: 'tap-1', data: 'cfsub:a2', message: { message_id: 7, chat: { id: '555' } } },
      removalDeps,
      rangeUi,
      ui,
    );
    await vi.waitFor(() => expect(runner).toHaveBeenCalled());
    expect(runner).toHaveBeenCalledWith('codeforces-manual', expect.objectContaining({ accountIds: ['a2'], forceDailyAttempt: true }));
    expect(answers).toEqual([{ id: 'tap-1', text: 'Started 🚀' }]);
    expect(edits[0]).toContain('a2');
  });

  it('All accounts deliberately omits the account filter', async () => {
    const { ui, runner } = makeCodeforcesUi([account('a1'), account('a2')]);
    await handleCallbackQuery(
      { id: 'tap-2', data: 'cfsub:all', message: { message_id: 7, chat: { id: '555' } } },
      removalDeps,
      rangeUi,
      ui,
    );
    await vi.waitFor(() => expect(runner).toHaveBeenCalled());
    expect(runner).toHaveBeenCalledWith('codeforces-manual', expect.not.objectContaining({ accountIds: expect.anything() }));
  });

  it('keeps callback data under Telegram\'s 64-byte limit', () => {
    const picker = buildCodeforcesSubmitPicker([account('cmg3x9k2v0000qz8l5y7abcde')]);
    for (const row of picker.buttons) for (const button of row) expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
  });
});

describe('/cfmanualnext', () => {
  it('sends the selected account a source link and matching Codeforces submit page without posting', async () => {
    const { ui } = makeCodeforcesUi([account('a1', 'sks4401')]);
    const edits: string[] = [];
    const manualUi: CodeforcesManualUiDeps = {
      listAccounts: ui.listAccounts,
      nextEntry: async () => ({
        key: '2A - Winner.cpp', path: '2A - Winner.cpp', fileName: '2A - Winner.cpp', language: 'cpp',
        kind: 'CODEFORCES', contestId: 2, problemIndex: 'A', problemName: 'Winner',
        problemUrl: 'https://codeforces.com/contest/2/problem/A', rawUrl: 'https://raw.example/2A.cpp',
        interactive: false, gym: false, reason: 'test',
      } satisfies SourceIndexEntry),
      send: async () => undefined,
      edit: async (_chat, _message, text) => void edits.push(text),
      answer: async () => undefined,
    };
    await handleCallbackQuery(
      { id: 'manual-1', data: 'cfmanual:a1', message: { message_id: 7, chat: { id: '555' } } },
      removalDeps,
      rangeUi,
      ui,
      manualUi,
    );
    expect(edits[0]).toContain('https://raw.example/2A.cpp');
    expect(edits[0]).toContain('https://codeforces.com/problemset/submit/2/A');
    expect(edits[0]).toContain('Paste the source and submit');
  });
});

describe('/cfnetwork', () => {
  it('shows the persisted route and both choices', () => {
    const picker = buildCodeforcesNetworkPicker('tailscale');
    expect(picker.text).toContain('Phone Tailscale');
    expect(picker.buttons).toContainEqual([{ text: '✅ 📱 Phone Tailscale', callback_data: 'cfnet:tailscale' }]);
    expect(picker.buttons).toContainEqual([{ text: '🏠 Residential proxy', callback_data: 'cfnet:proxy' }]);
  });

  it('persists the selected route from the callback', async () => {
    const setMode = vi.fn(async (_mode: 'proxy' | 'tailscale') => undefined);
    const edits: string[] = [];
    const networkUi: CodeforcesNetworkUiDeps = {
      getMode: async () => 'proxy',
      setMode,
      send: async () => undefined,
      edit: async (_chat, _message, text) => void edits.push(text),
      answer: async () => undefined,
    };
    await handleCallbackQuery(
      { id: 'network-1', data: 'cfnet:tailscale', message: { message_id: 7, chat: { id: '555' } } },
      removalDeps,
      rangeUi,
      undefined,
      undefined,
      networkUi,
    );
    expect(setMode).toHaveBeenCalledWith('tailscale');
    expect(edits[0]).toContain('phone Tailscale');
  });
});

describe('/cfrange account multi-selection picker', () => {
  it('builds picker with checkboxes, Select All as the last selection option, and action buttons', () => {
    const accs = [account('a1', 'alice'), account('a2', 'bob')];
    const unselected = buildCodeforcesRangePicker(10, accs, new Set());

    expect(unselected.text).toContain('CODEFORCES BATCH (10 QUESTIONS)');
    expect(unselected.text).toContain('30s pacing');
    expect(unselected.buttons[0]).toEqual([{ text: '▫️ alice', callback_data: 'cfrange:a:a1' }]);
    expect(unselected.buttons[1]).toEqual([{ text: '▫️ bob', callback_data: 'cfrange:a:a2' }]);
    expect(unselected.buttons[2]).toEqual([{ text: '👥 Select All (2)', callback_data: 'cfrange:all' }]);
    expect(unselected.buttons[3]).toEqual([
      { text: '🚀 Start Batch (10 Qs)', callback_data: 'cfrange:run' },
      { text: '✖️ Cancel', callback_data: 'cfrange:x' },
    ]);

    const partial = buildCodeforcesRangePicker(5, accs, new Set(['a1']));
    expect(partial.buttons[0]).toEqual([{ text: '✅ alice', callback_data: 'cfrange:a:a1' }]);
    expect(partial.buttons[1]).toEqual([{ text: '▫️ bob', callback_data: 'cfrange:a:a2' }]);
    expect(partial.buttons[2]).toEqual([{ text: '👥 Select All (2)', callback_data: 'cfrange:all' }]);
    expect(partial.buttons[3]?.[0]?.text).toBe('🚀 Start Batch (5 Qs · 1 acc)');

    const all = buildCodeforcesRangePicker(1, accs, new Set(['a1', 'a2']));
    expect(all.text).toContain('CODEFORCES BATCH (1 QUESTION)');
    expect(all.buttons[0]).toEqual([{ text: '✅ alice', callback_data: 'cfrange:a:a1' }]);
    expect(all.buttons[1]).toEqual([{ text: '✅ bob', callback_data: 'cfrange:a:a2' }]);
    expect(all.buttons[2]).toEqual([{ text: '✅ Select All (2)', callback_data: 'cfrange:all' }]);
    expect(all.buttons[3]?.[0]?.text).toBe('🚀 Start Batch (1 Qs · 2 acc)');
  });

  it('handleCodeforcesRangePickerCommand prompts for selection and pre-selects single account', async () => {
    const { ui, sent } = makeCodeforcesUi([account('sks4401')]);
    await handleCodeforcesRangePickerCommand(10, ui, '555');

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain('CODEFORCES BATCH (10 QUESTIONS)');
    const state = cfRangeSelections.get('555');
    expect(state).toBeDefined();
    expect(state?.count).toBe(10);
    expect(Array.from(state?.selectedAccountIds ?? [])).toEqual(['sks4401']);
  });

  it('toggles individual accounts and Select All', async () => {
    const { ui, edits, answers } = makeCodeforcesUi([account('a1', 'alice'), account('a2', 'bob')]);
    cfRangeSelections.set('555', { count: 5, selectedAccountIds: new Set() });

    // Select a1
    await handleCodeforcesRangeButton('555', 42, 'cb-1', 'cfrange:a:a1', ui);
    expect(answers[0]).toEqual({ id: 'cb-1', text: 'Selected' });
    expect(cfRangeSelections.get('555')?.selectedAccountIds.has('a1')).toBe(true);

    // Deselect a1
    await handleCodeforcesRangeButton('555', 42, 'cb-2', 'cfrange:a:a1', ui);
    expect(answers[1]).toEqual({ id: 'cb-2', text: 'Unselected' });
    expect(cfRangeSelections.get('555')?.selectedAccountIds.has('a1')).toBe(false);

    // Select all
    await handleCodeforcesRangeButton('555', 42, 'cb-3', 'cfrange:all', ui);
    expect(answers[2]).toEqual({ id: 'cb-3', text: 'All accounts selected' });
    expect(cfRangeSelections.get('555')?.selectedAccountIds.size).toBe(2);

    // Clear all
    await handleCodeforcesRangeButton('555', 42, 'cb-4', 'cfrange:all', ui);
    expect(answers[3]).toEqual({ id: 'cb-4', text: 'Cleared all' });
    expect(cfRangeSelections.get('555')?.selectedAccountIds.size).toBe(0);
  });

  it('prevents starting batch when no accounts are selected', async () => {
    const { ui, answers } = makeCodeforcesUi([account('a1'), account('a2')]);
    cfRangeSelections.set('555', { count: 5, selectedAccountIds: new Set() });

    const trigger = vi.fn(async () => null);
    await handleCodeforcesRangeButton('555', 42, 'cb-run-empty', 'cfrange:run', ui, trigger as never);

    expect(trigger).not.toHaveBeenCalled();
    expect(answers).toEqual([{ id: 'cb-run-empty', text: 'Select at least one account' }]);
    expect(cfRangeSelections.has('555')).toBe(true);
  });

  it('starts batch with selected accounts and clears selection state', async () => {
    const { ui, edits, answers } = makeCodeforcesUi([account('a1', 'alice'), account('a2', 'bob')]);
    cfRangeSelections.set('555', { count: 10, selectedAccountIds: new Set(['a2']) });

    const trigger = vi.fn(async () => null);
    await handleCodeforcesRangeButton('555', 42, 'cb-run-ok', 'cfrange:run', ui, trigger as never);

    expect(answers).toEqual([{ id: 'cb-run-ok', text: 'Batch starting 🚀' }]);
    expect(edits[0]).toContain('Starting Codeforces batch (10 Qs) for bob');
    expect(trigger).toHaveBeenCalledWith(expect.objectContaining({
      forceNext: true,
      count: 10,
      accountIds: ['a2'],
    }));
    expect(cfRangeSelections.has('555')).toBe(false);
  });

  it('cancels batch picker cleanly', async () => {
    const { ui, edits, answers } = makeCodeforcesUi([account('a1')]);
    cfRangeSelections.set('555', { count: 5, selectedAccountIds: new Set(['a1']) });

    await handleCodeforcesRangeButton('555', 42, 'cb-x', 'cfrange:x', ui);

    expect(answers).toEqual([{ id: 'cb-x', text: 'Cancelled' }]);
    expect(edits[0]).toContain('batch submission cancelled');
    expect(cfRangeSelections.has('555')).toBe(false);
  });

  it('routes cfrange callback queries from handleCallbackQuery', async () => {
    const { ui, answers } = makeCodeforcesUi([account('a1')]);
    cfRangeSelections.set('555', { count: 3, selectedAccountIds: new Set() });

    await handleCallbackQuery(
      { id: 'query-1', data: 'cfrange:a:a1', message: { message_id: 10, chat: { id: '555' } } },
      removalDeps,
      rangeUi,
      ui,
    );

    expect(answers).toEqual([{ id: 'query-1', text: 'Selected' }]);
    expect(cfRangeSelections.get('555')?.selectedAccountIds.has('a1')).toBe(true);
  });
});

