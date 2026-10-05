import type { Page, Request, Response } from 'playwright';

export interface VerificationFlags {
  turnstile: boolean;
  interactive: boolean;
}

export class BrowserFormError extends Error {
  constructor(
    message: string,
    readonly kind: 'blocked' | 'submission-error',
    readonly flags: VerificationFlags = { turnstile: false, interactive: false },
    readonly clicked = false,
  ) {
    super(message);
    this.name = 'BrowserFormError';
  }
}

/** Keep CSS and all verification resources; only omit decorative page assets. */
export function blockCodeforcesResource(url: string, type: string): boolean {
  const parsed = new URL(url);
  if (parsed.hostname === 'challenges.cloudflare.com' || parsed.pathname.startsWith('/cdn-cgi/')) return false;
  return type === 'image' || type === 'media' || type === 'font';
}

/** Preserve Codeforces' editor teardown and submit handlers instead of replacing window.editor. */
export async function fillSource(page: Page, code: string): Promise<void> {
  await page.evaluate((content) => {
    const toggle = document.getElementById('toggleEditorCheckbox') as HTMLInputElement | null;
    // "Switch off editor" is checked when the plain textarea is active.
    // Unchecking it re-enables Ace, whose submit handler can replace the source.
    if (toggle && !toggle.checked) toggle.click();
    const editor = (window as unknown as { editor?: { setValue?: (value: string, cursor?: number) => void } }).editor;
    // Keep the real editor in sync too, since some page versions save it on submit.
    if (typeof editor?.setValue === 'function') editor.setValue(content, -1);
    const source = document.querySelector('textarea[name="source"]') as HTMLTextAreaElement | null;
    if (!source) throw new Error('Codeforces submit form has no source textarea');
    source.value = content;
    source.dispatchEvent(new Event('input', { bubbles: true }));
    source.dispatchEvent(new Event('change', { bubbles: true }));
  }, code);
}

/** Read only visible validation labels, never textarea content or hidden tokens. */
export async function submissionFeedback(page: Page): Promise<string | null> {
  const errors = await page.locator('.error, .error-message, .alert-danger, .notice, [class*="error-for__"]')
    .evaluateAll((nodes) => nodes.filter((node) => {
      const element = node as HTMLElement;
      return element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0;
    }).map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean))
    .catch(() => [] as string[]);
  const text = [...new Set(errors)].join(' · ').slice(0, 600);
  // Redact token-like query values should a validation label include a URL.
  return text ? text.replace(/(csrf_token|turnstileToken|cf-turnstile-response)=\S+/gi, '$1=[redacted]') : null;
}

