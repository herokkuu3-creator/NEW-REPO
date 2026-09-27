import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountOutcome, RunReport } from '../src/scheduler/report';

/** Telegram /triggersubmission — no network: sendTelegramMessage is mocked. */

const sent = vi.hoisted(() => [] as string[]);
vi.mock('../src/notifications/telegram', () => ({
  sendTelegramMessage: vi.fn(async (t: string) => {
    sent.push(t);
    return true;
  }),
}));

import { handleTriggerSubmission } from '../src/notifications/telegramBot';
import { buildReport, formatAccountMessage, formatReportForTelegram } from '../src/scheduler/report';

const outcomes: AccountOutcome[] = [
  { label: 'a1', username: 'a1', kind: 'solved', state: 'SUCCESS', submissionId: '11', submissionStatus: 'Accepted', runtime: '0 ms', memory: '8.6 MB' },
  { label: 'a2', kind: 'failed', state: 'SUBMISSION_REJECTED', submissionId: '12', error: 'judge verdict: Wrong Answer' },
  { label: 'a3', username: 'a3', kind: 'rejected', error: 'LeetCode rejected the transferred session' },
];

function fakeRunner(list: AccountOutcome[]) {
  return vi.fn(async (_reason: string, opts?: { onAccountOutcome?: (o: AccountOutcome, i: number, t: number) => unknown }) => {
    for (let i = 0; i < list.length; i++) await opts?.onAccountOutcome?.(list[i]!, i + 1, list.length);
    return buildReport({ date: '2026-09-27', reason: 'trigger-submission', startedAt: 'x', outcomes: list }) as RunReport;
  });
}

beforeEach(() => {
  sent.length = 0;
});

describe('formatAccountMessage', () => {
  it('renders one account with index and submission id', () => {
    expect(formatAccountMessage(outcomes[0]!, 1, 3)).toBe(
      'Account 1/3 — [OK] a1 (a1) — Accepted · 0 ms · 8.6 MB\nSubmission ID: 11',
    );
    expect(formatAccountMessage(outcomes[1]!, 2, 3)).toBe(
      'Account 2/3 — [FAIL] a2 — SUBMISSION_REJECTED: judge verdict: Wrong Answer\nSubmission ID: 12',
    );
    expect(formatAccountMessage(outcomes[2]!, 3, 3)).toBe(
      'Account 3/3 — [REJECTED] a3 (a3) — LeetCode rejected the transferred session',
    );
  });

  it('the aggregated report text is unchanged by the refactor', () => {
    const r = buildReport({ date: '2026-09-27', reason: 'cron', startedAt: 'x', outcomes });
    expect(formatReportForTelegram(r)).toBe(
      [
        'LeetCode Daily Report — 2026-09-27',
        '3 account(s): 1 solved, 1 rejected, 1 failed',
        '',
        '[OK] a1 (a1) — Accepted · 0 ms · 8.6 MB',
        '[FAIL] a2 — SUBMISSION_REJECTED: judge verdict: Wrong Answer',
        '[REJECTED] a3 (a3) — LeetCode rejected the transferred session',
      ].join('\n'),
    );
  });
});

describe('/triggersubmission', () => {
  it('replies once at start, then one message per account, with the force reason', async () => {
    const runner = fakeRunner(outcomes);
    const handle = await handleTriggerSubmission(runner as never, () => false);
    expect(handle).not.toBeNull();
    await handle!.done;

    expect(runner).toHaveBeenCalledWith('trigger-submission', expect.any(Object));
    expect(sent).toHaveLength(1 + outcomes.length);
    expect(sent[0]).toMatch(/Submitting today's daily question for all accounts/);
    expect(sent[1]).toMatch(/^Account 1\/3 — \[OK\] a1/);
    expect(sent[2]).toMatch(/^Account 2\/3 — \[FAIL\] a2/);
    expect(sent[3]).toMatch(/^Account 3\/3 — \[REJECTED\] a3/);
  });

  it('does not block: returns before the run finishes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runner = vi.fn(async () => {
      await gate;
      return buildReport({ date: 'd', reason: 'r', startedAt: 'x', outcomes: [] });
    });
    const handle = await handleTriggerSubmission(runner as never, () => false);
    expect(handle).not.toBeNull(); // returned while the run is still gated
    release();
    await handle!.done;
  });

  it('refuses while a run is in progress', async () => {
    const runner = fakeRunner(outcomes);
    const handle = await handleTriggerSubmission(runner as never, () => true);
    expect(handle).toBeNull();
    expect(runner).not.toHaveBeenCalled();
    expect(sent).toEqual([expect.stringMatching(/already in progress/)]);
  });

  it('reports a race (runner returned null) and no-accounts', async () => {
    const h1 = await handleTriggerSubmission((async () => null) as never, () => false);
    await h1!.done;
    expect(sent.at(-1)).toMatch(/another run began/);

    const h2 = await handleTriggerSubmission(fakeRunner([]) as never, () => false);
    await h2!.done;
    expect(sent.at(-1)).toMatch(/No accounts configured/);
  });

  it('reports a crash instead of failing silently', async () => {
    const h = await handleTriggerSubmission((async () => { throw new Error('boom'); }) as never, () => false);
    await h!.done;
    expect(sent.at(-1)).toBe('/triggersubmission failed: boom');
  });
});
