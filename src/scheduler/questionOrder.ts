import { randomInt } from 'node:crypto';
import { getSystemState, setSystemState } from '../database/models';

/** Fisher-Yates: each candidate appears exactly once; the input is never mutated. */
export function shuffled<T>(items: readonly T[], choose = (limit: number) => randomInt(limit)): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = choose(i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

interface Cursor { nextKey: string | null; lastCompletedKey: string | null }
interface Plan { version: 1; original: string[]; order: string[]; initial: Cursor }
export interface PlannedQueue<T> { queue: T[]; nextKey: string | null; initial: Cursor }

/** Re-map only the untouched cursor. Later completions use normal durable progress. */
export function plannedProgress<T, P extends Cursor>(plan: PlannedQueue<T>, progress: P): P {
  return progress.nextKey === plan.initial.nextKey && progress.lastCompletedKey === plan.initial.lastCompletedKey ?
    { ...progress, nextKey: plan.nextKey } : progress;
}

/**
 * Shuffle only the next requested source window, preserving its prefix/suffix.
 * Persist before any submission so retries/restarts reuse the same permutation.
 * Daily single-item runs also honor an unfinished shuffled batch.
 */
export async function prepareShuffledBatch<T>(platform: 'codeforces' | 'codechef', accountId: string,
  queue: readonly T[], cursor: Cursor, startIndex: number, count: number, keyOf: (item: T) => string,
  shuffle: (items: readonly string[]) => string[] = shuffled): Promise<PlannedQueue<T>> {
  const stateKey = `question-order:v1:${platform}:${accountId}`;
  const initial = { nextKey: cursor.nextKey, lastCompletedKey: cursor.lastCompletedKey };
  const raw = await getSystemState(stateKey);
  let saved: Plan | undefined;
  if (raw) {
    try { saved = JSON.parse(raw); } catch { throw new Error('Saved question order is unreadable; progress was preserved.'); }
    if (!saved || saved.version !== 1 || !saved.initial || !Array.isArray(saved.original) || !Array.isArray(saved.order) ||
      ![saved.initial.nextKey, saved.initial.lastCompletedKey].every(key => key === null || typeof key === 'string') ||
      !saved.original.length || saved.original.length !== saved.order.length ||
      new Set(saved.original).size !== saved.original.length || new Set(saved.order).size !== saved.order.length ||
      saved.order.some(key => typeof key !== 'string' || !saved!.original.includes(key))) {
      throw new Error('Saved question order is invalid; progress was preserved.');
    }
  }
  const base = [...queue];
  const keys = base.map(keyOf);
  const untouched = saved && cursor.nextKey === saved.initial.nextKey && cursor.lastCompletedKey === saved.initial.lastCompletedKey;
  const applicable = saved && (untouched || (cursor.nextKey ? saved.order.includes(cursor.nextKey) :
    !!cursor.lastCompletedKey && saved.order.includes(cursor.lastCompletedKey)));
  if (saved && applicable) {
    const start = keys.indexOf(saved.original[0]!);
    if (start < 0 || saved.original.some((key, index) => keys[start + index] !== key)) {
      throw new Error('Source queue changed inside an unfinished shuffled batch; progress was preserved.');
    }
    const byKey = new Map(base.map(item => [keyOf(item), item]));
    base.splice(start, saved.order.length, ...saved.order.map(key => byKey.get(key)!));
    // A crash between saving a plan and finishing its first item leaves the
    // original cursor unchanged. Recover the selected head in that case.
    const nextKey = untouched ?
      saved.order[0]! : cursor.nextKey;
    return { queue: base, nextKey, initial };
  }
  if (count <= 1 || startIndex >= base.length) return { queue: base, nextKey: cursor.nextKey, initial };
  const window = base.slice(startIndex, startIndex + count);
  const original = window.map(keyOf);
  const order = shuffle(original);
  const plan: Plan = { version: 1, original, order, initial };
  await setSystemState(stateKey, JSON.stringify(plan));
  const byKey = new Map(window.map(item => [keyOf(item), item]));
  base.splice(startIndex, window.length, ...order.map(key => byKey.get(key)!));
  return { queue: base, nextKey: order[0] ?? cursor.nextKey, initial };
}
