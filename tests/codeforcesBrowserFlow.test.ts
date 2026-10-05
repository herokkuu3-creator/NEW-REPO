import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { blockCodeforcesResource, clickSubmitForm, ensureFormTurnstile, fillSource, isSubmissionHistory, submissionFeedback, waitForCodeforcesPage } from '../src/codeforces/browserForm';
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

function formHtml(options: { token?: string; disabled?: boolean; prevent?: boolean; callback?: boolean; editorEnabled?: boolean } = {}): string {
  return `<!doctype html><link rel="stylesheet" href="/submit.css"><div id="body">
    <form action="/search" method="post"><input type="submit" value="Search"></form>
    <form id="solution" action="${fixtureOrigin}/contest/1/submit" method="post">
      <input type="hidden" name="csrf_token" value="csrf">
      <select name="submittedProblemIndex"><option value="A">A</option></select>
      <select name="programTypeId"><option value="89">GNU G++23</option></select>
      <input type="hidden" name="turnstileToken" value="${options.token ?? ''}">
      <input type="hidden" name="_tta" value="">
      <input id="toggleEditorCheckbox" type="checkbox" ${options.editorEnabled ? '' : 'checked'}>
      <textarea name="source"></textarea>
      <input type="submit" name="submit" value="Submit" ${options.disabled ? 'disabled' : ''}>
      ${options.callback ? '<div class="cf-turnstile" data-sitekey="fixture-key" data-callback="onVerified"></div>' : ''}
    </form></div>
    <script>
      window.editor = {
        value: '',
        setValue: function(value) { this.value = value; },
        save: function() {
          window.saved = true;
          if (!document.getElementById('toggleEditorCheckbox').checked) {
            document.querySelector('[name=source]').value = this.value;
          }
        }
      };
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
  it('does not mistake a generic body container for a completed page', async () => {
    await page.setContent('<div id="body">Loading...</div>');
    expect(await waitForCodeforcesPage(page, 'submit', 200)).toBe(false);
  });

  it('waits for the actual form to appear after the page shell', async () => {
    await page.setContent(`<div id="body"></div><script>
      setTimeout(() => document.querySelector('#body').innerHTML =
        '<form><textarea name="source"></textarea><select name="programTypeId"></select></form>', 150);
    </script>`);
    expect(await waitForCodeforcesPage(page, 'submit', 2000)).toBe(true);
  });

  it('does not accept a challenge title even when form controls exist', async () => {
    await page.setContent('<title>Just a moment...</title>' + formHtml());
    expect(await waitForCodeforcesPage(page, 'submit', 200)).toBe(false);
  });

  it('requires submission rows or a status table on a history URL', async () => {
    await fixture();
    await page.goto('https://codeforces.com/contest/1/my');
    expect(await waitForCodeforcesPage(page, 'result', 200)).toBe(false);
    await page.locator('#body').evaluate(el => { el.innerHTML = '<table class="status-frame"></table>'; });
    expect(await waitForCodeforcesPage(page, 'result', 1000)).toBe(true);
  });

  it('retains CSS and every Cloudflare verification resource', async () => {
    expect(blockCodeforcesResource('https://challenges.cloudflare.com/widget/image', 'image')).toBe(false);
    expect(blockCodeforcesResource('https://codeforces.com/cdn-cgi/challenge-platform/image', 'image')).toBe(false);
    expect(blockCodeforcesResource('https://codeforces.com/logo.png', 'image')).toBe(true);
    await fixture({ token: 'verified' });
    expect(await page.locator('#body').evaluate(e => getComputedStyle(e).color)).toBe('rgb(1, 2, 3)');
  });

  it('allows an empty legacy token field when no Turnstile widget is present', async () => {
    await fixture();
    expect(await ensureFormTurnstile(page, 25)).toEqual({ turnstile: false, interactive: false });
    expect(posts).toHaveLength(0);
  });

  it('stops without clicking or posting when a Turnstile widget never produces a token', async () => {
    await fixture({ disabled: true, callback: true });
    await expect(ensureFormTurnstile(page, 25)).rejects.toMatchObject({ kind: 'blocked', clicked: false, flags: { turnstile: true } });
    expect(posts).toHaveLength(0);
  });

  it('waits for a delayed native token', async () => {
    await fixture();
    await page.evaluate(() => setTimeout(() => {
      (document.querySelector('[name=turnstileToken]') as HTMLInputElement).value = 'native-token';
    }, 40));
    expect(await ensureFormTurnstile(page, 1_000)).toEqual({ turnstile: true, interactive: false });
  });

  it('detects a widget outside the form even without a custom token field', async () => {
    await fixture();
    await page.evaluate(() => {
      document.querySelector('[name=turnstileToken]')?.remove();
      const widget = document.createElement('div');
      widget.className = 'cf-turnstile';
      document.body.append(widget);
    });
    await expect(ensureFormTurnstile(page, 50)).rejects.toMatchObject({ kind: 'blocked', clicked: false });
    expect(posts).toHaveLength(0);
  });

  it('accepts the standard native response only when Submit becomes ready', async () => {
    await fixture({ disabled: true });
    await page.evaluate(() => {
      const field = document.querySelector('[name=turnstileToken]') as HTMLInputElement;
      field.name = 'cf-turnstile-response';
      setTimeout(() => {
        field.value = 'native-standard-response';
        (document.querySelector('#solution input[type=submit]') as HTMLInputElement).disabled = false;
      }, 40);
    });
    expect(await ensureFormTurnstile(page, 1_000)).toEqual({ turnstile: true, interactive: false });
    expect(posts).toHaveLength(0);
  });

  it('waits for a late widget instead of mistaking missing fields for no verification', async () => {
    await fixture();
    await page.evaluate(() => {
      document.querySelector('[name=turnstileToken]')?.remove();
      setTimeout(() => {
        const widget = document.createElement('div');
        widget.className = 'cf-turnstile';
        document.body.append(widget);
      }, 30);
    });
    await expect(ensureFormTurnstile(page, 500)).rejects.toMatchObject({ kind: 'blocked', clicked: false });
    expect(posts).toHaveLength(0);
  });

  it('blocks when verification script exists but its widget has not initialized', async () => {
    await fixture();
    await page.evaluate(() => {
      const script = document.createElement('script');
      script.type = 'text/plain';
      script.textContent = 'turnstile.render(container)';
      document.body.append(script);
    });
    await expect(ensureFormTurnstile(page, 50)).rejects.toMatchObject({ kind: 'blocked', clicked: false });
    expect(posts).toHaveLength(0);
  });

  it('never submits with a token while the native Submit control remains disabled', async () => {
    await fixture({ token: 'verified', disabled: true });
    await expect(ensureFormTurnstile(page, 50)).rejects.toMatchObject({ kind: 'blocked', clicked: false });
    await expect(clickSubmitForm(page, 300)).rejects.toMatchObject({ kind: 'blocked', clicked: false });
    expect(posts).toHaveLength(0);
  });

  it('never forces a hidden Submit control into sending a POST', async () => {
    await fixture({ token: 'verified' });
    await page.locator('#solution input[type=submit]').evaluate(element => (element as HTMLElement).style.display = 'none');
    await expect(ensureFormTurnstile(page, 50)).rejects.toMatchObject({ kind: 'blocked', clicked: false });
    await expect(clickSubmitForm(page, 300)).rejects.toMatchObject({ kind: 'blocked', clicked: false });
    expect(posts).toHaveLength(0);
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

  it('switches off an enabled editor and keeps source intact through native submit', async () => {
    await fixture({ token: 'verified', editorEnabled: true });
    await fillSource(page, code);
    expect(await page.locator('#toggleEditorCheckbox').isChecked()).toBe(true);
    expect(await page.evaluate(() => (window as any).editor.value)).toBe(code);
    await clickSubmitForm(page);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.get('source')).toBe(code);
  });

  it('reads visible validation labels without reading source or hidden tokens', async () => {
    await page.setContent('<span class="error">Source is empty</span><span class="error" style="display:none">Hidden error</span><textarea>private source</textarea><input type="hidden" name="csrf_token" value="private-token">');
    expect(await submissionFeedback(page)).toBe('Source is empty');
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
