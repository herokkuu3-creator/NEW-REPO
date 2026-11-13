import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { config } from '../config';
import { logger } from '../logger';
import { type StorageStateShape } from '../browser/cookiePayload';
import { buildLaunchArgs } from '../browser/playwright';
import { applyStealthScripts, getRandomDesktopViewport } from '../browser/stealth';
import { detectVerificationPage } from '../browser/cloudflareDetector';
import { DEFAULT_DESKTOP_CHROME_USER_AGENT } from '../codeforces/browserForm';
import { resolveLeetCodeResidentialProxy } from '../codeforces/proxyManager';
import { toPlaywrightProxy } from '../codeforces/proxyRotator';
import {
  deduplicateLeetCodeCookies,
  isCsrfRejectionBody,
  isSubmissionLimitError,
  LeetCodeHttpError,
  parseRetryAfter,
  selectBestCsrfCookie,
  summarizeHttpErrorBody,
} from './apiClient';

const ORIGIN = 'https://leetcode.com';

export interface GhostSubmitParams {
  slug: string;
  questionId: string;
  lang: string;
  code: string;
  userAgent?: string;
  proxyUrl?: string;
  onStorageState?: (state: StorageStateShape) => Promise<void> | void;
}

export interface GhostSubmitResult {
  submissionId: string;
  storageState: StorageStateShape;
}

/**
 * Serializes on-demand Chromium fallback launches so parallel range workers
 * cannot spike memory beyond container limits (e.g., 512 MB on Render).
 */
let ghostLaunchQueue: Promise<unknown> = Promise.resolve();

function withGhostBrowserLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = ghostLaunchQueue.then(fn, fn);
  ghostLaunchQueue = run.catch(() => undefined);
  return run;
}

/**
 * Drops decorative heavy assets (images, media, fonts, beacons) inside the
 * ghost Chromium session while keeping LeetCode app scripts and Cloudflare
 * verification scripts intact.
 */
export function blockNonEssentialProblemAssets(url: string, type: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();

  if (
    host === 'challenges.cloudflare.com' ||
    host.endsWith('.challenges.cloudflare.com') ||
    host === 'cloudflare.com' ||
    host.endsWith('.cloudflare.com') ||
    pathname.startsWith('/cdn-cgi/')
  ) {
    return false;
  }

  if (['image', 'media', 'font', 'websocket', 'eventsource', 'manifest', 'ping'].includes(type)) {
    return true;
  }

  const isLeetCode = host === 'leetcode.com' || host.endsWith('.leetcode.com');
  return !isLeetCode;
}

function pruneExpiredCookies(cookies: StorageStateShape['cookies']): StorageStateShape['cookies'] {
  return deduplicateLeetCodeCookies(cookies, ORIGIN);
}

/**
 * Executes LeetCode's `/problems/<slug>/submit/` POST from INSIDE a loaded
 * Chromium page using `fetch()`, inheriting Chromium's native TLS/HTTP2
 * fingerprint, Sec-Fetch / Sec-CH-UA headers, Referer, Origin, and fresh
 * browser cookies.
 */
