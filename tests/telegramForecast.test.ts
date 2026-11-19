import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ save: vi.fn(), disable: vi.fn(), preview: vi.fn(), status: vi.fn(), reply: vi.fn() }));
vi.mock('../src/database/accounts', async original => ({ ...await original<object>(), listEnabledAccounts: async () => [
  { id: 'first-account-id', label: 'first', username: 'first' }, { id: 'second-account-id', label: 'second', username: 'second' },
] }));
vi.mock('../src/notifications/telegram', () => ({ sendTelegramMessage: mocks.reply }));
vi.mock('../src/solutionPosts/dailyForecast', async original => ({ ...await original<object>(), predictNextDaily: mocks.preview }));
vi.mock('../src/solutionPosts/forecastScheduler', async original => ({ ...await original<object>(),
  saveForecastSchedule: mocks.save, disableForecastSchedule: mocks.disable, getForecastScheduleStatus: mocks.status,
}));

import { config } from '../src/config';
import { defaultCoinClaimUiDeps, handleCallbackQuery, handleMessage } from '../src/notifications/telegramBot';

const chat = { id: config.telegram.chatId };
const command = (text: string) => handleMessage({ chat, text } as never);
const tap = (data: string) => handleCallbackQuery({ message: { chat, message_id: 1 }, id: 'tap', data } as never);

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

it('requires a valid IST time and applies it only after a current account button is selected', async () => {
  const send = vi.spyOn(defaultCoinClaimUiDeps, 'send').mockResolvedValue(undefined);
  const answer = vi.spyOn(defaultCoinClaimUiDeps, 'answer').mockResolvedValue(undefined);
  const edit = vi.spyOn(defaultCoinClaimUiDeps, 'edit').mockResolvedValue(undefined);
  mocks.save.mockResolvedValue({ time: '22:30', firstTarget: '2026-11-20' });
  await command('/predictdaily 24:00');
  expect(mocks.reply).toHaveBeenCalledWith(expect.stringContaining('24-hour time'));
  expect(send).not.toHaveBeenCalled();
  await command('/predictdaily 21:30');
  await command('/predictdaily 22:30');
  const old = send.mock.calls[0]![1]![0]![0]!;
  const current = send.mock.calls[1]![1]![1]![0]!;
  await tap(old.callback_data);
  expect(answer).toHaveBeenCalledWith('tap', expect.stringContaining('expired'));
  expect(mocks.save).not.toHaveBeenCalled();
  await tap(current.callback_data);
  expect(mocks.save).toHaveBeenCalledWith('second-account-id', '22:30');
  expect(edit).toHaveBeenCalledWith(chat.id, 1, expect.stringContaining('second'));
  await tap(current.callback_data);
  expect(mocks.save).toHaveBeenCalledTimes(1);
});

it('supports preview and off without changing account selection from preview', async () => {
  mocks.preview.mockResolvedValue({ target: '2026-11-20', method: 'editorials', picks: [] });
  await command('/predictdaily preview');
  expect(mocks.reply).toHaveBeenCalledWith(expect.stringContaining('No eligible problems'));
  expect(mocks.save).not.toHaveBeenCalled();
  await command('/predictdaily off');
  expect(mocks.disable).toHaveBeenCalledTimes(1);
});
