import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { normalizeCodeChefVerdict, submitOnCodeChefPage } from '../src/codechef/api';
import { loginOnCodeChefPage } from '../src/codechef/auth';

let browser: Browser;
let page: Page;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
beforeEach(async () => { page = await browser.newPage(); });
afterEach(async () => { await page.close(); });
afterAll(async () => { await browser.close(); });

describe('CodeChef current browser flow', () => {
  async function fixture(result: unknown, withEditor = true) {
    const submitted: unknown[] = [];
    await page.route('https://www.codechef.com/**', async route => {
      if (route.request().method() === 'POST') {
        submitted.push(route.request().postDataJSON());
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
      }
      return route.fulfill({ contentType: 'text/html', body: `<p>Sample output: Correct Answer</p><div class="toaster">Correct Answer</div>
        <select><option value="python3">Python 3</option><option value="cpp17">C++17</option></select>
        ${withEditor ? '<div class="ace_editor" style="width:400px;height:100px">Editor</div>' : ''}
        <button id="submit_btn">Submit</button><script>
        window.source='';window.ace={edit:()=>({setValue:c=>window.source=c,getValue:()=>window.source})};
        document.querySelector('#submit_btn').onclick=()=>fetch('/api/ide/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:window.source,language:document.querySelector('select').value})});
        </script>` });
    });
    return submitted;
  }

  it('fills Ace, selects C++, and confirms the ID and verdict from the submission POST', async () => {
    const submitted = await fixture({ data: { submission_id: 123456, verdict: 'Correct Answer' } });
    const result = await submitOnCodeChefPage(page, 'https://www.codechef.com/OCT21C/problems/THREEBOX', 'int main(){}', 'cpp', 2000);
    expect(submitted).toEqual([{ code: 'int main(){}', language: 'cpp17' }]);
    expect(result).toMatchObject({ ok: true, performed: true, submissionId: '123456', verdict: 'Accepted', clicked: true });
  });

  it('records a terminal wrong answer as performed rather than looping on the same source', async () => {
    const submitted = await fixture({ submission_id: '234567', verdict: 'Wrong Answer' });
    const result = await submitOnCodeChefPage(page, 'https://www.codechef.com/problems/AAA', 'code', 'cpp', 2000);
    expect(result).toMatchObject({ ok: false, performed: true, submissionId: '234567', verdict: 'Wrong Answer' });
    expect(submitted).toHaveLength(1);
  });

  it('does not claim acceptance from problem text, toast text, or a response without an ID', async () => {
    const submitted = await fixture({ verdict: 'Accepted' });
    const result = await submitOnCodeChefPage(page, 'https://www.codechef.com/problems/AAA', 'code', 'cpp', 300);
    expect(result).toMatchObject({ ok: false, clicked: true, verdict: 'UNKNOWN' });
    expect(result.performed).not.toBe(true);
    expect(submitted).toHaveLength(1);
  });

  it('recognizes login redirects before any submission attempt', async () => {
    await page.route('https://www.codechef.com/**', route => (route.request().url().includes('/submit/') || route.request().url().includes('/problems/'))
      ? route.fulfill({ status: 302, headers: { location: 'https://www.codechef.com/login' } })
      : route.fulfill({ contentType: 'text/html', body: 'Please login' }));
    expect(await submitOnCodeChefPage(page, 'https://www.codechef.com/problems/AAA', 'code')).toMatchObject({ ok: false, kind: 'signed-out', clicked: false });
  });

  it('verifies submission using upid and result_code from modern CodeChef /api/ide/submit response', async () => {
    await fixture({
      upid: '1369704347',
      result_code: 'accepted',
      result_description: '',
      show_status_table: 'yes',
    });
    const result = await submitOnCodeChefPage(page, 'https://www.codechef.com/problems/LEXMATCH?tab=ide', 'int main(){}', 'cpp', 2000);
    expect(result).toMatchObject({
      ok: true,
      performed: true,
      submissionId: '1369704347',
      verdict: 'Accepted',
      clicked: true,
    });
  });

  it('handles active polling for verdict when initial submit returns pending result', async () => {
    let polled = false;
    await page.route('https://www.codechef.com/**', async route => {
      const url = route.request().url();
      if (route.request().method() === 'POST') {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ upid: '1369704347', result_code: 'wait' }) });
      }
      if (url.includes('/api/ide/submit') && url.includes('solution_id=')) {
        polled = true;
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ upid: '1369704347', result_code: 'accepted' }) });
      }
      return route.fulfill({ contentType: 'text/html', body: `
        <select><option value="cpp17">C++17</option></select>
        <div class="ace_editor">Editor</div>
        <button id="submit_btn">Submit</button>
        <script>
        window.source='';window.ace={edit:()=>({setValue:c=>window.source=c,getValue:()=>window.source})};
        document.querySelector('#submit_btn').onclick=()=>fetch('/api/ide/submit',{method:'POST',body:JSON.stringify({code:window.source})});
        </script>` });
    });

    const result = await submitOnCodeChefPage(page, 'https://www.codechef.com/problems/LEXMATCH', 'int main(){}', 'cpp', 5000);
    expect(result).toMatchObject({
      ok: true,
      performed: true,
      submissionId: '1369704347',
      verdict: 'Accepted',
    });
    expect(polled).toBe(true);
  });

  it('logs in through the login form instead of the adjacent registration form', async () => {
    let submitted = 0;
    await page.route('https://www.codechef.com/**', route => {
      if (route.request().method() === 'POST') {
        submitted++;
        return route.fulfill({ status: 302, headers: { location: 'https://www.codechef.com/users/tester' } });
      }
      return route.fulfill({ contentType: 'text/html', body: route.request().url().includes('/login')
        ? '<form><input name="full_name"><input name="password" type="password"></form><form method="post"><input name="name"><input name="pass" type="password"><input type="submit"></form>'
        : '<a href="/logout">Logout</a>' });
    });
    await loginOnCodeChefPage(page, 'tester', 'fixture-password', 1000);
    expect(submitted).toBe(1);
  });

  it('does not treat unrelated cookies as a verified login', async () => {
    await page.context().addCookies([{ name: 'analytics', value: 'fixture', domain: 'www.codechef.com', path: '/' }]);
    await page.route('https://www.codechef.com/**', route => route.fulfill({ contentType: 'text/html', body: '<form><input name="name"><input name="pass" type="password"><input type="submit"></form><script>document.querySelector("form").onsubmit=e=>e.preventDefault()</script>' }));
    await expect(loginOnCodeChefPage(page, 'tester', 'fixture', 100)).rejects.toThrow('login was not verified');
  });

  it('uses exact terminal verdicts, including compilation/runtime/time-limit failures', () => {
    expect(normalizeCodeChefVerdict('Incorrect')).toBeNull();
    expect(normalizeCodeChefVerdict('Running')).toBeNull();
    expect(normalizeCodeChefVerdict('Compilation Error')).toBe('Compilation Error');
    expect(normalizeCodeChefVerdict('TLE')).toBe('Time Limit Exceeded');
    expect(normalizeCodeChefVerdict('Runtime Error')).toBe('Runtime Error');
    expect(normalizeCodeChefVerdict('accepted')).toBe('Accepted');
    expect(normalizeCodeChefVerdict('wrong')).toBe('Wrong Answer');
  });
});
