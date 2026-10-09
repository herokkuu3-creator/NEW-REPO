import type { Page, Request, Response } from 'playwright';


function log(fields: Record<string, unknown>, msg: string): void {
  const time = new Date().toISOString();
  process.stdout.write(`${JSON.stringify({ level: 30, time, service: 'browser-form', ...fields, msg })}\n`);
}

function logWarn(fields: Record<string, unknown>, msg: string): void {
  const time = new Date().toISOString();
  process.stdout.write(`${JSON.stringify({ level: 40, time, service: 'browser-form', ...fields, msg })}\n`);
}

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

/**
 * Keep the native Codeforces form and Cloudflare verification intact, while
 * dropping resources which cannot affect a submission. This route runs inside
 * the residential-proxy browser, so it is also the boundary that prevents
 * analytics and decorative page assets from spending proxy data.
 */
export function blockCodeforcesResource(url: string, type: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();

  // Never block Cloudflare's challenge page, iframe, token requests, or Turnstile JS.
  // Turnstile's entropy scripts can be served from any *.cloudflare.com subdomain.
  if (
    host === 'challenges.cloudflare.com' || host.endsWith('.challenges.cloudflare.com') ||
    host === 'cloudflare.com' || host.endsWith('.cloudflare.com') ||
    path.startsWith('/cdn-cgi/')
  ) {
    return false;
  }

  if (['image', 'media', 'font', 'websocket', 'eventsource', 'manifest', 'ping'].includes(type)) return true;

  // The submit form is self-contained on Codeforces. Third-party analytics,
  // ads, and telemetry are not needed to render, verify, or POST the form.
  const isCodeforcesHost = host === 'codeforces.com' || host.endsWith('.codeforces.com') ||
    host === 'codeforces.org' || host.endsWith('.codeforces.org');
  if (!isCodeforcesHost) return true;

  // MathJax can download several megabytes but is only used to typeset problem
  // statements; the submit page does not need it.
  return path.includes('mathjax') || parsed.search.toLowerCase().includes('mathjax');
}

/** Preserve Codeforces' editor teardown and submit handlers instead of replacing window.editor. */
export async function fillSource(page: Page, code: string): Promise<void> {
  await page.evaluate((content) => {
    const toggle = document.getElementById('toggleEditorCheckbox') as HTMLInputElement | null;
    // Keep the plain textarea active. Some Codeforces pages preserve an Ace
    // editor preference; switching it on after filling the textarea makes the
    // editor look empty and leaves Submit disabled.
    if (toggle && !toggle.checked) toggle.click();
    const editor = (window as unknown as {
      editor?: { setValue?: (value: string, cursor?: number) => void };
    }).editor;
    // Sync Ace as well so the site's native submit handler cannot overwrite
    // the textarea with stale editor content.
    if (typeof editor?.setValue === 'function') editor.setValue(content, -1);
    const source = document.querySelector('textarea[name="source"]') as HTMLTextAreaElement | null;
    if (!source) throw new Error('Codeforces submit form has no source textarea');
    source.value = content;
    source.dispatchEvent(new Event('input', { bubbles: true }));
    source.dispatchEvent(new Event('change', { bubbles: true }));
  }, code);
}

export interface SolverResult {
  token?: string;
  cookies?: Record<string, string>;
}

export async function solveCloudflareWithCapzy(
  websiteURL: string,
  proxyUrl?: string,
  userAgent?: string,
  timeoutMs = 35_000,
): Promise<SolverResult | null> {
  const apiKey =
    process.env.CAPZY_API_KEY?.trim() ||
    'capzy_9dc57a569ec4a6b2453b7d2869e85320ece4cddfc9a36d2f';
  const proxy =
    proxyUrl ||
    process.env.CODEFORCES_PROXY?.trim() ||
    'http://customer-jp-lmc6hb64r-cc-in-iptype-residential-sessid-ylvk7rom-sesstime-1-backup-1:kdKWYXp9PFrh@gate.joyproxy.com:9001';

  try {
    const parsed = new URL(proxy);
    const init = await fetch('https://api.capzy.ai/createTask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: apiKey,
        task: {
          type: 'AntiCloudflareTask',
          websiteURL,
          proxyType: 'http',
          proxyAddress: parsed.hostname,
          proxyPort: parseInt(parsed.port, 10),
          proxyLogin: decodeURIComponent(parsed.username),
          proxyPassword: decodeURIComponent(parsed.password),
          ...(userAgent ? { userAgent } : {}),
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await init.json()) as { errorId?: number; taskId?: string };
    if (!data?.taskId) return null;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const poll = await fetch('https://api.capzy.ai/getTaskResult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: apiKey, taskId: data.taskId }),
        signal: AbortSignal.timeout(10_000),
      });
      const res = (await poll.json()) as {
        errorId?: number;
        status?: string;
        solution?: {
          token?: string;
          cookies?: Record<string, string>;
        };
      };
      if (res?.status === 'ready' && res?.solution) {
        return {
          token: res.solution.token,
          cookies: res.solution.cookies,
        };
      }
      if (res?.errorId && res.errorId !== 0) {
        logWarn({ taskId: data.taskId, errorId: res.errorId, status: res.status, raw: res }, 'Capzy solve reported error');
        break;
      }
    }
  } catch {
    // Graceful fallback
  }
  return null;
}

