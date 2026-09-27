import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Simulates a Render deploy: an OLD bot instance is polling, a NEW instance
 * boots with the same token. Telegram (mocked fetch) allows one poller and
 * answers 409 to the other. The old instance must stop on its own, and the
 * new one must end up as the only poller.
 */

vi.mock('../src/config', async (orig) => {
  const real = (await orig()) as { config: Record<string, unknown> };
  return {
    config: {
      ...real.config,
      telegram: { ...(real.config.telegram as object), enabled: true, commands: true, botToken: 'T', chatId: '1' },
    },
  };
});
vi.mock('../src/notifications/telegram', () => ({ sendTelegramMessage: vi.fn(async () => true) }));
vi.mock('../src/database/models', () => ({
  getAllSystemState: vi.fn(),
  latestRun: vi.fn(),
  getSystemState: vi.fn(async () => null),
  setSystemState: vi.fn(async () => undefined),
}));

import { isConflictError, startTelegramBot } from '../src/notifications/telegramBot';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stops: Array<() => void> = [];

afterEach(() => {
  stops.splice(0).forEach((s) => s());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('isConflictError', () => {
  it('recognises Telegram 409s only', () => {
    expect(isConflictError(new Error('telegram getUpdates failed: HTTP 409 Conflict: terminated by other getUpdates request'))).toBe(true);
    expect(isConflictError(new Error('telegram getUpdates failed: HTTP 502'))).toBe(false);
  });
});

describe('telegram poller handover', () => {
  it('old instance stops polling once a newer instance claims the slot', async () => {
    // Fake Telegram: one long-poll at a time; a concurrent poll gets 409.
    let active = 0;
    let conflicts = 0;
    vi.stubGlobal('fetch', async (url: string, init: { signal: AbortSignal }) => {
      const json = (b: unknown, status = 200) =>
        ({ ok: status === 200, status, json: async () => b }) as unknown as Response;
      if (!url.endsWith('/getUpdates')) return json({ ok: true, result: true });
      if (active > 0) {
        conflicts++;
        return json({ ok: false, description: 'Conflict: terminated by other getUpdates request' }, 409);
      }
      active++;
      try {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 15);
          init.signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('aborted'));
          });
        });
      } finally {
        active--;
      }
      return json({ ok: true, result: [] });
    });

    // Shared "database" row + per-instance loop counters (getOwner runs once per loop).
    let owner: string | null = null;
    const loops = { old: 0, new: 0 };
    const storeFor = (id: 'old' | 'new') => ({
      instanceId: id,
      getOwner: async () => {
        loops[id]++;
        return owner;
      },
      setOwner: async (v: string) => void (owner = v),
      retryDelayMs: 10,
    });

    stops.push(startTelegramBot(storeFor('old')));
    await sleep(80);
    expect(loops.old).toBeGreaterThan(1); // old instance is polling normally

    // New deploy boots and claims ownership while the old one is still alive.
    stops.push(startTelegramBot(storeFor('new')));
    await sleep(80);
    expect(owner).toBe('new');
    const oldLoopsAfterHandover = loops.old;
    const newLoopsAfterHandover = loops.new;

    await sleep(150);
    // Old instance has exited its loop: no more iterations at all.
    expect(loops.old).toBe(oldLoopsAfterHandover);
    // New instance keeps polling on its own, with no further conflicts.
    expect(loops.new).toBeGreaterThan(newLoopsAfterHandover + 2);
    const conflictsNow = conflicts;
    await sleep(80);
    expect(conflicts).toBe(conflictsNow);
  });

  it('stop() aborts the in-flight long-poll immediately', async () => {
    let aborted = false;
    vi.stubGlobal('fetch', async (url: string, init: { signal: AbortSignal }) => {
      if (url.endsWith('/getUpdates')) {
        await new Promise((_, reject) =>
          init.signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          }),
        );
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) } as unknown as Response;
    });
    const stop = startTelegramBot({ instanceId: 'x', getOwner: async () => 'x', setOwner: async () => undefined });
    await sleep(20);
    stop();
    await sleep(5);
    expect(aborted).toBe(true);
  });

  it('keeps polling when the ownership store is unavailable', async () => {
    let polls = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/getUpdates')) {
        polls++;
        await sleep(5);
        return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) } as unknown as Response;
    });
    stops.push(
      startTelegramBot({
        instanceId: 'x',
        getOwner: async () => {
          throw new Error('db down');
        },
        setOwner: async () => {
          throw new Error('db down');
        },
      }),
    );
    await sleep(60);
    expect(polls).toBeGreaterThan(2);
  });
});
