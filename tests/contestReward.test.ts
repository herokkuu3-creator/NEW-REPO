import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import type { AccountRecord } from '../src/database/accounts';
import { claimContestReward, isContestRewardCandidate } from '../src/leetcode/contestReward';
import { buildCoinClaimPicker } from '../src/notifications/telegramBot';
import { formatOutcomeLine } from '../src/scheduler/report';

function account(id: string, label: string): AccountRecord {
  return { id, label, username: label, status: 'ACTIVE' } as unknown as AccountRecord;
}

describe('LeetCode contest reward safety', () => {
  it('accepts reward controls in the contest-page promotion area', () => {
    expect(isContestRewardCandidate({ text: 'Unbox surprise', x: 20, y: 110, width: 180, height: 42 })).toBe(true);
    expect(isContestRewardCandidate({ text: 'Claim your LeetCoins', x: 30, y: 140, width: 200, height: 40 })).toBe(true);
    expect(isContestRewardCandidate({ text: 'Mystery drop', x: 25, y: 120, width: 160, height: 40 })).toBe(true);
  });

  it('does not treat contest actions or distant navigation as rewards', () => {
    expect(isContestRewardCandidate({ text: 'Register Weekly Contest', x: 20, y: 110, width: 180, height: 42 })).toBe(false);
    expect(isContestRewardCandidate({ text: 'LeetCoin Store', x: 900, y: 40, width: 120, height: 40 })).toBe(false);
  });

  it('adds the collection note only after a confirmed claim', () => {
    const base = { label: 'dom9090', username: 'dom9090', kind: 'solved' as const, submissionStatus: 'Accepted', runtime: '0 ms', memory: '7.9 MB' };
    expect(formatOutcomeLine(base)).toBe('✅ dom9090 (dom9090) — Accepted · 0 ms · 7.9 MB');
    expect(formatOutcomeLine({ ...base, coinsCollected: true })).toBe(
      '✅ dom9090 (dom9090) — Accepted · 0 ms · 7.9 MB || Coins offered collected',
    );
  });

  it('clicks an authenticated contest-page offer in an isolated browser tab', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.route('https://leetcode.com/contest/', async (route) => {
      await route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><body>
          <button id="offer" style="position:fixed;left:20px;top:110px;width:180px;height:42px"
            onclick="this.remove();document.getElementById('done').style.display='block'">Mystery drop</button>
          <div id="done" role="alert" style="display:none">Reward collected</div>
        </body>`,
      });
    });
    try {
      await expect(claimContestReward(context, 'test')).resolves.toEqual({ offered: true, claimed: true });
    } finally {
      await context.close();
      await browser.close();
    }
  }, 10_000);
});

describe('/claimcoins picker', () => {
  it('supports individual multi-selection and an ALL option', () => {
    const accounts = [account('a1', 'first'), account('a2', 'second')];
    const view = buildCoinClaimPicker(accounts, new Set(['a2']));
    expect(view.buttons.map((row) => row[0]!.callback_data)).toEqual([
      'lccoin:a:a1',
      'lccoin:a:a2',
      'lccoin:all',
      'lccoin:run',
    ]);
    expect(view.buttons[0]![0]!.text).toContain('▫️');
    expect(view.buttons[1]![0]!.text).toContain('✅');
    expect(view.buttons[2]![0]!.text).toContain('ALL (2)');
    expect(view.buttons[3]![0]!.text).toContain('Claim selected (1)');
  });
});
