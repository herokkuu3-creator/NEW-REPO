import { chromium, type BrowserContext, type Page } from 'playwright';
import { buildLaunchArgs } from '../browser/playwright';
import { applyStealthScripts, getRandomDesktopViewport } from '../browser/stealth';
import { DEFAULT_DESKTOP_CHROME_USER_AGENT } from '../codeforces/browserForm';
import { solveCloudflareOrchestrated } from '../codeforces/captchaSolver';
import { StorageStateShape } from '../browser/cookiePayload';
import { logger } from '../logger';
import { toPlaywrightProxy } from '../codeforces/proxyRotator';

export interface LeetCodeLoginResult {
  ok: boolean;
  username?: string;
  storageState?: StorageStateShape;
  error?: string;
}

export interface LeetCodeLoginOptions {
  proxyUrl?: string;
  timeoutMs?: number;
  onProgress?: (status: string) => Promise<void> | void;
}

/**
 * Executes an automated login to LeetCode, solving Turnstile / Cloudflare challenges
 * using the orchestrated solver (CPSolver -> Capzy fallback).
 */
export async function loginToLeetCode(
  loginInput: string,
  passwordInput: string,
  options?: LeetCodeLoginOptions,
): Promise<LeetCodeLoginResult> {
  const username = loginInput.trim();
  const password = passwordInput;
  if (!username || !password) {
    return { ok: false, error: 'Username/email and password are required' };
  }

  const timeoutMs = options?.timeoutMs ?? 60_000;
  const notify = async (msg: string) => {
    try {
      await options?.onProgress?.(msg);
    } catch {}
  };

  logger.info({ username }, 'Starting automated LeetCode login');
  await notify('🔎 Launching browser for LeetCode authentication…');

  const proxyConfig = options?.proxyUrl ? toPlaywrightProxy(options.proxyUrl) : undefined;
  const launchArgs = buildLaunchArgs(true);

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: launchArgs,
      proxy: proxyConfig,
    });
  } catch (err) {
    return {
      ok: false,
      error: `Could not launch browser: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const viewport = getRandomDesktopViewport();
    const context: BrowserContext = await browser.newContext({
      userAgent: DEFAULT_DESKTOP_CHROME_USER_AGENT,
      viewport,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      serviceWorkers: 'block',
    });

    await applyStealthScripts(context, 'chromium');

    // Route blocking to conserve memory on 512MB RAM instances
    await context.route('**/*', (route) => {
      const request = route.request();
      const parsed = new URL(request.url());
      if (
        parsed.hostname === 'challenges.cloudflare.com' ||
        parsed.hostname.includes('leetcode.com') ||
        parsed.hostname.includes('recaptcha.net') ||
        parsed.hostname.includes('google.com') ||
        parsed.hostname.includes('gstatic.com') ||
        parsed.pathname.startsWith('/cdn-cgi/')
      ) {
        return route.continue();
      }
      const blockedTypes = ['image', 'font', 'media'];
      if (blockedTypes.includes(request.resourceType())) return route.abort();
      const blockedHosts = ['google-analytics.com', 'googletagmanager.com', 'doubleclick.net'];
      if (blockedHosts.some((h) => parsed.hostname.includes(h))) return route.abort();
      return route.continue();
    });

    let page: Page = await context.newPage();

    await notify('🌐 Navigating to LeetCode login page…');
    const gotoRes = await page.goto('https://leetcode.com/accounts/login/', {
      waitUntil: 'domcontentloaded',
      timeout: 40_000,
    }).catch((e) => {
      logger.warn({ err: String(e) }, 'Initial navigation to login page timed out or had error');
      return null;
    });

    if (gotoRes && gotoRes.status() >= 400 && gotoRes.status() !== 403) {
      return { ok: false, error: `LeetCode login page returned HTTP ${gotoRes.status()}` };
    }

    // Wait for initial render
    await page.waitForTimeout(2000);

    // Check for Cloudflare Turnstile or Managed Challenge on page
    const turnstileFrame = page.locator('iframe[src*="challenges.cloudflare.com"]');
    const hasTurnstile = (await turnstileFrame.count().catch(() => 0)) > 0;
    const isCloudflareChallenge =
      (await page.title().catch(() => '')).toLowerCase().includes('just a moment') ||
      (await page.locator('text=/just a moment|checking your browser|verify you are human/i').count().catch(() => 0)) > 0 ||
      (await page.locator('input[name="cf-turnstile-response"]').count().catch(() => 0)) > 0;

    if (hasTurnstile || isCloudflareChallenge) {
      await notify('🧩 Detected Cloudflare Turnstile verification. Solving…');
      logger.info('Cloudflare Turnstile detected on LeetCode login page; solving via orchestrated solver');
      const sitekey = await page.evaluate(() => {
        const el = document.querySelector('[data-sitekey]');
        return el ? el.getAttribute('data-sitekey') : null;
      }).catch(() => null);

      const currentCookies = await context.cookies('https://leetcode.com').catch(() => []);
      const solved = await solveCloudflareOrchestrated({
        websiteURL: page.url(),
        sitekey: sitekey || undefined,
        proxyUrl: options?.proxyUrl,
        userAgent: DEFAULT_DESKTOP_CHROME_USER_AGENT,
        cookies: currentCookies,
        timeoutMs: Math.min(timeoutMs, 35_000),
      });

      if (solved?.cookies) {
        const newCookies = Object.entries(solved.cookies).map(([name, value]) => ({
          name,
          value,
          domain: '.leetcode.com',
          path: '/',
        }));
        await context.addCookies(newCookies).catch(() => {});
      }

      if (solved?.token && !page.isClosed()) {
        await page.evaluate((token) => {
          const input = document.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement;
          if (input) input.value = token;
        }, solved.token).catch(() => null);
      }

      // Check if page closed or crashed during the solve wait; recreate if needed
      if (page.isClosed()) {
        logger.warn('Page closed or crashed during Cloudflare solve; creating fresh page with clearance cookies');
        page = await context.newPage();
      }

      await notify('🔄 Reloading LeetCode login page with clearance cookies…');
      await page.goto('https://leetcode.com/accounts/login/', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      }).catch(async () => {
        if (page.isClosed()) {
          page = await context.newPage();
          await page.goto('https://leetcode.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null);
        }
      });
      await page.waitForTimeout(2000);
    }

    // Locate login inputs with robust multi-selector support
    const usernameSelector = 'input#id_login, input[name="username"], input[name="login"], input[placeholder*="Username" i], input[placeholder*="E-mail" i], input[autocomplete="username"]';
    const passwordSelector = 'input#id_password, input[name="password"], input[type="password"], input[autocomplete="current-password"]';
    const submitSelector = 'button#signin_btn, button[type="submit"], button:has-text("Sign In"), button:has-text("Log In"), input[type="submit"]';

    const usernameInput = page.locator(usernameSelector).first();
    const passwordInputEl = page.locator(passwordSelector).first();
    const submitBtn = page.locator(submitSelector).first();

    const usernameVisible = await usernameInput.waitFor({ state: 'visible', timeout: 25_000 }).then(() => true).catch(() => false);
    if (!usernameVisible) {
      // Check if already signed in
      const cookies = await context.cookies('https://leetcode.com');
      const hasSession = cookies.some((c) => c.name === 'LEETCODE_SESSION' && c.value.length > 5);
      if (hasSession) {
        const storageState = (await context.storageState()) as StorageStateShape;
        return { ok: true, username, storageState };
      }
      return { ok: false, error: 'LeetCode login form elements could not be found' };
    }

    await notify('📝 Entering credentials…');
    await usernameInput.fill(username);
    await page.waitForTimeout(300);
    await passwordInputEl.fill(password);
    await page.waitForTimeout(500);

    await notify('🚀 Submitting login form…');
    await submitBtn.click().catch(async () => {
      await page.keyboard.press('Enter');
    });

    await notify('⏳ Waiting for authentication…');
    const deadline = Date.now() + Math.min(timeoutMs, 40_000);
    let authenticatedUser: string | null = null;

    while (Date.now() < deadline) {
      await page.waitForTimeout(2000);

      // 1. Check cookies for LEETCODE_SESSION
      const cookies = await context.cookies('https://leetcode.com');
      const sessionCookie = cookies.find((c) => c.name === 'LEETCODE_SESSION' && c.value.length > 5);

      if (sessionCookie) {
        // Confirm userStatus via GraphQL
        authenticatedUser = await checkSignedInUser(page).catch(() => null);
        if (authenticatedUser || !page.url().includes('/accounts/login/')) {
          authenticatedUser = authenticatedUser ?? username;
          break;
        }
      }

      // 2. Check for explicit error messages on page
      const errorMsg = await page.evaluate(() => {
        const errEl = document.querySelector('.error-message, [role="alert"], p.text-red-500, div.text-red-500');
        if (errEl && errEl.textContent) {
          const t = errEl.textContent.trim();
          if (t.length > 3) return t;
        }
        return null;
      }).catch(() => null);

      if (errorMsg) {
        logger.warn({ errorMsg }, 'LeetCode login returned error on page');
        return { ok: false, error: `Login failed: ${errorMsg}` };
      }

      // 3. Check if redirected to home / problemset
      const curUrl = page.url();
      if (!curUrl.includes('/accounts/login/') && (curUrl.includes('/problemset') || curUrl.endsWith('leetcode.com/'))) {
        authenticatedUser = await checkSignedInUser(page).catch(() => null);
        authenticatedUser = authenticatedUser ?? username;
        break;
      }
    }

    if (!authenticatedUser) {
      const cookies = await context.cookies('https://leetcode.com');
      const sessionCookie = cookies.find((c) => c.name === 'LEETCODE_SESSION' && c.value.length > 5);
      if (sessionCookie) {
        authenticatedUser = username;
      } else {
        return {
          ok: false,
          error: 'Login timed out. No active session cookie received from LeetCode.',
        };
      }
    }

    const storageState = (await context.storageState()) as StorageStateShape;
    logger.info({ username: authenticatedUser }, 'LeetCode login succeeded');
    await notify(`✅ Authenticated successfully as ${authenticatedUser}`);

    return {
      ok: true,
      username: authenticatedUser,
      storageState,
    };
  } catch (err) {
    logger.error({ err }, 'LeetCode login error encountered during browser interaction');
    return {
      ok: false,
      error: `Login Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function checkSignedInUser(page: Page): Promise<string | null> {
  if (!page || page.isClosed()) return null;
  return page.evaluate(async () => {
    try {
      const res = await fetch('https://leetcode.com/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          query: 'query { userStatus { isSignedIn username } }',
          variables: {},
        }),
      });
      const json = (await res.json()) as {
        data?: { userStatus?: { isSignedIn?: boolean; username?: string | null } };
      };
      const u = json.data?.userStatus;
      return u?.isSignedIn ? (u.username ?? null) : null;
    } catch {
      return null;
    }
  }).catch(() => null);
}
