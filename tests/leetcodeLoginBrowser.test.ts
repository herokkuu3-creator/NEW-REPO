import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { loginOnLeetCodePage, loginToLeetCode } from '../src/leetcode/auth';

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
});
