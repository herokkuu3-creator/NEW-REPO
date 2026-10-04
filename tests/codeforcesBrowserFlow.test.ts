import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { blockCodeforcesResource, clickSubmitForm, ensureFormTurnstile, fillSource, isSubmissionHistory } from '../src/codeforces/browserForm';
import { postSubmitForm } from '../src/codeforces/submission';
import type { BrowserSession } from '../src/browser/playwright';
import type { SourceIndexEntry } from '../src/codeforces/sourceRepo';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let browser: Browser;
let page: Page;
const source = { contestId: 1, problemIndex: 'A', gym: false, language: 'cpp' } as SourceIndexEntry;
const code = 'int main() { return 0; }';
let posts: URLSearchParams[];
let server: Server;
let fixtureOrigin: string;
let fixtureResult = 'history';

function formHtml(options: { token?: string; disabled?: boolean; prevent?: boolean; callback?: boolean } = {}): string {
  return `<!doctype html><link rel="stylesheet" href="/submit.css"><div id="body">
    <form action="/search" method="post"><input type="submit" value="Search"></form>
    <form id="solution" action="${fixtureOrigin}/contest/1/submit" method="post">
      <input type="hidden" name="csrf_token" value="csrf">
      <select name="submittedProblemIndex"><option value="A">A</option></select>
      <select name="programTypeId"><option value="89">GNU G++23</option></select>
      <input type="hidden" name="turnstileToken" value="${options.token ?? ''}">
      <input type="hidden" name="_tta" value="">
      <input id="toggleEditorCheckbox" type="checkbox" checked>
      <textarea name="source"></textarea>
      <input type="submit" name="submit" value="Submit" ${options.disabled ? 'disabled' : ''}>
      ${options.callback ? '<div class="cf-turnstile" data-sitekey="fixture-key" data-callback="onVerified"></div>' : ''}
    </form></div>
    <script>
      window.editor = { save: () => { window.saved = true; } };
      window.onVerified = () => document.querySelector('#solution input[type=submit]').disabled = false;
      document.querySelector('#solution').addEventListener('submit', event => {
        ${options.prevent ? 'event.preventDefault();' : ''}
        window.editor.save();
        event.target.querySelector('[name=_tta]').value = 'native-signature';
      });
    </script>`;
}

async function fixture(options: Parameters<typeof formHtml>[0] = {}, result = 'history') {
  fixtureResult = result;
  await page.route('https://codeforces.com/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (blockCodeforcesResource(request.url(), request.resourceType())) return route.abort();
    if (path === '/submit.css') return route.fulfill({ contentType: 'text/css', body: '#body { color: rgb(1, 2, 3); }' });
    if (path === '/contest/1/my') return route.fulfill({ contentType: 'text/html', body: '<div id="body">My submissions</div>' });
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="body">Home</div>' });
    return route.fulfill({ contentType: 'text/html', body: formHtml(options) });
  });
  await page.goto('https://codeforces.com/contest/1/submit');
}

