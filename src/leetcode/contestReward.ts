import type { BrowserContext, Locator, Page } from 'playwright';
import type { AccountRecord } from '../database/accounts';
import { parseStoredStorageState } from '../database/accounts';
import { checkSession } from '../browser/sessionCheck';
import { launchWithStorageStateObject } from '../browser/playwright';
import { detectVerificationPage } from '../browser/cloudflareDetector';
import { LeetCodeApi } from './apiClient';
import { logger } from '../logger';

export interface ContestRewardResult {
  offered: boolean;
  claimed: boolean;
  error?: string;
}

const CONTEST_URL = 'https://leetcode.com/contest/';
const OFFER_WORDS = /\b(unbox|surprise|lucky|reward|gift|bonus|claim|collect|coins?|leetcoins?)\b/i;
const EXCLUDED_WORDS = /\b(problems?|weekly|biweekly|contest|discuss|more|register|ranking|sponsor|store|premium)\b/i;
const CONFIRM_WORDS = /\b(claim|collect|receive|open|unbox)\b/i;
const SUCCESS_WORDS = /\b(congratulations|claimed|collected|received|reward|leetcoins?|coins?)\b/i;

/** Pure helper kept exported so the safety rules can be unit-tested. */
export function isContestRewardCandidate(input: {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}): boolean {
  const text = input.text.replace(/\s+/g, ' ').trim();
  return (
    text.length > 0 &&
    text.length <= 80 &&
    input.width > 0 &&
    input.height > 0 &&
    input.x >= 0 &&
    input.y >= 75 &&
    input.x <= 460 &&
    input.y <= 280 &&
    input.width <= 420 &&
    input.height <= 100 &&
    !EXCLUDED_WORDS.test(text) &&
    // Known reward words are preferred, while the position-based fallback
    // supports future promotion names. LeetCode currently reserves this
    // small top-left contest-page slot for the optional offer.
    (OFFER_WORDS.test(text) || (input.x <= 260 && input.y <= 220))
  );
}

async function findOffer(page: Page): Promise<Locator | null> {
  const controls = page.locator('button, a, [role="button"]');
  const details = await controls.evaluateAll((nodes) =>
    nodes.map((node) => {
      const el = node as HTMLElement;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return {
        text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim(),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        visible: style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || '1') > 0,
      };
    }),
  );
  const index = details.findIndex((item) => item.visible && isContestRewardCandidate(item));
  return index < 0 ? null : controls.nth(index);
}

async function visibleDialogText(page: Page): Promise<string> {
  return page
    .locator('[role="dialog"]:visible, [aria-modal="true"]:visible')
    .allInnerTexts()
    .then((parts) => parts.join(' '))
    .catch(() => '');
}

async function clickDialogConfirmation(page: Page): Promise<boolean> {
  const dialog = page.locator('[role="dialog"]:visible, [aria-modal="true"]:visible').last();
  if ((await dialog.count().catch(() => 0)) === 0) return false;
  const controls = dialog.locator('button:visible, a:visible, [role="button"]:visible');
  const labels = await controls.allInnerTexts().catch(() => [] as string[]);
  const index = labels.findIndex((text) => CONFIRM_WORDS.test(text.trim()) && !/cancel|close|later/i.test(text));
  if (index < 0) return false;
  await controls.nth(index).click({ timeout: 5_000 });
  return true;
}

/**
 * Claims the occasional contest-page reward using an isolated tab in an
 * already-authenticated context. Absence of an offer is a normal result.
 */
export async function claimContestReward(
  context: BrowserContext,
  label = 'account',
): Promise<ContestRewardResult> {
  let page: Page | null = null;
  try {
    page = await context.newPage();
    await page.goto(CONTEST_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (await detectVerificationPage(page)) {
      return { offered: false, claimed: false, error: 'LeetCode verification page blocked the contest reward check' };
    }

    // The contest shell is client-rendered. This short wait lets the optional
    // promotion mount without turning a missing offer into a long daily delay.
    await page.waitForTimeout(1_500);
    const offer = await findOffer(page);
    if (!offer) return { offered: false, claimed: false };

    const originalText = (await offer.innerText().catch(() => 'reward')).trim();
    await offer.click({ timeout: 7_500 });
    await page.waitForTimeout(700);
    const confirmationClicked = await clickDialogConfirmation(page);
    if (confirmationClicked) await page.waitForTimeout(900);

    const [offerStillVisible, dialogText, statusText] = await Promise.all([
      offer.isVisible().catch(() => false),
      visibleDialogText(page),
      page.locator('[role="status"]:visible, [role="alert"]:visible, [class*="toast"]:visible')
        .allInnerTexts()
        .then((parts) => parts.join(' '))
        .catch(() => ''),
    ]);
    const successText = `${dialogText} ${statusText}`;
    const claimed = confirmationClicked || !offerStillVisible || SUCCESS_WORDS.test(successText);
    logger.info({ label, offer: originalText.slice(0, 80), claimed }, 'LeetCode contest reward checked');
    return claimed
      ? { offered: true, claimed: true }
      : { offered: true, claimed: false, error: 'the reward control opened, but collection was not confirmed' };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn({ label, err: error }, 'LeetCode contest reward check failed without affecting submission');
    return { offered: false, claimed: false, error };
  } finally {
    await page?.close().catch(() => undefined);
  }
}

/** Runs one manual reward check from a stored account session. */
export async function claimContestRewardForAccount(account: AccountRecord): Promise<ContestRewardResult> {
  const parsed = parseStoredStorageState(account.storageState);
  if (!parsed.ok) return { offered: false, claimed: false, error: parsed.error };
  const session = await launchWithStorageStateObject(parsed.state, account.label);
  if (!session) return { offered: false, claimed: false, error: 'browser launch failed' };
  try {
    const check = await checkSession(new LeetCodeApi(session.context));
    if (!check.authenticated) {
      return { offered: false, claimed: false, error: 'LeetCode session is not authenticated; renew this account first' };
    }
    return await claimContestReward(session.context, account.label);
  } catch (err) {
    return { offered: false, claimed: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await session.close().catch(() => undefined);
  }
}
