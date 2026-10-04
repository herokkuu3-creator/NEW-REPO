import { describe, expect, it, vi } from 'vitest';
import type { CodeforcesAccount } from '@prisma/client';
import {
  buildCodeforcesSubmitPicker,
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
