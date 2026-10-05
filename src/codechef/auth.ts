import type { Page } from 'playwright';
import { withCodeChefPage, type CodeChefState } from './browser';
import { logger } from '../logger';

export async function loginOnCodeChefPage(page: Page, username: string, password: string, waitMs = 20000): Promise<CodeChefState> {
  if (!username || !password) throw new Error('CodeChef username and password are missing');
  logger.info({ username }, 'Opening CodeChef login page...');
  const response = await page.goto('https://www.codechef.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (response && response.status() >= 400) throw new Error(`CodeChef login page returned HTTP ${response.status()}`);

  const form = page.locator('form:has(input[name="name"]):has(input[name="pass"])').first();
  await form.locator('input[name="name"]').fill(username, { timeout: 15000 });
  try { await form.locator('input[name="pass"]').fill(password); }
  catch { throw new Error('CodeChef password field could not be filled; authentication was not attempted.'); }

  logger.info('Submitting CodeChef login form via AJAX...');

  const loginApiPromise = page.waitForResponse(
    res => res.url().includes('/api/codechef/login') && res.request().method() === 'POST',
    { timeout: waitMs }
  ).catch(() => null);

  await form.locator('input[type="submit"], button[type="submit"]').first().click();

  const apiRes = await loginApiPromise;
  if (apiRes) {
    const json = await apiRes.json().catch(() => null);
    logger.info({ status: apiRes.status(), json: json ? JSON.stringify(json).slice(0, 200) : null }, 'CodeChef login API responded');
    if (json && (json.status === 'error' || json.message?.error)) {
      const err = json.message?.error || json.message || JSON.stringify(json);
      throw new Error(`CodeChef login rejected: ${err}`);
    }
  }

  logger.info('Waiting for dashboard redirect or error message...');
  await Promise.race([
    page.waitForURL('**/dashboard*', { timeout: 15000 }).catch(() => null),
    page.waitForFunction(() => {
      const errs = document.querySelectorAll('.messages.error, .login-error, .error');
      for (const e of Array.from(errs)) if ((e.textContent || '').trim()) return true;
      return false;
    }, undefined, { timeout: 15000 }).catch(() => null)
  ]);

  const errorText = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.messages.error, .login-error, .error'))
      .map(el => (el.textContent || '').trim()).filter(Boolean).join('; ');
  });
  if (errorText) throw new Error(`CodeChef login failed: ${errorText}`);

  const cookies = await page.context().cookies('https://www.codechef.com');
  const hasSession = cookies.some(c => /^(?:S?SESS|remember_me|Drupal\.visitor)/i.test(c.name));
  const currentUrl = page.url();
  logger.info({ currentUrl, cookieCount: cookies.length, hasSession }, 'CodeChef session verified');

  if (!hasSession && !currentUrl.includes('/dashboard')) {
    throw new Error('CodeChef login was not verified. Session cookies were not received.');
  }

  return page.context().storageState();
}

export async function loginToCodeChef(username: string, password: string): Promise<CodeChefState> {
  return withCodeChefPage(undefined, page => loginOnCodeChefPage(page, username, password));
}
