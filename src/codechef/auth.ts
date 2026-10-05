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

  logger.info('Submitting CodeChef login form...');
  await form.locator('input[type="submit"], button[type="submit"]').first().click();

  logger.info('Waiting for login to process...');
  await page.waitForFunction(() => {
    return !document.querySelector('form input[name="pass"]')
      || !!document.querySelector('.messages.error, .login-error, .error, [role="alert"]');
  }, undefined, { timeout: waitMs }).catch(() => null);

  const errorText = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.messages.error, .login-error, .error'))
      .map(el => (el.textContent || '').trim()).filter(Boolean).join('; ');
  });
  if (errorText) throw new Error(`CodeChef login failed: ${errorText}`);

  const cookies = await page.context().cookies('https://www.codechef.com');
  const hasSession = cookies.some(c => /^(?:S?SESS|remember_me|Drupal\.visitor)/i.test(c.name));
  const currentUrl = page.url();
  const hasLoggedInElement = (await page.locator('a[href*="/logout"], a[href*="/edit"], #user-menu, .logged-in-user, .user-avatar').count()) > 0;
  logger.info({ currentUrl, cookieCount: cookies.length, hasSession, hasLoggedInElement }, 'CodeChef session verified');

  if (!hasSession && !currentUrl.includes('/dashboard') && !hasLoggedInElement) {
    throw new Error('CodeChef login was not verified. Session cookies were not received.');
  }

  return page.context().storageState();
}

export async function loginToCodeChef(username: string, password: string): Promise<CodeChefState> {
  return withCodeChefPage(undefined, page => loginOnCodeChefPage(page, username, password));
}
