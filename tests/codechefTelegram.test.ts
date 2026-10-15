import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/config', async (orig) => {
  const real = (await orig()) as { config: Record<string, unknown> };
  return { config: { ...real.config, telegram: { ...(real.config.telegram as object), chatId: '555', enabled: true, commands: true, botToken: 'T' } } };
});

import {
  handleCodeChefTrigger,
  renderCodeChefProgressSections,
  CodeChefAccountSectionState,
  buildCodeChefRangeCountPicker,
  handleCodeChefRangePrompt,
  handleCodeChefRangeButton,
  CodeChefUiDeps,
  buildDailySolutionPicker,
  buildManualSolutionPicker,
  handleCallbackQuery,
} from '../src/notifications/telegramBot';

describe('daily solution account picker', () => {
  it('renders saved accounts as selected and exposes save plus immediate daily-run actions', () => {
    const picker = buildDailySolutionPicker([
      { id: 'a', label: 'alpha', username: 'alice', status: 'ACTIVE' },
      { id: 'b', label: 'beta', username: 'bob', status: 'ACTIVE' },
    ] as never, new Set(['a']));
    expect(picker.text).toContain('preloaded');
    expect(picker.text).toContain('1/2');
    expect(picker.buttons).toContainEqual([{ text: '✅ alpha (alice)', callback_data: 'lcsol:a:a' }]);
    expect(picker.buttons).toContainEqual([{ text: '▫️ beta (bob)', callback_data: 'lcsol:a:b' }]);
    expect(picker.buttons.flat()).toContainEqual({ text: '💾 Save daily selection (1)', callback_data: 'lcsol:save' });
    expect(picker.buttons.flat()).toContainEqual({ text: '🚀 Run daily now', callback_data: 'lcsol:daily' });
  });
});

describe('manual solution account picker', () => {
  it('uses its own one-time selections and offers either the daily or numbered workflow', () => {
    const picker = buildManualSolutionPicker([
      { id: 'a', label: 'alpha', username: 'alice', status: 'ACTIVE' },
      { id: 'b', label: 'beta', username: 'bob', status: 'ACTIVE' },
    ] as never, new Set(['b']));
    expect(picker.text).toContain('do not alter the 06:00 IST daily schedule');
    expect(picker.buttons).toContainEqual([{ text: '▫️ alpha (alice)', callback_data: 'lcsol:m:a:a' }]);
    expect(picker.buttons).toContainEqual([{ text: '✅ beta (bob)', callback_data: 'lcsol:m:a:b' }]);
    expect(picker.buttons.flat()).toContainEqual({ text: '📅 Run daily now', callback_data: 'lcsol:m:daily' });
    expect(picker.buttons.flat()).toContainEqual({ text: '🔢 Enter question number', callback_data: 'lcsol:m:question' });
  });
});

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

describe('/ccrange batch picker and button handling', () => {
  function makeCodeChefUi(accounts: Array<{ id: string; label: string; username: string | null }>) {
    const sent: Array<{ text: string; buttons?: unknown }> = [];
    const edits: string[] = [];
    const answers: Array<{ id: string; text?: string }> = [];
    const ui: CodeChefUiDeps = {
      listAccounts: async () => accounts as never,
      inProgress: () => false,
      send: async (text, buttons) => void sent.push({ text, buttons }),
      edit: async (_c, _m, text) => void edits.push(text),
      answer: async (id, text) => void answers.push({ id, text }),
    };
    return { ui, sent, edits, answers };
  }

  it('buildCodeChefRangeCountPicker builds batch size buttons and cancel', () => {
    const picker = buildCodeChefRangeCountPicker();
    expect(picker.text).toContain('CodeChef Batch Submission');
    expect(picker.text).toContain('How many questions do you want to submit?');
    expect(picker.buttons).toEqual([
      [
        { text: '5 Questions', callback_data: 'ccrange:run:5' },
        { text: '10 Questions', callback_data: 'ccrange:run:10' },
      ],
      [
        { text: '15 Questions', callback_data: 'ccrange:run:15' },
        { text: '20 Questions', callback_data: 'ccrange:run:20' },
      ],
      [
        { text: '✖️ Cancel', callback_data: 'ccrange:x' },
      ],
    ]);
  });

  it('handleCodeChefRangePrompt sends batch size prompt when invoked without arguments', async () => {
    const { ui, sent } = makeCodeChefUi([{ id: 'c1', label: 'chef1', username: 'chef1' }]);
    await handleCodeChefRangePrompt(ui);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain('CodeChef Batch Submission');
    expect(sent[0]?.buttons).toEqual(buildCodeChefRangeCountPicker().buttons);
  });

  it('handleCodeChefRangeButton starts batch with chosen count', async () => {
    const { ui, edits, answers } = makeCodeChefUi([{ id: 'c1', label: 'chef1', username: 'chef1' }]);
    const trigger = vi.fn(async () => null);

    await handleCodeChefRangeButton('555', 42, 'cb-cc-10', 'ccrange:run:10', ui, trigger as never);

    expect(answers[0]).toEqual({ id: 'cb-cc-10', text: 'Starting batch (10 Qs) 🚀' });
    expect(edits[0]).toContain('Starting CodeChef batch (10 questions)');
    expect(trigger).toHaveBeenCalledWith({ forceNext: true, count: 10 });
  });

  it('handleCodeChefRangeButton handles cancel cleanly', async () => {
    const { ui, edits, answers } = makeCodeChefUi([{ id: 'c1', label: 'chef1', username: 'chef1' }]);

    await handleCodeChefRangeButton('555', 42, 'cb-cc-x', 'ccrange:x', ui);

    expect(answers[0]).toEqual({ id: 'cb-cc-x', text: 'Cancelled' });
    expect(edits[0]).toContain('CodeChef batch submission cancelled');
  });

  it('routes ccrange callback query from handleCallbackQuery', async () => {
    const { ui, answers, edits } = makeCodeChefUi([{ id: 'c1', label: 'chef1', username: 'chef1' }]);

    await handleCallbackQuery(
      { id: 'query-cc-5', data: 'ccrange:x', message: { message_id: 10, chat: { id: '555' } } },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ui,
    );

    expect(answers).toEqual([{ id: 'query-cc-5', text: 'Cancelled' }]);
    expect(edits[0]).toContain('CodeChef batch submission cancelled');
  });

  it('handleCodeChefRangePrompt stops early when a run is in progress', async () => {
    const { ui, sent } = makeCodeChefUi([{ id: 'c1', label: 'chef1', username: 'chef1' }]);
    ui.inProgress = () => true;
    await handleCodeChefRangePrompt(ui);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain('A CodeChef run is already in progress');
  });

  it('handleCodeChefRangePrompt stops early when no accounts configured', async () => {
    const { ui, sent } = makeCodeChefUi([]);
    await handleCodeChefRangePrompt(ui);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain('No active CodeChef accounts configured');
  });

  it('handleCodeChefRangeButton blocks when a run is in progress', async () => {
    const { ui, edits, answers } = makeCodeChefUi([{ id: 'c1', label: 'chef1', username: 'chef1' }]);
    ui.inProgress = () => true;
    await handleCodeChefRangeButton('555', 42, 'cb-cc-10', 'ccrange:run:10', ui);
    expect(answers[0]).toEqual({ id: 'cb-cc-10', text: 'A CodeChef run is already in progress' });
    expect(edits[0]).toContain('A CodeChef run is already in progress');
  });
});


