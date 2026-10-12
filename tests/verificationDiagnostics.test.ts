import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConcurrencyQueue } from '../CPSolver/src/queue';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { BrowserManager } from '../CPSolver/src/browser';

// Recycle regression plus characterization of the remaining documented defects.
// No browser launch, network request, credentials, or production challenge.
afterEach(() => vi.useRealTimers());

describe('offline verification failure evidence', () => {
  it('recycling a connected browser completes without waiting on its own promise', async () => {
    vi.useFakeTimers();
    const manager = BrowserManager.getInstance();
    const state = manager as any;
    const close = vi.fn(async () => {});
    state.browser = { close, isConnected: () => true };
    const replacement = { isConnected: () => true };
    const launch = vi.spyOn(state, 'getOrLaunchBrowser').mockImplementation(async () => {
      state.browser = replacement;
      return replacement;
    });
    const recycling = manager.recycle();
    const concurrent = manager.recycle();
    const outcome = Promise.race([
      recycling.then(() => 'finished'),
      new Promise<string>(resolve => setTimeout(() => resolve('pending'), 100)),
    ]);
    await vi.advanceTimersByTimeAsync(100);
    expect(await outcome).toBe('finished');
    await concurrent;
    expect(close).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledOnce();
    expect(state.browser).toBe(replacement);
    expect(state.recyclingPromise).toBeNull();
    expect(state.launchingPromise).toBeNull();
    launch.mockRestore();
    (BrowserManager as any).instance = null;
  });

  it('queue timeout releases capacity while the original task is still running', async () => {
    vi.useFakeTimers();
    const queue = new ConcurrencyQueue(1, 2);
    let finish!: () => void;
    let running = 0;
    let observed = 0;
    const first = queue.run(async () => {
      running++;
      await new Promise<void>(resolve => { finish = resolve; });
      running--;
    });
    const rejection = expect(first).rejects.toThrow('120s');
    const second = queue.run(async () => { observed = running + 1; });
    await vi.advanceTimersByTimeAsync(120_000);
    await rejection;
    await second;
    expect(observed).toBe(2);
    expect(queue.active).toBe(0);
    expect(running).toBe(1);
    finish();
    await Promise.resolve();
  });

  it('aborting an active task does not cancel its work', async () => {
    const queue = new ConcurrencyQueue(1, 1);
    const controller = new AbortController();
    let finish!: () => void;
    const work = queue.run(() => new Promise<void>(resolve => { finish = resolve; }), controller.signal);
    controller.abort();
    expect(queue.active).toBe(1);
    finish();
    await expect(work).resolves.toBeUndefined();
  });

  it('the actual harness expiry callback leaves token copies in title and inputs', () => {
    const source = readFileSync(new URL('../CPSolver/src/solver.ts', import.meta.url), 'utf8');
    const script = source.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    const inputs = new Map<string, { value: string }>();
    for (const id of ['cf-turnstile-response', 'turnstileToken']) inputs.set(id, { value: '' });
    const window: any = { addEventListener() {} };
    const document = { title: '', getElementById: (id: string) => inputs.get(id) };
    vm.runInNewContext(script!, { window, document });
    window.onTurnstileSuccess('LOCAL_FIXTURE_VALUE_ONLY');
    window.onTurnstileExpired();
    expect(window.__turnstileToken).toBeNull();
    expect(document.title).toBe('TURNSTILE_TOKEN:LOCAL_FIXTURE_VALUE_ONLY');
    expect(inputs.get('cf-turnstile-response')?.value).toBe('LOCAL_FIXTURE_VALUE_ONLY');
  });
});
