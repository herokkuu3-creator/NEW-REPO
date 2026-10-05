import { chromium } from 'playwright';
import { logger } from '../logger';

export async function loginToCodeChef(username: string, password: string):Promise<any> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    logger.info({ username }, 'Logging into CodeChef');
    await page.goto('https://www.codechef.com/login', { waitUntil: 'networkidle' });
    
    // Fill credentials
    await page.fill('input[name="username"]', username);
    await page.fill('input[name="password"]', password);
    
    // Click submit
    await page.click('button[type="submit"]');
    
    // Wait for navigation or successful login indication
    await page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {});
    
    // Optional: verify login by checking for a user menu or similar element
    // await page.waitForSelector('.user-details-container', { timeout: 5000 });

    const storageState = await context.storageState();
    return storageState;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'CodeChef login failed');
    throw err;
  } finally {
    await browser.close();
  }
}
