import { describe, expect, it } from 'vitest';
import { Page } from 'playwright';
import { firstUnsolvedIndex, handoffCaption, submitPageUrl } from '../src/codeforces/handoff';
import { CodeforcesBlockedError, CodeforcesSubmissionError, openSubmitForm } from '../src/codeforces/submission';
import { buildCodeforcesReport, formatCodeforcesAccountMessage, summarizeCodeforcesReport } from '../src/codeforces/report';
import { SourceIndexEntry } from '../src/codeforces/sourceRepo';

const entry = (contestId: number, problemIndex: string, extra: Partial<SourceIndexEntry> = {}) =>
  ({ key: `${contestId}${problemIndex}.cpp`, contestId, problemIndex, problemName: 'P', fileName: 'f.cpp', language: 'cpp', gym: false, ...extra }) as SourceIndexEntry;

function blockedPage(): Page {
  let current = '';
  return {
    goto: async (url: string) => { current = url; return { status: () => 403 }; },
    url: () => current,
    title: async () => 'Just a moment...',
    evaluate: async () => [],
    locator: () => ({ innerText: async () => '' }),
  } as unknown as Page;
}

describe('Cloudflare block classification', () => {
  it('throws CodeforcesBlockedError when every submit endpoint is challenged (the reported run)', async () => {
    const err = await openSubmitForm(blockedPage(), entry(1, 'A')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodeforcesBlockedError);
    expect(err).not.toBeInstanceOf(CodeforcesSubmissionError);
    expect(String((err as Error).message)).toMatch(/Cloudflare challenge/);
  });
});

describe('firstUnsolvedIndex', () => {
  const queue = [entry(1, 'A'), entry(2, 'A'), entry(4, 'A')];
  it('skips problems the handle already solved, which is how a handed-off solution is detected', () => {
    expect(firstUnsolvedIndex(queue, 0, new Set(['1/A']))).toBe(1);
    expect(firstUnsolvedIndex(queue, 0, new Set(['1/A', '2/A']))).toBe(2);
  });
  it('stays put when the current problem is unsolved', () => {
    expect(firstUnsolvedIndex(queue, 0, new Set(['2/A']))).toBe(0);
  });
  it('runs off the end when everything is solved', () => {
    expect(firstUnsolvedIndex(queue, 0, new Set(['1/A', '2/A', '4/A']))).toBe(3);
  });
});

describe('hand-off message', () => {
  it('links the exact submit page and language', () => {
    expect(submitPageUrl(entry(1, 'A'))).toBe('https://codeforces.com/problemset/submit/1/A');
    expect(submitPageUrl(entry(101021, '1', { gym: true }))).toBe('https://codeforces.com/gym/101021/submit');
    const caption = handoffCaption(entry(1, 'A', { problemName: 'Theatre Square' }), 'me_superman');
    expect(caption).toContain('1A — Theatre Square');
    expect(caption).toContain('https://codeforces.com/problemset/submit/1/A');
    expect(caption).toContain('G++');
    expect(caption.length).toBeLessThanOrEqual(1000);
  });

  it('reports a hand-off as pending, not failed', () => {
    const outcome = { label: 'me_superman', username: 'me_superman', kind: 'pending' as const, problem: '1A — Theatre Square' };
    const report = buildCodeforcesReport({ date: '2026-09-29', reason: 'x', startedAt: 'x', outcomes: [outcome] });
    expect(report.totals.pending).toBe(1);
    expect(report.totals.failed).toBe(0);
    expect(summarizeCodeforcesReport(report)).toContain('1 sent to you');
    expect(formatCodeforcesAccountMessage(outcome, 1, 1)).toContain('solution sent to you');
  });
});
