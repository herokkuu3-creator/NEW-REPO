import { Page } from 'playwright';
import { logger } from '../logger';

/**
 * Cloudflare / bot-verification DETECTION ONLY.
 *
 * This module exists so the worker can recognize a verification interstitial
 * (Turnstile, challenge page, "verify you are human") and STOP GRACEFULLY
 * with a diagnostics bundle for the human operator. It contains no solving,
 * bypass, spoofing, or evasion logic of any kind — by design.
 */

export type DetectionKind =
  | 'turnstile'
  | 'challenge-page'
  | 'verify-page'
  | null;

const TITLE_PATTERNS: RegExp[] = [
  /just a moment/i,
  /attention required/i,
  /verify you are/i,
  /security check/i,
  /are you a robot/i,
];

const BODY_MARKERS: { kind: Exclude<DetectionKind, null>; pattern: RegExp }[] = [
  { kind: 'turnstile', pattern: /cf-turnstile/i },
  { kind: 'challenge-page', pattern: /challenge-platform|cf_chl_|challenge-form/i },
  { kind: 'verify-page', pattern: /verify you are (a )?human/i },
];

/**
 * Returns the kind of verification page detected, or null if the page looks
 * normal. Safe to call on any loaded page; never throws.
 */
export async function detectVerificationPage(page: Page): Promise<DetectionKind> {
  try {
    const url = page.url();
    if (/\/cdn-cgi\/challenge|\/cdn-cgi\/.*turnstile/i.test(url)) {
      logger.warn({ url }, 'Cloudflare challenge URL detected');
      return 'challenge-page';
    }

    const title = await page.title().catch(() => '');
    if (TITLE_PATTERNS.some((re) => re.test(title))) {
      logger.warn({ title, url }, 'verification page detected by title');
      return title.match(/just a moment/i) ? 'challenge-page' : 'verify-page';
    }

    // Cheap DOM probe, bounded timeout so a healthy page never stalls.
    const marker = await page
      .evaluate(() => {
        const html = document.documentElement?.innerHTML ?? '';
        if (/cf-turnstile/i.test(html)) return 'turnstile';
        if (/challenge-platform|cf_chl_|challenge-form/i.test(html)) return 'challenge-page';
        if (/verify you are (a )?human/i.test(document.body?.innerText ?? '')) return 'verify-page';
        return null;
      })
      .catch(() => null);

    if (marker) {
      logger.warn({ marker, url }, 'verification page detected by DOM marker');
      return marker as Exclude<DetectionKind, null>;
    }
    return null;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'verification detection probe failed — assuming page is normal',
    );
    return null;
  }
}
