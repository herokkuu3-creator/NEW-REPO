import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConcurrencyQueue } from '../CPSolver/src/queue';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { BrowserManager } from '../CPSolver/src/browser';

// Lifecycle regressions plus characterization of the remaining expiry defect.
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

  it('queue timeout cancels work and holds capacity until cleanup completes', async () => {
    vi.useFakeTimers();
    const queue = new ConcurrencyQueue(1, 2);
    let finish!: () => void;
    let running = 0;
    let observed = 0;
    let workSignal!: AbortSignal;
    const first = queue.run(async signal => {
      workSignal = signal;
      running++;
      await new Promise<void>(resolve => { finish = resolve; });
      running--;
    });
    const rejection = expect(first).rejects.toThrow('120s');
    const second = queue.run(async () => { observed = running + 1; });
    await vi.advanceTimersByTimeAsync(120_000);
    await rejection;
    expect(workSignal.aborted).toBe(true);
    expect(observed).toBe(0);
    expect(queue.active).toBe(1);
    expect(running).toBe(1);
    finish();
    await second;
    expect(observed).toBe(1);
    expect(queue.active).toBe(0);
  });

  it('aborting an active task propagates cancellation and preserves capacity until cleanup', async () => {
    const queue = new ConcurrencyQueue(1, 1);
    const controller = new AbortController();
    let finish!: () => void;
    let workSignal!: AbortSignal;
    const work = queue.run(signal => {
      workSignal = signal;
      return new Promise<void>(resolve => { finish = resolve; });
    }, controller.signal);
    const rejected = expect(work).rejects.toThrow('aborted during execution');
    controller.abort();
    await rejected;
    expect(workSignal.aborted).toBe(true);
    expect(queue.active).toBe(1);
    finish();
    await vi.waitFor(() => expect(queue.active).toBe(0));
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
