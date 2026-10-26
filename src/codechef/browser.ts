import { chromium, type BrowserContext, type Page } from 'playwright';
import { buildLaunchArgs } from '../browser/playwright';
import { releaseHeap } from '../memory';
import { logger } from '../logger';

export type CodeChefState = Awaited<ReturnType<BrowserContext['storageState']>>;

export async function withCodeChefPage<T>(state: CodeChefState | undefined, action: (page: Page) => Promise<T>): Promise<T> {
  releaseHeap();
  logger.info('Launching lightweight Chromium context for CodeChef action...');
  const browser = await chromium.launch({ headless: true, args: buildLaunchArgs() });
  try {
    const safeState = state ? {
      cookies: state.cookies || [],
      origins: [],
    } : undefined;
    const context = await browser.newContext({ 
      storageState: safeState, 
      viewport: { width: 1000, height: 750 },
      serviceWorkers: 'block' 
    });
    await context.route('**/*', route => {
      const request = route.request();
      const parsed = new URL(request.url());
      if (parsed.hostname === 'challenges.cloudflare.com' || parsed.pathname.startsWith('/cdn-cgi/')) return route.continue();
      
      // Aggressive blocking to save memory on 512MB limit
      const blockedTypes = ['image', 'font', 'media'];
      if (blockedTypes.includes(request.resourceType())) return route.abort();
      
      // Block common trackers and third-party scripts
      const blockedHosts = ['google-analytics.com', 'googletagmanager.com', 'clarity.ms', 'doubleclick.net'];
      if (blockedHosts.some(h => parsed.hostname.includes(h))) return route.abort();

      return route.continue();
    });
    const page = context.pages()[0] ?? (await context.newPage());
    return await action(page);
  } finally {
    await browser.close().catch(() => undefined);
    releaseHeap();
  }
}

