import { afterEach, expect, it, vi } from 'vitest';
import { RangeRequestGate } from '../src/scheduler/rangeRequestGate';
import { LeetCodeHttpError, parseRetryAfter } from '../src/leetcode/apiClient';
import { LeetCodeApi } from '../src/leetcode/apiClient';
import { z } from 'zod';
import { abortableSleep } from '../src/scheduler/rangeSubmission';
afterEach(() => vi.useRealTimers());
it('serializes parallel submission starts across accounts', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const gate = new RangeRequestGate(Date.now); const signal = new AbortController().signal;
  const starts: number[] = [];
  const jobs = Array.from({ length: 4 }, () => gate.wait(true, abortableSleep, signal).then(() => starts.push(Date.now())));
  await vi.advanceTimersByTimeAsync(90000); await Promise.all(jobs);
  expect(starts).toEqual([0, 30000, 60000, 90000]);
});
it('applies Retry-After to every waiting account and rechecks a later extension', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const gate = new RangeRequestGate(Date.now); const signal = new AbortController().signal;
  gate.observe(new LeetCodeHttpError('HTTP 429', 429, 125000));
  const starts: number[] = [];
  const pending = gate.wait(true, abortableSleep, signal).then(() => starts.push(Date.now()));
  await vi.advanceTimersByTimeAsync(120000); expect(starts).toEqual([]);
  gate.observe(new LeetCodeHttpError('HTTP 429', 429, 60000));
  await vi.advanceTimersByTimeAsync(59999); expect(starts).toEqual([]);
  await vi.advanceTimersByTimeAsync(1); await pending; expect(starts).toEqual([180000]);
});
it('cancels a queued submit without sending and keeps CSRF separate from throttling', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const gate = new RangeRequestGate(Date.now); const controller = new AbortController();
  gate.observe(new LeetCodeHttpError('HTTP 429', 429));
  const pending = gate.wait(true, abortableSleep, controller.signal).catch(error => error);
  controller.abort(); expect((await pending).message).toContain('cancelled');
  const fresh = new RangeRequestGate(Date.now);
  fresh.observe(new LeetCodeHttpError('CSRF failed', 403));
  await fresh.wait(true, abortableSleep, new AbortController().signal);
  expect(Date.now()).toBe(0);
});
it('parses numeric and dated Retry-After values without guessing a daily quota', () => {
  expect(parseRetryAfter('125')).toBe(125000);
  expect(parseRetryAfter('Sun, 08 Nov 2026 18:00:00 GMT', Date.parse('2026-11-08T17:59:00Z'))).toBe(60000);
  expect(parseRetryAfter('invalid')).toBeUndefined();
});
it('retains actual Retry-After response headers from question and submission endpoints', async () => {
  const post = vi.fn(async () => ({ status: () => 429, text: async () => '{}', headers: () => ({ 'retry-after': '125' }) }));
  const api = new LeetCodeApi({ request: { post }, cookies: async () => [{ name: 'csrftoken', value: 'test' }] } as any);
  await expect(api.graphql('query {}', {}, z.unknown())).rejects.toMatchObject({ status: 429, retryAfterMs: 125000 });
  await expect(api.submitSolution({ slug: 'example', questionId: '1', lang: 'cpp', code: 'source' })).rejects.toMatchObject({ status: 429, retryAfterMs: 125000 });
});

it('applies a judge 429 to the shared gate before attempting another endpoint', async () => {
  const gate = new RangeRequestGate();
  const signal = new AbortController().signal;
  const dispose = vi.fn(async () => undefined);
  const get = vi.fn(async () => ({ status: () => 429, text: async () => '{}', headers: () => ({ 'retry-after': '90' }), dispose }));
  const post = vi.fn();
  const api = new LeetCodeApi({ request: { get, post }, cookies: async () => [] } as any, {
    beforeRequest: deadline => gate.wait(false, abortableSleep, signal, undefined, deadline),
    observe: error => gate.observe(error), signal, timeoutMs: 20_000,
  });
  await expect(api.awaitSubmission('2192767591', 'example', 5_000, { firstPollDelayMs: 1 })).rejects.toMatchObject({ status: 429, retryAfterMs: 90_000 });
  expect(get).toHaveBeenCalledTimes(1);
  expect(post).not.toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledTimes(1);
  await expect(gate.wait(true, abortableSleep, signal, undefined, Date.now() + 80_000)).rejects.toThrow('window expired');
});