export async function ensureFormTurnstile(page: Page, timeoutMs: number, proxyUrl?: string): Promise<VerificationFlags> {
  const form = page.locator('form:has(textarea[name="source"])').first();
  const field = form.locator('input[name="turnstileToken"]');
  const cfField = form.locator('input[name="cf-turnstile-response"]');
  const widget = page.locator('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]');

  if (await field.count() === 0 && await cfField.count() === 0 && await widget.count() === 0) {
    return { turnstile: false, interactive: false };
  }

  const syncTokens = async (): Promise<string> => {
    return page.evaluate(() => {
      const formEl = document.querySelector('form:has(textarea[name="source"])');
      if (!formEl) return '';
      const ttInput = formEl.querySelector('input[name="turnstileToken"]') as HTMLInputElement | null;
      const cfInput = formEl.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement | null;
      const api = (window as unknown as { turnstile?: { getResponse?: (widgetId?: string) => string; } }).turnstile;
      let token = (ttInput?.value || cfInput?.value || '').trim();
      if (!token && api?.getResponse) {
        const widgetEl = formEl.querySelector('.cf-turnstile') as HTMLElement | null;
        try { token = (api.getResponse(widgetEl?.dataset.widgetId) || '').trim(); } catch {}
      }
      if (token) {
        if (ttInput && !ttInput.value) { ttInput.value = token; ttInput.dispatchEvent(new Event('input', { bubbles: true })); ttInput.dispatchEvent(new Event('change', { bubbles: true })); }
        if (cfInput && !cfInput.value) { cfInput.value = token; cfInput.dispatchEvent(new Event('input', { bubbles: true })); cfInput.dispatchEvent(new Event('change', { bubbles: true })); }
        if (!ttInput) { const input = document.createElement('input'); input.type = 'hidden'; input.name = 'turnstileToken'; input.value = token; formEl.appendChild(input); }
        if (!cfInput) { const input = document.createElement('input'); input.type = 'hidden'; input.name = 'cf-turnstile-response'; input.value = token; formEl.appendChild(input); }
      }
      return token;
    }).catch(() => '');
  };

  const hasToken = async (): Promise<boolean> => {
    const tok = await syncTokens();
    return tok.length > 5;
  };

  if (await hasToken()) return { turnstile: true, interactive: false };

  const solverPromise = (async () => {
    const solverUrl = process.env.TURNSTILE_SOLVER_URL?.trim();
    if (solverUrl) {
      // 1. Generic solver URL has explicit priority when configured
      const widgetInfo = await page.evaluate(() => {
        const element = document.querySelector('.cf-turnstile[data-sitekey]');
        const inline = Array.from(document.scripts).map((s) => s.textContent ?? '').join('\n');
        const sitekey = element?.getAttribute('data-sitekey') ?? /["']?sitekey["']?\s*:\s*["']([^"']+)["']/.exec(inline)?.[1];
        const action = element?.getAttribute('data-action') ?? /["']?action["']?\s*:\s*["']([^"']+)["']/.exec(inline)?.[1];
        const cdata = element?.getAttribute('data-cdata') ?? /["']?cdata["']?\s*:\s*["']([^"']+)["']/.exec(inline)?.[1];
        return { sitekey, action, cdata, callback: element?.getAttribute('data-callback') ?? null };
      });
      if (widgetInfo.sitekey) {
        try {
          const response = await fetch(`${solverUrl.replace(/\/+$/, '')}/solve`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ siteurl: page.url(), sitekey: widgetInfo.sitekey, action: widgetInfo.action, cdata: widgetInfo.cdata }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (response.ok) {
            const data = await response.json() as { token?: unknown };
            if (typeof data.token === 'string' && data.token.trim()) {
              await form.evaluate((element, { token, callback }) => {
                const input = element.querySelector('input[name="turnstileToken"]') as HTMLInputElement | null;
                if (input) { input.value = token; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }
                const cfInput = element.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement | null;
                if (cfInput) { cfInput.value = token; cfInput.dispatchEvent(new Event('input', { bubbles: true })); cfInput.dispatchEvent(new Event('change', { bubbles: true })); }
                if (callback) { const fn = callback.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, window); if (typeof fn === 'function') fn(token); }
              }, { token: data.token, callback: widgetInfo.callback });
            }
          }
        } catch {}
      }
      return;
    }

    // 2. Capzy AntiCloudflareTask
    const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => undefined);
    const capzySol = await solveCloudflareWithCapzy(page.url(), proxyUrl, userAgent, timeoutMs);
    if (capzySol?.cookies) {
      const cookieList = Object.entries(capzySol.cookies)
        .filter(([name]) => name.toLowerCase().startsWith('cf_') || name.toLowerCase().startsWith('__cf'))
        .map(([name, value]) => ({
          name,
          value,
          domain: '.codeforces.com',
          path: '/',
        }));
      if (cookieList.length > 0) {
        log({ count: cookieList.length, names: cookieList.map(c => c.name) }, 'ensureFormTurnstile: injecting Capzy Cloudflare clearance cookies');
        await page.context().addCookies(cookieList).catch(() => {});
      }
    }
    if (capzySol?.token) {
      await form.evaluate((element, { token }) => {
        const input = element.querySelector('input[name="turnstileToken"]') as HTMLInputElement | null;
        if (input) { input.value = token; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }
        const cfInput = element.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement | null;
        if (cfInput) { cfInput.value = token; cfInput.dispatchEvent(new Event('input', { bubbles: true })); cfInput.dispatchEvent(new Event('change', { bubbles: true })); }
      }, { token: capzySol.token });
      return;
    }
  })();

  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let executeCount = 0;
  let nextExecuteAt = startedAt + 5_000;
  const MAX_EXECUTE_RETRIES = 4;
  let renderChecked = false;
  let renderAttempt = '';
  let executeAttempt = '';
  let clickAttemptedAt = 0;
  const noWidgetGraceMs = 5_000;

  while (Date.now() < deadline) {
    if (await hasToken()) {
      if (solverPromise) await solverPromise.catch(() => {});
      return { turnstile: true, interactive: false };
    }
    if (Date.now() - startedAt >= noWidgetGraceMs && await widget.count() === 0) {
      if (solverPromise) await solverPromise.catch(() => {});
      return { turnstile: false, interactive: false };
    }
    if (!renderChecked && Date.now() - startedAt >= 2_000) {
      renderChecked = true;
      renderAttempt = await form.evaluate((element) => {
        const widgetEl = element.querySelector('.cf-turnstile[data-sitekey]') as HTMLElement | null;
        const api = (window as unknown as { turnstile?: { render?: (container: HTMLElement, options: { sitekey: string; callback: (token: string) => void; 'error-callback'?: () => void }) => string; execute?: (container: HTMLElement | string) => void; } }).turnstile;
        if (!widgetEl || !api?.render) return 'not-needed';
        const pageIframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
        if (pageIframe) return 'not-needed';
        const sitekey = widgetEl.dataset.sitekey;
        if (!sitekey) return 'no-sitekey';
        try {
          const widgetId = api.render(widgetEl, { sitekey, callback: (token) => { const callbackName = widgetEl.getAttribute('data-callback'); if (callbackName) { const fn = callbackName.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, window); if (typeof fn === 'function') (fn as (value: string) => void)(token); } const input = element.querySelector('input[name="turnstileToken"]') as HTMLInputElement | null; if (input && !input.value) { input.value = token; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); } const cfInput = element.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement | null; if (cfInput && !cfInput.value) { cfInput.value = token; cfInput.dispatchEvent(new Event('input', { bubbles: true })); cfInput.dispatchEvent(new Event('change', { bubbles: true })); } }, 'error-callback': () => {} });
          if (widgetId && widgetEl) widgetEl.dataset.widgetId = String(widgetId);
          return `rendered:${widgetId ?? 'no-id'}`;
        } catch { return 'render-error'; }
      }).catch(() => 'page-error');
    }
    if (executeCount < MAX_EXECUTE_RETRIES && Date.now() >= nextExecuteAt) {
      executeCount += 1;
      executeAttempt = await form.evaluate((element) => {
        const widgetEl = element.querySelector('.cf-turnstile[data-sitekey]') as HTMLElement | null;
        const api = (window as unknown as { turnstile?: { execute?: (container: HTMLElement | string) => void; getResponse?: (id?: string) => string; } }).turnstile;
        if (!widgetEl || !api?.execute) return 'unavailable';
        const storedId = widgetEl.dataset.widgetId;
        try { if (storedId) { api.execute(storedId); } else { api.execute(widgetEl); } return 'executed'; } catch { return 'execute-error'; }
      }).catch(() => 'page-error');
      const backoffMs = [5_000, 8_000, 12_000, 17_000][executeCount - 1] ?? 17_000;
      nextExecuteAt = Date.now() + backoffMs;
    }
    if (Date.now() > clickAttemptedAt + 5_000) {
      try {
        const frameLocator = page.frameLocator('iframe[src*="challenges.cloudflare.com"]').first();
      const checkbox = frameLocator.locator('.ctp-checkbox-container, .mark, input[type="checkbox"]').first();
      if ((await checkbox.count().catch(() => 0)) > 0 && await checkbox.isVisible().catch(() => false)) { clickAttemptedAt = Date.now(); await checkbox.click({ timeout: 500 }).catch(() => {}); } else { const body = frameLocator.locator('body').first(); if ((await body.count().catch(() => 0)) > 0 && await body.isVisible().catch(() => false)) { clickAttemptedAt = Date.now(); await body.click({ position: { x: 10, y: 10 }, timeout: 500 }).catch(() => {}); } }
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
  }
  if (solverPromise) await solverPromise.catch(() => {});
  if (await hasToken()) {
    return { turnstile: true, interactive: false };
  }
  if (await widget.count() === 0) {
    return { turnstile: false, interactive: false };
  }
  const diagnostics = await page.evaluate(() => ({
    apiLoaded: typeof (window as unknown as { turnstile?: unknown }).turnstile !== 'undefined',
    iframePresent: !!document.querySelector('iframe[src*="challenges.cloudflare.com"]'),
    widgetPresent: !!document.querySelector('.cf-turnstile'),
    widgetInForm: !!document.querySelector('form:has(textarea[name="source"]) .cf-turnstile'),
    sitekeyInForm: !!document.querySelector('form:has(textarea[name="source"]) .cf-turnstile[data-sitekey]'),
    execution: document.querySelector('form:has(textarea[name="source"]) .cf-turnstile')?.getAttribute('data-execution') ?? null,
    responseInputPresent: !!document.querySelector('form:has(textarea[name="source"]) input[name="cf-turnstile-response"]'),
    widgetId: (document.querySelector('form:has(textarea[name="source"]) .cf-turnstile') as HTMLElement | null)?.dataset.widgetId ?? null,
  }));
  throw new BrowserFormError(
    `Codeforces Turnstile did not issue a token within ${timeoutMs}ms (${JSON.stringify({ ...diagnostics, renderAttempt, executeAttempt, executeCount })}). ` +
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
  // Codeforces can enable Submit a moment after the source input/change events.
  // Wait for that native update, but never remove the disabled attribute or
  // force a form that Codeforces still considers invalid.
  const readyDeadline = Date.now() + Math.min(5_000, timeoutMs);
  while (!await control.isEnabled().catch(() => false) && Date.now() < readyDeadline) {
    await new Promise(resolve => setTimeout(resolve, Math.min(100, readyDeadline - Date.now())));
  }
  if (!await control.isEnabled().catch(() => false)) {
    const details = await form.evaluate((element) => {
      const source = element.querySelector<HTMLTextAreaElement>('textarea[name="source"]');
      const toggle = document.getElementById('toggleEditorCheckbox') as HTMLInputElement | null;
      return { sourcePresent: !!source?.value.trim(), editorDisabled: toggle?.checked ?? null,
        widgetPresent: !!element.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]') };
    }).catch(() => ({ sourcePresent: false, editorDisabled: null, widgetPresent: false }));
    throw new BrowserFormError(
      `Codeforces submit button stayed disabled after source initialization (${JSON.stringify(details)}). No submission was sent.`,
      'blocked',
    );
  }

  // Ensure Turnstile tokens are fully synchronized to both hidden inputs before clicking
  await page.evaluate(() => {
    const formEl = document.querySelector('form:has(textarea[name="source"])');
    if (!formEl) return;
    const tt = (formEl.querySelector('input[name="turnstileToken"]') as HTMLInputElement)?.value;
    const cf = (formEl.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement)?.value;
    const tok = (tt || cf || '').trim();
    if (tok) {
      const ttInput = formEl.querySelector('input[name="turnstileToken"]') as HTMLInputElement | null;
      if (ttInput && !ttInput.value) ttInput.value = tok;
      const cfInput = formEl.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement | null;
      if (cfInput && !cfInput.value) cfInput.value = tok;
    }
  }).catch(() => {});

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
    try {
      await control.click({ timeout: Math.min(timeoutMs, 5_000), noWaitAfter: true });
    } catch {
      // force skips layout checks under memory pressure, but never enables a disabled control.
      await control.click({ force: true, noWaitAfter: true, timeout: Math.min(timeoutMs, 15_000) });
    }
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
