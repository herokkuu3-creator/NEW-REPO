import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';

export class AttemptCancelledError extends Error {
  constructor(readonly reason: 'deadline' | 'disconnect') {
    super(reason === 'deadline' ? 'Browser attempt deadline reached' : 'Submission client disconnected');
    this.name = 'AttemptCancelledError';
  }
}

interface AttemptContext { requestId: string; deadline: number; signal: AbortSignal }
const attempts = new AsyncLocalStorage<AttemptContext>();
export const getAttemptContext = () => attempts.getStore();
export function throwIfAttemptAborted(): void { attempts.getStore()?.signal.throwIfAborted(); }

/** All nested requests and delays share the lifetime of their submission. */
export async function withAttemptContext<T>(
  requestId: string, deadline: number, task: () => Promise<T>, parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
  const remaining = deadline - Date.now();
  if (remaining <= 0) controller.abort(new AttemptCancelledError('deadline'));
  const timer = remaining > 0 ? setTimeout(() => controller.abort(new AttemptCancelledError('deadline')), remaining) : undefined;
  try {
    return await attempts.run({ requestId, deadline, signal }, async () => {
      signal.throwIfAborted();
      return task();
    });
  } finally {
    if (timer) clearTimeout(timer);
    // Stop any helper work that a failing page operation left in the background.
    controller.abort(new Error('Submission attempt finished'));
  }
}

export function attemptFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const signal = getAttemptContext()?.signal;
  signal?.throwIfAborted();
  return globalThis.fetch(input, {
    ...init,
    signal: signal && init?.signal ? AbortSignal.any([signal, init.signal]) : signal ?? init?.signal,
  });
}

export async function attemptSleep(ms: number): Promise<void> {
  const signal = getAttemptContext()?.signal;
  signal?.throwIfAborted();
  try { await delay(ms, undefined, { signal }); }
  catch (err) { signal?.throwIfAborted(); throw err; }
}
