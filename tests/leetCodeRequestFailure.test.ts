import { describe, expect, it, vi } from 'vitest';
import {
  buildBrowserClientHeaders,
  cookieMatchesOrigin,
  deduplicateLeetCodeCookies,
  LeetCodeApi,
  LeetCodeHttpError,
  leetCodeRequestFailure,
  looksLikeChallenge,
  isSubmissionLimitError,
  selectBestCsrfCookie,
  summarizeHttpErrorBody,
} from '../src/leetcode/apiClient';

it('distinguishes CSRF rejection, transient server throttling, HTML verification and actual quota', () => {
  const csrf = new LeetCodeHttpError('submit HTTP 403: CSRF verification failed', 403);
  expect(leetCodeRequestFailure(csrf).category).toBe('session-csrf'); expect(looksLikeChallenge(csrf)).toBe(false);
  const unauth = new LeetCodeHttpError('submit HTTP 403: User is not authenticated', 403);
  expect(leetCodeRequestFailure(unauth).category).toBe('session-auth'); expect(looksLikeChallenge(unauth)).toBe(false);
  const rate = new LeetCodeHttpError('GraphQL HTTP 429', 429);
  expect(leetCodeRequestFailure(rate).category).toBe('rate-limit'); expect(isSubmissionLimitError(rate)).toBe(false);
  expect(leetCodeRequestFailure(new LeetCodeHttpError('submit HTTP 403: <!DOCTYPE html> Just a moment', 403)).category).toBe('challenge');
  expect(leetCodeRequestFailure(Error('submit rejected: You have reached the submission limit for today.')).category).toBe('submission-limit');
  expect(looksLikeChallenge(new LeetCodeHttpError('submit response contained no submission_id'))).toBe(false);
  expect(isSubmissionLimitError(Error('submission limit; try again in 10 seconds'))).toBe(false);
  expect(looksLikeChallenge(Error('submit rejected: You are submitting too fast, please try again later'))).toBe(true);
});

describe('CSRF, headers, and HTML diagnostic helpers', () => {
  it('preserves Django CSRF rejection beyond 600 bytes of style CSS', () => {
    const paddingCss = 'body { color: #111; } '.repeat(35);
    const djangoHtml = `<!DOCTYPE html><html lang="en"><head><title>403 Forbidden</title><style>${paddingCss}</style></head><body><h1>Forbidden (403)</h1><p>CSRF verification failed. Request aborted.</p></body></html>`;
    const summary = summarizeHttpErrorBody(djangoHtml);
    expect(summary).toContain('403 Forbidden');
    expect(summary).toContain('CSRF verification failed');
    const err = new LeetCodeHttpError(`submit HTTP 403: ${summary}`, 403);
    expect(leetCodeRequestFailure(err).category).toBe('session-csrf');
    expect(looksLikeChallenge(err)).toBe(false);
  });

  it('selects the newest non-expired csrftoken for leetcode.com and respects subdomain boundaries', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    expect(cookieMatchesOrigin('.leetcode.com', 'https://leetcode.com')).toBe(true);
    expect(cookieMatchesOrigin('.leetcode.com', 'https://assets.leetcode.com')).toBe(true);
    expect(cookieMatchesOrigin('leetcode.com', 'https://evil-leetcode.com')).toBe(false);
    expect(cookieMatchesOrigin('.leetcode.com', 'https://leetcode.com.evil.com')).toBe(false);

    expect(
      selectBestCsrfCookie([
        { name: 'csrftoken', value: 'expired', domain: '.leetcode.com', expires: nowSec - 60 },
        { name: 'csrftoken', value: 'wrong_site', domain: 'evil-leetcode.com', expires: nowSec + 99999 },
        { name: 'csrftoken', value: 'old_parent', domain: '.leetcode.com', expires: nowSec + 1000 },
        { name: 'csrftoken', value: 'fresh_host', domain: 'leetcode.com', expires: nowSec + 50000 },
      ]),
    ).toBe('fresh_host');
  });

  it('builds consistent Sec-CH-UA headers from the active User-Agent', () => {
    const winHeaders = buildBrowserClientHeaders('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36');
    expect(winHeaders['sec-ch-ua']).toContain('"Chromium";v="131"');
    expect(winHeaders['sec-ch-ua-platform']).toBe('"Windows"');

    const ffHeaders = buildBrowserClientHeaders('Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0');
    expect(ffHeaders['sec-ch-ua']).toBeUndefined();
    expect(ffHeaders['Accept-Language']).toBe('en-US,en;q=0.9');
  });

  it('sends problem referer + Sec-Fetch headers and retries once after refreshing CSRF token on 403 CSRF HTML', async () => {
    let csrf = 'stale_csrf';
    const postCalls: Array<{ url: string; headers: Record<string, string> }> = [];
    const get = vi.fn(async () => {
      csrf = 'fresh_csrf';
      return { status: () => 200, text: async () => '{}', headers: () => ({}), dispose: async () => undefined };
    });
    const post = vi.fn(async (url: string, opts: { headers: Record<string, string> }) => {
      postCalls.push({ url, headers: opts.headers });
      if (opts.headers['x-csrftoken'] === 'stale_csrf') {
        const html = `<!DOCTYPE html><html><head><title>403 Forbidden</title><style>${'a{b:c}'.repeat(80)}</style></head><body>CSRF verification failed.</body></html>`;
        return { status: () => 403, text: async () => html, headers: () => ({}), dispose: async () => undefined };
      }
      return { status: () => 200, text: async () => JSON.stringify({ submission_id: 991177 }), headers: () => ({}), dispose: async () => undefined };
    });

    const api = new LeetCodeApi({
      request: { post, get },
      cookies: async () => [{ name: 'csrftoken', value: csrf, domain: '.leetcode.com' }],
    } as any);

    const id = await api.submitSolution({ slug: 'nth-highest-salary', questionId: '177', lang: 'mysql', code: 'SELECT 1;' });
    expect(id).toBe('991177');
    expect(post).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(1);
    expect(postCalls[0]!.headers.Referer).toBe('https://leetcode.com/problems/nth-highest-salary/');
    expect(postCalls[0]!.headers['Sec-Fetch-Site']).toBe('same-origin');
    expect(postCalls[0]!.headers['Sec-Fetch-Mode']).toBe('cors');
    expect(postCalls[1]!.headers['x-csrftoken']).toBe('fresh_csrf');
  });

  it('deduplicates stale .leetcode.com vs host-only leetcode.com singleton cookies while preserving other cookies', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const deduped = deduplicateLeetCodeCookies([
      { name: 'csrftoken', value: 'old_dot', domain: '.leetcode.com', expires: nowSec + 1000 },
      { name: 'csrftoken', value: 'fresh_host', domain: 'leetcode.com', expires: nowSec + 50000 },
      { name: 'LEETCODE_SESSION', value: 'sess_active', domain: '.leetcode.com', expires: nowSec + 50000 },
      { name: 'csrftoken', value: 'expired_dead', domain: '.leetcode.com', expires: nowSec - 10 },
      { name: '_ga', value: 'ga_keep', domain: '.leetcode.com', expires: nowSec + 1000 },
    ]);
    expect(deduped.filter((c) => c.name === 'csrftoken').map((c) => c.value)).toEqual(['fresh_host']);
    expect(deduped.some((c) => c.name === '_ga' && c.value === 'ga_keep')).toBe(true);
    expect(deduped.some((c) => c.name === 'LEETCODE_SESSION' && c.value === 'sess_active')).toBe(true);
  });
});
