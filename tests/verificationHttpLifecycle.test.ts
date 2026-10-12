import { describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';

const state = vi.hoisted(() => ({ entered: 0, signals: [] as AbortSignal[] }));
vi.mock('../CPSolver/src/solver', async () => {
  const { ConcurrencyQueue } = await import('../CPSolver/src/queue');
  const queue = new ConcurrencyQueue(1, 10);
  return {
    solverQueue: queue,
    solverStats: {},
    lastDebugScreenshot: null,
    solveTurnstile: (_request: unknown, signal: AbortSignal) => {
      state.signals.push(signal);
      return queue.run(async () => {
        state.entered++;
        await new Promise(resolve => setTimeout(resolve, 100));
        return { ok: false, error: 'Controlled fixture result', durationMs: 100 };
      }, signal);
    },
  };
});
import { app } from '../CPSolver/src/index';

describe('HTTP request completion versus client disconnect', () => {
  it('keeps connected requests queued after their JSON bodies finish', async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/solve`;
      const post = () => fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteurl: 'http://localhost/fixture', mode: 'navigate' }),
      });
      const first = post();
      while (!state.entered) await new Promise(resolve => setTimeout(resolve, 1));
      const second = post();
      const responses = await Promise.all([first, second]);
      expect(responses.map(r => r.status)).toEqual([422, 422]);
      expect(state.entered).toBe(2);
      expect(state.signals.every(signal => !signal.aborted)).toBe(true);
      for (const response of responses) {
        expect((await response.json() as any).error).toBe('Controlled fixture result');
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
