import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODEFORCES_ATTEMPT_MS, readBeforeDeadline, runSubmissionAttempts } from '../src/codeforces/attempts';
import { ActionBroker } from '../src/codeforces/actionBroker';
import { waitForActionResult } from '../src/codeforces/remoteSubmitter';
import { renderCodeforcesProgressLines } from '../src/notifications/telegramBot';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('bounded Codeforces attempts', () => {
  it('retries the same source three times at most with a fresh eight-minute budget', async () => {
    const calls: number[] = [];
    const phases: string[] = [];
    const result = await runSubmissionAttempts(async (deadline, attempt) => {
      expect(deadline - Date.now()).toBeLessThanOrEqual(CODEFORCES_ATTEMPT_MS);
      expect(deadline - Date.now()).toBeGreaterThan(CODEFORCES_ATTEMPT_MS - 1000);
      calls.push(attempt);
      return { ok: false, safeToRetry: true };
    }, (phase, attempt) => { phases.push(`${phase}:${attempt}`); });
    expect(result.ok).toBe(false);
    expect(calls).toEqual([1, 2, 3]);
    expect(phases).toEqual(['attempt:1', 'retry:2', 'attempt:2', 'retry:3', 'attempt:3']);
  });

  it('stops after a successful retry and never repeats a completed account', async () => {
    const completed = vi.fn(async () => ({ ok: true, submissionId: '101', verdict: 'OK' }));
    const next = vi.fn().mockResolvedValueOnce({ ok: false, safeToRetry: true })
      .mockResolvedValue({ ok: true, submissionId: '102', verdict: 'OK' });
    await runSubmissionAttempts(completed);
    await runSubmissionAttempts(next);
    expect(completed).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it.each(['Turnstile did not issue a token', 'Please complete the anti-bot verification',
    'HTTP 403', 'Cloudflare challenge did not clear'])('retries site verification with automated solver when safeToRetry: %s', async error => {
    const submit = vi.fn(async () => ({ ok: false, safeToRetry: true, error }));
    await runSubmissionAttempts(submit);
    expect(submit).toHaveBeenCalledTimes(3);
  });

  it.each([
    { ok: false, safeToRetry: false },
    { ok: false },
    { ok: false, safeToRetry: true, submissionId: '103', verdict: 'TESTING' },
    { ok: false, safeToRetry: true, submissionId: '104', verdict: 'WRONG_ANSWER' },
  ])('does not repost an uncertain or judged result %j', async result => {
    const submit = vi.fn(async () => result);
    await runSubmissionAttempts(submit);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('times out a read at the attempt deadline and clears its timer', async () => {
    vi.useFakeTimers();
    const read = readBeforeDeadline(new Promise(() => {}), Date.now() + 8000);
    const assertion = expect(read).rejects.toThrow('eight-minute limit');
    await vi.advanceTimersByTimeAsync(8000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('timeout cancellation and job polling', () => {
  it('cancels an unclaimed job atomically so a late runner cannot claim it', async () => {
    const broker = new ActionBroker(async () => {});
    const id = await broker.enqueue({ code: 'original' });
    expect(broker.cancelUnclaimed(id)).toBe(true);
    expect(broker.claim(id)).toBeNull();
    expect(broker.busy).toBe(false);
    expect(await broker.enqueue({ code: 'same source' })).not.toBe(id);
  });

  it('cannot cancel a claimed job and cannot start a duplicate job', async () => {
    const broker = new ActionBroker(async () => {});
    const id = await broker.enqueue({ code: 'original' });
    expect(broker.claim(id)).toEqual({ code: 'original' });
    expect(broker.cancelUnclaimed(id)).toBe(false);
    await expect(broker.enqueue({ code: 'duplicate' })).rejects.toThrow('already running');
  });

  it('cancels a guarded claimed runner before POST and rejects its late authorization', async () => {
    const broker = new ActionBroker(async () => {});
    const id = await broker.enqueue({ requiresPostAuthorization: true });
    expect(broker.claim(id)).toBeNull(); // Legacy runners cannot bypass the guard during deployment.
    expect(broker.claim(id, true)).toEqual({ requiresPostAuthorization: true });
    expect(broker.cancelUnclaimed(id)).toBe(true);
    expect(broker.authorizePost(id)).toBe(false);
    expect(broker.busy).toBe(false);
  });

  it('does not cancel a guarded runner after it is authorized to submit', async () => {
    const broker = new ActionBroker(async () => {});
    const id = await broker.enqueue({ requiresPostAuthorization: true });
    broker.claim(id, true);
    expect(broker.authorizePost(id)).toBe(true);
    expect(broker.authorizePost(id)).toBe(false);
    expect(broker.cancelUnclaimed(id)).toBe(false);
    expect(broker.busy).toBe(true);
  });

  it.each([true, false])('allows retry only if the waiting job was cancelled: %s', async cancelled => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify(
      init?.method === 'POST' ? { cancelled } : { pending: true, claimed: !cancelled },
    ), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const progress = vi.fn();
    const result = waitForActionResult('https://broker.example', 'fixture-token', 'job', Date.now() + CODEFORCES_ATTEMPT_MS, progress);
    await vi.advanceTimersByTimeAsync(CODEFORCES_ATTEMPT_MS);
    expect(await result).toMatchObject({ ok: false, safeToRetry: cancelled, clicked: !cancelled });
    expect(fetch.mock.calls.at(-1)?.[0]).toBe('https://broker.example/jobs/job/cancel');
    expect(progress).toHaveBeenCalledWith(cancelled ? 'queued' : 'running');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports queued then running then the actual result without another submission', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ pending: true, claimed: false })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ pending: true, claimed: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ pending: false, result: { ok: true, clicked: true } })));
    vi.stubGlobal('fetch', fetch);
    const progress = vi.fn();
    const result = waitForActionResult('https://broker.example', 'fixture-token', 'job', Date.now() + CODEFORCES_ATTEMPT_MS, progress);
    await vi.advanceTimersByTimeAsync(9000);
    expect(await result).toEqual({ ok: true, clicked: true });
    expect(progress.mock.calls).toEqual([['queued'], ['running']]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

it('keeps final error rows and the current account visible within Telegram limits', () => {
  const rows = new Map<number, string>();
  for (let i = 1; i <= 16; i++) rows.set(i, `<b>Account ${i}</b> ${'failed '.repeat(150)}`);
  const rendered = renderCodeforcesProgressLines(rows).join('\n');
  expect(rendered.length).toBeLessThan(3700);
  expect(rendered).toContain('<b>Account 16</b>');
  expect(rendered).toContain('earlier account result');
  expect((rendered.match(/<b>/g) ?? []).length).toBe((rendered.match(/<\/b>/g) ?? []).length);
});
