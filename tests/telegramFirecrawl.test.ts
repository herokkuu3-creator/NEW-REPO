import { afterEach, describe, expect, it, vi } from 'vitest';
const send = vi.hoisted(() => vi.fn(async (_text: string) => true));
vi.mock('../src/notifications/telegram', () => ({ sendTelegramMessage: send }));
import { handleTestFirecrawl } from '../src/notifications/telegramBot';

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('/testfirecrawl', () => {
  it('does not transmit missing or malformed credentials', async () => {
    const mock = vi.fn(); vi.stubGlobal('fetch', mock);
    await handleTestFirecrawl(); await handleTestFirecrawl('invalid');
    expect(mock).not.toHaveBeenCalled(); expect(send).toHaveBeenCalledTimes(2);
  });
  it('reports safe server-side evidence without claiming solution generation worked', async () => {
    const secret = `fc-${'a'.repeat(32)}`;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true,
      data: { markdown: '# Example Domain', metadata: { statusCode: 200 } } }))));
    await handleTestFirecrawl(secret);
    expect(send).toHaveBeenCalledTimes(2);
    const text = send.mock.calls.map(call => call[0]).join('\n');
    expect(text).toContain('SCRAPE_OK'); expect(text).toContain('separate validation');
    expect(text).not.toContain(secret);
  });
});