export async function ensureFormTurnstile(page: Page, timeoutMs: number): Promise<VerificationFlags> {
  // Put the bottom of the form in view so the site's lazy-loaded widget can initialize.
  await page.evaluate(() => document.querySelector('form:has(textarea[name="source"])')?.scrollIntoView({ block: 'end' }));
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  let seenVerification = false;
  let last: Awaited<ReturnType<typeof verificationState>> | undefined;
  do {
    last = await verificationState(page);
    seenVerification ||= last.required;
    // A token is insufficient while the site's own callback still hides/disables Submit.
    if (last.tokenInForm && last.submitReady) return { turnstile: true, interactive: false };
    // Give scripts time to insert widgets, including widgets outside the form.
    if (!seenVerification && last.submitReady && Date.now() - started >= Math.min(5_000, timeoutMs)) {
      return { turnstile: false, interactive: false };
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
  } while (true);
  if (last && !seenVerification && last.submitReady) return { turnstile: false, interactive: false };
  throw new BrowserFormError(
    `Codeforces verification did not complete normally within ${timeoutMs}ms. No submission was sent. ` +
    `Widget: ${last?.widgetPresent ? 'present' : 'not detected'}; script: ${last?.scriptPresent ? 'present' : 'not detected'}; ` +
    `response in submit form: ${last?.tokenInForm ? 'present' : 'missing'}; Submit: ${last?.submitReady ? 'ready' : 'hidden or disabled'}.`,
    'blocked',
    { turnstile: seenVerification, interactive: last?.iframePresent ?? false },
  );
}

/** Read only booleans; leave verification tokens and callbacks entirely to the site. */
async function verificationState(page: Page) {
  return page.evaluate(() => {
    const form = document.querySelector('form:has(textarea[name="source"])') as HTMLFormElement | null;
    const fields = form ? Array.from(form.elements).filter((element) =>
      /^(turnstileToken|cf-turnstile-response)$/.test((element as HTMLInputElement).name ?? '')) : [];
    const tokenInForm = fields.some((element) => !!(element as HTMLInputElement).value?.trim());
    const iframePresent = !!document.querySelector('iframe[src*="challenges.cloudflare.com"]');
    const widgetPresent = iframePresent || !!document.querySelector('.cf-turnstile, [data-sitekey][data-callback]');
    const scriptPresent = Array.from(document.scripts).some((script) =>
      /challenges\.cloudflare\.com\/turnstile/i.test(script.src) ||
      /turnstile\.(?:render|execute)\s*\(/i.test(script.textContent ?? ''));
    const control = form?.querySelector('input[type="submit"], button[type="submit"], button:not([type])') as HTMLInputElement | HTMLButtonElement | null;
    const submitReady = !!control && !control.disabled && control.getClientRects().length > 0 &&
      getComputedStyle(control).visibility !== 'hidden' && getComputedStyle(control).display !== 'none';
    return { tokenInForm, iframePresent, widgetPresent, scriptPresent, submitReady,
      required: widgetPresent || scriptPresent || tokenInForm };
  });
}

/** One native click, with evidence from the actual POST. Never retry an ambiguous POST. */
export async function clickSubmitForm(page: Page, timeoutMs = 30_000): Promise<{ clicked: boolean; status: number | null }> {
  const form = page.locator('form:has(textarea[name="source"])').first();
  const control = form.locator('input[type="submit"], button[type="submit"], button:not([type])').first();
  if (await control.count() === 0) return { clicked: false, status: null };
  if (!await control.isEnabled() || !await control.isVisible()) {
    throw new BrowserFormError('Codeforces submit button is hidden or disabled; verification or form initialization is incomplete. No submission was sent.', 'blocked');
  }

  let posted: Request | undefined;
  let response: Response | undefined;
  let finalResponse: Response | undefined;
  let failure: string | undefined;
  let settled = false;
  const navigationResponses = new Map<Request, Response>();
  const onRequest = (request: Request) => {
    const url = new URL(request.url());
    if (request.isNavigationRequest() && request.frame() === page.mainFrame() && request.method() === 'POST' &&
      url.hostname === 'codeforces.com' && /\/submit(?:\/\d+\/[a-z0-9]+)?\/?$/i.test(url.pathname)) posted = request;
  };
  const onResponse = (value: Response) => {
    const request = value.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigationResponses.set(request, value);
    if (request === posted) response = value;
  };
  const onFailure = (request: Request) => { if (request === posted) failure = request.failure()?.errorText ?? 'network failure'; };
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onFailure);
  let clicked = false;
  const deadline = Date.now() + timeoutMs;
  const finishResponse = async (value: Response) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const error = await Promise.race([
        value.finished(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Codeforces response did not finish; acceptance is uncertain and the POST was not retried.')), Math.max(1, deadline - Date.now()));
        }),
      ]);
      if (error) failure = error.message;
      await page.waitForLoadState('domcontentloaded', { timeout: Math.max(1, deadline - Date.now()) });
      finalResponse = value;
      settled = true;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  try {
    // force skips layout checks under memory pressure, but never enables a disabled control.
    await control.click({ force: true, noWaitAfter: true, timeout: Math.min(timeoutMs, 15_000) });
    clicked = true;
    while (Date.now() < deadline) {
      if (failure) break;
      // The POST response alone is insufficient: wait for its redirected document too.
      if (response) {
        const status = response.status();
        const redirect = status >= 300 && status < 400;
        if (!redirect) {
          await finishResponse(response);
          break;
        }
        let request = posted?.redirectedTo();
        while (request?.redirectedTo()) request = request.redirectedTo();
        if (request) {
          const redirectedResponse = navigationResponses.get(request);
          if (redirectedResponse && (redirectedResponse.status() < 300 || redirectedResponse.status() >= 400)) {
            await finishResponse(redirectedResponse);
            break;
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (failure) throw new Error(`Codeforces POST failed: ${failure}. It was not retried because acceptance is uncertain.`);
    if (!posted) throw new Error('Codeforces submit click did not send a POST; the page prevented submission.');
    if (!response) throw new Error('Codeforces POST was sent but no response arrived. It was not retried because acceptance is uncertain.');
    if (!settled || !finalResponse) throw new Error('Codeforces POST response did not settle; acceptance is uncertain and the POST was not retried.');
    return { clicked: true, status: finalResponse.status() };
  } catch (err) {
    throw new BrowserFormError(err instanceof Error ? err.message : String(err), 'submission-error', undefined, clicked || !!posted);
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
    page.off('requestfailed', onFailure);
  }
}

export function isSubmissionHistory(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'codeforces.com' && /^\/(?:contest\/\d+\/my|gym\/\d+\/my|problemset\/status)\/?$/.test(parsed.pathname);
  } catch { return false; }
}
