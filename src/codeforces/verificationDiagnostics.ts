import type { Page } from 'playwright';
import { diagnosticLog } from './diagnosticLog';

/** Read-only inventory: never collect field values, HTML, keys, or URL paths. */
export function collectVerificationInventory(selectedSitekey: string | null) {
  const form = document.querySelector('form:has(textarea[name="source"])');
  const count = (selector: string) => ({
    page: document.querySelectorAll(selector).length,
    form: form?.querySelectorAll(selector).length ?? 0,
  });
  const frames = Array.from(document.querySelectorAll('iframe'));
  const scripts = Array.from(document.scripts);
  const frameOrigins = frames.slice(0, 20).map(frame => {
    let origin = 'unavailable';
    try { origin = new URL(frame.getAttribute('src') ?? '', document.baseURI).origin; } catch {}
    return { origin, inForm: !!form?.contains(frame) };
  });
  const keys = Array.from(document.querySelectorAll('[data-sitekey], [data-key]'));
  const matches = selectedSitekey ? keys.filter(el =>
    el.getAttribute('data-sitekey') === selectedSitekey || el.getAttribute('data-key') === selectedSitekey) : [];
  return {
    formPresent: !!form,
    markers: {
      turnstile: count('.cf-turnstile'),
      recaptcha: count('.g-recaptcha'),
      hcaptcha: count('.h-captcha'),
      genericKey: count('[data-sitekey], [data-key]'),
      turnstileResponse: count('[name="cf-turnstile-response"], [name="turnstileToken"]'),
      recaptchaResponse: count('[name="g-recaptcha-response"]'),
      hcaptchaResponse: count('[name="h-captcha-response"]'),
    },
    frameCount: frames.length,
    framesTruncated: frames.length > 20,
    frameOrigins,
    scriptOrigins: scripts.slice(0, 20).map(script => {
      const src = script.getAttribute('src');
      if (!src) return 'inline';
      try { return new URL(src, document.baseURI).origin; } catch { return 'unavailable'; }
    }),
    scriptsTruncated: scripts.length > 20,
    selectedKeyPresent: !!selectedSitekey,
    selectedKeyMatchesInForm: matches.filter(el => form?.contains(el)).length,
    selectedKeyMatchesOutsideForm: matches.filter(el => !form?.contains(el)).length,
  };
}

export async function logVerificationInventory(page: Page, stage: string, selectedSitekey: string | null = null): Promise<void> {
  try {
    const inventory = await page.evaluate(collectVerificationInventory, selectedSitekey);
    diagnosticLog('browser-form', 30, { stage, ...inventory }, 'submission verification inventory');
  } catch {
    // Diagnostics must neither mask the original failure nor leak page errors.
    diagnosticLog('browser-form', 40, { stage }, 'submission verification inventory unavailable');
  }
}
