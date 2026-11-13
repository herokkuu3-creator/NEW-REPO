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
import { solveCloudflareOrchestrated } from '../codeforces/captchaSolver';
import {
  deduplicateLeetCodeCookies,
  isCsrfRejectionBody,
  isSubmissionLimitError,
  LeetCodeHttpError,
  parseRetryAfter,
  selectBestCookieByName,
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

export interface GhostBrowserSubmitParams {
  slug: string;
  questionId: string;
  lang: string;
  code: string;
  signal?: AbortSignal;
  forceNavigate?: boolean;
}

export interface GhostBrowserSessionOptions {
  userAgent?: string;
  proxyUrl?: string;
  onStorageState?: (state: StorageStateShape) => Promise<void> | void;
}

export interface GhostBrowserSession {
  submit(params: GhostBrowserSubmitParams): Promise<GhostSubmitResult>;
  close(): Promise<void>;
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
 * Drops decorative heavy assets (images, media, fonts, stylesheets, heavy
 * Monaco/React bundles from `assets.leetcode.com`, and analytics) inside the
 * ghost Chromium session while keeping `blob:`/`data:` challenge workers and
 * Cloudflare verification scripts intact.
 */
export function blockNonEssentialProblemAssets(url: string, type: string): boolean {
  const lowerUrl = url.toLowerCase();
  if (lowerUrl.startsWith('blob:') || lowerUrl.startsWith('data:') || lowerUrl.startsWith('about:')) {
    return false;
  }

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

  if (
    ['image', 'media', 'font', 'stylesheet', 'websocket', 'eventsource', 'manifest', 'ping'].includes(
      type,
    )
  ) {
    return true;
  }

  if (host === 'assets.leetcode.com') {
    return true;
  }

  const isLeetCode = host === 'leetcode.com' || host.endsWith('.leetcode.com');
  return !isLeetCode;
}

function pruneExpiredCookies(cookies: StorageStateShape['cookies']): StorageStateShape['cookies'] {
  return deduplicateLeetCodeCookies(cookies, ORIGIN);
}

function normalizeChromeUserAgent(userAgent?: string): string {
  if (!userAgent || /Firefox\//i.test(userAgent)) {
    return DEFAULT_DESKTOP_CHROME_USER_AGENT;
  }
  return userAgent;
}

function isRecoverableBrowserCrash(err: unknown, pageCrashed: boolean): boolean {
  if (pageCrashed) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /Page crashed|Target page, context or browser has been closed|Session closed|Connection closed|Browser has been closed/i.test(msg);
}

async function extractChallengeMetadata(page: Page): Promise<{ sitekey?: string; action?: string; cdata?: string }> {
  return page
    .evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      let sitekey = typeof w.__turnstileSitekey === 'string' ? w.__turnstileSitekey.trim() : '';
      if (!sitekey) {
        const el = document.querySelector('[data-sitekey]');
        sitekey = el?.getAttribute('data-sitekey')?.trim() ?? '';
      }
      if (!sitekey) {
        const iframes = Array.from(document.querySelectorAll('iframe[src*="challenges.cloudflare.com"]'));
        for (const iframe of iframes) {
          const m = /\/(0x[0-9a-zA-Z_-]{10,})\//.exec(iframe.getAttribute('src') ?? '');
          if (m?.[1]) {
            sitekey = m[1];
            break;
          }
        }
      }
      return {
        ...(sitekey ? { sitekey } : {}),
        ...(typeof w.__turnstileAction === 'string' && w.__turnstileAction ? { action: w.__turnstileAction } : {}),
        ...(typeof w.__turnstileCdata === 'string' && w.__turnstileCdata ? { cdata: w.__turnstileCdata } : {}),
      };
    })
    .catch(() => ({}));
}

