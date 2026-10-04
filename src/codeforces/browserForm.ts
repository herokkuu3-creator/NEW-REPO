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
    if (toggle?.checked) toggle.click();
    const source = document.querySelector('textarea[name="source"]') as HTMLTextAreaElement | null;
    if (!source) throw new Error('Codeforces submit form has no source textarea');
    source.value = content;
    source.dispatchEvent(new Event('input', { bubbles: true }));
    source.dispatchEvent(new Event('change', { bubbles: true }));
  }, code);
}

export async function ensureFormTurnstile(page: Page, timeoutMs: number): Promise<VerificationFlags> {
  const form = page.locator('form:has(textarea[name="source"])').first();
  const field = form.locator('input[name="turnstileToken"]');
  if (await field.count() === 0) return { turnstile: false, interactive: false };

  // A token must be present in the Codeforces form, not merely in a challenge iframe.
  const deadline = Date.now() + timeoutMs;
  const hasToken = async () => !!(await field.first().inputValue({ timeout: 1_000 }).catch(() => '')).trim();
  while (Date.now() < deadline) {
    if (await hasToken()) return { turnstile: true, interactive: false };
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
  }
  if (await hasToken()) return { turnstile: true, interactive: false };

  // Retain the optional solver contract, but never submit any form from here.
  const solverUrl = process.env.TURNSTILE_SOLVER_URL?.trim();
  if (solverUrl) {
    const widget = await page.evaluate(() => {
      const element = document.querySelector('.cf-turnstile[data-sitekey]');
      const inline = Array.from(document.scripts).map((s) => s.textContent ?? '').join('\n');
      const sitekey = element?.getAttribute('data-sitekey') ?? /["']?sitekey["']?\s*:\s*["']([^"']+)["']/.exec(inline)?.[1];
      return { sitekey, callback: element?.getAttribute('data-callback') ?? null };
    });
    if (widget.sitekey) {
      try {
        const response = await fetch(`${solverUrl.replace(/\/+$/, '')}/solve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ siteurl: page.url(), sitekey: widget.sitekey }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.ok) {
          const data = await response.json() as { token?: unknown };
          if (typeof data.token === 'string' && data.token.trim()) {
            await form.evaluate((element, { token, callback }) => {
              const input = element.querySelector('input[name="turnstileToken"]') as HTMLInputElement | null;
              if (!input) throw new Error('Turnstile input disappeared');
              input.value = token;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              // Named callbacks update the site's own enabled/verified state.
              if (callback) {
                const fn = callback.split('.').reduce<unknown>((value, key) =>
                  value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, window);
                if (typeof fn === 'function') fn(token);
              }
            }, { token: data.token, callback: widget.callback });
            if (await hasToken()) return { turnstile: true, interactive: false };
          }
        }
      } catch {
        // Return the same actionable verification error; never log solver tokens.
      }
    }
  }

  const diagnostics = await page.evaluate(() => ({
    apiLoaded: typeof (window as unknown as { turnstile?: unknown }).turnstile !== 'undefined',
    iframePresent: !!document.querySelector('iframe[src*="challenges.cloudflare.com"]'),
    widgetPresent: !!document.querySelector('.cf-turnstile'),
  }));
  throw new BrowserFormError(
    `Codeforces Turnstile did not issue a token within ${timeoutMs}ms (${JSON.stringify(diagnostics)}). ` +
    'No submission was sent. Complete verification in a supported browser or use an accessible submitter connection.',
    'blocked',
    { turnstile: false, interactive: diagnostics.iframePresent },
  );
}

/** One native click, with evidence from the actual POST. Never retry an ambiguous POST. */
export async function clickSubmitForm(page: Page, timeoutMs = 30_000): Promise<{ clicked: boolean; status: number | null }> {
  const form = page.locator('form:has(textarea[name="source"])').first();
  const control = form.locator('input[type="submit"], button[type="submit"], button:not([type])').first();
  if (await control.count() === 0) return { clicked: false, status: null };
  if (!await control.isEnabled()) {
    throw new BrowserFormError('Codeforces submit button is disabled; verification or form initialization is incomplete. No submission was sent.', 'blocked');
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
