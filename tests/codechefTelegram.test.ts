import { describe, expect, it, vi } from 'vitest';
import { handleCodeChefTrigger } from '../src/notifications/telegramBot';

describe('/codechef manual trigger', () => {
  it('starts the real runner asynchronously rather than returning the old placeholder', async () => {
    const runner = vi.fn(async () => ({ date: '2026-10-05', outcomes: [] }));
    const send = vi.fn(async () => undefined);
    const handle = await handleCodeChefTrigger(runner, () => false, send);
    await handle!.done;
    expect(runner).toHaveBeenCalledWith('manual');
    expect(send.mock.calls[0]?.[0]).toContain('CodeChef');
  });
  it('does not start a second run and reports startup failures', async () => {
    const runner = vi.fn(async () => { throw new Error('missing database table'); });
    const send = vi.fn(async (_text: string) => undefined);
    expect(await handleCodeChefTrigger(runner, () => true, send)).toBeNull();
    expect(runner).not.toHaveBeenCalled();
    const handle = await handleCodeChefTrigger(runner, () => false, send);
    await handle!.done;
    expect(send.mock.calls.at(-1)?.[0]).toContain('missing database table');
  });
});
