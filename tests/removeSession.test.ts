import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountRecord } from '../src/database/accounts';

/** /removesession and /removeallsessions — in-memory fake store, no network, no DB. */

vi.mock('../src/config', async (orig) => {
  const real = (await orig()) as { config: Record<string, unknown> };
  return {
    config: { ...real.config, telegram: { ...(real.config.telegram as object), chatId: '555', enabled: true, commands: true, botToken: 'T' } },
  };
});
vi.mock('../src/notifications/telegram', () => ({ sendTelegramMessage: vi.fn(async () => true) }));

import {
  buildRemoveSessionView,
  handleCallbackQuery,
  handleRemoveAllSessions,
  handleRemoveSession,
  RemovalDeps,
} from '../src/notifications/telegramBot';

function acct(id: string, label: string, username: string | null = label): AccountRecord {
  return { id, label, username, status: 'ACTIVE' } as unknown as AccountRecord;
}

let store: AccountRecord[];
let busy: boolean;
let legacyCleared: number;
const sent: Array<{ text: string; buttons?: { text: string; callback_data: string }[][] }> = [];
const edits: Array<{ chatId: number | string; messageId: number; text: string; buttons?: { text: string; callback_data: string }[][] }> = [];
const answers: Array<{ id: string; text?: string }> = [];

const deps: RemovalDeps = {
  listAccounts: async () => [...store],
  deleteAccountById: async (id) => {
    const before = store.length;
    store = store.filter((a) => a.id !== id);
    return store.length < before;
  },
  deleteAllAccounts: async () => {
    const n = store.length;
    store = [];
    return n;
  },
  clearLegacySession: async () => void legacyCleared++,
  isRunInProgress: () => busy,
  send: async (text, buttons) => void sent.push({ text, buttons }),
  edit: async (chatId, messageId, text, buttons) => void edits.push({ chatId, messageId, text, buttons }),
  answer: async (id, text) => void answers.push({ id, text }),
};

const tap = (data: string, chatId: number | string = 555) =>
  handleCallbackQuery({ id: `cb-${data}`, data, message: { message_id: 42, chat: { id: chatId } } }, deps);

beforeEach(() => {
  store = [acct('id1', 'broZEdex'), acct('id2', 'dom4429'), acct('id3', 'main', 'thor_77')];
  busy = false;
  legacyCleared = 0;
  sent.length = 0;
  edits.length = 0;
  answers.length = 0;
});

describe('/removesession', () => {
  it('lists every session with its own Remove button', async () => {
    await handleRemoveSession(deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toMatch(/Sessions stored: 3/);
    expect(sent[0]!.text).toMatch(/3\. main \(thor_77\) - ACTIVE/);
    expect(sent[0]!.buttons).toEqual([
      [{ text: '🗑️ Remove broZEdex', callback_data: 'rm:id1' }],
      [{ text: '🗑️ Remove dom4429', callback_data: 'rm:id2' }],
      [{ text: '🗑️ Remove main (thor_77)', callback_data: 'rm:id3' }],
      [{ text: '✅ Done', callback_data: 'rm:done' }],
    ]);
  });

  it('button callback data fits Telegram\'s 64-byte limit for real cuid ids', () => {
    const v = buildRemoveSessionView([acct('cmg3x9k2v0000qz8l5y7abcde', 'x'.repeat(32))]);
    for (const row of v.buttons) for (const b of row) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
  });

  it('tapping Remove deletes ONLY that account and refreshes the list', async () => {
    await tap('rm:id2');
    expect(store.map((a) => a.label)).toEqual(['broZEdex', 'main']);
    expect(answers.at(-1)).toEqual({ id: 'cb-rm:id2', text: '✅ Removed dom4429' });
    const e = edits.at(-1)!;
    expect(e.messageId).toBe(42);
    expect(e.text).toMatch(/^✅ Removed dom4429\n\n🗂️ Sessions stored: 2/);
    expect(e.buttons!.map((r) => r[0]!.callback_data)).toEqual(['rm:id1', 'rm:id3', 'rm:done']);
    expect(legacyCleared).toBe(0);
  });

  it('tapping an already-removed account is harmless', async () => {
    await tap('rm:id2');
    await tap('rm:id2');
    expect(store).toHaveLength(2);
    expect(answers.at(-1)!.text).toBe('🤷 That account was already removed.');
  });

  it('removing the last account also clears the legacy session copy', async () => {
    store = [acct('id1', 'only')];
    await tap('rm:id1');
    expect(store).toHaveLength(0);
    expect(legacyCleared).toBe(1);
    expect(edits.at(-1)!.text).toMatch(/No sessions stored/);
    expect(edits.at(-1)!.buttons).toEqual([]);
  });

  it('refuses to remove while a run is in progress', async () => {
    busy = true;
    await tap('rm:id1');
    expect(store).toHaveLength(3);
    expect(sent.at(-1)!.text).toMatch(/run is in progress/);
  });

  it('Done closes the list', async () => {
    await tap('rm:done');
    expect(edits.at(-1)!.text).toBe('✅ Done.');
    expect(store).toHaveLength(3);
  });

  it('no accounts → friendly message, no buttons', async () => {
    store = [];
    await handleRemoveSession(deps);
    expect(sent[0]).toEqual({ text: '📭 No sessions stored - nothing to remove.', buttons: undefined });
  });
});

describe('/removeallsessions', () => {
  it('asks for confirmation first — nothing is deleted yet', async () => {
    await handleRemoveAllSessions(deps);
    expect(store).toHaveLength(3);
    expect(sent[0]!.text).toMatch(/Remove ALL 3 session/);
    expect(sent[0]!.text).toMatch(/^⚠️ /);
    expect(sent[0]!.buttons).toEqual([[
      { text: '🔥 Yes, remove all 3', callback_data: 'rmall:yes' },
      { text: 'Cancel', callback_data: 'rmall:no' },
    ]]);
  });

  it('confirm removes every account and the legacy copy', async () => {
    await tap('rmall:yes');
    expect(store).toHaveLength(0);
    expect(legacyCleared).toBe(1);
    expect(edits.at(-1)!.text).toMatch(/🧹 Removed all sessions \(3 account/);
  });

  it('cancel removes nothing', async () => {
    await tap('rmall:no');
    expect(store).toHaveLength(3);
    expect(edits.at(-1)!.text).toMatch(/❌ Cancelled/);
  });

  it('refuses while a run is in progress', async () => {
    busy = true;
    await tap('rmall:yes');
    expect(store).toHaveLength(3);
  });

  it('no accounts → nothing to confirm', async () => {
    store = [];
    await handleRemoveAllSessions(deps);
    expect(sent[0]!.buttons).toBeUndefined();
  });
});

describe('access control', () => {
  it('button taps from any other chat are ignored', async () => {
    await tap('rmall:yes', 999);
    await tap('rm:id1', 999);
    expect(store).toHaveLength(3);
    expect(edits).toHaveLength(0);
  });
});
