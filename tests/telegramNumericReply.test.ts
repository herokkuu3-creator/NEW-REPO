import { describe, expect, it, vi } from 'vitest';
const sent = vi.hoisted(() => vi.fn(async (_text: string) => true));
vi.mock('../src/notifications/telegram', () => ({ sendTelegramMessage: sent }));
import { config } from '../src/config';
import { handleMessage, setPendingPromptType } from '../src/notifications/telegramBot';

describe('Telegram selection replies', () => {
  it('explains an unclaimed number rather than sending it to AI', async () => {
    setPendingPromptType(null);
    sent.mockClear();
    await handleMessage({ chat: { id: config.telegram.chatId }, text: '2' } as never);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0]![0]).toContain('No selection is waiting');
  });
});
