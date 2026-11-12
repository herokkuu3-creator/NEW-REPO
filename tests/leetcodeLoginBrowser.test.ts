import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  loginOnLeetCodePage,
  loginToLeetCode,
  detectVerificationDetail,
  type LoginState,
} from '../src/leetcode/auth';

let browser: Browser;
let page: Page;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
beforeEach(async () => { page = await browser.newPage(); });
afterEach(async () => { vi.restoreAllMocks(); await page.context().close(); });
afterAll(async () => { await browser.close(); });

describe('LeetCode login using an owned browser fixture', () => {
  async function fixture({ verification = false, disabled = false, rejected = false,
    signedIn = true, redirect = false, fakeCookie = false, pageStatus = 200 } = {}) {
    let submissions = 0;
    let supplied: unknown;
    await page.route('https://leetcode.com/**', async route => {
      const request = route.request();
      if (request.url().includes('/graphql')) return route.fulfill({ contentType: 'application/json',
        body: JSON.stringify({ data: { userStatus: { isSignedIn: submissions > 0 && signedIn, username: 'actual_handle' } } }) });
      if (request.method() === 'POST') {
        submissions++;
        supplied = request.postDataJSON();
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ rejected }) });
      }
      return route.fulfill({ status: pageStatus, contentType: 'text/html', body: `
        ${verification ? '<title>Just a moment...</title><form id="challenge-form"></form>' : ''}
        <form id="search"><input><button type="submit">Search</button></form>
        <form id="login"><input id="id_login"><input id="id_password" type="password">
          <button type="submit" ${disabled ? 'disabled' : ''}>Sign In</button></form>
        <div role="alert" hidden></div>
        <script>
          document.querySelector('#login').onsubmit=async e=>{
            e.preventDefault();
            const response=await fetch('/accounts/login/',{method:'POST',body:JSON.stringify({
              username:document.querySelector('#id_login').value,password:document.querySelector('#id_password').value})});
            const body=await response.json();
            if(body.rejected) { document.querySelector('[role=alert]').hidden=false;
              document.querySelector('[role=alert]').textContent='Credentials rejected'; }
            ${fakeCookie ? "document.cookie='LEETCODE_SESSION=unverified_fixture_cookie; path=/';" : ''}
            ${redirect ? "history.pushState({},'', '/problemset/');" : ''}
          };
        </script>` });
    });
    return { count: () => submissions, supplied: () => supplied };
  }

  it('submits once without requiring a CAPTCHA and returns the verified handle', async () => {
    const state = await fixture();
    const result = await loginOnLeetCodePage(page, 'email@example.test', '  exact password  ', { timeoutMs: 3000 });
    expect(result).toMatchObject({ ok: true, username: 'actual_handle' });
    expect(state.count()).toBe(1);
    expect(state.supplied()).toEqual({ username: 'email@example.test', password: '  exact password  ' });
  });
  it('hands a verification page off without typing credentials or posting', async () => {
    const state = await fixture({ verification: true, pageStatus: 403 });
    const result = await loginOnLeetCodePage(page, 'user', 'secret', { timeoutMs: 2000 });
    expect(result).toMatchObject({ ok: false, code: 'VERIFICATION_REQUIRED' });
    expect(state.count()).toBe(0);
    expect(await page.locator('#id_password').inputValue()).toBe('');
  });
  it('does not mistake an empty legacy token field for an active verification widget', async () => {
    const state = await fixture();
    await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
      const input = document.createElement('input');
      input.type = 'hidden'; input.name = 'cf-turnstile-response';
      document.querySelector('#login')!.append(input);
    }));
    expect(await loginOnLeetCodePage(page, 'user', 'secret', { timeoutMs: 3000 })).toMatchObject({ ok: true });
    expect(state.count()).toBe(1);
  });
  it('never enables a disabled login button', async () => {
    const state = await fixture({ disabled: true });
    expect(await loginOnLeetCodePage(page, 'user', 'secret', { timeoutMs: 2000 }))
      .toMatchObject({ ok: false, code: 'LOGIN_FORM_NOT_READY' });
    expect(await page.locator('#login button').isDisabled()).toBe(true);
    expect(state.count()).toBe(0);
  });
  it('does not trust a homepage redirect or session cookie without server identity', async () => {
    const state = await fixture({ signedIn: false, redirect: true, fakeCookie: true });
    expect(await loginOnLeetCodePage(page, 'user', 'secret', { timeoutMs: 900 }))
      .toMatchObject({ ok: false, code: 'LOGIN_TIMEOUT' });
    expect(state.count()).toBe(1);
  });
  it('reports form rejection and does not resubmit', async () => {
    const state = await fixture({ signedIn: false, rejected: true });
    expect(await loginOnLeetCodePage(page, 'user', 'secret', { timeoutMs: 2000 }))
      .toMatchObject({ ok: false, code: 'LOGIN_REJECTED' });
    expect(state.count()).toBe(1);
  });
  it('does not swallow navigation errors and continue into a solver', async () => {
    await page.route('**/*', route => route.abort('connectionfailed'));
    expect(await loginOnLeetCodePage(page, 'user', 'secret', { timeoutMs: 1500 }))
      .toMatchObject({ ok: false, code: 'LOGIN_BROWSER_ERROR' });
  });
  it('uses one bounded timeout for a delayed login page', async () => {
    await page.route('**/*', async route => {
      await new Promise(resolve => setTimeout(resolve, 600));
      await route.fulfill({ body: 'delayed' }).catch(() => undefined);
    });
    const start = Date.now();
    expect(await loginOnLeetCodePage(page, 'user', 'secret', { timeoutMs: 200 }))
      .toMatchObject({ ok: false, code: 'LOGIN_TIMEOUT' });
    expect(Date.now() - start).toBeLessThan(1500);
  });
  it('honors an already cancelled login without launching a browser', async () => {
    const controller = new AbortController(); controller.abort();
    expect(await loginToLeetCode('user', 'secret', { signal: controller.signal }))
      .toMatchObject({ ok: false, code: 'LOGIN_CANCELLED' });
  });
  it('closes the owned browser when cancellation arrives during navigation', async () => {
    const launch = chromium.launch.bind(chromium);
    let owned: Browser | undefined;
    vi.spyOn(chromium, 'launch').mockImplementationOnce(async options => {
      owned = await launch(options);
      const createContext = owned.newContext.bind(owned);
      vi.spyOn(owned, 'newContext').mockImplementationOnce(async options => {
        const context = await createContext(options);
        await context.route('**/*', () => { /* cancelled navigation: no remote request */ });
        return context;
      });
      return owned;
    });
    const controller = new AbortController();
    const result = await loginToLeetCode('user', 'secret', { timeoutMs: 3000, signal: controller.signal,
      onProgress: () => { controller.abort(); } });
    expect(result.code).toBe('LOGIN_CANCELLED');
    expect(owned?.isConnected()).toBe(false);
  });

  it('detects Cloudflare interstitial challenge and extracts sitekey', async () => {
    await page.route('https://leetcode.com/**', route => {
      route.fulfill({
        status: 403,
        contentType: 'text/html',
        body: '<html><head><title>Just a moment...</title></head><body><div id="challenge-running">Checking browser</div></body></html>',
      });
    });
    await page.goto('https://leetcode.com/accounts/login/');
    const detail = await detectVerificationDetail(page);
    expect(detail).toEqual({ type: 'cloudflare_interstitial', required: true });
  });

  it('detects Turnstile widget and extracts custom sitekey', async () => {
    await page.route('https://leetcode.com/**', route => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><div class="cf-turnstile" data-sitekey="0x4CustomLeetCodeKey999"></div><input name="cf-turnstile-response"></body></html>',
      });
    });
    await page.goto('https://leetcode.com/accounts/login/');
    const detail = await detectVerificationDetail(page);
    expect(detail).toEqual({
      type: 'turnstile',
      required: true,
      sitekey: '0x4CustomLeetCodeKey999',
    });
  });

  it('detects unsupported reCAPTCHA and hCaptcha challenges', async () => {
    await page.route('https://leetcode.com/**', route => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><div class="g-recaptcha"></div><input name="g-recaptcha-response"></body></html>',
      });
    });
    await page.goto('https://leetcode.com/accounts/login/');
    expect((await detectVerificationDetail(page)).type).toBe('recaptcha');

    await page.route('https://leetcode.com/**', route => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><div class="h-captcha"></div><input name="h-captcha-response"></body></html>',
      });
    });
    await page.goto('https://leetcode.com/accounts/login/');
    expect((await detectVerificationDetail(page)).type).toBe('hcaptcha');
  });

  it('transitions through complete state machine when solver succeeds in authorized test fixture', async () => {
    let turnstileCleared = false;
    let submissions = 0;
    await page.route('https://leetcode.com/**', async route => {
      const req = route.request();
      if (req.url().includes('/graphql')) {
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ data: { userStatus: { isSignedIn: submissions > 0, username: 'black_sheep_7' } } }),
        });
      }
      if (req.method() === 'POST') {
        submissions++;
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      }
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `
          <html>
            <body>
              <div id="cf-container">
                ${turnstileCleared ? '' : '<div class="cf-turnstile" data-sitekey="0x4TurnstileTestKey"></div><input name="cf-turnstile-response">'}
              </div>
              <form id="login">
                <input id="id_login">
                <input id="id_password" type="password">
                <button type="submit">Sign In</button>
              </form>
              <script>
                document.querySelector('#login').onsubmit = e => {
                  e.preventDefault();
                  fetch('/accounts/login/', { method: 'POST' });
                };
              </script>
            </body>
          </html>
        `,
      });
    });

    const states: LoginState[] = [];
    const solver = vi.fn(async () => {
      turnstileCleared = true;
      return { token: 'solved_turnstile_token', cookies: { cf_clearance: 'cleared_cookie' } };
    });

    const result = await loginOnLeetCodePage(page, 'black_sheep_7', 'test-password', {
      timeoutMs: 5000,
      solver,
      onProgress: (_msg, state) => {
        if (state) states.push(state);
      },
    });

    expect(solver).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    expect(result.state).toBe('AUTHENTICATED');
    expect(result.username).toBe('black_sheep_7');
    expect(states).toContain('LOGIN_PAGE_LOADING');
    expect(states).toContain('VERIFICATION_REQUIRED');
    expect(states).toContain('VERIFICATION_IN_PROGRESS');
    expect(states).toContain('VERIFICATION_COMPLETED');
    expect(states).toContain('AUTHENTICATING');
    expect(states).toContain('AUTHENTICATED');
  });

  it('transitions to AWAITING_USER_VERIFICATION with full diagnostics when solver fails to clear challenge', async () => {
    await page.route('https://leetcode.com/**', async route => {
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><div class="cf-turnstile"></div><input name="cf-turnstile-response"></body></html>',
      });
    });

    const states: LoginState[] = [];
    const solver = vi.fn(async () => null);

    const result = await loginOnLeetCodePage(page, 'black_sheep_7', 'test-password', {
      timeoutMs: 3000,
      solver,
      onProgress: (_msg, state) => {
        if (state) states.push(state);
      },
    });

    expect(solver).toHaveBeenCalledOnce();
    expect(result.ok).toBe(false);
    expect(result.code).toBe('VERIFICATION_REQUIRED');
    expect(result.state).toBe('AWAITING_USER_VERIFICATION');
    expect(result.diagnostic).toMatchObject({
      challengeType: 'turnstile',
      adapterInitialized: true,
      solverAttempted: true,
      solverResult: 'failed',
      manualVerificationRequired: true,
      continuationStatus: 'awaiting_user',
    });
    expect(states).toContain('LOGIN_PAGE_LOADING');
    expect(states).toContain('VERIFICATION_REQUIRED');
    expect(states).toContain('VERIFICATION_IN_PROGRESS');
    expect(states).toContain('AWAITING_USER_VERIFICATION');
  });

  it('transitions to AWAITING_USER_VERIFICATION without calling solver when challenge is unsupported', async () => {
    await page.route('https://leetcode.com/**', async route => {
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><div class="g-recaptcha"></div><input name="g-recaptcha-response"></body></html>',
      });
    });

    const solver = vi.fn();
    const result = await loginOnLeetCodePage(page, 'black_sheep_7', 'test-password', {
      timeoutMs: 3000,
      solver,
    });

    expect(solver).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.code).toBe('VERIFICATION_REQUIRED');
    expect(result.state).toBe('AWAITING_USER_VERIFICATION');
    expect(result.diagnostic).toMatchObject({
      challengeType: 'recaptcha',
      solverAttempted: false,
      solverResult: 'unsupported_challenge',
      manualVerificationRequired: true,
    });
  });

  it('detects explicit closed-shadow-root Turnstile widget (input[id^="cf-chl-widget-"][id$="_response"]) and ignores passive invisible reCAPTCHA Enterprise badge', async () => {
    await page.route('https://leetcode.com/**', route => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `
          <html>
            <body>
              <iframe src="https://www.recaptcha.net/recaptcha/enterprise/anchor?ar=1&k=6LdBpsIUAAAAAKAYWjZfIpn4cJHVIk_tsmxpl7cz&size=invisible"></iframe>
              <textarea name="g-recaptcha-response" id="g-recaptcha-response-100000" style="display:none"></textarea>
              <div>
                <div></div>
                <input type="hidden" name="cf-turnstile-response" id="cf-chl-widget-oc2gf_response">
              </div>
              <form id="login">
                <input id="id_login">
                <input id="id_password" type="password">
                <button type="submit">Sign In</button>
              </form>
            </body>
          </html>
        `,
      });
    });

    await page.goto('https://leetcode.com/accounts/login/');
    const detail = await detectVerificationDetail(page);
    expect(detail.type).toBe('turnstile');
    expect(detail.required).toBe(true);
    expect(detail.sitekey).toBeUndefined();
  });

  it('rejects Turnstile challenge with MISSING_TURNSTILE_SITEKEY when no runtime sitekey is present on page and never substitutes 0x4AAAAAAADnPIDROrmt1Wwj', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { initCapzyKeys } = await import('../src/codeforces/capzyKeyManager');
    initCapzyKeys(['capzy_test_fixture_00000000000000000000000000000000'], 0);

    await page.route('https://leetcode.com/**', route => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `
          <html>
            <body>
              <div>
                <input type="hidden" name="cf-turnstile-response" id="cf-chl-widget-nositekey_response">
              </div>
              <form id="login">
                <input id="id_login">
                <input id="id_password" type="password">
                <button type="submit">Sign In</button>
              </form>
            </body>
          </html>
        `,
      });
    });

    const result = await loginOnLeetCodePage(page, 'black_sheep_7', 'test-password', {
      timeoutMs: 3000,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('VERIFICATION_REQUIRED');
    expect(result.diagnostic?.providerErrorCode).toBe('MISSING_TURNSTILE_SITEKEY');
    expect(result.diagnostic?.providerErrorCategory).toBe('INVALID_REQUEST_CONFIGURATION');
    expect(fetchSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('api.capzy.ai'),
      expect.anything(),
    );
    initCapzyKeys([], 0);
    vi.unstubAllGlobals();
  });

  it('extracts LeetCode Turnstile sitekey from challenges.cloudflare.com resource entries instead of universal fallback', async () => {
    await page.route('https://challenges.cloudflare.com/**', route => {
      route.fulfill({ status: 200, contentType: 'application/javascript', body: '/* turnstile stub */' });
    });
    await page.route('https://leetcode.com/**', route => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `
          <html>
            <head>
              <script src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0/rch/89jvw/0x4AAAAAAAQrSHUTor4iGTpW/auto/fbE/new/flexible"></script>
            </head>
            <body>
              <div>
                <input type="hidden" name="cf-turnstile-response" id="cf-chl-widget-89jvw_response">
              </div>
              <form id="login">
                <input id="id_login">
                <input id="id_password" type="password">
                <button type="submit">Sign In</button>
              </form>
            </body>
          </html>
        `,
      });
    });

    await page.goto('https://leetcode.com/accounts/login/');
    const detail = await detectVerificationDetail(page);
    expect(detail.type).toBe('turnstile');
    expect(detail.required).toBe(true);
    expect(detail.sitekey).toBe('0x4AAAAAAAQrSHUTor4iGTpW');
  });

  it('finds sibling Sign In button outside <form> and detects deferred Turnstile mounting while disabled', async () => {
    let posts = 0;
    await page.route('https://challenges.cloudflare.com/**', route => {
      route.fulfill({ status: 200, contentType: 'application/javascript', body: '/* turnstile stub */' });
    });
    await page.route('https://leetcode.com/**', async route => {
      const req = route.request();
      if (req.url().includes('/graphql')) {
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ data: { userStatus: { isSignedIn: posts > 0, username: 'black_sheep_7' } } }),
        });
      }
      if (req.method() === 'POST') {
        posts++;
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      }
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `
          <html>
            <head>
              <script id="cf-turnstile-script" src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0/rch/89jvw/0x4AAAAAAAQrSHUTor4iGTpW/auto/fbE/new/flexible"></script>
            </head>
            <body>
              <form class="flex flex-col">
                <input id="id_login" name="username">
                <input id="id_password" name="password" type="password">
              </form>
              <div id="cf-turnstile" style="display: none;"></div>
              <div class="w-full">
                <button id="signin_btn" type="button" data-cy="sign-in-btn" disabled>Sign In</button>
              </div>
              <script>
                setTimeout(() => {
                  const box = document.getElementById('cf-turnstile');
                  box.style.display = 'block';
                  const inp = document.createElement('input');
                  inp.type = 'hidden';
                  inp.name = 'cf-turnstile-response';
                  inp.id = 'cf-chl-widget-89jvw_response';
                  box.appendChild(inp);
                  window.turnstile = {
                    render: (_el, params) => {
                      if (params && typeof params.callback === 'function') window.__onTs = params.callback;
                      return 'w1';
                    }
                  };
                  window.turnstile.render(box, {
                    sitekey: '0x4AAAAAAAQrSHUTor4iGTpW',
                    callback: () => {
                      document.getElementById('signin_btn').disabled = false;
                    }
                  });
                }, 150);
                document.getElementById('signin_btn').addEventListener('click', () => {
                  fetch('/accounts/login/', { method: 'POST' });
                });
              </script>
            </body>
          </html>
        `,
      });
    });

    const solver = vi.fn(async (params) => {
      expect(params.sitekey).toBe('0x4AAAAAAAQrSHUTor4iGTpW');
      return { token: 'solved_deferred_token' };
    });

    const result = await loginOnLeetCodePage(page, 'black_sheep_7', 'test-password', {
      timeoutMs: 6000,
      solver,
    });

    expect(solver).toHaveBeenCalledOnce();
    expect(posts).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.username).toBe('black_sheep_7');
  });
});
