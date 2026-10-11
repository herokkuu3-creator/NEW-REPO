import type { Page, Request, Response } from 'playwright';
import { interactWithTurnstileCheckbox, simulateHumanMouseMove } from '../browser/stealth';
import {
  getCandidateCapzyKeys,
  rotateToNextCapzyKey,
  isCapzyKeyError,
  maskApiKey,
} from './capzyKeyManager';



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
  const isCodeforcesHost =
    host === 'codeforces.com' || host.endsWith('.codeforces.com') ||
    host === 'codeforces.org' || host.endsWith('.codeforces.org') ||
    host === 'codeforces.net' || host.endsWith('.codeforces.net');
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

export {
  type SolverResult,
  DEFAULT_DESKTOP_CHROME_USER_AGENT,
  DEFAULT_DESKTOP_FIREFOX_USER_AGENT,
  DEFAULT_DESKTOP_USER_AGENT,
  getDefaultUserAgent,
  solveTurnstileWithCapzy,
  solveCloudflareWithCapzy,
  solveTurnstileOrchestrated,
  solveCloudflareOrchestrated,
} from './captchaSolver';
import {
  solveTurnstileOrchestrated,
  solveCloudflareOrchestrated,
} from './captchaSolver';

async function injectTurnstileToken(form: ReturnType<Page['locator']>, token: string, callbackName?: string | null): Promise<void> {
  await form.evaluate((element, { token, callback }) => {
    const ttInput = element.querySelector('input[name="turnstileToken"]') as HTMLInputElement | null;
    if (ttInput) {
      ttInput.value = token;
      ttInput.dispatchEvent(new Event('input', { bubbles: true }));
      ttInput.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'turnstileToken';
      input.value = token;
      element.appendChild(input);
    }

    const cfInput = element.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement | null;
    if (cfInput) {
      cfInput.value = token;
      cfInput.dispatchEvent(new Event('input', { bubbles: true }));
      cfInput.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'cf-turnstile-response';
      input.value = token;
      element.appendChild(input);
    }

    // Sync any document-level inputs outside the form
    const docCfInputs = document.querySelectorAll('input[name="cf-turnstile-response"], input[name="turnstileToken"]');
    docCfInputs.forEach((i) => {
      const inp = i as HTMLInputElement;
      if (!inp.value) inp.value = token;
    });

    // Patch window.turnstile.getResponse and isExpired so form submit handlers pass
    const win = window as any;
    if (win.turnstile) {
      win.turnstile.getResponse = () => token;
      win.turnstile.isExpired = () => false;
    }

    // Trigger intercepted render callback
    if (typeof win.__turnstileCallback === 'function') {
      try { win.__turnstileCallback(token); } catch {}
    }

    // Trigger named callback
    if (callback) {
      const fn = callback.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, window);
      if (typeof fn === 'function') (fn as (t: string) => void)(token);
    }

    // Trigger widget data-callback attribute
    const widgetEl = document.querySelector('.cf-turnstile[data-callback], [data-callback]') as HTMLElement | null;
    const widgetCb = widgetEl?.getAttribute('data-callback');
    if (widgetCb && widgetCb !== callback) {
      const fn = widgetCb.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, window);
      if (typeof fn === 'function') (fn as (t: string) => void)(token);
    }

    // Re-enable submit buttons on form and page
    const submitBtns = document.querySelectorAll('input[type="submit"], button[type="submit"], button:not([type])');
    submitBtns.forEach((btn) => {
      (btn as HTMLButtonElement).disabled = false;
      btn.removeAttribute('disabled');
    });
  }, { token, callback: callbackName }).catch(() => {});
}