beforeAll(async () => {
  // Browser routing does not intercept the next hop of an HTTP redirect. Use a
  // real loopback server and map the fixture hostname so no redirect reaches Codeforces.
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.method !== 'POST') {
      response.end(request.url === '/contest/1/my' ? '<div id="body">My submissions</div>' : '<div id="body">Home</div>');
      return;
    }
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      posts.push(new URLSearchParams(body));
      if (fixtureResult === 'abort') { request.socket.destroy(); return; }
      if (fixtureResult === 'form') { response.end(formHtml({ token: 'fresh' })); return; }
      if (fixtureResult === 'challenge') { response.statusCode = 403; response.end('Just a moment... checking your browser'); return; }
      response.statusCode = 302;
      response.setHeader('location', fixtureResult === 'home' ? '/' : '/contest/1/my');
      response.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  fixtureOrigin = `http://codeforces.com:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP codeforces.com 127.0.0.1', '--no-proxy-server'] });
});
beforeEach(async () => { page = await browser.newPage(); posts = []; });
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await page.close(); });
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

describe('Codeforces native browser submission', () => {
  it('retains CSS and every Cloudflare verification resource', async () => {
    expect(blockCodeforcesResource('https://challenges.cloudflare.com/widget/image', 'image')).toBe(false);
    expect(blockCodeforcesResource('https://codeforces.com/cdn-cgi/challenge-platform/image', 'image')).toBe(false);
    expect(blockCodeforcesResource('https://codeforces.com/logo.png', 'image')).toBe(true);
    await fixture({ token: 'verified' });
    expect(await page.locator('#body').evaluate(e => getComputedStyle(e).color)).toBe('rgb(1, 2, 3)');
  });

  it('stops without clicking or posting when verification never produces a token', async () => {
    await fixture({ disabled: true });
    await expect(ensureFormTurnstile(page, 25)).rejects.toMatchObject({ kind: 'blocked', clicked: false, flags: { turnstile: false } });
    expect(posts).toHaveLength(0);
  });

  it('waits for a delayed native token', async () => {
    await fixture();
    await page.evaluate(() => setTimeout(() => {
      (document.querySelector('[name=turnstileToken]') as HTMLInputElement).value = 'native-token';
    }, 40));
    expect(await ensureFormTurnstile(page, 1_000)).toEqual({ turnstile: true, interactive: false });
  });

  it('renders an uninitialized Turnstile widget with the real page API', async () => {
    await fixture({ disabled: true, callback: true });
    await page.evaluate(() => {
      (window as any).turnstile = {
        render: (_widget: HTMLElement, options: { callback: (token: string) => void }) => {
          setTimeout(() => options.callback('native-render-token'), 10);
          return 'widget-id';
        },
      };
    });
    expect(await ensureFormTurnstile(page, 3_500)).toEqual({ turnstile: true, interactive: false });
    expect(await page.locator('#solution input[type=submit]').isEnabled()).toBe(true);
    expect(posts).toHaveLength(0);
  });

  it('never turns a disabled button into a successful click', async () => {
    await fixture({ token: 'verified', disabled: true });
    await expect(clickSubmitForm(page, 300)).rejects.toMatchObject({ kind: 'blocked', clicked: false });
    expect(posts).toHaveLength(0);
  });

  it('lets a solver update the native callback without submitting the search or solution form', async () => {
    await fixture({ disabled: true, callback: true });
    vi.stubEnv('TURNSTILE_SOLVER_URL', 'https://solver.example');
    const solve = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ token: 'solver-token' }) });
    vi.stubGlobal('fetch', solve);
    expect(await ensureFormTurnstile(page, 25)).toEqual({ turnstile: true, interactive: false });
    expect(solve).toHaveBeenCalledOnce();
    expect(posts).toHaveLength(0);
    expect(await page.locator('#solution input[type=submit]').isEnabled()).toBe(true);
  });

  it('submits the source once through native signing handlers and follows the redirect', async () => {
    await fixture({ token: 'verified' });
    const result = await postSubmitForm({ page } as BrowserSession, source, code);
    expect(result).toMatchObject({ ok: true, clicked: true, turnstile: true, status: 200 });
    expect(posts).toHaveLength(1);
    expect(posts[0]?.get('source')).toBe(code);
    expect(posts[0]?.get('_tta')).toBe('native-signature');
    expect(posts[0]?.get('turnstileToken')).toBe('verified');
  });

  it('preserves the real editor object while filling the textarea', async () => {
    await fixture({ token: 'verified' });
    await fillSource(page, code);
    expect(await page.locator('textarea').inputValue()).toBe(code);
    expect(await page.evaluate(() => {
      (window as any).editor.save();
      return (window as any).saved;
    })).toBe(true);
  });

  it('reports a prevented submit instead of treating a click as a POST', async () => {
    await fixture({ token: 'verified', prevent: true });
    await expect(clickSubmitForm(page, 300)).rejects.toMatchObject({ clicked: true, message: expect.stringContaining('did not send a POST') });
    expect(posts).toHaveLength(0);
  });

  it('does not report success or repeat a POST when Codeforces returns the form', async () => {
    await fixture({ token: 'verified' }, 'form');
    const result = await postSubmitForm({ page } as BrowserSession, source, code);
    expect(result).toMatchObject({ ok: false, kind: 'submission-error', clicked: true });
    expect(posts).toHaveLength(1);
  });

  it('rejects a homepage redirect instead of waiting for a nonexistent judge verdict', async () => {
    await fixture({ token: 'verified' }, 'home');
    expect(await postSubmitForm({ page } as BrowserSession, source, code)).toMatchObject({ ok: false, kind: 'submission-error' });
    expect(posts).toHaveLength(1);
  });

  it('does not repeat an ambiguous failed POST', async () => {
    await fixture({ token: 'verified' }, 'abort');
    expect(await postSubmitForm({ page } as BrowserSession, source, code)).toMatchObject({ ok: false, clicked: true, turnstile: true });
    expect(posts).toHaveLength(1);
  });

  it('reports a Cloudflare block without a second POST', async () => {
    vi.stubEnv('CODEFORCES_CHALLENGE_WAIT_MS', '0');
    await fixture({ token: 'verified' }, 'challenge');
    expect(await postSubmitForm({ page } as BrowserSession, source, code)).toMatchObject({ ok: false, kind: 'blocked', status: 403 });
    expect(posts).toHaveLength(1);
  });

  it('recognizes only Codeforces submission history URLs', () => {
    expect(isSubmissionHistory('https://codeforces.com/gym/101021/my')).toBe(true);
    expect(isSubmissionHistory('https://codeforces.com/problemset/status?my=on')).toBe(true);
    expect(isSubmissionHistory('https://codeforces.com/')).toBe(false);
    expect(isSubmissionHistory('https://codeforces.com.evil.example/contest/1/my')).toBe(false);
  });
});
