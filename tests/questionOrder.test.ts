import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ state: new Map<string, string>() }));
vi.mock('../src/database/models', () => ({
  getSystemState: vi.fn(async (key: string) => h.state.get(key) ?? null),
  setSystemState: vi.fn(async (key: string, value: string) => { h.state.set(key, value); }),
}));
import { shuffled, prepareShuffledBatch, plannedProgress, accountQuestionOrders, QuestionReservations } from '../src/scheduler/questionOrder';
import { setSystemState } from '../src/database/models';

const reverse = (keys: readonly string[]) => [...keys].reverse();
const cursor = { nextKey: 'A', lastCompletedKey: null };
beforeEach(() => { h.state.clear(); vi.clearAllMocks(); });

describe('per-account question permutations', () => {
  it('assigns distinct starts to the first parallel group and preserves every account permutation', () => {
    const numbers = Array.from({ length: 11 }, (_, i) => 3700 + i);
    const orders = accountQuestionOrders(numbers, 15, values => [...values].reverse());
    expect(new Set(orders.slice(0, 5).map(order => order[0])).size).toBe(5);
    expect(new Set(orders.slice(0, 11).map(order => order[0])).size).toBe(11);
    expect(orders).toHaveLength(15);
    for (const order of orders) expect([...order].sort((a, b) => a - b)).toEqual(numbers);
    expect(accountQuestionOrders([1], 3)).toEqual([[1], [1], [1]]);
  });
  it('reserves different available questions and releases waiters without leaking cancelled claims', async () => {
    const reservations = new QuestionReservations();
    const controller = new AbortController();
    expect(await reservations.claim([1, 2], controller.signal)).toBe(1);
    expect(await reservations.claim([1, 2], controller.signal)).toBe(2);
    const waiting = vi.fn();
    const blocked = reservations.claim([1, 2], controller.signal, waiting);
    expect(waiting).toHaveBeenCalledOnce();
    reservations.release(2);
    expect(await blocked).toBe(2);
    const cancelled = reservations.claim([1, 2], controller.signal);
    controller.abort();
    expect(await cancelled).toBeNull();
    reservations.release(1);
    reservations.release(2);
    expect(await reservations.claim([1], new AbortController().signal)).toBe(1);
  });

  it('uses a permutation without mutating, repeating, or dropping any selected item', () => {
    const input = Array.from({ length: 51 }, (_, i) => 50 + i);
    const order = shuffled(input, () => 0);
    expect(order).not.toEqual(input);
    expect([...order].sort((a, b) => a - b)).toEqual(input);
    expect(new Set(order).size).toBe(51);
    expect(input[0]).toBe(50);
    expect(shuffled([])).toEqual([]);
    expect(shuffled([99])).toEqual([99]);
  });
  it('persists independent account/platform orders and preserves the queue prefix and suffix', async () => {
    const source = ['old', 'A', 'B', 'C', 'D'];
    const a = await prepareShuffledBatch('codeforces', 'a', source, cursor, 1, 3, x => x, reverse);
    const b = await prepareShuffledBatch('codeforces', 'b', source, cursor, 1, 3, x => x,
      keys => [keys[1]!, keys[2]!, keys[0]!]);
    expect(a.queue).toEqual(['old', 'C', 'B', 'A', 'D']);
    expect(b.queue).toEqual(['old', 'B', 'C', 'A', 'D']);
    expect(a.nextKey).toBe('C');
    expect(b.nextKey).toBe('B');
    expect(source).toEqual(['old', 'A', 'B', 'C', 'D']);
    const cc = await prepareShuffledBatch('codechef', 'a', source, cursor, 1, 3, x => x, keys => [...keys]);
    expect(cc.queue).toEqual(source);
  });
  it('reuses a saved plan across restart before the first completion, including a null initial cursor', async () => {
    const initial = { nextKey: null, lastCompletedKey: null };
    await prepareShuffledBatch('codechef', 'a', ['A', 'B', 'C'], initial, 0, 3, x => x, reverse);
    const mustNotShuffle = vi.fn(() => { throw new Error('must reuse saved permutation'); });
    const resumed = await prepareShuffledBatch('codechef', 'a', ['A', 'B', 'C'], initial, 0, 1, x => x, mustNotShuffle);
    expect(resumed.queue).toEqual(['C', 'B', 'A']);
    expect(plannedProgress(resumed, initial).nextKey).toBe('C');
    expect(mustNotShuffle).not.toHaveBeenCalled();
  });
  it('keeps an interrupted problem pending and never revisits earlier items on resume', async () => {
    await prepareShuffledBatch('codeforces', 'a', ['A', 'B', 'C', 'D'], cursor, 0, 3, x => x, reverse);
    const afterOne = { nextKey: 'B', lastCompletedKey: 'C' };
    const resumed = await prepareShuffledBatch('codeforces', 'a', ['A', 'B', 'C', 'D'], afterOne, 1, 2, x => x, reverse);
    expect(resumed.queue).toEqual(['C', 'B', 'A', 'D']);
    expect(resumed.nextKey).toBe('B');
    expect(plannedProgress(resumed, { nextKey: 'A', lastCompletedKey: 'B' }).nextKey).toBe('A');
    expect(setSystemState).toHaveBeenCalledTimes(1);
  });
  it('moves to the next untouched window after completing a permutation', async () => {
    await prepareShuffledBatch('codechef', 'a', ['A', 'B', 'C', 'D', 'E'], cursor, 0, 3, x => x, reverse);
    const next = await prepareShuffledBatch('codechef', 'a', ['A', 'B', 'C', 'D', 'E'],
      { nextKey: 'D', lastCompletedKey: 'A' }, 3, 2, x => x, reverse);
    expect(next.queue).toEqual(['A', 'B', 'C', 'E', 'D']);
    expect(next.nextKey).toBe('E');
  });
  it('retains the end-of-queue permutation so exhaustion cannot restart completed items', async () => {
    await prepareShuffledBatch('codechef', 'a', ['A', 'B', 'C'], cursor, 0, 3, x => x, reverse);
    const done = await prepareShuffledBatch('codechef', 'a', ['A', 'B', 'C'],
      { nextKey: null, lastCompletedKey: 'A' }, 1, 3, x => x, reverse);
    expect(done.queue).toEqual(['C', 'B', 'A']);
    expect(done.queue.indexOf('A') + 1).toBe(done.queue.length);
    expect(setSystemState).toHaveBeenCalledTimes(1);
  });
  it('fails before submission when saved order or an unfinished source window is inconsistent', async () => {
    h.state.set('question-order:v1:codechef:a', 'broken json');
    await expect(prepareShuffledBatch('codechef', 'a', ['A', 'B'], cursor, 0, 2, x => x)).rejects.toThrow('unreadable');
    h.state.clear();
    await prepareShuffledBatch('codechef', 'a', ['A', 'B', 'C'], cursor, 0, 3, x => x, reverse);
    await expect(prepareShuffledBatch('codechef', 'a', ['A', 'new', 'B', 'C'], cursor, 0, 3, x => x)).rejects.toThrow('Source queue changed');
  });
});
