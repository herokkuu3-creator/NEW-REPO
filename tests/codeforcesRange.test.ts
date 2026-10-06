import { describe, expect, it, vi } from 'vitest';
import {
  handleCodeforcesTrigger,
  renderCodeforcesProgressSections,
  CodeforcesAccountSectionState,
} from '../src/notifications/telegramBot';
import {
  formatCodeforcesRangeStatus,
  CodeforcesRangeJobInfo,
  cancelCodeforcesRun,
  getCodeforcesRangeStatus,
} from '../src/codeforces/worker';

describe('/cfrange and Codeforces trigger', () => {
  it('starts the real runner asynchronously for Codeforces', async () => {
    const runner = vi.fn(async () => ({
      date: '2026-10-06',
      reason: 'codeforces-manual',
      startedAt: 'now',
      finishedAt: 'now',
      totals: { accounts: 0, solved: 0, failed: 0, expired: 0, rejected: 0, skipped: 0, pending: 0 },
      accounts: [],
    }));
    const send = vi.fn(async () => undefined);
    const handle = await handleCodeforcesTrigger({ count: 5 }, runner as never, () => false, send);
    await handle!.done;
    expect(runner).toHaveBeenCalledWith('codeforces-manual', expect.objectContaining({ batchCount: 5, forceDailyAttempt: true }));
    expect(send.mock.calls[0]?.[0]).toContain('Codeforces');
  });

  it('does not start a second run when one is already in progress', async () => {
    const runner = vi.fn(async () => { throw new Error('should not be called'); });
    const send = vi.fn(async (_text: string) => undefined);
    expect(await handleCodeforcesTrigger({ count: 2 }, runner as never, () => true, send)).toBeNull();
    expect(runner).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[0]).toContain('already active');
  });
});

describe('renderCodeforcesProgressSections', () => {
  it('renders distinct account sections with proper headers and tree connectors', () => {
    const sections = new Map<number, CodeforcesAccountSectionState>([
      [
        0,
        {
          accIndex: 0,
          label: 'pts0003',
          username: 'pts0003',
          completedItems: [
            '✅ [1/2] <code>15A</code> — <b>OK</b> · #393347640',
            '✅ [2/2] <code>34B</code> — <b>OK</b> · #393347711',
          ],
        },
      ],
      [
        1,
        {
          accIndex: 1,
          label: 'sks4401',
          username: 'sks4401',
          completedItems: [],
          activeLine: '🚀 [1/2] Submitting <code>15A</code>…',
        },
      ],
    ]);

    const rendered = renderCodeforcesProgressSections(sections, 2);
    expect(rendered).toHaveLength(2);

    // Account 1 should show header and both completed questions
    expect(rendered[0]).toContain('👤 <b>Account 1/2 · <code>pts0003</code></b>');
    expect(rendered[0]).toContain('├ ✅ [1/2] <code>15A</code> — <b>OK</b> · #393347640');
    expect(rendered[0]).toContain('└ ✅ [2/2] <code>34B</code> — <b>OK</b> · #393347711');

    // Account 2 should show header and active submitting line
    expect(rendered[1]).toContain('👤 <b>Account 2/2 · <code>sks4401</code></b>');
    expect(rendered[1]).toContain('└ 🚀 [1/2] Submitting <code>15A</code>…');

    // Joining with \n\n creates distinct sections with spacing
    const fullBody = rendered.join('\n\n');
    expect(fullBody).toContain('Account 1/2');
    expect(fullBody).toContain('Account 2/2');
  });

  it('keeps completed verdict visible alongside active pacing line without overwriting', () => {
    const sections = new Map<number, CodeforcesAccountSectionState>([
      [
        0,
        {
          accIndex: 0,
          label: 'pts0003',
          username: 'pts0003',
          completedItems: [
            '✅ [1/5] <code>15A</code> — <b>OK</b> · #393347640',
          ],
          activeLine: '⏳ Waiting 30s before question [2/5] (human pacing)…',
        },
      ],
    ]);

    const rendered = renderCodeforcesProgressSections(sections, 1);
    expect(rendered).toHaveLength(1);

    // Completed verdict must be intact!
    expect(rendered[0]).toContain('├ ✅ [1/5] <code>15A</code> — <b>OK</b> · #393347640');
    // Pacing delay must be placed under it as the active leaf
    expect(rendered[0]).toContain('└ ⏳ Waiting 30s before question [2/5] (human pacing)…');
  });

  it('shows queued state for unstarted accounts', () => {
    const sections = new Map<number, CodeforcesAccountSectionState>([
      [
        0,
        {
          accIndex: 0,
          label: 'pts0003',
          username: 'pts0003',
          completedItems: [],
        },
      ],
    ]);

    const rendered = renderCodeforcesProgressSections(sections, 1);
    expect(rendered[0]).toContain('└ ⏳ Queued…');
  });
});

describe('formatCodeforcesRangeStatus', () => {
  it('formats running status with progress and counts', () => {
    const info: CodeforcesRangeJobInfo = {
      totalRequested: 10,
      completed: 3,
      skipped: 1,
      failed: 0,
      currentStep: 5,
      currentAccount: 'pts0003',
      currentProblem: '34B',
      startedAt: Date.now() - 45000,
      state: 'running',
    };

    const status = formatCodeforcesRangeStatus(info);
    expect(status).toContain('CODEFORCES RANGE STATUS');
    expect(status).toContain('Running');
    expect(status).toContain('<b>3</b> / 10');
    expect(status).toContain('pts0003');
    expect(status).toContain('34B');
    expect(status).toContain('/cfcancelrange');
  });

  it('formats waiting/pacing status with remaining seconds', () => {
    const now = Date.now();
    const info: CodeforcesRangeJobInfo = {
      totalRequested: 5,
      completed: 1,
      skipped: 0,
      failed: 0,
      currentStep: 1,
      currentAccount: 'pts0003',
      currentProblem: '15A',
      startedAt: now - 15000,
      state: 'waiting',
      waitEndsAt: now + 18000,
    };

    const status = formatCodeforcesRangeStatus(info, now);
    expect(status).toContain('Pacing delay');
    expect(status).toContain('18s remaining');
  });
});
