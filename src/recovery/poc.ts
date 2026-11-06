import { LOGIN_URL, USERNAME, verificationState } from '../leetcode/auth';
import { openRemoteBrowser, type RemoteBrowserOptions } from './remoteBrowser';

export type PocVerdict =
  | 'LOGIN_FORM_REACHED' // no human step was even needed from this network
  | 'HUMAN_VERIFICATION_PRESENTED' // a challenge was served; a remote human can attempt it
  | 'BLOCKED' // hard block page: remote verification is NOT viable from this network
  | 'NAVIGATION_FAILED';

export interface PocResult {
  verdict: PocVerdict;
  httpStatus: number | null;
  title: string | null;
  finalUrl: string | null;
  challengePage: boolean;
  turnstileFramePresent: boolean;
  loginFormVisible: boolean;
  hardBlockText: string | null;
  screencastFrames: number;
  frameBytes: number;
  inputPipelineWorks: boolean;
  userAgent: string | null;
  elapsedMs: number;
  note: string;
}

const HARD_BLOCK = /you have been blocked|access denied|error code:?\s*(1020|1015|1006|1005|1009|1010)|sorry, you have been blocked/i;

/**
 * Proof of concept: opens the REAL LeetCode login page in the same plain remote
 * browser the recovery portal uses, and records exactly how LeetCode/Cloudflare
 * respond. It never clicks, solves or alters any challenge.
 */
export async function runRemoteBrowserPoc(
  opts: RemoteBrowserOptions & { url?: string; settleMs?: number } = {},
): Promise<PocResult & { screenshot: Buffer | null }> {
  const started = Date.now();
  const empty: PocResult = {
    verdict: 'NAVIGATION_FAILED',
    httpStatus: null,
    title: null,
    finalUrl: null,
    challengePage: false,
    turnstileFramePresent: false,
    loginFormVisible: false,
    hardBlockText: null,
    screencastFrames: 0,
    frameBytes: 0,
    inputPipelineWorks: false,
    userAgent: null,
    elapsedMs: 0,
    note: '',
  };
  const browser = await openRemoteBrowser(opts);
  try {
    const page = browser.page;
    let httpStatus: number | null = null;
    try {
      const res = await page.goto(opts.url ?? LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      httpStatus = res?.status() ?? null;
    } catch {
      return { ...empty, elapsedMs: Date.now() - started, note: 'navigation to the login page failed from this network', screenshot: null };
    }

    // Allow non-interactive challenges to resolve on their own (browser behaviour only).
    const settleUntil = Date.now() + (opts.settleMs ?? 8000);
    let challenge: 'none' | 'required' = 'required';
    let formVisible = false;
    while (Date.now() < settleUntil) {
      challenge = await verificationState(page).catch(() => 'required' as const);
      formVisible = await page.locator(USERNAME).first().isVisible().catch(() => false);
      if (formVisible && challenge === 'none') break;
      await new Promise((r) => setTimeout(r, 400));
    }

    // Prove the remote-input pipeline reaches the page (mouse events only).
    await page.evaluate(() => {
      (window as unknown as { __pocMoves: number }).__pocMoves = 0;
      window.addEventListener('mousemove', () => {
        (window as unknown as { __pocMoves: number }).__pocMoves += 1;
      });
    }).catch(() => undefined);
    await browser.input({ type: 'move', x: 100, y: 100 });
    await browser.input({ type: 'move', x: 220, y: 180 });
    const moves = await page
      .evaluate(() => (window as unknown as { __pocMoves?: number }).__pocMoves ?? 0)
      .catch(() => 0);

    const title = await page.title().catch(() => null);
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 600) ?? '').catch(() => '');
    const turnstile =
      (await page.locator('iframe[src*="challenges.cloudflare.com"], .cf-turnstile').count().catch(() => 0)) > 0;
    const hardBlock = HARD_BLOCK.exec(`${title ?? ''} ${bodyText}`)?.[0] ?? null;
    const shot = await browser.snapshot();
    const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => null);

    let verdict: PocVerdict;
    let note: string;
    if (formVisible && challenge === 'none') {
      verdict = 'LOGIN_FORM_REACHED';
      note = 'The real login form rendered with no verification pending; the server could fill and submit it unattended from this network.';
    } else if (hardBlock && !turnstile) {
      verdict = 'BLOCKED';
      note = 'LeetCode/Cloudflare served a hard block page, not a solvable challenge: remote interactive verification is NOT viable from this network.';
    } else if (challenge === 'required') {
      verdict = 'HUMAN_VERIFICATION_PRESENTED';
      note = 'A verification challenge was served and is viewable/clickable through the remote browser. Whether a human completes it and Cloudflare accepts the result must be confirmed by an actual human attempt.';
    } else {
      verdict = 'NAVIGATION_FAILED';
      note = 'The page loaded without a login form or a recognisable challenge.';
    }

    return {
      verdict,
      httpStatus,
      title,
      finalUrl: page.url(),
      challengePage: challenge === 'required',
      turnstileFramePresent: turnstile,
      loginFormVisible: formVisible,
      hardBlockText: hardBlock,
      screencastFrames: browser.frameCount(),
      frameBytes: shot?.length ?? 0,
      inputPipelineWorks: moves >= 2,
      userAgent,
      elapsedMs: Date.now() - started,
      note,
      screenshot: shot,
    };
  } finally {
    await browser.close();
  }
}
