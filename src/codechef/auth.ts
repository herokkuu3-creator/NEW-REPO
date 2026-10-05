import type { Page } from 'playwright';
import { withCodeChefPage, type CodeChefState } from './browser';

export async function loginOnCodeChefPage(page: Page, username: string, password: string, waitMs = 20000): Promise<CodeChefState> {
  if (!username || !password) throw new Error('CodeChef username and password are missing');
  const response = await page.goto('https://www.codechef.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (response && response.status() >= 400) throw new Error(`CodeChef login page returned HTTP ${response.status()}`);
  const form = page.locator('form:has(input[name="name"]):has(input[name="pass"])').first();
  await form.locator('input[name="name"]').fill(username, { timeout: 15000 });
  // Playwright action errors can include the filled value. Never propagate it.
  try { await form.locator('input[name="pass"]').fill(password); }
  catch { throw new Error('CodeChef password field could not be filled; authentication was not attempted.'); }
  await form.locator('input[type="submit"], button[type="submit"]').first().click();
  await page.waitForFunction(() => !document.querySelector('form input[name="pass"]')
    || !!document.querySelector('.messages.error, .login-error'), undefined, { timeout: waitMs }).catch(() => undefined);
  await page.goto('https://www.codechef.com/users/' + encodeURIComponent(username), { waitUntil: 'domcontentloaded', timeout: 30000 });
  const loggedIn = await page.locator('a[href*="/logout"], a[href*="/edit"], .logged-in-user, #user-menu').count();
  if (!loggedIn) throw new Error('CodeChef login was not verified. Check credentials or complete any required verification in your browser.');
  return page.context().storageState();
}

export async function loginToCodeChef(username: string, password: string): Promise<CodeChefState> {
  return withCodeChefPage(undefined, page => loginOnCodeChefPage(page, username, password));
}
