import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { ActionBroker } from '../src/codeforces/actionBroker';
import { isTerminalCodeforcesVerdict, shouldReleaseDailyAttempt } from '../src/codeforces/dailyGate';
import { stripCppComments } from '../src/codeforces/codeSanitizer';
import { cookieHeader } from '../src/codeforces/httpSubmit';
import { getAttemptContext, withAttemptContext } from '../src/codeforces/attemptContext';
import { diagnosticLog, logRingBuffer } from '../src/codeforces/diagnosticLog';
import { selectWorkingProxy, testHttpProxyNative, toPlaywrightProxy } from '../src/codeforces/proxyRotator';
import { clickSubmitForm, ensureFormTurnstile, isSubmissionHistory } from '../src/codeforces/browserForm';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('actionBroker post-claim metadata', () => {
  it('preserves networkMode, removedProxies, and proxy after claim clears payload', async () => {
    const broker = new ActionBroker(async () => {});
    const id = await broker.enqueue({
      networkMode: 'tailscale',
      removedProxies: ['dead1', 'dead2'],
      proxy: 'http://u:p@proxy.example:8080',
      code: 'int main(){}',
    });

    expect(broker.nextNetworkMode).toBe('tailscale');
    expect(broker.nextRemovedProxies).toEqual(['dead1', 'dead2']);
    expect(broker.nextProxy).toBe('http://u:p@proxy.example:8080');

    expect(broker.claim(id)).not.toBeNull();
    expect(() => broker.networkMode(id)).not.toThrow();
    expect(broker.networkMode(id)).toBe('tailscale');
    expect(broker.removedProxies(id)).toEqual(['dead1', 'dead2']);
    expect(broker.proxy(id)).toBe('http://u:p@proxy.example:8080');
  });
});

describe('dailyGate non-terminal exclusions', () => {
  it.each(['BLOCKED', 'ERROR', 'SIGNED_OUT', 'REJECTED', 'JUDGE_TIMEOUT', 'SENT_TO_USER'])(
    'treats %s as non-terminal and releases daily attempt for auto retry',
    (verdict) => {
      expect(isTerminalCodeforcesVerdict(verdict)).toBe(false);
      expect(
        shouldReleaseDailyAttempt({
          manual: false,
          lastAttemptDate: '2026-11-18',
          lastVerdict: verdict.toLowerCase(),
          today: '2026-11-18',
        }),
      ).toBe(true);
    },
  );
});

describe('codeSanitizer C++14 digit separators and raw string delimiters', () => {
  it('handles C++14 digit separators without swallowing trailing comments', () => {
    const src = [
      "const long long a = 100'000'000; // strip decimal comment",
      "const unsigned b = 0xDE'AD'BE'EF; /* strip hex block */",
      "const int c = 0b1010'0101; // strip binary comment",
      "const double d = 1'234.56'78e-1'2; // strip float comment",
      "const char ch = u8'a'; // strip after u8 char literal",
      "const char esc = u8'\\''; // strip after escaped u8 char",
    ].join('\n');

    const stripped = stripCppComments(src);
    expect(stripped).toContain("100'000'000;");
    expect(stripped).toContain("0xDE'AD'BE'EF;");
    expect(stripped).toContain("0b1010'0101;");
    expect(stripped).toContain("1'234.56'78e-1'2;");
    expect(stripped).toContain("u8'a';");
    expect(stripped).toContain("u8'\\'';");
    expect(stripped).not.toContain('strip decimal comment');
    expect(stripped).not.toContain('strip hex block');
    expect(stripped).not.toContain('strip binary comment');
    expect(stripped).not.toContain('strip float comment');
    expect(stripped).not.toContain('strip after u8 char literal');
    expect(stripped).not.toContain('strip after escaped u8 char');
  });

  it('fixes raw string delimiter regex for "s" and whitespace', () => {
    const src = 'const char* p = R"str(\n// keep inside raw\n)str"; // remove trailing\n// also remove after "space delim"';
    const stripped = stripCppComments(src);
    expect(stripped).toContain('// keep inside raw');
    expect(stripped).not.toContain('remove trailing');
    expect(stripped).not.toContain('also remove after');
  });
});

