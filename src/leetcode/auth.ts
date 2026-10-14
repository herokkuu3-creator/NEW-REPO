import { chromium, type BrowserContext, type Page } from 'playwright';
import { buildLaunchArgs } from '../browser/playwright';
import { applyStealthScripts, getRandomDesktopViewport } from '../browser/stealth';
import {
  solveCloudflareOrchestrated,
  solveTurnstileOrchestrated,
  CLOUDFLARE_UNIVERSAL_SITEKEY,
  LEETCODE_TURNSTILE_SITEKEY,
  getLastCapzyError,
} from '../codeforces/captchaSolver';
import { DEFAULT_DESKTOP_CHROME_USER_AGENT } from '../codeforces/browserForm';
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

    // Phase 1: Check for full-page Cloudflare interstitial ("Just a moment...")
    const isCloudflareInterstitial =
      (await page.title().catch(() => '')).toLowerCase().includes('just a moment') ||
      (await page.locator('text=/just a moment|checking your browser|verify you are human/i').count().catch(() => 0)) > 0;

    if (isCloudflareInterstitial) {
      await notify('🧩 Detected Cloudflare verification challenge. Solving…');
      logger.info('Cloudflare interstitial detected on LeetCode login page; solving via orchestrated solver');

      const currentCookies = await context.cookies('https://leetcode.com').catch(() => []);
      const solved = await solveCloudflareOrchestrated({
        websiteURL: page.url(),
        sitekey: CLOUDFLARE_UNIVERSAL_SITEKEY,
        proxyUrl: options?.proxyUrl,
        userAgent: DEFAULT_DESKTOP_CHROME_USER_AGENT,
        cookies: currentCookies,
        timeoutMs: Math.min(timeoutMs, 45_000),
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

      page = await ensureHealthyPage(context, page, 'https://leetcode.com/accounts/login/');
      await notify('🔄 Reloading LeetCode login page with clearance cookies…');
      await page.goto('https://leetcode.com/accounts/login/', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      }).catch(async () => {
        page = await context.newPage();
        await page.goto('https://leetcode.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null);
      });
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Phase 2: Locate login inputs with robust multi-selector support
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
    await usernameInput.dispatchEvent('input').catch(() => null);
    await usernameInput.dispatchEvent('change').catch(() => null);
    await usernameInput.dispatchEvent('blur').catch(() => null);
    await new Promise((r) => setTimeout(r, 300));

    await passwordInputEl.fill(password);
    await passwordInputEl.dispatchEvent('input').catch(() => null);
    await passwordInputEl.dispatchEvent('change').catch(() => null);
    await passwordInputEl.dispatchEvent('blur').catch(() => null);
    await new Promise((r) => setTimeout(r, 500));

    // Phase 3: Mandatory Cloudflare Turnstile Solve & Token Injection
    // Check if the page has already acquired a valid Turnstile token
    let existingToken = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[name="cf-turnstile-response"], input[name="turnstileToken"]')) as HTMLInputElement[];
      for (const input of inputs) {
        if (input.value && input.value.trim().length > 20) {
          return input.value.trim();
        }
      }
      return null;
    }).catch(() => null);

    if (!existingToken) {
      await notify('🧩 Solving Cloudflare Turnstile verification…');
      logger.info('Solving Cloudflare Turnstile verification before submitting LeetCode credentials');
      const sitekey = await extractTurnstileSitekey(page);

      const solved = await solveTurnstileOrchestrated({
        siteurl: page.url(),
        sitekey: sitekey || CLOUDFLARE_UNIVERSAL_SITEKEY,
        proxyUrl: options?.proxyUrl,
        userAgent: DEFAULT_DESKTOP_CHROME_USER_AGENT,
        timeoutMs: Math.min(timeoutMs, 45_000),
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

      if (solved?.token) {
        existingToken = solved.token;
        await page.evaluate((token) => {
          let injected = false;
          const inputs = document.querySelectorAll('input[name="cf-turnstile-response"], input[name="turnstileToken"]');
          for (const input of Array.from(inputs)) {
            (input as HTMLInputElement).value = token;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            injected = true;
          }
          if (!injected) {
            const hidden = document.createElement('input');
            hidden.type = 'hidden';
            hidden.name = 'cf-turnstile-response';
            hidden.value = token;
            const container = document.querySelector('form') || document.body;
            container.appendChild(hidden);
          }
        }, solved.token).catch(() => null);
        await new Promise((r) => setTimeout(r, 500));
      }

      // If Turnstile failed to produce a token or cookies, abort immediately with explicit diagnostic message
      if (!existingToken && !solved?.cookies && !solved?.cfClearance) {
        const capzyErr = getLastCapzyError();
        const errDetail = capzyErr ? `: ${capzyErr}` : '';
        return {
          ok: false,
          error: `Cloudflare Turnstile verification could not be solved${errDetail}. Please add a funded API key via /addcapzy <key>.`,
        };
      }
    }

    // Phase 4: Submit login form
    // Listen for login response to capture immediate error messages from LeetCode backend
    let loginHttpError: string | null = null;
    const onLoginResponse = async (res: any) => {
      try {
        const u = res.url();
        if (u.includes('/accounts/login') && res.request().method() === 'POST') {
          const status = res.status();
          if (status >= 400) {
            let detail = `HTTP ${status}`;
            try {
              const body = await res.json();
              if (body?.recaptcha?.error) detail = body.recaptcha.error;
              else if (body?.form?.errors) detail = Array.isArray(body.form.errors) ? body.form.errors.join(', ') : JSON.stringify(body.form.errors);
              else if (body?.error) detail = body.error;
            } catch {
              try {
                const txt = await res.text();
                if (txt && txt.length < 200) detail = txt;
              } catch {}
            }
            loginHttpError = detail;
          }
        }
      } catch {}
    };
    page.on('response', onLoginResponse);

    await notify('🚀 Submitting login form…');
    // Ensure button is not disabled in DOM and trigger form submit event
    await page.evaluate(() => {
      const form = document.querySelector('form');
      if (form) {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
      const btn = document.querySelector('button#signin_btn, button[type="submit"]') as HTMLButtonElement | null;
      if (btn) {
        btn.removeAttribute('disabled');
        btn.disabled = false;
        btn.click();
      }
    }).catch(() => null);

    await submitBtn.click({ timeout: 4000, force: true }).catch(async () => {
      await page.keyboard.press('Enter').catch(() => null);
    });
    await passwordInputEl.press('Enter').catch(() => null);

    await notify('⏳ Waiting for authentication…');
    const deadline = Date.now() + Math.min(timeoutMs, 40_000);
    let authenticatedUser: string | null = null;

    while (Date.now() < deadline) {
      if (loginHttpError) {
        page.off('response', onLoginResponse);
        return { ok: false, error: `LeetCode rejected login: ${loginHttpError}` };
      }

      await new Promise((r) => setTimeout(r, 2000));

      // 1. Check cookies for LEETCODE_SESSION
      const cookies = await context.cookies('https://leetcode.com').catch(() => []);
      const sessionCookie = cookies.find((c) => c.name === 'LEETCODE_SESSION' && c.value.length > 5);

      if (sessionCookie) {
        if (!page.isClosed()) {
          authenticatedUser = await checkSignedInUser(page).catch(() => null);
        }
        authenticatedUser = authenticatedUser ?? username;
        break;
      }

      if (page.isClosed()) {
        logger.warn('Page closed during authentication wait; re-checking context cookies');
        break;
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
        page.off('response', onLoginResponse);
        logger.warn({ errorMsg }, 'LeetCode login returned error on page');
        return { ok: false, error: `Login failed: ${errorMsg}` };
      }

      // 3. Check if redirected to home / problemset
      const curUrl = page.url();
      if (!curUrl.includes('/accounts/login/') && (curUrl.includes('/problemset') || curUrl.endsWith('leetcode.com/'))) {
        if (!page.isClosed()) {
          authenticatedUser = await checkSignedInUser(page).catch(() => null);
        }
        authenticatedUser = authenticatedUser ?? username;
        break;
      }
    }
    page.off('response', onLoginResponse);

    if (!authenticatedUser) {
      const cookies = await context.cookies('https://leetcode.com').catch(() => []);
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

async function extractTurnstileSitekey(page: Page): Promise<string> {
  const fallbackKey = LEETCODE_TURNSTILE_SITEKEY;
  if (!page || page.isClosed()) return fallbackKey;
  try {
    const extracted = await page.evaluate(() => {
      const win = window as any;
      const el = document.querySelector('.cf-turnstile, [data-sitekey], [data-key]');
      let key = win.__turnstileSitekey || el?.getAttribute('data-sitekey') || el?.getAttribute('data-key') || (el as HTMLElement | null)?.dataset?.sitekey || null;
      if (!key) {
        const iframes = Array.from(document.querySelectorAll('iframe[src*="challenges.cloudflare.com"], iframe[src*="cloudflare.com"]')) as HTMLIFrameElement[];
        for (const iframe of iframes) {
          if (iframe?.src) {
            const match = /(0x4[a-zA-Z0-9_-]{18,})/i.exec(iframe.src);
            if (match?.[1]) { key = match[1]; break; }
            try {
              const u = new URL(iframe.src);
              key = u.searchParams.get('sitekey') || u.searchParams.get('key') || /\/([0-9a-zA-Z_-]{20,})\//.exec(u.pathname)?.[1] || null;
              if (key) break;
            } catch {}
          }
        }
      }
      if (!key) {
        const inline = Array.from(document.scripts).map((s) => s.textContent ?? '').join('\n');
        key = /["']?sitekey["']?\s*[:=]\s*["']([^"']+)["']/i.exec(inline)?.[1] ??
              /(0x4[a-zA-Z0-9_-]{18,})/i.exec(inline)?.[1] ?? null;
      }
      return key;
    }).catch(() => null);
    return extracted || fallbackKey;
  } catch {
    return fallbackKey;
  }
}

async function ensureHealthyPage(context: BrowserContext, page: Page, fallbackUrl: string): Promise<Page> {
  let healthy = false;
  if (!page.isClosed()) {
    try {
      await page.evaluate(() => 1);
      healthy = true;
    } catch {
      healthy = false;
    }
  }
  if (!healthy) {
    logger.warn({ fallbackUrl }, 'Target page was closed or crashed; creating fresh page');
    try {
      await page.close().catch(() => {});
    } catch {}
    const newPage = await context.newPage();
    await newPage.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 35_000 }).catch(() => null);
    return newPage;
  }
  return page;
}
