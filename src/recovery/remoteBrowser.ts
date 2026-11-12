import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
  type Route,
} from 'playwright';
import type { StorageStateShape } from '../browser/cookiePayload';
import { toPlaywrightProxy } from '../codeforces/proxyRotator';
import { logger } from '../logger';

/**
 * One isolated, remotely viewable browser per recovery.
 *
 * Deliberately PLAIN: no stealth scripts, no user-agent/fingerprint overrides,
 * no automation-flag tweaks. If LeetCode/Cloudflare decline to serve this
 * browser, that is reported as a limitation — it is never evaded.
 *
 * The remote human can only send MOUSE events (move / press / release / wheel).
 * There is no remote keyboard, so credentials can never be typed or altered
 * from the portal; they are filled server-side by the login driver.
 */

export interface RemoteInput {
  type: 'move' | 'down' | 'up' | 'wheel';
  x: number;
  y: number;
  deltaY?: number;
}

export interface RemoteBrowser {
  readonly page: Page;
  readonly context: BrowserContext;
  readonly viewport: { width: number; height: number };
  /** Latest screencast JPEG (falls back to a screenshot when none is fresh). */
  snapshot(): Promise<Buffer | null>;
  frameCount(): number;
  input(ev: RemoteInput): Promise<void>;
  captureStorageState(): Promise<StorageStateShape>;
  onDisconnected(cb: () => void): void;
  /** Closes the context and browser. NEVER clicks Logout. Idempotent. */
  close(): Promise<void>;
}

export interface RemoteBrowserOptions {
  viewport?: { width: number; height: number };
  proxyUrl?: string;
  headless?: boolean;
}

/** Top-level navigations are restricted to LeetCode and its challenge providers. */
const ALLOWED_NAV_HOSTS: RegExp[] = [
  /(^|\.)leetcode\.com$/i,
  /(^|\.)leetcode\.cn$/i,
  /(^|\.)cloudflare\.com$/i,
  /(^|\.)challenges\.cloudflare\.com$/i,
  /(^|\.)google\.com$/i,
  /(^|\.)gstatic\.com$/i,
  /(^|\.)hcaptcha\.com$/i,
];

export function isAllowedNavigation(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'about:') return true;
    if (u.protocol !== 'https:') return false;
    return ALLOWED_NAV_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

export async function openRemoteBrowser(opts: RemoteBrowserOptions = {}): Promise<RemoteBrowser> {
  const viewport = opts.viewport ?? { width: 1024, height: 720 };
  let browser: Browser | null = null;
  try {
    const proxy = opts.proxyUrl ? toPlaywrightProxy(opts.proxyUrl) : undefined;
    if (opts.proxyUrl && !proxy) throw new Error('LEETCODE_PROXY_INVALID');
    browser = await chromium.launch({
      headless: opts.headless ?? true,
      // Container-required flags + a memory cap only. Nothing that alters how
      // the browser presents itself to the site.
      args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu', '--js-flags=--max-old-space-size=256'],
      proxy,
    });
    const context = await browser.newContext({
      viewport,
      locale: 'en-US',
      serviceWorkers: 'block',
      acceptDownloads: false,
      permissions: [],
    });
    const page = await context.newPage();

    // Keep the session to ONE tab, and keep top-level navigation on-site.
    context.on('page', (p) => {
      if (p !== page) void p.close().catch(() => undefined);
    });
    await context.route('**/*', async (route: Route) => {
      const req = route.request();
      if (req.isNavigationRequest() && req.frame() === page.mainFrame() && !isAllowedNavigation(req.url())) {
        return route.abort('blockedbyclient');
      }
      return route.fallback();
    });

    let latest: Buffer | null = null;
    let latestAt = 0;
    let frames = 0;
    let cdp: CDPSession | null = null;
    try {
      cdp = await context.newCDPSession(page);
      cdp.on('Page.screencastFrame', (frame: { data: string; sessionId: number }) => {
        latest = Buffer.from(frame.data, 'base64');
        latestAt = Date.now();
        frames += 1;
        void cdp?.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
      });
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 55,
        maxWidth: viewport.width,
        maxHeight: viewport.height,
        everyNthFrame: 2,
      });
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'recovery screencast unavailable; using screenshots');
    }

    let closed = false;
    const owned = browser;
    return {
      page,
      context,
      viewport,
      async snapshot() {
        if (closed) return null;
        if (latest && Date.now() - latestAt < 2500) return latest;
        try {
          const shot = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 4000 });
          latest = shot;
          latestAt = Date.now();
          return shot;
        } catch {
          return latest;
        }
      },
      frameCount: () => frames,
      async input(ev: RemoteInput) {
        if (closed) return;
        const x = Math.min(Math.max(0, ev.x), viewport.width - 1);
        const y = Math.min(Math.max(0, ev.y), viewport.height - 1);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        if (ev.type === 'move') await page.mouse.move(x, y);
        else if (ev.type === 'down') {
          await page.mouse.move(x, y);
          await page.mouse.down({ button: 'left' });
        } else if (ev.type === 'up') {
          await page.mouse.move(x, y);
          await page.mouse.up({ button: 'left' });
        } else if (ev.type === 'wheel') {
          await page.mouse.wheel(0, Math.min(Math.max(-1200, ev.deltaY ?? 0), 1200));
        }
      },
      async captureStorageState() {
        const state = await context.storageState();
        return {
          transport: { proxyUrl: opts.proxyUrl, userAgent: await page.evaluate(() => navigator.userAgent) },
          cookies: state.cookies as unknown as StorageStateShape['cookies'],
          origins: (state.origins ?? []) as unknown as StorageStateShape['origins'],
        };
      },
      onDisconnected(cb: () => void) {
        owned.on('disconnected', cb);
      },
      async close() {
        if (closed) return;
        closed = true;
        // Close — never log out: Logout would invalidate the session we just stored.
        await cdp?.send('Page.stopScreencast').catch(() => undefined);
        await context.close().catch(() => undefined);
        await owned.close().catch(() => undefined);
      },
    };
  } catch (err) {
    await browser?.close().catch(() => undefined);
    throw err;
  }
}
