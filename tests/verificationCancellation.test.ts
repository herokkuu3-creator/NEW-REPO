import { afterEach, expect, it, vi } from 'vitest';
import { BrowserManager } from '../CPSolver/src/browser';
import { solveTurnstile, solverQueue } from '../CPSolver/src/solver';

afterEach(() => vi.restoreAllMocks());
it('an active HTTP cancellation closes the real solver context and stops navigation work', async () => {
  let failNavigation!: (error: Error) => void;
  const goto = vi.fn(() => new Promise<never>((_resolve, reject) => { failNavigation = reject; }));
  const close = vi.fn(async () => { failNavigation?.(new Error('Controlled context closed')); });
  const page = { route: async () => {}, goto, setDefaultTimeout: () => {}, close: async () => {}, screenshot: vi.fn() };
  const context = { newPage: async () => page, close };
  vi.spyOn(BrowserManager, 'getInstance').mockReturnValue({
    createContext: async () => context, notifySolveCompleted: async () => {},
  } as unknown as BrowserManager);
  const controller = new AbortController();
  const work = solveTurnstile({ siteurl: 'http://localhost/owned-fixture', mode: 'navigate', proxy: 'direct' }, controller.signal);
  const rejection = expect(work).rejects.toThrow('aborted during execution');
  await vi.waitFor(() => expect(goto).toHaveBeenCalledOnce());
  controller.abort();
  await rejection;
  await vi.waitFor(() => expect(solverQueue.active).toBe(0));
  expect(close).toHaveBeenCalled();
  expect(page.screenshot).not.toHaveBeenCalled();
});