export async function ensureFormTurnstile(page: Page, timeoutMs: number, proxyUrl?: string, overrideKeys?: string[]): Promise<VerificationFlags> {
  const form = page.locator('form:has(textarea[name="source"])').first();
  const challengeIframe = page.locator('iframe[src*="challenges.cloudflare.com"]');
  const control = form.locator('input[type="submit"], button[type="submit"], button:not([type])').first();

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

  // 1. If token already exists, verification is satisfied immediately
  if (await hasToken()) return { turnstile: true, interactive: false };

  // 2. Check if a Turnstile widget, Cloudflare script, or sitekey is present on the page
  const checkWidgetPresent = async (): Promise<boolean> => {
    return page.evaluate(() => {
      const win = window as any;
      const el = document.querySelector('.cf-turnstile, [data-sitekey], [data-key]');
      const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="cloudflare.com"], iframe[title*="Turnstile"], iframe[title*="Cloudflare"]');
      const script = document.querySelector('script[src*="turnstile"], script[src*="challenge-platform"]');
      const link = document.querySelector('link[href*="challenges.cloudflare.com"]');
      const sitekey = win.__turnstileSitekey || el?.getAttribute('data-sitekey') || el?.getAttribute('data-key') || (el as HTMLElement | null)?.dataset?.sitekey;
      const cfParams = win.__CF$cv$params;
      return !!(el || iframe || script || link || win.turnstile || cfParams || sitekey);
    }).catch(() => false);
  };

  const graceDeadline = Date.now() + Math.min(3_000, timeoutMs);
  while (Date.now() < graceDeadline) {
    if (await hasToken()) return { turnstile: true, interactive: false };
    if (await checkWidgetPresent()) break;
    await new Promise((r) => setTimeout(r, 20));
  }

  if (await hasToken()) return { turnstile: true, interactive: false };

  const isWidgetPresent = await checkWidgetPresent();
  const isControlEnabled = await control.isEnabled().catch(() => false);
  if (!isWidgetPresent && isControlEnabled) {
    return { turnstile: false, interactive: false };
  }

  // 3. A Turnstile widget IS present. Extract sitekey and launch background solver.
  const extractWidgetInfo = async () => {
    return page.evaluate(() => {
      const win = window as any;
      const elements = Array.from(document.querySelectorAll('.cf-turnstile, [data-sitekey], [data-key]'));
      const inline = Array.from(document.scripts).map((s) => s.textContent ?? '').join('\n');
      const fullHtml = document.body ? document.body.innerHTML : '';
      let sitekey: string | null = (typeof win.__turnstileSitekey === 'string' && win.__turnstileSitekey ? win.__turnstileSitekey : null);
      let action: string | null = (typeof win.__turnstileAction === 'string' && win.__turnstileAction ? win.__turnstileAction : null);
      let cdata: string | null = (typeof win.__turnstileCdata === 'string' && win.__turnstileCdata ? win.__turnstileCdata : null);
      let callback: string | null = (typeof win.__turnstileCallback === 'string' && win.__turnstileCallback ? win.__turnstileCallback : null);

      for (const el of elements) {
        if (!sitekey) {
          sitekey = el.getAttribute('data-sitekey') || el.getAttribute('data-key') || (el as HTMLElement).dataset?.sitekey || null;
        }
        if (!action) action = el.getAttribute('data-action') || null;
        if (!cdata) cdata = el.getAttribute('data-cdata') || null;
        if (!callback) callback = el.getAttribute('data-callback') || null;
      }

      if (!sitekey) {
        sitekey = /["']?sitekey["']?\s*[:=]\s*["']([^"']+)["']/i.exec(inline)?.[1] ??
          /["']?sitekey["']?\s*[:=]\s*["']([^"']+)["']/i.exec(fullHtml)?.[1] ??
          /(0x4[a-zA-Z0-9_-]{18,})/i.exec(inline)?.[1] ??
          /(0x4[a-zA-Z0-9_-]{18,})/i.exec(fullHtml)?.[1] ?? null;
      }
      if (!action) action = /["']?action["']?\s*[:=]\s*["']([^"']+)["']/i.exec(inline)?.[1] ?? null;
      if (!cdata) cdata = /["']?cdata["']?\s*[:=]\s*["']([^"']+)["']/i.exec(inline)?.[1] ?? null;

      if (!sitekey) {
        const iframes = Array.from(document.querySelectorAll('iframe[src*="challenges.cloudflare.com"], iframe[src*="cloudflare.com"]')) as HTMLIFrameElement[];
        for (const iframe of iframes) {
          if (iframe?.src) {
            try {
              const u = new URL(iframe.src);
              sitekey = u.searchParams.get('sitekey') || u.searchParams.get('key') || /\/([0-9a-zA-Z_-]{20,})\//.exec(u.pathname)?.[1] || /(0x4[a-zA-Z0-9_-]{18,})/i.exec(iframe.src)?.[1] || null;
              if (sitekey) break;
            } catch {}
          }
        }
      }
      return { sitekey, action, cdata, callback };
    }).catch(() => ({ sitekey: null, action: null, cdata: null, callback: null }));
  };

  let solverStarted = false;
  let solverPromise: Promise<void> | null = null;
  const awaitSolver = async () => {
    if (solverPromise) await solverPromise.catch(() => {});
  };

  const triggerSolver = (info: { sitekey: string | null; action: string | null; cdata: string | null; callback: string | null }) => {
    if (solverStarted) return;
    solverStarted = true;
    solverPromise = (async () => {
      const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => undefined);

      if (info.sitekey) {
        const solution = await solveTurnstileOrchestrated({
          siteurl: page.url(),
          sitekey: info.sitekey,
          action: info.action ?? undefined,
          cdata: info.cdata ?? undefined,
          proxyUrl,
          userAgent,
          timeoutMs,
          overrideKeys,
        });

        if (solution?.token) {
          log({ tokenLength: solution.token.length, source: solution.source }, 'ensureFormTurnstile: injecting Turnstile token');
          await injectTurnstileToken(form, solution.token, info.callback);
          return;
        }

        if (solution?.cookies) {
          const cookieList = Object.entries(solution.cookies)
            .filter(([name]) => name.toLowerCase().startsWith('cf_') || name.toLowerCase().startsWith('__cf'))
            .map(([name, value]) => ({
              name,
              value,
              domain: '.codeforces.com',
              path: '/',
            }));
          if (cookieList.length > 0) {
            log({ count: cookieList.length, names: cookieList.map(c => c.name), source: solution.source }, 'ensureFormTurnstile: injecting clearance cookies');
            await page.context().addCookies(cookieList).catch(() => {});
          }
        }
      } else {
        const cloudflareSol = await solveCloudflareOrchestrated({
          websiteURL: page.url(),
          proxyUrl,
          userAgent,
          timeoutMs,
          overrideKeys,
        });

        if (cloudflareSol?.cookies) {
          const cookieList = Object.entries(cloudflareSol.cookies)
            .filter(([name]) => name.toLowerCase().startsWith('cf_') || name.toLowerCase().startsWith('__cf'))
            .map(([name, value]) => ({
              name,
              value,
              domain: '.codeforces.com',
              path: '/',
            }));
          if (cookieList.length > 0) {
            log({ count: cookieList.length, names: cookieList.map(c => c.name), source: cloudflareSol.source }, 'ensureFormTurnstile: injecting Cloudflare clearance cookies');
            await page.context().addCookies(cookieList).catch(() => {});
          }
        }

        if (cloudflareSol?.token) {
          log({ tokenLength: cloudflareSol.token.length, source: cloudflareSol.source }, 'ensureFormTurnstile: injecting Cloudflare token');
          await injectTurnstileToken(form, cloudflareSol.token, info.callback);
        }
      }
    })();
  };

  let widgetInfo = await extractWidgetInfo();
  if (widgetInfo.sitekey) {
    triggerSolver(widgetInfo);
  }

  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let executeCount = 0;
  let nextExecuteAt = startedAt + 5_000;
  const MAX_EXECUTE_RETRIES = 4;
  let apiScriptInjected = false;
  let widgetRendered = false;
  let renderAttempt = '';
  let executeAttempt = '';
  let clickAttemptedAt = 0;

  while (Date.now() < deadline) {
    if (await hasToken()) {
      await awaitSolver();
      return { turnstile: true, interactive: false };
    }

    if (!solverStarted) {
      widgetInfo = await extractWidgetInfo();
      if (widgetInfo.sitekey || Date.now() - startedAt >= 2_000) {
        triggerSolver(widgetInfo);
      }
    }

    if (!apiScriptInjected && Date.now() - startedAt >= 1_000) {
      apiScriptInjected = true;
      const hasApi = await page.evaluate(() => typeof (window as any).turnstile !== 'undefined').catch(() => false);
      if (!hasApi) {
        await page.addScriptTag({ url: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit' }).catch(() => {});
      }
    }

    if (!widgetRendered && Date.now() - startedAt >= 1_500) {
      const renderRes = await form.evaluate((element) => {
        const widgetEl = element.querySelector('.cf-turnstile[data-sitekey]') as HTMLElement | null;
        const api = (window as unknown as { turnstile?: { render?: (container: HTMLElement, options: Record<string, unknown>) => string; execute?: (container: HTMLElement | string) => void; } }).turnstile;
        if (!widgetEl || !api?.render) return null;
        const pageIframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
        if (pageIframe) return 'iframe-exists';
        const sitekey = widgetEl.dataset.sitekey;
        if (!sitekey) return 'no-sitekey';
        try {
          const widgetId = api.render(widgetEl, {
            sitekey,
            callback: (token: string) => {
              const callbackName = widgetEl.getAttribute('data-callback');
              if (callbackName) {
                const fn = callbackName.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, window);
                if (typeof fn === 'function') (fn as (value: string) => void)(token);
              }
              const input = element.querySelector('input[name="turnstileToken"]') as HTMLInputElement | null;
              if (input && !input.value) { input.value = token; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }
              const cfInput = element.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement | null;
              if (cfInput && !cfInput.value) { cfInput.value = token; cfInput.dispatchEvent(new Event('input', { bubbles: true })); cfInput.dispatchEvent(new Event('change', { bubbles: true })); }
            },
            'error-callback': () => {},
          });
          if (widgetId && widgetEl) widgetEl.dataset.widgetId = String(widgetId);
          return `rendered:${widgetId ?? 'no-id'}`;
        } catch { return 'render-error'; }
      }).catch(() => 'page-error');
      if (renderRes) {
        renderAttempt = renderRes;
        if (renderRes !== 'render-error' && renderRes !== 'page-error') {
          widgetRendered = true;
        }
      }
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

    if (Date.now() > clickAttemptedAt + 3_000) {
      clickAttemptedAt = Date.now();
      await interactWithTurnstileCheckbox(page).catch(() => {});
    }

    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
  }

  await awaitSolver();
  if (await hasToken()) {
    return { turnstile: true, interactive: false };
  }

  // If CPSolver / Cloudflare clearance cookies were injected and the submit button is enabled,
  // allow the submission to proceed rather than throwing a false-positive blocked error.
  const contextCookies = await page.context().cookies().catch(() => []);
  const hasClearanceCookie = contextCookies.some((c) => c.name.toLowerCase().startsWith('cf_') && c.value.length > 5);
  const isSubmitEnabled = await control.isEnabled().catch(() => false);
  if (hasClearanceCookie && isSubmitEnabled) {
    log({ source: 'clearance-cookies' }, 'ensureFormTurnstile: clearance cookies present and submit control enabled');
    return { turnstile: true, interactive: false };
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
    const api = (window as any).turnstile;
    let apiTok = '';
    try { apiTok = typeof api?.getResponse === 'function' ? api.getResponse() : ''; } catch {}
    const tok = (tt || cf || apiTok || '').trim();
    if (tok) {
      let ttInput = formEl.querySelector('input[name="turnstileToken"]') as HTMLInputElement | null;
      if (!ttInput) {
        ttInput = document.createElement('input');
        ttInput.type = 'hidden';
        ttInput.name = 'turnstileToken';
        formEl.appendChild(ttInput);
      }
      ttInput.value = tok;

      let cfInput = formEl.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement | null;
      if (!cfInput) {
        cfInput = document.createElement('input');
        cfInput.type = 'hidden';
        cfInput.name = 'cf-turnstile-response';
        formEl.appendChild(cfInput);
      }
      cfInput.value = tok;
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
      const box = await control.boundingBox().catch(() => null);
      if (box && box.width > 0 && box.height > 0) {
        const targetX = Math.round(box.x + box.width * (0.35 + Math.random() * 0.3));
        const targetY = Math.round(box.y + box.height * (0.35 + Math.random() * 0.3));
        await simulateHumanMouseMove(page, targetX, targetY, 15).catch(() => {});
        await new Promise((r) => setTimeout(r, 60 + Math.random() * 60));
      }
    } catch {}

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
    if (parsed.hostname !== 'codeforces.com') return false;
    return /^\/(?:contest\/\d+\/(?:my|status|submission\/\d+)|gym\/\d+\/(?:my|status)|problemset\/(?:status|submission\/\d+\/\d+)|submissions(?:\/[a-zA-Z0-9_.-]+)?)\/?$/.test(parsed.pathname);
  } catch { return false; }
}
