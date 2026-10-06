import { describe, expect, it, vi } from 'vitest';
import {
  handleCodeChefTrigger,
  renderCodeChefProgressSections,
  CodeChefAccountSectionState,
} from '../src/notifications/telegramBot';

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

describe('renderCodeChefProgressSections', () => {
  it('renders distinct account sections with proper headers and tree connectors', () => {
    const sections = new Map<number, CodeChefAccountSectionState>([
      [
        0,
        {
          accIndex: 0,
          label: 'herokkuu7@gmail.com',
          username: 'herokkuu7',
          completedItems: [
            '✅ [1/2] <code>ADAKNG</code> — <b>Accepted</b> · #12345',
            '✅ [2/2] <code>BFTT</code> — <b>Accepted</b> · #12346',
          ],
        },
      ],
      [
        1,
        {
          accIndex: 1,
          label: 'cool_wonder_06',
          username: 'cool_wonder_06',
          completedItems: [],
          activeLine: '🚀 [1/2] Submitting <code>ADAKNG</code>…',
        },
      ],
    ]);

    const rendered = renderCodeChefProgressSections(sections, 2);
    expect(rendered).toHaveLength(2);

    // Account 1 should show header and both completed questions
    expect(rendered[0]).toContain('👤 <b>Account 1/2 · <code>herokkuu7</code></b>');
    expect(rendered[0]).toContain('├ ✅ [1/2] <code>ADAKNG</code> — <b>Accepted</b> · #12345');
    expect(rendered[0]).toContain('└ ✅ [2/2] <code>BFTT</code> — <b>Accepted</b> · #12346');

    // Account 2 should show header and active submitting line
    expect(rendered[1]).toContain('👤 <b>Account 2/2 · <code>cool_wonder_06</code></b>');
    expect(rendered[1]).toContain('└ 🚀 [1/2] Submitting <code>ADAKNG</code>…');

    // Joining with \n\n creates distinct sections with spacing
    const fullBody = rendered.join('\n\n');
    expect(fullBody).toContain('Account 1/2');
    expect(fullBody).toContain('Account 2/2');
  });

  it('keeps completed verdict visible alongside active pacing line without overwriting', () => {
    const sections = new Map<number, CodeChefAccountSectionState>([
      [
        0,
        {
          accIndex: 0,
          label: 'herokkuu7@gmail.com',
          username: 'herokkuu7',
          completedItems: [
            '✅ [1/5] <code>ADAKNG</code> — <b>Accepted</b> · #1369723352',
          ],
          activeLine: '⏳ Waiting 30s before question [2/5] (human pacing)…',
        },
      ],
    ]);

    const rendered = renderCodeChefProgressSections(sections, 1);
    expect(rendered).toHaveLength(1);

    // Completed verdict must be intact!
    expect(rendered[0]).toContain('├ ✅ [1/5] <code>ADAKNG</code> — <b>Accepted</b> · #1369723352');
    // Pacing delay must be placed under it as the active leaf
    expect(rendered[0]).toContain('└ ⏳ Waiting 30s before question [2/5] (human pacing)…');
  });

  it('shows queued state for unstarted accounts', () => {
    const sections = new Map<number, CodeChefAccountSectionState>([
      [
        0,
        {
          accIndex: 0,
          label: 'herokkuu7@gmail.com',
          username: 'herokkuu7',
          completedItems: [],
        },
      ],
    ]);

    const rendered = renderCodeChefProgressSections(sections, 1);
    expect(rendered[0]).toContain('└ ⏳ Queued…');
  });
});
