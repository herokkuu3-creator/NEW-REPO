import { afterEach, describe, expect, it, vi } from 'vitest';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { chromium, request as playwrightRequest } from 'playwright';
import { AccountStatus } from '@prisma/client';
import { blockNonEssentialProblemAssets } from '../src/leetcode/ghostSubmit';
import { openRequestSession } from '../src/scheduler/rangeSubmission';
import { RangeRequestGate } from '../src/scheduler/rangeRequestGate';
import { LeetCodeHttpError } from '../src/leetcode/apiClient';
import { abortableSleep } from '../src/scheduler/rangeSubmission';

afterEach(() => vi.restoreAllMocks());

describe('Ghost-mode LeetCode submission & cookie rotation', () => {
  it('blocks heavy media/fonts/stylesheets/assets.leetcode.com and analytics while keeping blob/data and Cloudflare scripts intact', () => {
    expect(blockNonEssentialProblemAssets('https://leetcode.com/problems/nth-highest-salary/', 'document')).toBe(false);
    expect(blockNonEssentialProblemAssets('https://static.leetcode.com/app.js', 'script')).toBe(false);
    expect(blockNonEssentialProblemAssets('blob:https://leetcode.com/worker-id', 'script')).toBe(false);
    expect(blockNonEssentialProblemAssets('data:text/javascript,void(0)', 'script')).toBe(false);
    expect(blockNonEssentialProblemAssets('https://assets.leetcode.com/static_assets/public/webpack_bundles/app.js', 'script')).toBe(true);
    expect(blockNonEssentialProblemAssets('https://leetcode.com/styles/app.css', 'stylesheet')).toBe(true);
    expect(blockNonEssentialProblemAssets('https://challenges.cloudflare.com/turnstile/v0/api.js', 'script')).toBe(false);
    expect(blockNonEssentialProblemAssets('https://leetcode.com/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1', 'script')).toBe(false);
    expect(blockNonEssentialProblemAssets('https://leetcode.com/hero.png', 'image')).toBe(true);
    expect(blockNonEssentialProblemAssets('https://leetcode.com/font.woff2', 'font')).toBe(true);
    expect(blockNonEssentialProblemAssets('https://www.google-analytics.com/collect', 'xhr')).toBe(true);
  });

  it('clears cooldown for immediate verdict polling while enforcing a full 30s submit gap before the next submit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const gate = new RangeRequestGate(Date.now);
      const signal = new AbortController().signal;
      gate.observe(new LeetCodeHttpError('submit HTTP 403: <!DOCTYPE html>', 403));
      gate.clearCooldown();
      await gate.wait(false, abortableSleep, signal, undefined, Date.now() + 5_000);
      expect(Date.now()).toBe(0);

      let resolvedNextSubmit = false;
      const nextSubmitPromise = gate
        .wait(true, abortableSleep, signal, undefined, Date.now() + 60_000)
        .then(() => {
          resolvedNextSubmit = true;
        });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(resolvedNextSubmit).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await nextSubmitPromise;
      expect(resolvedNextSubmit).toBe(true);
      expect(Date.now()).toBe(30_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('upgrades challenged API submit via ghost Chromium behind CONNECT proxy, syncs cookies, and reuses the warm browser session across questions', async () => {
    const sockets = new Set<net.Socket>();
    let observedSubmitAgent = '';
    let observedReferer = '';
    let observedSecondReferer = '';
    let apiSubmitAttempts = 0;
    let secondSubmitAttempts = 0;
    let pageVisits = 0;
    let chromiumLaunchCount = 0;

    const fixture = https.createServer({
      key: readFileSync(new URL('./fixtures/auth/key.pem', import.meta.url)),
      cert: readFileSync(new URL('./fixtures/auth/cert.pem', import.meta.url)),
    }, (req, res) => {
      const cookie = req.headers.cookie ?? '';
      if (req.url === '/problems/nth-highest-salary/' && req.method === 'GET') {
        pageVisits++;
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Set-Cookie', [
          'csrftoken=csrf_fresh_browser; Path=/; Secure',
          'cf_clearance=cf_browser_ok; Path=/; Secure',
        ]);
        return res.end('<!DOCTYPE html><html><head><title>177. Nth Highest Salary - LeetCode</title></head><body>Editor</body></html>');
      }

      if (req.url === '/problems/human-traffic-of-stadium/' && req.method === 'GET') {
        pageVisits++;
        res.setHeader('Content-Type', 'text/html');
        return res.end('<!DOCTYPE html><html><head><title>601. Human Traffic of Stadium - LeetCode</title></head><body>Editor</body></html>');
      }

      if (req.url === '/problems/nth-highest-salary/submit/' && req.method === 'POST') {
        apiSubmitAttempts++;
        observedSubmitAgent = String(req.headers['user-agent'] ?? '');
        observedReferer = String(req.headers.referer ?? '');
        const hasCleared = cookie.includes('cf_clearance=cf_browser_ok');
        const hasFreshCsrf = cookie.includes('csrftoken=csrf_fresh_browser') && req.headers['x-csrftoken'] === 'csrf_fresh_browser';
        if (!hasCleared || !hasFreshCsrf) {
          res.writeHead(403, { 'Content-Type': 'text/html' });
          return res.end('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div id="cf-chl">Challenge</div></body></html>');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ submission_id: 777177 }));
      }

      if (req.url === '/problems/human-traffic-of-stadium/submit/' && req.method === 'POST') {
        secondSubmitAttempts++;
        observedSecondReferer = String(req.headers.referer ?? '');
        const hasCleared = cookie.includes('cf_clearance=cf_browser_ok');
        const hasFreshCsrf = cookie.includes('csrftoken=csrf_fresh_browser') && req.headers['x-csrftoken'] === 'csrf_fresh_browser';
        if (!hasCleared || !hasFreshCsrf) {
          res.writeHead(403, { 'Content-Type': 'text/html' });
          return res.end('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div id="cf-chl">Challenge</div></body></html>');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ submission_id: 777601 }));
      }

      if (req.url === '/submissions/detail/777177/v2/check/' && req.method === 'GET') {
        const hasCleared = cookie.includes('cf_clearance=cf_browser_ok');
        if (!hasCleared) {
          res.writeHead(403, { 'Content-Type': 'text/html' });
          return res.end('<!DOCTYPE html><title>Just a moment...</title>');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ state: 'SUCCESS', status_code: 10, status_msg: 'Accepted', status_runtime: '180 ms', status_memory: '0B' }));
      }

      res.writeHead(404);
      res.end('not found');
    });

    await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
    const fixturePort = (fixture.address() as net.AddressInfo).port;

    const proxy = http.createServer((_req, res) => {
      res.writeHead(403);
      res.end();
    });
    proxy.on('connect', (req, socket, head) => {
      if (req.url !== 'leetcode.com:443') return socket.destroy();
      const upstream = net.connect(fixturePort, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      sockets.add(socket);
      sockets.add(upstream);
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;

    const origLaunch = chromium.launch.bind(chromium);
    const origNewRequest = playwrightRequest.newContext.bind(playwrightRequest);
    vi.spyOn(chromium, 'launch').mockImplementation(async (options) => {
      chromiumLaunchCount++;
      const browser = await origLaunch(options);
      const origNewContext = browser.newContext.bind(browser);
      vi.spyOn(browser, 'newContext').mockImplementation((opts) => origNewContext({ ...opts, ignoreHTTPSErrors: true }));
      return browser;
    });
    vi.spyOn(playwrightRequest, 'newContext').mockImplementation((opts) =>
      origNewRequest({ ...opts, ignoreHTTPSErrors: true }),
    );

    const customUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    const persistCalls: string[] = [];
    const account = {
      id: 'acc-ghost-1',
      label: 'chris_grif',
      username: 'chris_grif',
      status: AccountStatus.ACTIVE,
      storageState: JSON.stringify({
        transport: { userAgent: customUa },
        cookies: [
          { name: 'LEETCODE_SESSION', value: 'valid_session_token_123', domain: '.leetcode.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
          { name: 'csrftoken', value: 'initial_csrf', domain: '.leetcode.com', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' },
        ],
        origins: [],
      }),
    } as any;

    const session = await openRequestSession(account, undefined, {
      gate: new RangeRequestGate(Date.now, 0, 0),
      resolveProxy: async () => ({
        proxy: { index: 1, url: proxyUrl, masked: proxyUrl, hash: 'test', isRemoved: false, isCustom: true, isPreferred: true },
        url: proxyUrl,
        host: new URL(proxyUrl).host,
        fromPreferred: true,
        fallbackOccurred: false,
      }),
      persistCookies: async (_acc, _initial, ctx) => {
        const latest = await ctx.storageState?.();
        const csrf = (latest?.cookies as Array<{ name: string; value: string }> | undefined)?.find((c) => c.name === 'csrftoken')?.value;
        if (csrf) persistCalls.push(csrf);
        return true;
      },
    });

    try {
      await expect(
        session.api.submit({ slug: 'nth-highest-salary', questionId: '177', lang: 'mysql', code: 'CREATE FUNCTION...' }),
      ).rejects.toMatchObject({ status: 403 });
      expect(observedSubmitAgent).toBe(customUa);
      expect(observedReferer).toBe('https://leetcode.com/problems/nth-highest-salary/');

      const submissionId = await session.api.submitWithBrowserFallback!({
        slug: 'nth-highest-salary',
        questionId: '177',
        lang: 'mysql',
        code: 'CREATE FUNCTION getNthHighestSalary(N INT) RETURNS INT BEGIN RETURN 1; END',
      });

      expect(submissionId).toBe('777177');
      expect(pageVisits).toBe(1);
      expect(chromiumLaunchCount).toBe(1);
      expect(apiSubmitAttempts).toBe(2);
      expect(persistCalls).toContain('csrf_fresh_browser');

      // Upgraded Tier-1 context now holds cf_clearance & fresh csrftoken and has no 60s block cooldown
      const outcome = await session.api.awaitResult('777177', 'nth-highest-salary');
      expect(outcome.classification).toBe('ACCEPTED');

      // Second question routes directly through the warm GhostBrowserSession without cold-relaunching or re-navigating
      const secondSubmissionId = await session.api.submit({
        slug: 'human-traffic-of-stadium',
        questionId: '601',
        lang: 'mysql',
        code: 'SELECT * FROM Stadium WHERE people >= 100',
      });
      expect(secondSubmissionId).toBe('777601');
      expect(secondSubmitAttempts).toBe(1);
      expect(chromiumLaunchCount).toBe(1);
      expect(pageVisits).toBe(1);
      expect(observedSecondReferer).toBe('https://leetcode.com/problems/human-traffic-of-stadium/');
    } finally {
      await session.close();
      for (const s of sockets) s.destroy();
      await Promise.all([
        new Promise<void>((r) => proxy.close(() => r())),
        new Promise<void>((r) => fixture.close(() => r())),
      ]);
    }
  }, 30_000);
});