export async function submitViaPageFetch(
  page: Page,
  params: { slug: string; questionId: string; lang: string; code: string },
): Promise<string> {
  const readCsrf = async (): Promise<string | null> => {
    const contextCookies = await page.context().cookies(ORIGIN).catch(() => []);
    const fromContext = selectBestCsrfCookie(contextCookies, ORIGIN);
    if (fromContext) return fromContext;
    const fromDoc = await page
      .evaluate(() => {
        const m = /(?:^|;\s*)csrftoken=([^;]+)/.exec(document.cookie);
        return m?.[1] ? decodeURIComponent(m[1]) : null;
      })
      .catch(() => null);
    return fromDoc && fromDoc.trim() ? fromDoc.trim() : null;
  };

  const sendInPage = async (csrfToken: string) =>
    page.evaluate(
      async ({ submitUrl, body, csrf }) => {
        const res = await fetch(submitUrl, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/plain, */*',
            'x-csrftoken': csrf,
          },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        return {
          status: res.status,
          text,
          retryAfter: res.headers.get('retry-after') ?? undefined,
        };
      },
      {
        submitUrl: `${ORIGIN}/problems/${params.slug}/submit/`,
        body: {
          lang: params.lang,
          question_id: params.questionId,
          typed_code: params.code,
        },
        csrf: csrfToken,
      },
    );

  let token = await readCsrf();
  if (!token) {
    await page.waitForTimeout(1_000).catch(() => undefined);
    token = await readCsrf();
  }
  if (!token) {
    throw new Error('missing csrftoken cookie in ghost browser');
  }

  let response = await sendInPage(token);
  if (response.status === 403 && isCsrfRejectionBody(response.text)) {
    await page.waitForTimeout(1_000).catch(() => undefined);
    const refreshed = await readCsrf();
    if (refreshed && refreshed !== token) {
      response = await sendInPage(refreshed);
    }
  }

  if (response.status !== 200) {
    const detail = summarizeHttpErrorBody(response.text);
    const retryAfterMs = parseRetryAfter(response.retryAfter);
    throw new LeetCodeHttpError(
      `submit HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
      response.status,
      retryAfterMs,
    );
  }

  let parsed: { submission_id?: number; error?: string };
  try {
    parsed = JSON.parse(response.text) as { submission_id?: number; error?: string };
  } catch {
    const detail = summarizeHttpErrorBody(response.text);
    throw new LeetCodeHttpError(
      `submit returned non-JSON body${detail ? `: ${detail}` : ''}`,
      200,
    );
  }

  if (parsed.error) {
    const err = new Error(`submit rejected: ${parsed.error}`);
    if (isSubmissionLimitError(err)) throw err;
    throw err;
  }
  if (typeof parsed.submission_id !== 'number') {
    throw new LeetCodeHttpError('submit response contained no submission_id', 200);
  }

  return String(parsed.submission_id);
}

async function waitForPassiveChallengeSettle(page: Page, signal?: AbortSignal): Promise<string | null> {
  const deadline = Date.now() + 8_000;
  let kind = await detectVerificationPage(page);
  while (kind && Date.now() < deadline && !signal?.aborted) {
    await page.waitForTimeout(600).catch(() => undefined);
    kind = await detectVerificationPage(page);
  }
  return kind;
}

export interface GhostBrowserDeps {
  resolveProxy?: typeof resolveLeetCodeResidentialProxy;
  submitPageFetch?: typeof submitViaPageFetch;
}

/**
 * Ghost-mode stealth Chromium submission fallback.
 *
 * Launches headless Chromium using the account's legitimate cookies, transport
 * User-Agent, and configured residential proxy, loads `/problems/<slug>/` to
 * establish genuine browser TLS/cookies, submits via in-page `fetch()`, and
 * returns the submission ID alongside updated storageState for cookie sync.
 */
export async function submitViaGhostBrowser(
  state: StorageStateShape,
  params: GhostSubmitParams,
  signal?: AbortSignal,
  deps: GhostBrowserDeps = {},
): Promise<GhostSubmitResult> {
  if (signal?.aborted) {
    throw new Error('Range cancelled before ghost browser submission');
  }

  return withGhostBrowserLock(async () => {
    if (signal?.aborted) {
      throw new Error('Range cancelled before ghost browser submission');
    }

    const resolveProxy = deps.resolveProxy ?? resolveLeetCodeResidentialProxy;
    const pageFetch = deps.submitPageFetch ?? submitViaPageFetch;
    const proxyUrl = params.proxyUrl ?? state.transport?.proxyUrl ?? (await resolveProxy())?.url;
    const proxy = proxyUrl ? toPlaywrightProxy(proxyUrl) : undefined;
    if (proxyUrl && !proxy) {
      throw new Error('LEETCODE_PROXY_INVALID');
    }

    const userAgent =
      params.userAgent ?? state.transport?.userAgent ?? DEFAULT_DESKTOP_CHROME_USER_AGENT;
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;

    const onAbort = () => {
      void context?.close().catch(() => undefined);
      void browser?.close().catch(() => undefined);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const headless = config.browser.headless;
      browser = await chromium.launch({
        headless,
        args: buildLaunchArgs(headless),
        proxy,
      });

      const cleanedCookies = pruneExpiredCookies(state.cookies ?? []);
      context = await browser.newContext({
        userAgent,
        viewport: getRandomDesktopViewport(),
        locale: 'en-US',
        storageState: {
          cookies: cleanedCookies as never,
          origins: (state.origins ?? []) as never,
        },
      });
      await applyStealthScripts(context, 'chromium');

      await context.route('**/*', async (route) => {
        if (blockNonEssentialProblemAssets(route.request().url(), route.request().resourceType())) {
          return route.abort().catch(() => undefined);
        }
        return route.continue().catch(() => undefined);
      });

      const page = await context.newPage();
      const targetUrl = `${ORIGIN}/problems/${params.slug}/`;
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(800).catch(() => undefined);

      const notifyState = async () => {
        if (!params.onStorageState) return;
        const latest = (await context?.storageState().catch(() => null)) as
          | { cookies: StorageStateShape['cookies']; origins: StorageStateShape['origins'] }
          | null;
        if (!latest) return;
        await params.onStorageState({
          transport: state.transport ?? (proxyUrl ? { proxyUrl, userAgent } : { userAgent }),
          cookies: deduplicateLeetCodeCookies(latest.cookies, ORIGIN),
          origins: latest.origins ?? state.origins ?? [],
        });
      };

      const verificationKind = await waitForPassiveChallengeSettle(page, signal);
      if (verificationKind) {
        const title = await page.title().catch(() => '');
        await notifyState();
        throw new LeetCodeHttpError(
          `submit HTTP 403: Cloudflare verification required (${verificationKind})${title ? ` [${title}]` : ''}`,
          403,
        );
      }

      let submissionId: string;
      try {
        submissionId = await pageFetch(page, {
          slug: params.slug,
          questionId: params.questionId,
          lang: params.lang,
          code: params.code,
        });
      } catch (err) {
        await notifyState().catch(() => undefined);
        throw err;
      }

      const latest = (await context.storageState()) as {
        cookies: StorageStateShape['cookies'];
        origins: StorageStateShape['origins'];
      };
      const updatedState: StorageStateShape = {
        transport: state.transport ?? (proxyUrl ? { proxyUrl, userAgent } : { userAgent }),
        cookies: deduplicateLeetCodeCookies(latest.cookies, ORIGIN),
        origins: latest.origins ?? state.origins ?? [],
      };
      if (params.onStorageState) {
        await params.onStorageState(updatedState);
      }

      logger.info(
        { slug: params.slug, language: params.lang, submissionId, viaProxy: Boolean(proxy) },
        'submitted solution via ghost-mode stealth Chromium fallback',
      );
      return { submissionId, storageState: updatedState };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
  });
}
