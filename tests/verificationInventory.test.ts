import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { collectVerificationInventory, logVerificationInventory } from '../src/codeforces/verificationDiagnostics';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

it('distinguishes mixed markers inside/outside the form without exposing keys or field values', async () => {
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  await page.setContent(`<div class="cf-turnstile" data-sitekey="PRIVATE_OUTSIDE"></div>
    <form><textarea name="source">PRIVATE_CODE</textarea>
      <div class="g-recaptcha" data-sitekey="PRIVATE_INSIDE"></div>
      <textarea name="g-recaptcha-response">PRIVATE_TOKEN</textarea>
      <iframe src="https://example.invalid/widget?secret=PRIVATE_QUERY"></iframe>
    </form>`);
  const before = await page.content();
  const result = await page.evaluate(collectVerificationInventory, 'PRIVATE_OUTSIDE');
  expect(result.markers.turnstile).toEqual({ page: 1, form: 0 });
  expect(result.markers.recaptcha).toEqual({ page: 1, form: 1 });
  expect(result.selectedKeyMatchesInForm).toBe(0);
  expect(result.selectedKeyMatchesOutsideForm).toBe(1);
  expect(result.frameOrigins).toEqual([{ origin: 'https://example.invalid', inForm: true }]);
  expect(result.scriptOrigins).toEqual([]);
  expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  expect(await page.content()).toBe(before);
  await page.close();
});

it('records an unavailable snapshot without throwing or logging a page error', async () => {
  const page = await browser.newPage();
  await page.close();
  await expect(logVerificationInventory(page, 'closed-fixture')).resolves.toBeUndefined();
});

it('bounds iframe inventory and tolerates a missing form and malformed URL', async () => {
  const page = await browser.newPage();
  await page.setContent('<iframe src="http://["></iframe>' + '<iframe></iframe>'.repeat(21));
  const result = await page.evaluate(collectVerificationInventory, null);
  expect(result.formPresent).toBe(false);
  expect(result.frameCount).toBe(22);
  expect(result.framesTruncated).toBe(true);
  expect(result.frameOrigins).toHaveLength(20);
  expect(result.frameOrigins[0].origin).toBe('unavailable');
  await page.close();
});
