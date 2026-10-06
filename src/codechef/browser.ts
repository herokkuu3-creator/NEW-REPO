import { chromium, type BrowserContext, type Page } from 'playwright';
import { buildLaunchArgs } from '../browser/playwright';
import { MemoryWatch, memoryReading, memoryLimitMb, releaseHeap } from '../memory';

export type CodeChefState = Awaited<ReturnType<BrowserContext['storageState']>>;

export async function withCodeChefPage<T>(state: CodeChefState | undefined, action: (page: Page) => Promise<T>): Promise<T> {
  releaseHeap();
  const memory = memoryReading();
  if (memory.usedMb !== null && memoryLimitMb() - memory.usedMb < 60) {
    throw new Error(`Not enough free memory to start CodeChef browser safely (Used: ${memory.usedMb}MB, Limit: ${memoryLimitMb()}MB). Try again after the other run finishes.`);
  }
  const browser = await chromium.launch({ headless: true, args: buildLaunchArgs() });
  const watch = new MemoryWatch(() => { void browser.close().catch(() => undefined); });
  try {
    watch.start();
    const context = await browser.newContext({ 
      storageState: state, 
      viewport: { width: 1000, height: 750 },
      serviceWorkers: 'block' 
    });
    await context.route('**/*', route => {
      const request = route.request();
      const parsed = new URL(request.url());
      if (parsed.hostname === 'challenges.cloudflare.com' || parsed.pathname.startsWith('/cdn-cgi/')) return route.continue();
      
      // Aggressive blocking to save memory on 512MB limit
      const blockedTypes = ['image', 'font', 'media', 'stylesheet'];
      if (blockedTypes.includes(request.resourceType())) return route.abort();
      
      // Block common trackers and third-party scripts
      const blockedHosts = ['google-analytics.com', 'googletagmanager.com', 'clarity.ms', 'doubleclick.net'];
      if (blockedHosts.some(h => parsed.hostname.includes(h))) return route.abort();

      return route.continue();
    });
    return await action(await context.newPage());
  } finally {
    watch.stop();
    await browser.close();
    releaseHeap();
  }
}
