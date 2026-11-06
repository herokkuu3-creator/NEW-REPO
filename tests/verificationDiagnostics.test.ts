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

  it('the actual harness expiry callback clears token copies in title and inputs', () => {
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
    expect(document.title).toBe('Verification');
    expect(inputs.get('cf-turnstile-response')?.value).toBe('');
    expect(inputs.get('turnstileToken')?.value).toBe('');
  });

  it('navigation mode does not synthesize clearance on an ordinary page without cookies or token', async () => {
    vi.useFakeTimers();
    const { solveTurnstile } = await import('../CPSolver/src/solver');
    const contextCookies = vi.fn(async () => []);
    const page: any = {
      route: vi.fn(async () => {}),
      unroute: vi.fn(async () => {}),
      goto: vi.fn(async () => {}),
      setDefaultTimeout: vi.fn(),
      title: vi.fn(async () => 'Ordinary Login Page'),
      url: vi.fn(() => 'https://example.test/login'),
      evaluate: vi.fn(async () => null),
      frames: vi.fn(() => []),
      mainFrame: vi.fn(() => ({})),
      locator: vi.fn(() => ({ inputValue: vi.fn(async () => '') })),
      context: () => ({ cookies: contextCookies }),
      screenshot: vi.fn(async () => null),
      close: vi.fn(async () => {}),
    };
    const context: any = {
      newPage: vi.fn(async () => page),
      cookies: contextCookies,
      close: vi.fn(async () => {}),
    };
    const spy = vi.spyOn(BrowserManager, 'getInstance').mockReturnValue({
      createContext: vi.fn(async () => context),
      notifySolveCompleted: vi.fn(async () => {}),
    } as any);

    try {
      const promise = solveTurnstile({
        siteurl: 'https://example.test/login',
        mode: 'navigate',
        proxy: 'direct',
        timeout: 5000,
      });
      await vi.advanceTimersByTimeAsync(6000);
      const res = await promise;
      expect(res.ok).toBe(false);
      expect(res.cfClearance).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('harness fallback on 600010 unroutes synthetic HTML and reports navigate mode', async () => {
    const { solveTurnstile } = await import('../CPSolver/src/solver');
    let unrouted = false;
    let navChecks = 0;
    const page: any = {
      route: vi.fn(async () => {}),
      unroute: vi.fn(async () => { unrouted = true; }),
      goto: vi.fn(async () => {}),
      on: vi.fn(),
      waitForTimeout: vi.fn(async () => {}),
      setDefaultTimeout: vi.fn(),
      title: vi.fn(async () => {
        if (!unrouted) return 'Verification';
        navChecks++;
        return navChecks >= 1 ? 'TURNSTILE_TOKEN:VALID_NAV_FALLBACK_TOKEN_12345' : 'Verification';
      }),
      url: vi.fn(() => 'https://example.test/form'),
      evaluate: vi.fn(async (fn: Function) => {
        if (!unrouted && String(fn).includes('__turnstileError')) return '600010';
        return null;
      }),
      frames: vi.fn(() => []),
      mainFrame: vi.fn(() => ({})),
      locator: vi.fn(() => ({ inputValue: vi.fn(async () => '') })),
      context: () => ({ cookies: vi.fn(async () => []) }),
      screenshot: vi.fn(async () => null),
      close: vi.fn(async () => {}),
    };
    const context: any = {
      newPage: vi.fn(async () => page),
      cookies: vi.fn(async () => []),
      close: vi.fn(async () => {}),
    };
    const spy = vi.spyOn(BrowserManager, 'getInstance').mockReturnValue({
      createContext: vi.fn(async () => context),
      notifySolveCompleted: vi.fn(async () => {}),
    } as any);

    try {
      const res = await solveTurnstile({
        siteurl: 'https://example.test/form',
        sitekey: '0x4AAAAAACDz1ltMYNJCAQZS',
        mode: 'harness',
        proxy: 'direct',
        timeout: 5000,
      });
      expect(unrouted).toBe(true);
      expect(res.ok).toBe(true);
      expect(res.modeUsed).toBe('navigate');
      expect(res.token).toBe('VALID_NAV_FALLBACK_TOKEN_12345');
    } finally {
      spy.mockRestore();
    }
  });
});
