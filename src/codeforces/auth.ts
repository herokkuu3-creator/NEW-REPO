import { chromium, type BrowserContext, type Page } from 'playwright';
import { buildLaunchArgs } from '../browser/playwright';
import { applyStealthScripts, getRandomDesktopViewport } from '../browser/stealth';
import { DEFAULT_DESKTOP_CHROME_USER_AGENT } from './browserForm';
import { solveCloudflareOrchestrated } from './captchaSolver';
import { getPreferredProxy } from './proxyManager';
import { toPlaywrightProxy } from './proxyRotator';
import { StorageStateShape } from '../browser/cookiePayload';
import { logger } from '../logger';

export interface CodeforcesLoginResult {
  ok: boolean;
  handle?: string;
  storageState?: StorageStateShape;
  error?: string;
}

export interface CodeforcesLoginOptions {
  proxyUrl?: string;
  timeoutMs?: number;
  onProgress?: (status: string) => Promise<void> | void;
}

/**
 * Executes an automated login to Codeforces, solving Turnstile / Cloudflare challenges
 * using the orchestrated solver (CPSolver -> Capzy fallback).
 */
export async function loginToCodeforces(
  handleOrEmailInput: string,
  passwordInput: string,
  options?: CodeforcesLoginOptions,
): Promise<CodeforcesLoginResult> {
  const handleOrEmail = handleOrEmailInput.trim();
  const password = passwordInput;
  if (!handleOrEmail || !password) {
    return { ok: false, error: 'Handle/email and password are required' };
  }

  const timeoutMs = options?.timeoutMs ?? 75_000;
  const notify = async (msg: string) => {
    try {
      await options?.onProgress?.(msg);
    } catch {}
  };

  const preferredProxy = await getPreferredProxy().catch(() => null);
  const proxyUrl =
    options?.proxyUrl ||
    preferredProxy ||
    process.env.CODEFORCES_PROXY?.trim() ||
    undefined;

  logger.info({ handleOrEmail, proxy: proxyUrl ? 'configured' : 'none' }, 'Starting automated Codeforces login');
  await notify('🔎 Launching browser for Codeforces authentication…');

  const proxyConfig = proxyUrl ? toPlaywrightProxy(proxyUrl) : undefined;
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
      timezoneId: 'UTC',
      serviceWorkers: 'block',
    });

    await applyStealthScripts(context, 'chromium');

    // Route blocking to save memory on 512MB RAM instances
    await context.route('**/*', (route) => {
      const request = route.request();
      const parsed = new URL(request.url());
      if (
        parsed.hostname === 'challenges.cloudflare.com' ||
        parsed.hostname.includes('codeforces.com') ||
        parsed.hostname.includes('codeforces.net') ||
        parsed.hostname.includes('codeforces.org') ||
        parsed.pathname.startsWith('/cdn-cgi/')
      ) {
        return route.continue();
      }
      const blockedTypes = ['image', 'font', 'media'];
      if (blockedTypes.includes(request.resourceType())) return route.abort();
      const blockedHosts = ['google-analytics.com', 'googletagmanager.com', 'clarity.ms', 'doubleclick.net'];
      if (blockedHosts.some((h) => parsed.hostname.includes(h))) return route.abort();
      return route.continue();
    });

    let page: Page = await context.newPage();

    await notify('🌐 Navigating to Codeforces login page…');
    const gotoRes = await page.goto('https://codeforces.com/enter', {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    }).catch((e) => {
      logger.warn({ err: String(e) }, 'Initial navigation to Codeforces enter page timed out or had error');
      return null;
    });

    if (gotoRes && gotoRes.status() >= 400 && gotoRes.status() !== 403) {
      return { ok: false, error: `Codeforces enter page returned HTTP ${gotoRes.status()}` };
    }

    await page.waitForFunction(
      () => !document.title.toLowerCase().startsWith('loading'),
      { timeout: 15_000 }
    ).catch(() => null);
    await new Promise((r) => setTimeout(r, 2000));

    // Check for Cloudflare challenge / Turnstile on enter page
    const turnstileFrame = page.locator('iframe[src*="challenges.cloudflare.com"]');
    const hasTurnstile = (await turnstileFrame.count().catch(() => 0)) > 0;
    const isCloudflareChallenge =
      (await page.title().catch(() => '')).toLowerCase().includes('just a moment') ||
      (await page.locator('text=/just a moment|checking your browser|verify you are human/i').count().catch(() => 0)) > 0;

    if (hasTurnstile || isCloudflareChallenge) {
      await notify('🧩 Detected Cloudflare verification on Codeforces. Solving…');
      logger.info('Cloudflare challenge detected on Codeforces enter page; invoking orchestrated solver');

      const sitekey = await extractTurnstileSitekey(page);

      const currentCookies = await context.cookies('https://codeforces.com').catch(() => []);
      const solved = await solveCloudflareOrchestrated({
        websiteURL: page.url(),
        sitekey,
        proxyUrl,
        userAgent: DEFAULT_DESKTOP_CHROME_USER_AGENT,
        cookies: currentCookies,
        timeoutMs: Math.min(timeoutMs, 35_000),
      });

      if (solved?.cookies) {
        const newCookies = Object.entries(solved.cookies).map(([name, value]) => ({
          name,
          value,
          domain: '.codeforces.com',
          path: '/',
        }));
        await context.addCookies(newCookies).catch(() => {});
      }

      if (solved?.token) {
        try {
          if (!page.isClosed()) {
            await page.evaluate((token) => {
              const input = document.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement;
              if (input) input.value = token;
            }, solved.token).catch(() => null);
          }
        } catch {}
      }

      page = await ensureHealthyPage(context, page, 'https://codeforces.com/enter');

      // Reload the enter page now that clearance cookies are in the context
      await notify('🔄 Reloading Codeforces enter page with clearance cookies…');
      await page.goto('https://codeforces.com/enter', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      }).catch(async () => {
        page = await context.newPage();
        await page.goto('https://codeforces.com/enter', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null);
      });
      await page.waitForFunction(
        () => !document.title.toLowerCase().startsWith('loading'),
        { timeout: 15_000 }
      ).catch(() => null);
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Locate form fields
    const handleInput = page.locator('input#handleOrEmail, input[name="handleOrEmail"]').first();
    const passwordInputEl = page.locator('input#password, input[name="password"]').first();

    const handleVisible = await handleInput.waitFor({ state: 'visible', timeout: 25_000 }).then(() => true).catch(() => false);
    if (!handleVisible) {
      // Check if already signed in
      const cookies = await context.cookies('https://codeforces.com');
      const hasSession = cookies.some((c) => (c.name === 'JSESSIONID' || c.name === '39ce7') && c.value.length > 5);
      const detected = await detectCodeforcesHandle(page);
      if (hasSession && detected) {
        const storageState = (await context.storageState()) as StorageStateShape;
        return { ok: true, handle: detected, storageState };
      }
      return { ok: false, error: 'Codeforces login form elements could not be found' };
    }

    await notify('📝 Entering credentials…');
    await handleInput.fill(handleOrEmail);
    await new Promise((r) => setTimeout(r, 300));
    await passwordInputEl.fill(password);
    await new Promise((r) => setTimeout(r, 300));

    // Remember me checkbox
    const rememberCheckbox = page.locator('input#remember, input[name="remember"]').first();
    if (await rememberCheckbox.isVisible().catch(() => false)) {
      await rememberCheckbox.check().catch(() => undefined);
    }

    const submitBtn = page.locator('input[type="submit"].submit, input.submit, button[type="submit"], input[type="submit"]').first();
    await notify('🚀 Submitting login form…');
    await submitBtn.click({ timeout: 4000, force: true }).catch(async () => {
      await page.keyboard.press('Enter').catch(() => null);
    });
    await passwordInputEl.press('Enter').catch(() => null);

    await notify('⏳ Waiting for authentication…');
    const deadline = Date.now() + Math.min(timeoutMs, 40_000);
    let authenticatedHandle: string | null = null;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));

      const cookies = await context.cookies('https://codeforces.com').catch(() => []);
      const hasSession = cookies.some((c) => (c.name === 'JSESSIONID' || c.name === '39ce7') && c.value.length > 5);

      if (!page.isClosed()) {
        const detected = await detectCodeforcesHandle(page);
        if (detected) {
          authenticatedHandle = detected;
          break;
        }

        const curUrl = page.url();
        // Check for error text on page
        const errorMsg = await page.evaluate(() => {
          const errEl = document.querySelector('.error.for__password, .error.for__handleOrEmail, span.error, div.error');
          if (errEl && errEl.textContent) {
            const t = errEl.textContent.trim();
            if (t.length > 3) return t;
          }
          return null;
        }).catch(() => null);

        if (errorMsg && /\/enter(?:[/?#]|$)/i.test(curUrl)) {
          logger.warn({ errorMsg }, 'Codeforces login returned error on page');
          return { ok: false, error: `Login failed: ${errorMsg}` };
        }

        if (!/\/enter(?:[/?#]|$)/i.test(curUrl) && (curUrl.includes('codeforces.com') || curUrl.endsWith('/'))) {
          if (hasSession) {
            authenticatedHandle = detected || handleOrEmail;
            break;
          }
        }
      } else {
        if (hasSession) {
          authenticatedHandle = handleOrEmail;
          break;
        }
      }
    }

    if (!authenticatedHandle) {
      const cookies = await context.cookies('https://codeforces.com').catch(() => []);
      const hasSession = cookies.some((c) => (c.name === 'JSESSIONID' || c.name === '39ce7') && c.value.length > 5);
      if (hasSession) {
        authenticatedHandle = handleOrEmail;
      } else {
        return {
          ok: false,
          error: 'Login timed out. No active session cookie received from Codeforces.',
        };
      }
    }

    const storageState = (await context.storageState()) as StorageStateShape;
    logger.info({ handle: authenticatedHandle }, 'Codeforces login succeeded');
    await notify(`✅ Authenticated successfully as ${authenticatedHandle}`);

    return {
      ok: true,
      handle: authenticatedHandle,
      storageState,
    };
  } catch (err) {
    logger.error({ err }, 'Codeforces login error encountered during browser interaction');
    return {
      ok: false,
      error: `Login Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function detectCodeforcesHandle(page: Page): Promise<string | null> {
  if (!page || page.isClosed()) return null;
  return page.evaluate(() => {
    try {
      const anchors = Array.from(document.querySelectorAll('a[href*="/profile/"]')) as HTMLAnchorElement[];
      for (const a of anchors) {
        const match = /\/profile\/([^/?#]+)/i.exec(a.href);
        if (match && match[1]) {
          const text = (a.textContent || '').trim();
          if (text && text.toLowerCase() === match[1].toLowerCase()) {
            return decodeURIComponent(match[1]);
          }
        }
      }
      // Lang chooser header area
      const headerUser = document.querySelector('.lang-chooser a[href*="/profile/"]');
      if (headerUser) {
        const match = /\/profile\/([^/?#]+)/i.exec((headerUser as HTMLAnchorElement).href);
        if (match && match[1]) return decodeURIComponent(match[1]);
      }
      return null;
    } catch {
      return null;
    }
  }).catch(() => null);
}

async function extractTurnstileSitekey(page: Page): Promise<string> {
  const fallbackKey = '0x4AAAAAAADnPIDROrmt1Wwj';
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