async function applyCloudflareSolution(
  page: Page,
  context: BrowserContext,
  targetUrl: string,
  solved: NonNullable<Awaited<ReturnType<typeof solveCloudflareOrchestrated>>>,
): Promise<void> {
  const cookiesToSet: Array<{ name: string; value: string; domain: string; path: string; secure: boolean }> = [];
  if (solved.cookies) {
    for (const [name, value] of Object.entries(solved.cookies)) {
      if ((name.toLowerCase().startsWith('cf_') || name.toLowerCase().startsWith('__cf')) && value && value !== 'cleared') {
        cookiesToSet.push({ name, value: String(value), domain: '.leetcode.com', path: '/', secure: true });
      }
    }
  }
  if (solved.cfClearance && solved.cfClearance.length > 5 && solved.cfClearance !== 'cleared') {
    if (!cookiesToSet.some((c) => c.name === 'cf_clearance')) {
      cookiesToSet.push({ name: 'cf_clearance', value: solved.cfClearance, domain: '.leetcode.com', path: '/', secure: true });
    }
  }
  if (cookiesToSet.length > 0) {
    await context.addCookies(cookiesToSet).catch(() => undefined);
  }
  if (typeof solved.token === 'string' && solved.token.trim().length > 10) {
    await page
      .evaluate((token) => {
        const inputs = Array.from(
          document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
            'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"], input[name="g-recaptcha-response"]',
          ),
        );
        for (const el of inputs) el.value = token;
        const w = window as unknown as { __turnstileCallback?: (t: string) => void };
        if (typeof w.__turnstileCallback === 'function') {
          try {
            w.__turnstileCallback(token);
          } catch {}
        }
      }, solved.token.trim())
      .catch(() => undefined);
    await page.waitForTimeout(1_200).catch(() => undefined);
  }
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => undefined);
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
  storedCookies?: StorageStateShape['cookies'],
): Promise<string> {
  const restoreSessionCookieIfMissing = async (): Promise<boolean> => {
    const contextCookies = await page.context().cookies(ORIGIN).catch(() => []);
    if (selectBestCookieByName(contextCookies, 'LEETCODE_SESSION', ORIGIN)) {
      return false;
    }
    const storedSession = storedCookies?.length
      ? selectBestCookieByName(storedCookies, 'LEETCODE_SESSION', ORIGIN)
      : null;
    if (!storedSession) return false;
    await page
      .context()
      .addCookies([
        {
          name: storedSession.name,
          value: storedSession.value,
          domain: storedSession.domain || '.leetcode.com',
          path: storedSession.path || '/',
          expires: storedSession.expires ?? -1,
          httpOnly: storedSession.httpOnly ?? true,
          secure: storedSession.secure ?? true,
          sameSite: storedSession.sameSite ?? 'Lax',
        },
      ])
      .catch(() => undefined);
    return true;
  };

  await restoreSessionCookieIfMissing();

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
      async ({ origin, problemPath, submitUrl, body, csrf }) => {
        try {
          if (window.location.origin === origin && window.location.pathname !== problemPath) {
            window.history.replaceState(null, '', problemPath);
          }
        } catch {
          // Ignore history replace errors if origin differs.
        }
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
        origin: ORIGIN,
        problemPath: `/problems/${params.slug}/`,
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
  if (response.status === 403 && /not\s+authenticated|unauthenticated/i.test(response.text)) {
    const restored = await restoreSessionCookieIfMissing();
    if (restored) {
      const refreshed = (await readCsrf()) ?? token;
      response = await sendInPage(refreshed);
    }
    if (response.status === 403 && /not\s+authenticated|unauthenticated/i.test(response.text)) {
      const latestCookies = await page.context().cookies(ORIGIN).catch(() => []);
      logger.warn(
        {
          slug: params.slug,
          hasSessionCookie: Boolean(selectBestCookieByName(latestCookies, 'LEETCODE_SESSION', ORIGIN)),
          hasCsrfCookie: Boolean(selectBestCsrfCookie(latestCookies, ORIGIN)),
        },
        'ghost browser submit rejected with 403 unauthenticated',
      );
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

async function waitForPassiveChallengeSettle(
  page: Page,
  signal?: AbortSignal,
  maxWaitMs = 25_000,
): Promise<string | null> {
  const safeDetect = async (): Promise<string | null> => {
    try {
      return await detectVerificationPage(page);
    } catch {
      // Execution context can be destroyed mid-redirect while Cloudflare settles.
      return 'challenge-page';
    }
  };

  const deadline = Date.now() + maxWaitMs;
  let kind = await safeDetect();
  while (kind && Date.now() < deadline && !signal?.aborted) {
    await page.waitForTimeout(600).catch(() => undefined);
    kind = await safeDetect();
  }
  if (!kind && !signal?.aborted) {
    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => undefined);
    kind = await safeDetect();
  }
  return kind;
}

export interface GhostBrowserDeps {
  resolveProxy?: typeof resolveLeetCodeResidentialProxy;
  submitPageFetch?: typeof submitViaPageFetch;
  solveCloudflare?: typeof solveCloudflareOrchestrated;
  challengeWaitMs?: number;
  retryWaitMs?: number;
  postSolveWaitMs?: number;
}

/**
 * Reusable ghost-mode stealth Chromium session. Keeps one Browser, Context,
 * and Page warm across multiple submissions so Cloudflare `cf_clearance` and
 * Chromium's TLS session survive between questions without cold-relaunching or
 * re-navigating problem pages unnecessarily.
 */
export async function openGhostBrowserSession(
  initialState: StorageStateShape,
  sessionOptions: GhostBrowserSessionOptions = {},
  deps: GhostBrowserDeps = {},
): Promise<GhostBrowserSession> {
  const resolveProxy = deps.resolveProxy ?? resolveLeetCodeResidentialProxy;
  const pageFetch = deps.submitPageFetch ?? submitViaPageFetch;
  const solveCloudflare = deps.solveCloudflare ?? solveCloudflareOrchestrated;
  const challengeWaitMs = deps.challengeWaitMs ?? 20_000;
  const retryWaitMs = deps.retryWaitMs ?? 10_000;
  const postSolveWaitMs = deps.postSolveWaitMs ?? 10_000;
  const canInvokeExternalSolver = !(
    (process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST)) &&
    !deps.solveCloudflare
  );

  let currentState: StorageStateShape = {
    ...initialState,
    cookies: pruneExpiredCookies(initialState.cookies ?? []),
  };
  let resolvedProxyUrl = sessionOptions.proxyUrl ?? initialState.transport?.proxyUrl;
  let proxyResolved = resolvedProxyUrl !== undefined;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let pageCrashed = false;
  let hasSettledProblemPage = false;
  let closed = false;

  const closeResources = async () => {
    hasSettledProblemPage = false;
    pageCrashed = false;
    const activeCtx = context;
    const activeBrowser = browser;
    page = null;
    context = null;
    browser = null;
    await activeCtx?.close().catch(() => undefined);
    await activeBrowser?.close().catch(() => undefined);
  };

  return {
    submit: (params) =>
      withGhostBrowserLock(async () => {
        if (closed) {
          throw new Error('Ghost browser session is closed');
        }
        if (params.signal?.aborted) {
          throw new Error('Range cancelled before ghost browser submission');
        }

        const userAgent = normalizeChromeUserAgent(
          sessionOptions.userAgent ?? currentState.transport?.userAgent,
        );

        const onAbort = () => {
          void closeResources();
        };
        params.signal?.addEventListener('abort', onAbort, { once: true });

        const runAttempt = async (): Promise<GhostSubmitResult> => {
          if (!proxyResolved) {
            resolvedProxyUrl = (await resolveProxy())?.url;
            proxyResolved = true;
          }
          const proxy = resolvedProxyUrl ? toPlaywrightProxy(resolvedProxyUrl) : undefined;
          if (resolvedProxyUrl && !proxy) {
            throw new Error('LEETCODE_PROXY_INVALID');
          }

          if (!browser || !browser.isConnected() || !context || !page || pageCrashed || page.isClosed()) {
            await closeResources();
            const headless = config.browser.headless;
            browser = await chromium.launch({
              headless,
              args: buildLaunchArgs(headless),
              proxy,
            });
            const cleanedCookies = pruneExpiredCookies(currentState.cookies ?? []);
            context = await browser.newContext({
              userAgent,
              viewport: getRandomDesktopViewport(),
              locale: 'en-US',
              storageState: {
                cookies: cleanedCookies as never,
                origins: (currentState.origins ?? []) as never,
              },
            });
            await applyStealthScripts(context, 'chromium');
            await context.route('**/*', async (route) => {
              if (
                blockNonEssentialProblemAssets(route.request().url(), route.request().resourceType())
              ) {
                return route.abort().catch(() => undefined);
              }
              return route.continue().catch(() => undefined);
            });
            page = await context.newPage();
            pageCrashed = false;
            page.on('crash', () => {
              pageCrashed = true;
              hasSettledProblemPage = false;
            });
            hasSettledProblemPage = false;
          }

          const activePage = page;
          const activeContext = context;
          const persistUpdatedState = async (warmReuse: boolean, submissionId: string) => {
            const latest = (await activeContext.storageState()) as {
              cookies: StorageStateShape['cookies'];
              origins: StorageStateShape['origins'];
            };
            const updatedState: StorageStateShape = {
              transport:
                currentState.transport ??
                (resolvedProxyUrl ? { proxyUrl: resolvedProxyUrl, userAgent } : { userAgent }),
              cookies: deduplicateLeetCodeCookies(latest.cookies, ORIGIN),
              origins: latest.origins ?? currentState.origins ?? [],
            };
            currentState = updatedState;
            if (sessionOptions.onStorageState) {
              await sessionOptions.onStorageState(updatedState);
            }
            logger.info(
              {
                slug: params.slug,
                language: params.lang,
                submissionId,
                viaProxy: Boolean(proxy),
                warmReuse,
              },
              'submitted solution via ghost-mode stealth Chromium fallback',
            );
            return { submissionId, storageState: updatedState };
          };

          // Warm fast-path: skip full page.goto() when the warm tab is already settled on LeetCode
          if (hasSettledProblemPage && !params.forceNavigate && activePage.url().startsWith(`${ORIGIN}/`)) {
            const currentKind = await detectVerificationPage(activePage).catch(() => 'challenge-page');
            const cookiesNow = await activeContext.cookies(ORIGIN).catch(() => []);
            const hasCsrf = Boolean(selectBestCsrfCookie(cookiesNow, ORIGIN));
            if (!currentKind && hasCsrf) {
              try {
                const submissionId = await pageFetch(
                  activePage,
                  {
                    slug: params.slug,
                    questionId: params.questionId,
                    lang: params.lang,
                    code: params.code,
                  },
                  currentState.cookies,
                );
                return await persistUpdatedState(true, submissionId);
              } catch (fastErr) {
                const shouldFallbackToNavigate =
                  (fastErr instanceof LeetCodeHttpError && fastErr.status !== 200) ||
                  (fastErr instanceof Error && /missing csrftoken/i.test(fastErr.message));
                if (!shouldFallbackToNavigate) {
                  throw fastErr;
                }
                hasSettledProblemPage = false;
              }
            } else {
              hasSettledProblemPage = false;
            }
          }

          const targetUrl = `${ORIGIN}/problems/${params.slug}/`;
          await activePage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

          let verificationKind = await waitForPassiveChallengeSettle(activePage, params.signal, challengeWaitMs);
          if (verificationKind && !params.signal?.aborted && canInvokeExternalSolver) {
            const cfMeta = await extractChallengeMetadata(activePage);
            const currentCookies = await activeContext.cookies(ORIGIN).catch(() => []);
            logger.info(
              {
                slug: params.slug,
                verificationKind,
                viaProxy: Boolean(proxy),
                hasSitekey: Boolean(cfMeta.sitekey),
              },
              'invoking orchestrated Cloudflare solver for ghost Chromium session',
            );
            const solved = await solveCloudflare({
              websiteURL: activePage.url() || targetUrl,
              proxyUrl: resolvedProxyUrl,
              userAgent,
              cookies: currentCookies,
              sitekey: cfMeta.sitekey,
              action: cfMeta.action,
              cdata: cfMeta.cdata,
              timeoutMs: 45_000,
            }).catch((solveErr) => {
              logger.warn(
                { slug: params.slug, err: solveErr instanceof Error ? solveErr.message : String(solveErr) },
                'orchestrated Cloudflare solver failed for ghost session',
              );
              return null;
            });
            logger.info(
              {
                slug: params.slug,
                ok: Boolean(solved),
                source: solved?.source,
                hasClearance: Boolean(solved?.cfClearance),
                hasToken: Boolean(solved?.token),
              },
              'orchestrated Cloudflare solver completed for ghost session',
            );
            if (solved && !params.signal?.aborted) {
              await applyCloudflareSolution(activePage, activeContext, targetUrl, solved);
              verificationKind = await waitForPassiveChallengeSettle(activePage, params.signal, postSolveWaitMs);
            }
          }

          if (verificationKind && !params.signal?.aborted) {
            await activePage
              .goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
              .catch(() => undefined);
            verificationKind = await waitForPassiveChallengeSettle(activePage, params.signal, retryWaitMs);
          }

          if (verificationKind) {
            hasSettledProblemPage = false;
            const title = await activePage.title().catch(() => '');
            // Never overwrite stored cookies with unverified challenge-page cookies.
            throw new LeetCodeHttpError(
              `submit HTTP 403: Cloudflare verification required (${verificationKind})${title ? ` [${title}]` : ''}`,
              403,
            );
          }

          hasSettledProblemPage = true;
          const submissionId = await pageFetch(
            activePage,
            {
              slug: params.slug,
              questionId: params.questionId,
              lang: params.lang,
              code: params.code,
            },
            currentState.cookies,
          );
          return await persistUpdatedState(false, submissionId);
        };

        try {
          try {
            return await runAttempt();
          } catch (firstErr) {
            if (!params.signal?.aborted && isRecoverableBrowserCrash(firstErr, pageCrashed)) {
              logger.warn(
                { slug: params.slug, err: firstErr instanceof Error ? firstErr.message : String(firstErr) },
                'ghost Chromium page crashed; relaunching fresh browser for recovery attempt',
              );
              await closeResources();
              return await runAttempt();
            }
            throw firstErr;
          }
        } catch (err) {
          if (
            params.signal?.aborted ||
            isRecoverableBrowserCrash(err, pageCrashed) ||
            (err instanceof LeetCodeHttpError && err.status === 403)
          ) {
            await closeResources();
            if (
              !sessionOptions.proxyUrl &&
              !initialState.transport?.proxyUrl &&
              err instanceof LeetCodeHttpError &&
              err.status === 403
            ) {
              proxyResolved = false;
            }
          }
          throw err;
        } finally {
          params.signal?.removeEventListener('abort', onAbort);
        }
      }),
    close: async () => {
      closed = true;
      await closeResources();
    },
  };
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

  const ghostSession = await openGhostBrowserSession(
    state,
    {
      userAgent: params.userAgent,
      proxyUrl: params.proxyUrl,
      onStorageState: params.onStorageState,
    },
    deps,
  );
  try {
    return await ghostSession.submit({
      slug: params.slug,
      questionId: params.questionId,
      lang: params.lang,
      code: params.code,
      signal,
    });
  } finally {
    await ghostSession.close();
  }
}
