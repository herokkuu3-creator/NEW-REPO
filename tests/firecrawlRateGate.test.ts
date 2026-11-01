import { afterEach, describe, expect, it, vi } from 'vitest';
import { FirecrawlRateGate } from '../src/solutionPosts/firecrawlRateGate';

afterEach(() => vi.useRealTimers());
describe('shared Firecrawl Agent start queue', () => {
  it('paces simultaneous callers to two starts per minute', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const gate = new FirecrawlRateGate();
    const starts: number[] = [];
    const jobs = [1, 2, 3].map(() => gate.acquire(601000, 'test').then(() => { starts.push(Date.now()); }));
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([1000]);
    await vi.advanceTimersByTimeAsync(31000);
    expect(starts).toEqual([1000, 32000]);
    await vi.advanceTimersByTimeAsync(31000);
    await Promise.all(jobs);
    expect(starts).toEqual([1000, 32000, 63000]);
  });
  it('rechecks a provider cooldown learned while another caller was waiting', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const gate = new FirecrawlRateGate();
    await gate.acquire(601000, 'first');
    let started = false;
    const next = gate.acquire(601000, 'next').then(() => { started = true; });
    await vi.advanceTimersByTimeAsync(10000);
    gate.defer(60000);
    await vi.advanceTimersByTimeAsync(50000);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(10000);
    await next;
    expect(started).toBe(true);
  });
  it('rejects a wait beyond the caller budget and releases later callers', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const gate = new FirecrawlRateGate();
    gate.defer(60000);
    await expect(gate.acquire(5000, 'short')).rejects.toThrow('FIRECRAWL_QUEUE_TIMEOUT');
    const next = gate.acquire(601000, 'next');
    await vi.advanceTimersByTimeAsync(60000);
    await next;
  });
});