describe('diagnosticLog redaction', () => {
  it('redacts cpsolverApiToken and socks5h:// credentials', () => {
    const startIdx = logRingBuffer.length;
    diagnosticLog(
      'test-svc',
      30,
      {
        cpsolverApiToken: 'super-secret-cp-token',
        msgUrl: 'socks5h://alice:mysecretpass@gate.example.com:1080/path?x=1',
      },
      'redaction test',
    );
    const entry = logRingBuffer[startIdx]!;
    expect(entry.cpsolverApiToken).toBe('[redacted]');
    expect(String(entry.msgUrl)).toBe('socks5h://redacted:****@gate.example.com:1080/path');
    expect(JSON.stringify(entry)).not.toContain('alice');
    expect(JSON.stringify(entry)).not.toContain('super-secret-cp-token');
    expect(JSON.stringify(entry)).not.toContain('mysecretpass');
  });
});

describe('httpSubmit, attemptContext, and api fixes', () => {
  it('skips expired epoch-0 cookies while preserving -1 session cookies', () => {
    const header = cookieHeader(
      {
        cookies: [
          { name: 'epoch0', value: 'dead', domain: '.codeforces.com', path: '/', expires: 0 },
          { name: 'past', value: 'old', domain: '.codeforces.com', path: '/', expires: 100 },
          { name: 'session', value: 'alive', domain: '.codeforces.com', path: '/', expires: -1 },
          { name: 'future', value: 'ok', domain: '.codeforces.com', path: '/', expires: 2_000_000_000 },
        ],
        origins: [],
      } as never,
      1_000_000,
    );
    expect(header).toBe('session=alive; future=ok');
  });

  it('clamps large or infinite deadlines in withAttemptContext without 32-bit timer overflow', async () => {
    const result = await withAttemptContext('inf-test', Infinity, async () => {
      await new Promise((r) => setTimeout(r, 15));
      return getAttemptContext()?.signal.aborted;
    });
    expect(result).toBe(false);

    const farResult = await withAttemptContext('far-test', Date.now() + 5_000_000_000, async () => {
      await new Promise((r) => setTimeout(r, 15));
      return getAttemptContext()?.signal.aborted;
    });
    expect(farResult).toBe(false);
  });

  it('updates nextAllowedAt in finally even when Codeforces API fetch rejects', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'OK', result: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchUserStatus } = await import('../src/codeforces/api');

    await expect(fetchUserStatus('alice')).rejects.toThrow('network down');
    const secondCall = fetchUserStatus('alice');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_200);
    expect(await secondCall).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('proxyRotator and proxyManager fixes', () => {
  it('normalizes socks5h: to socks5: in toPlaywrightProxy', () => {
    expect(toPlaywrightProxy('socks5h://u:p@proxy.example:1080')).toEqual({
      server: 'socks5://proxy.example:1080',
      username: 'u',
      password: 'p',
    });
  });

  it('checks prefRes.ok instead of object truthiness in selectWorkingProxy', async () => {
    const p1 = 'http://u:p@p1.example:8080';
    const p2 = 'http://u:p@p2.example:8080';
    const selected = await selectWorkingProxy(`${p1}, ${p2}`, {
      preferredProxy: p1,
      tester: async (url) => (url === p1 ? { ok: false, latencyMs: 10, error: 'dead' } : { ok: true, latencyMs: 20 }),
      log: () => {},
    });
    expect(selected.selectedProxy).toBe(p2);
    expect(selected.index).toBe(1);
  });

  it('returns ok:false on tlsTunnel errors / missing ip= in testHttpProxyNative', async () => {
    const server = createTcpServer((socket) => {
      socket.once('data', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        // Send invalid plaintext instead of TLS handshake to trigger tlsTunnel error
        socket.write('NOT_TLS_DATA\r\n');
        socket.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await testHttpProxyNative(`http://127.0.0.1:${port}`, 3);
      expect(res.ok).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('clears all per-proxy and overall timers in testAllProxiesOneByOne', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.doMock('../src/database/models', () => ({
      SystemKeys: {
        codeforcesRemovedProxies: 'codeforcesRemovedProxies',
        codeforcesCustomProxies: 'codeforcesCustomProxies',
        codeforcesPreferredProxy: 'codeforcesPreferredProxy',
      },
      getSystemState: vi.fn(async () => null),
      setSystemState: vi.fn(async () => {}),
      deleteSystemState: vi.fn(async () => {}),
    }));
    vi.doMock('../src/codeforces/proxyRotator', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/codeforces/proxyRotator')>();
      return {
        ...actual,
        testProxyDetailed: vi.fn(async () => ({ ok: true, latencyMs: 15, ip: '1.1.1.1' })),
      };
    });
    const { testAllProxiesOneByOne } = await import('../src/codeforces/proxyManager');
    const res = await testAllProxiesOneByOne(undefined, 'http://u:p@ok.example:8080', 5);
    expect(res).toHaveLength(1);
    expect(res[0]?.result.ok).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.doUnmock('../src/database/models');
    vi.doUnmock('../src/codeforces/proxyRotator');
  });
});

describe('submitterService security, token forwarding, proxy normalization, and challenge timeout', () => {
  it('gates /logs and /sage/* with timing-safe Bearer auth, enforces 64KB cap, catches errors, and handles NaN limit', async () => {
    vi.resetModules();
    vi.stubEnv('CODEFORCES_SUBMITTER_TOKEN', 'sub-secret-token-123');
    vi.stubEnv('CODEFORCES_RUNNER_MODE', 'render');
    vi.doMock('../src/ai/sageProbe', () => ({
      sageConsoleHtml: () => '<html>ok</html>',
      probeSageApi: vi.fn(async () => {
        throw new Error('probe boom');
      }),
      askSage: vi.fn(async () => ({ ok: true, answer: 'hi' })),
    }));

    const { server } = await import('../src/codeforces/submitterService');
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (const [method, path] of [
        ['GET', '/logs'],
        ['GET', '/sage'],
        ['GET', '/sage/test'],
        ['POST', '/sage/test'],
        ['POST', '/sage/ask'],
      ] as const) {
        const res = await fetch(`${origin}${path}`, { method });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ ok: false, error: 'unauthorized' });
      }

      const auth = { authorization: 'Bearer sub-secret-token-123', 'content-type': 'application/json' };
      const logsRes = await fetch(`${origin}/logs?limit=notanumber`, { headers: auth });
      expect(logsRes.status).toBe(200);
      expect((await logsRes.json()).ok).toBe(true);

      const sageHtml = await fetch(`${origin}/sage`, { headers: auth });
      expect(sageHtml.status).toBe(200);

      const probeErr = await fetch(`${origin}/sage/test`, { headers: auth });
      expect(probeErr.status).toBe(500);
      expect(await probeErr.json()).toEqual({ ok: false, error: 'probe boom' });

      const oversized = JSON.stringify({ question: 'x'.repeat(70_000) });
      const askLarge = await fetch(`${origin}/sage/ask`, { method: 'POST', headers: auth, body: oversized });
      expect(askLarge.status).toBe(413);
      expect(await askLarge.json()).toEqual({ ok: false, error: 'request body too large' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vi.doUnmock('../src/ai/sageProbe');
    }
  });

  it('forwards cpsolverApiToken, clears stale configs, and attaches activeCapzyKeyIndex on early/catch paths', async () => {
    vi.resetModules();
    vi.stubEnv('CODEFORCES_SUBMITTER_TOKEN', 'sub-token-xyz');
    vi.stubEnv('CODEFORCES_RUNNER_MODE', 'render');
    vi.stubEnv('CODEFORCES_BROWSER_MIN_FREE_MB', '999999');
    vi.stubEnv('CODEFORCES_SUBMITTER_URL', 'https://submitter.example');
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/health')) return new Response(JSON.stringify({ busy: false }), { status: 200 });
      return new Response(JSON.stringify({ ok: false, clicked: false, activeCapzyKeyIndex: 0 }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('CPSOLVER_API_TOKEN', 'cp-api-tok-777');
    vi.stubEnv('CPSOLVER_URL', 'https://cpsolver.example');

    const { submitViaRemoteSubmitter } = await import('../src/codeforces/remoteSubmitter');
    vi.doMock('../src/database/models', () => ({
      SystemKeys: {
        codeforcesRemovedProxies: 'codeforcesRemovedProxies',
        codeforcesCustomProxies: 'codeforcesCustomProxies',
        codeforcesPreferredProxy: 'codeforcesPreferredProxy',
      },
      getSystemState: vi.fn(async () => null),
      setSystemState: vi.fn(async () => {}),
      deleteSystemState: vi.fn(async () => {}),
    }));
    await submitViaRemoteSubmitter(
      { cookies: [] },
      'acct',
      'acct',
      { contestId: 1, problemIndex: 'A', key: '1A', path: '1A', fileName: '1A', language: 'cpp', kind: 'CODEFORCES', interactive: false, gym: false, reason: 'test' },
      'int main(){}',
      'proxy',
      { activeProxy: null },
    );
    const submitCall = fetchMock.mock.calls.find((c) => c[0].endsWith('/submit'))!;
    expect(JSON.parse(String(submitCall[1]!.body)).cpsolverApiToken).toBe('cp-api-tok-777');

    // Now test submitterService clears stale globals and includes activeCapzyKeyIndex on early return + HTTP catch
    vi.unstubAllEnvs();
    vi.stubEnv('CODEFORCES_SUBMITTER_TOKEN', 'sub-token-xyz');
    vi.stubEnv('CODEFORCES_RUNNER_MODE', 'render');
    vi.stubEnv('CODEFORCES_BROWSER_MIN_FREE_MB', '999999');
    const { submit, server } = await import('../src/codeforces/submitterService');
    const { getCPSolverUrl, getCPSolverApiToken } = await import('../src/codeforces/captchaSolver');
    const { getCapzyApiKeys } = await import('../src/codeforces/capzyKeyManager');

    const res1 = await submit({
      code: 'int main(){}',
      entry: { contestId: 1, problemIndex: 'A' },
      state: { cookies: [] },
      capzyApiKeys: ['capzy_11111111111111111111111111111111', 'capzy_22222222222222222222222222222222'],
      capzyActiveKeyIndex: 1,
      cpsolverUrl: 'https://cp1.example',
      cpsolverApiToken: 'secret-cp-1',
    });
    expect(res1.ok).toBe(false);
    expect(res1.activeCapzyKeyIndex).toBe(1);
    expect(getCPSolverUrl()).toBe('https://cp1.example');
    expect(getCPSolverApiToken()).toBe('secret-cp-1');

    const res2 = await submit({
      code: 'int main(){}',
      entry: { contestId: 1, problemIndex: 'A' },
      state: { cookies: [] },
    });
    expect(res2.activeCapzyKeyIndex).toBe(0);
    expect(getCPSolverUrl()).toBe('');
    expect(getCPSolverApiToken()).toBe('');
    expect(await getCapzyApiKeys()).toEqual([]);

    // Trigger catch block in POST /submit (invalid proxy throws before browser)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      vi.stubEnv('CODEFORCES_BROWSER_MIN_FREE_MB', '0');
      // Use a fresh import or trigger via proxy throw: notice BROWSER_MIN_FREE_MB is module const, so res2 returned low memory;
      // pass attemptDeadline: Date.now() (expired) -> throws AttemptCancelledError / BrowserFormError -> hits .catch in /submit!
      const catchRes = await fetch(`${origin}/submit`, {
        method: 'POST',
        headers: { authorization: 'Bearer sub-token-xyz', 'content-type': 'application/json' },
        body: JSON.stringify({
          attemptDeadline: Date.now(),
          code: 'int main(){}',
          entry: { contestId: 1, problemIndex: 'A' },
          state: { cookies: [] },
          capzyApiKeys: ['capzy_aaaa', 'capzy_bbbb'],
          capzyActiveKeyIndex: 1,
        }),
      });
      const catchJson = (await catchRes.json()) as { ok: boolean; activeCapzyKeyIndex?: number };
      expect(catchJson.ok).toBe(false);
      expect(catchJson.activeCapzyKeyIndex).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vi.doUnmock('../src/database/models');
    }
  });

  it('honors short positive timeoutMs < 50_000 and handles NaN CHALLENGE_WAIT_MS in waitOutChallenge', async () => {
    vi.stubEnv('CODEFORCES_CHALLENGE_WAIT_MS', 'not-a-number');
    vi.stubEnv('CPSOLVER_URL', '');
    vi.stubEnv('TURNSTILE_SOLVER_URL', '');
    const { waitOutChallenge: submitterWait } = await import('../src/codeforces/submitterService');
    const { waitOutChallenge: submissionWait } = await import('../src/codeforces/submission');

    const fakePage = {
      url: () => 'https://codeforces.com/contest/1/submit',
      title: async () => 'Just a moment...',
      context: () => ({ cookies: async () => [] }),
      locator: () => ({ count: async () => 0 }),
      frames: () => [],
    } as never;

    const t0 = Date.now();
    expect(await submitterWait(fakePage, 40)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2_000);

    const t1 = Date.now();
    expect(await submissionWait(fakePage, 40)).toBe(false);
    expect(Date.now() - t1).toBeLessThan(2_000);
  });
});

describe('captchaSolver HTML escaping and cfClearance check', () => {
  it('HTML-escapes dynamic error/proxy strings and accepts cfClearance in solveCloudflareOrchestrated', async () => {
    vi.resetModules();
    vi.stubEnv('CPSOLVER_URL', 'https://cp.example');
    vi.stubEnv('CPSOLVER_MAX_TRIES', '1');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'tg-bot-token');
    vi.stubEnv('TELEGRAM_CHAT_ID', '12345');
    vi.stubEnv('CAPZY_API_KEYS', 'capzy_real_key_12345678901234567890');
    vi.stubEnv('CAPZY_RETRY_DELAY_MS', '0');

    const sentTexts: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('api.telegram.org')) {
        sentTexts.push(JSON.parse(String(init?.body)).text);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith('/solve')) {
        return new Response('<html>Bad <Gateway> & Error</html>', { status: 500 });
      }
      if (url.includes('createTask')) {
        return new Response(JSON.stringify({ errorId: 0, taskId: 't1' }), { status: 200 });
      }
      if (url.includes('getTaskResult')) {
        return new Response(
          JSON.stringify({ errorId: 0, status: 'ready', solution: { cfClearance: 'valid_clearance_cookie_123' } }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { solveCloudflareOrchestrated } = await import('../src/codeforces/captchaSolver');
    const result = await solveCloudflareOrchestrated({
      websiteURL: 'https://codeforces.com/contest/1/submit',
      proxyUrl: 'http://u:p@proxy.example:8080',
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({ source: 'capsolver', cfClearance: 'valid_clearance_cookie_123' });
    const failMsg = sentTexts.find((m) => m.includes('Attempt 1/1 failed'));
    expect(failMsg).toContain('&lt;html&gt;Bad &lt;Gateway&gt; &amp; Error&lt;/html&gt;');
  });
});

describe('browserForm fixes', () => {
  it('recognizes gym submission URLs in isSubmissionHistory', () => {
    expect(isSubmissionHistory('https://codeforces.com/gym/101021/submission/987654')).toBe(true);
    expect(isSubmissionHistory('https://codeforces.com/gym/101021/submission/abc')).toBe(false);
  });

  it('registers expired-callback, overwrites expired token, aborts background solver on native token, and deduplicates Capzy', async () => {
    const { initCPSolverConfig } = await import('../src/codeforces/captchaSolver');
    const { initCapzyKeys } = await import('../src/codeforces/capzyKeyManager');
    const browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage();
    try {
      await page.route('https://codeforces.com/contest/1/submit', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `
            <form id="solution" action="/contest/1/submit" method="post">
              <textarea name="source">int main(){}</textarea>
              <input type="hidden" name="turnstileToken" value="">
              <input type="hidden" name="cf-turnstile-response" value="">
              <div class="cf-turnstile" data-sitekey="real-sitekey-0001"></div>
              <input type="submit" value="Submit" disabled>
            </form>
            <script>
              window.__callbacks = {};
              window.turnstile = {
                render: (_el, opts) => {
                  window.__callbacks.callback = opts.callback;
                  window.__callbacks.expired = opts['expired-callback'];
                  return 'wid-1';
                }
              };
            </script>
          `,
        });
      });
      await page.goto('https://codeforces.com/contest/1/submit');

      // Test deduplication when orchestrated solver fails (Capzy called once inside orchestrator, NOT 3 times)
      initCPSolverConfig({ url: '' });
      initCapzyKeys(['capzy_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4'], 0);
      vi.stubEnv('CPSOLVER_URL', '');
      vi.stubEnv('MAX_CAPZY_ATTEMPTS', '1');
      vi.stubEnv('CAPZY_RETRY_DELAY_MS', '0');
      let capzyCalls = 0;
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.includes('api.capzy.ai/createTask')) {
          capzyCalls++;
          return new Response(JSON.stringify({ errorId: 1, errorCode: 'ERROR_BAD_DATA', errorDescription: 'bad' }), { status: 400 });
        }
        return new Response('{}', { status: 404 });
      }));

      await expect(ensureFormTurnstile(page, 1_800)).rejects.toMatchObject({ kind: 'blocked' });
      expect(capzyCalls).toBe(1);

      // Verify expired-callback was registered and callback overwrites stale value
      await page.evaluate(() => {
        (document.querySelector('input[name="turnstileToken"]') as HTMLInputElement).value = 'stale-tok';
        (window as any).__callbacks.expired();
      });
      expect(await page.locator('input[name="turnstileToken"]').inputValue()).toBe('');

      await page.evaluate(() => {
        (document.querySelector('input[name="turnstileToken"]') as HTMLInputElement).value = 'expired-token-123';
        (window as any).__callbacks.callback('fresh-token-456');
      });
      expect(await page.locator('input[name="turnstileToken"]').inputValue()).toBe('fresh-token-456');
      expect(await page.locator('input[name="cf-turnstile-response"]').inputValue()).toBe('fresh-token-456');

      // Verify background solver is aborted quickly when native token arrives
      await page.evaluate(() => {
        (document.querySelector('input[name="turnstileToken"]') as HTMLInputElement).value = '';
        (document.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement).value = '';
      });
      vi.stubEnv('CPSOLVER_URL', 'https://slow-solver.example');
      let solverAborted = false;
      vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          solverAborted = true;
          reject(new DOMException('Aborted', 'AbortError'));
        });
      })));
      setTimeout(() => {
        void page.evaluate(() => {
          (document.querySelector('input[name="turnstileToken"]') as HTMLInputElement).value = 'native-fast-token-123456';
        }).catch(() => {});
      }, 150);
      const tStart = Date.now();
      expect(await ensureFormTurnstile(page, 10_000)).toEqual({ turnstile: true, interactive: false });
      expect(Date.now() - tStart).toBeLessThan(3_000);
      expect(solverAborted).toBe(true);
    } finally {
      await page.close();
      await browser.close();
    }
  });

  it('detects failed redirect requests via redirectedFrom() chain in clickSubmitForm', async () => {
    let server: Server;
    let origin = '';
    server = createServer((req, res) => {
      if (req.method === 'POST') {
        res.statusCode = 302;
        res.setHeader('location', '/contest/1/my');
        res.end();
        return;
      }
      if (req.url === '/contest/1/my') {
        req.socket.destroy();
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end(`
        <form id="solution" action="${origin}/contest/1/submit" method="post">
          <textarea name="source">int main(){}</textarea>
          <input type="hidden" name="turnstileToken" value="verified">
          <input type="submit" value="Submit">
        </form>
      `);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://codeforces.com:${(server.address() as AddressInfo).port}`;
    const browser = await chromium.launch({
      headless: true,
      args: ['--host-resolver-rules=MAP codeforces.com 127.0.0.1', '--no-proxy-server'],
    });
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/contest/1/submit`);
      const started = Date.now();
      await expect(clickSubmitForm(page, 15_000)).rejects.toMatchObject({
        kind: 'submission-error',
        clicked: true,
        message: expect.stringContaining('Codeforces POST failed'),
      });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await page.close();
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('auth.ts verification and worker.ts accountId resolution', () => {
  it('never treats sidebar profile link or anonymous JSESSIONID/39ce7 as authenticated', async () => {
    const { detectCodeforcesHandle } = await import('../src/codeforces/auth');
    const browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <div class="lang-chooser"><a href="/enter">Enter</a> | <a href="/register">Register</a></div>
        <div class="menu-box"><a href="/profile/tourist">tourist</a></div>
        <meta name="X-User-Sha1" content="">
      `);
      expect(await detectCodeforcesHandle(page)).toBeNull();

      await page.setContent(`
        <div class="lang-chooser"><a href="/profile/me_user">me_user</a> | <a href="/abc/logout">Logout</a></div>
      `);
      expect(await detectCodeforcesHandle(page)).toBe('me_user');

      await page.setContent(`
        <meta name="X-User" content="meta_handle">
      `);
      expect(await detectCodeforcesHandle(page)).toBe('meta_handle');
    } finally {
      await page.close();
      await browser.close();
    }
  });

  it('includes accountId on outcomes and passes activeProxy + CODEFORCES_ATTEMPT_MS on post-Capzy retry', async () => {
    vi.resetModules();
    const { CODEFORCES_ATTEMPT_MS } = await import('../src/codeforces/attempts');
    const solveCfSpy = vi.fn(async () => ({ cookies: { cf_clearance: 'cleared_tok_12345' } }));
    const remoteSubmitSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        kind: 'blocked',
        clicked: false,
        safeToRetry: false,
        error: 'Cloudflare challenge did not clear',
        submittedAt: 1,
        transport: 'isolated browser',
      })
      .mockResolvedValueOnce({
        ok: true,
        clicked: true,
        submittedAt: 2,
        transport: 'isolated browser',
      });

    vi.doMock('../src/database/models', () => ({
      getSystemState: vi.fn(async (key: string) => (key.startsWith('question-order:') ? null : 'proxy')),
      setSystemState: vi.fn(async () => {}),
      SystemKeys: {
        codeforcesNetworkMode: 'route',
        codeforcesDailyState: 'cfDaily',
      },
    }));
    vi.doMock('../src/codeforces/storage', () => {
      const rows = [
        { id: 'acc-1', label: 'l1', username: 'u1', status: 'ACTIVE', storageState: '{}' },
      ];
      return {
        listCodeforcesAccounts: vi.fn(async () => rows),
        listCodeforcesAccountSummaries: vi.fn(async () => rows),
        listCodeforcesAccountIds: vi.fn(async () => ['acc-1']),
        getCodeforcesAccountById: vi.fn(async () => rows[0]),
        parseStoredCodeforcesState: vi.fn(() => ({ ok: true, state: { cookies: [], origins: [] } })),
        getCodeforcesProgress: vi.fn(async () => ({ nextKey: '1A', lastCompletedKey: null })),
        claimDailyAttempt: vi.fn(async () => true),
        releaseDailyAttempt: vi.fn(async () => {}),
        recordAttempt: vi.fn(async () => {}),
        completeCurrentProblem: vi.fn(async () => {}),
        patchCodeforcesAccount: vi.fn(async () => {}),
      };
    });
    vi.doMock('../src/codeforces/sourceRepo', () => ({
      loadRuntimeSourceIndex: vi.fn(async () => ({
        queue: [{ key: '1A', contestId: 1, problemIndex: 'A', language: 'cpp', problemUrl: 'https://codeforces.com/contest/1/problem/A' }],
      })),
      fetchSourceCode: vi.fn(async () => 'int main(){}'),
    }));
    vi.doMock('../src/codeforces/api', () => ({ fetchSolvedProblemKeys: vi.fn(async () => new Set()) }));
    vi.doMock('../src/codeforces/submission', () => ({
      captureBefore: vi.fn(async () => new Set()),
      pollForVerdict: vi.fn(async () => ({ id: 555, verdict: 'OK' })),
    }));
    vi.doMock('../src/codeforces/remoteSubmitter', () => ({
      isRemoteSubmitterConfigured: () => true,
      notifyProxyInUse: vi.fn(async () => null),
      submitViaRemoteSubmitter: remoteSubmitSpy,
    }));
    vi.doMock('../src/codeforces/proxyManager', () => ({
      resolveActiveProxy: vi.fn(async () => ({ url: 'http://u:p@active.proxy:8080', host: 'active.proxy:8080', username: 'u', fromPreferred: false, fallbackOccurred: false })),
    }));
    vi.doMock('../src/codeforces/captchaSolver', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/codeforces/captchaSolver')>();
      return {
        ...actual,
        solveCloudflareWithCapzy: solveCfSpy,
      };
    });
    vi.doMock('../src/notifications/telegram', () => ({
      sendTelegramMessage: vi.fn(async () => true),
    }));

    const { runCodeforcesNow } = await import('../src/codeforces/worker');
    const beforeCall = Date.now();
    const report = await runCodeforcesNow('manual', { forceDailyAttempt: true });
    expect(report?.accounts[0]?.accountId).toBe('acc-1');
    expect(report?.totals.solved).toBe(1);
    expect(solveCfSpy).toHaveBeenCalledWith(
      'https://codeforces.com/contest/1/problem/A',
      'http://u:p@active.proxy:8080',
      undefined,
      60_000,
    );
    const retryOptions = remoteSubmitSpy.mock.calls[1]?.[6] as { deadline?: number };
    expect(retryOptions.deadline).toBeGreaterThan(beforeCall + CODEFORCES_ATTEMPT_MS - 10_000);

    vi.doUnmock('../src/database/models');
    vi.doUnmock('../src/codeforces/storage');
    vi.doUnmock('../src/codeforces/sourceRepo');
    vi.doUnmock('../src/codeforces/api');
    vi.doUnmock('../src/codeforces/submission');
    vi.doUnmock('../src/codeforces/remoteSubmitter');
    vi.doUnmock('../src/codeforces/proxyManager');
    vi.doUnmock('../src/codeforces/captchaSolver');
    vi.doUnmock('../src/notifications/telegram');
  });
});
