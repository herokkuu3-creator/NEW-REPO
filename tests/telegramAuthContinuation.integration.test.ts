import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { chromium, request, type Browser } from 'playwright';
import { AccountStatus } from '@prisma/client';

interface InMemoryAccountRow {
  id: string;
  label: string;
  username: string | null;
  status: AccountStatus;
  storageState: string;
  lastError: string | null;
  checkedAt: Date | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const accountMap = new Map<string, InMemoryAccountRow>();
const systemStateMap = new Map<string, string>();
let accountSeq = 0;

vi.mock('../src/database/accounts', async (original) => {
  const actual = await original() as typeof import('../src/database/accounts');
  return {
    ...actual,
    listAccounts: vi.fn(async () => Array.from(accountMap.values())),
    listEnabledAccounts: vi.fn(async () => Array.from(accountMap.values()).filter(a => a.enabled)),
    getAccountById: vi.fn(async (id: string) => {
      for (const acc of accountMap.values()) {
        if (acc.id === id) return acc;
      }
      return null;
    }),
    getAccountByLabel: vi.fn(async (label: string) => accountMap.get(label) ?? null),
    saveAccount: vi.fn(async (label: string, storageState: string, opts: { username?: string | null; status?: AccountStatus; lastError?: string | null } = {}) => {
      const existing = accountMap.get(label);
      const now = new Date();
      const row: InMemoryAccountRow = existing
        ? {
            ...existing,
            storageState,
            username: opts.username !== undefined ? opts.username : existing.username,
            status: opts.status ?? existing.status,
            lastError: opts.lastError !== undefined ? opts.lastError : existing.lastError,
            updatedAt: now,
          }
        : {
            id: `acct-${++accountSeq}`,
            label,
            username: opts.username ?? null,
            status: opts.status ?? AccountStatus.UNKNOWN,
            storageState,
            lastError: opts.lastError ?? null,
            checkedAt: null,
            enabled: true,
            createdAt: now,
            updatedAt: now,
          };
      accountMap.set(label, row);
      return row;
    }),
    patchAccount: vi.fn(async (id: string, patch: { status?: AccountStatus; lastError?: string | null; storageState?: string; username?: string | null; checked?: boolean }) => {
      for (const [label, acc] of accountMap.entries()) {
        if (acc.id === id) {
          const updated: InMemoryAccountRow = {
            ...acc,
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
            ...(patch.storageState !== undefined ? { storageState: patch.storageState } : {}),
            ...(patch.username !== undefined ? { username: patch.username } : {}),
            ...(patch.checked ? { checkedAt: new Date() } : {}),
            updatedAt: new Date(),
          };
          accountMap.set(label, updated);
          return updated;
        }
      }
      return null;
    }),
  };
});

vi.mock('../src/database/models', async (original) => {
  const actual = await original() as typeof import('../src/database/models');
  return {
    ...actual,
    getSystemState: vi.fn(async (key: string) => systemStateMap.get(key) ?? null),
    setSystemState: vi.fn(async (key: string, value: string) => {
      systemStateMap.set(key, value);
    }),
    deleteSystemState: vi.fn(async (key: string) => {
      systemStateMap.delete(key);
    }),
    getAllSystemState: vi.fn(async () => Array.from(systemStateMap.entries()).map(([key, value]) => ({ key, value, updatedAt: new Date() }))),
  };
});

describe('Telegram /lclogin Retry Wiring & Authentication Continuation Integration', () => {
  let fixture: https.Server;
  let proxy: http.Server;
  let proxyUrl = '';
  const sockets = new Set<net.Socket>();

  let serveInterstitialOnce = false;
  let expectedTurnstileToken = 'valid_turnstile_tok';
  let expectedUsername = 'black_sheep_7';
  let transientGraphqlErrorCount = 0;

  interface CapzyEvent {
    at: number;
    endpoint: string;
    taskType?: string;
    sitekey?: string;
  }

  let capzyCreateHandler: (payload: any, seq: number) => { status?: number; body: any };
  let capzyResultHandler: (taskId: string, seq: number) => { status?: number; body: any };
  let capzyEvents: CapzyEvent[] = [];
  let inFlightCapzy = 0;
  let maxConcurrentCapzy = 0;
  let tgMessages: Array<{ method: string; text: string }> = [];

  beforeAll(async () => {
    fixture = https.createServer(
      {
        key: readFileSync(new URL('./fixtures/auth/key.pem', import.meta.url)),
        cert: readFileSync(new URL('./fixtures/auth/cert.pem', import.meta.url)),
      },
      (req, res) => {
        if (req.url?.startsWith('/graphql')) {
          if (transientGraphqlErrorCount > 0) {
            transientGraphqlErrorCount -= 1;
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            return res.end('Bad Gateway');
          }
          const cookie = req.headers.cookie || '';
          const ok = cookie.includes(`LEETCODE_SESSION=sess_${expectedUsername}`) && req.headers['x-csrftoken'] === 'csrf_integ';
          res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify({
            data: { userStatus: { isSignedIn: ok, username: ok ? expectedUsername : null } },
          }));
        }

        if (req.url?.startsWith('/accounts/login') && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            try {
              const parsed = JSON.parse(body || '{}');
              if (parsed.turnstile === expectedTurnstileToken) {
                res.setHeader('Set-Cookie', [
                  `LEETCODE_SESSION=sess_${expectedUsername}; Path=/; Secure; HttpOnly`,
                  'csrftoken=csrf_integ; Path=/; Secure',
                ]);
                res.setHeader('Content-Type', 'application/json');
                return res.end(JSON.stringify({ ok: true }));
              }
            } catch {}
            res.writeHead(403, { 'Content-Type': 'text/html' });
            return res.end('<title>Just a moment...</title><div id="challenge-running">Verification Required</div>');
          });
          return;
        }

        if (serveInterstitialOnce) {
          serveInterstitialOnce = false;
          res.writeHead(403, { 'Content-Type': 'text/html' });
          return res.end('<html><head><title>Just a moment...</title></head><body><div id="challenge-running">Checking browser</div></body></html>');
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body>
              <form class="flex flex-col">
                <input id="id_login" name="username">
                <input id="id_password" name="password" type="password">
              </form>
              <div id="cf-turnstile" style="display:block;">
                <div class="cf-turnstile" data-sitekey="0x4AAAAAAAQrSHUTor4iGTpW"></div>
                <input type="hidden" name="cf-turnstile-response" id="cf-chl-widget-integ_response">
              </div>
              <div class="w-full">
                <button id="signin_btn" data-cy="sign-in-btn" type="button" disabled>Sign In</button>
              </div>
              <script>
                window.turnstile = {
                  render: function(_el, params) {
                    if (params && params.callback) window.__cb = params.callback;
                  }
                };
                window.turnstile.render('#cf-turnstile', {
                  sitekey: '0x4AAAAAAAQrSHUTor4iGTpW',
                  callback: function(tok) {
                    var inp = document.getElementById('cf-chl-widget-integ_response');
                    if (inp) inp.value = tok;
                    document.getElementById('signin_btn').disabled = false;
                  }
                });
                document.getElementById('signin_btn').addEventListener('click', function() {
                  var inp = document.getElementById('cf-chl-widget-integ_response');
                  fetch('/accounts/login/', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      username: document.getElementById('id_login').value,
                      password: document.getElementById('id_password').value,
                      turnstile: inp ? inp.value : ''
                    })
                  });
                });
              </script>
            </body>
          </html>
        `);
      },
    );

    await new Promise<void>(r => fixture.listen(0, '127.0.0.1', r));
    const fixturePort = (fixture.address() as net.AddressInfo).port;

    proxy = http.createServer((_q, r) => { r.writeHead(403); r.end(); });
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
    await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
    proxyUrl = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const s of sockets) s.destroy();
    await Promise.all([
      new Promise<void>(r => proxy.close(() => r())),
      new Promise<void>(r => fixture.close(() => r())),
    ]);
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    accountMap.clear();
    systemStateMap.clear();
    accountSeq = 0;
    capzyEvents = [];
    inFlightCapzy = 0;
    maxConcurrentCapzy = 0;
    tgMessages = [];
    serveInterstitialOnce = false;
    expectedTurnstileToken = 'valid_turnstile_tok';
    expectedUsername = 'black_sheep_7';
    transientGraphqlErrorCount = 0;

    delete process.env.CPSOLVER_URL;
    process.env.CAPZY_API_KEY = 'capzy_integ_test_key_0000';
    process.env.CAPZY_RETRY_DELAY_MS = '25';
    const { initCapzyKeys } = await import('../src/codeforces/capzyKeyManager');
    initCapzyKeys(['capzy_integ_test_key_0000'], 0);

    const { config } = await import('../src/config');
    (config.telegram as any).chatId = 'integ-chat';
    (config.telegram as any).botToken = '123456:integ_bot_token';
    (config.telegram as any).enabled = true;

    const proxyMgr = await import('../src/codeforces/proxyManager');
    vi.spyOn(proxyMgr, 'resolveLeetCodeResidentialProxy').mockResolvedValue({
      proxy: { index: 1, url: proxyUrl, masked: proxyUrl, hash: 'integ', isRemoved: false, isCustom: true, isPreferred: true },
      url: proxyUrl,
      host: new URL(proxyUrl).host,
      fromPreferred: true,
      fallbackOccurred: false,
    });

    const launch = chromium.launch.bind(chromium);
    const newRequest = request.newContext.bind(request);
    vi.spyOn(chromium, 'launch').mockImplementation(async (options) => {
      const browser: Browser = await launch(options);
      const newContext = browser.newContext.bind(browser);
      vi.spyOn(browser, 'newContext').mockImplementation(opts => newContext({ ...opts, ignoreHTTPSErrors: true }));
      return browser;
    });
    vi.spyOn(request, 'newContext').mockImplementation(opts => newRequest({ ...opts, ignoreHTTPSErrors: true }));

    let createSeq = 0;
    let resultSeq = 0;
    capzyCreateHandler = () => ({ body: { errorId: 0, taskId: `task-${++createSeq}` } });
    capzyResultHandler = () => ({ body: { errorId: 0, status: 'ready', solution: { token: expectedTurnstileToken } } });

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://api.telegram.org/')) {
        const method = url.split('/').pop() || 'unknown';
        let body: any = {};
        try { if (typeof init?.body === 'string') body = JSON.parse(init.body); } catch {}
        tgMessages.push({ method, text: String(body.text || '') });
        return new Response(JSON.stringify({ ok: true, result: { message_id: tgMessages.length } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === 'https://api.capzy.ai/createTask') {
        inFlightCapzy += 1;
        maxConcurrentCapzy = Math.max(maxConcurrentCapzy, inFlightCapzy);
        try {
          const payload = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
          createSeq += 1;
          capzyEvents.push({
            at: Date.now(),
            endpoint: '/createTask',
            taskType: payload?.task?.type,
            sitekey: payload?.task?.websiteKey,
          });
          const out = capzyCreateHandler(payload, createSeq);
          return new Response(JSON.stringify(out.body), {
            status: out.status ?? 200,
            headers: { 'Content-Type': 'application/json' },
          });
        } finally {
          inFlightCapzy -= 1;
        }
      }

      if (url === 'https://api.capzy.ai/getTaskResult') {
        const payload = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
        resultSeq += 1;
        capzyEvents.push({ at: Date.now(), endpoint: '/getTaskResult' });
        const out = capzyResultHandler(String(payload.taskId || ''), resultSeq);
        return new Response(JSON.stringify(out.body), {
          status: out.status ?? 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ ok: false }), { status: 404 });
    }));

    const bot = await import('../src/notifications/telegramBot');
    bot.setActiveLoginPrompt(null);
    bot.setPendingRenewalLabel(undefined);
    bot.setPendingLeetCodeVerificationHandoff(null);
    const { setRecoveryServiceForTests } = await import('../src/recovery/runtime');
    setRecoveryServiceForTests(null);
  });

  afterEach(() => {
    delete process.env.CAPZY_RETRY_DELAY_MS;
    vi.unstubAllGlobals();
  });

  async function driveTelegramLogin(label: string, identifier: string, password: string, terminalRegex: RegExp, timeoutMs = 25_000) {
    const bot = await import('../src/notifications/telegramBot');
    const chatId = 'integ-chat' as unknown as number;
    let seq = 0;
    await bot.handleMessage({ message_id: ++seq, chat: { id: chatId }, text: `/lclogin ${label}` });
    await bot.handleMessage({ message_id: ++seq, chat: { id: chatId }, text: identifier });
    await bot.handleMessage({ message_id: ++seq, chat: { id: chatId }, text: password });

    const deadline = Date.now() + timeoutMs;
    let doneAt: number | null = null;
    while (Date.now() < deadline) {
      if (tgMessages.some(m => terminalRegex.test(m.text))) {
        if (!doneAt) doneAt = Date.now();
        if (Date.now() - doneAt >= 300) return;
      }
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error(`Timed out waiting for Telegram terminal message matching ${terminalRegex}. Got: ${JSON.stringify(tgMessages)}`);
  }

  it('connects production 10s retry delay via /lclogin -> loginToLeetCode -> Capzy and completes full auth continuation on attempt 2', async () => {
    delete process.env.CAPZY_RETRY_DELAY_MS; // Exercise actual production CAPZY_RETRY_DELAY_MS = 10_000
    expectedUsername = 'black_sheep_7';
    expectedTurnstileToken = 'valid_turnstile_tok_attempt_2';

    const resultTimestamps: number[] = [];
    const createTimestamps: number[] = [];
    capzyCreateHandler = (_p, seq) => {
      createTimestamps.push(Date.now());
      return { body: { errorId: 0, taskId: `task-realdelay-${seq}` } };
    };
    capzyResultHandler = (_taskId, seq) => {
      resultTimestamps.push(Date.now());
      if (seq === 1) {
        return {
          body: {
            errorId: 1,
            errorCode: 'ERROR_CAPTCHA_UNSOLVABLE',
            errorDescription: 'Worker failed on attempt 1',
            status: 'failed',
          },
        };
      }
      return {
        body: {
          errorId: 0,
          status: 'ready',
          solution: { token: expectedTurnstileToken },
        },
      };
    };

    await driveTelegramLogin(
      'black_sheep_7',
      'black_sheep_7',
      'integ-secret-pw',
      /LeetCode Login Successful/i,
      30_000,
    );

    expect(createTimestamps).toHaveLength(2);
    // Production retry wait between attempt 1 terminal failure and attempt 2 createTask must be ~10s
    const waitBetweenAttempts = createTimestamps[1]! - resultTimestamps[0]!;
    expect(waitBetweenAttempts).toBeGreaterThanOrEqual(9_500);
    expect(maxConcurrentCapzy).toBe(1);

    const saved = accountMap.get('black_sheep_7');
    expect(saved).toBeDefined();
    expect(saved?.status).toBe(AccountStatus.ACTIVE);
    expect(saved?.username).toBe('black_sheep_7');
    expect(saved?.storageState).toContain('sess_black_sheep_7');

    const { getEncryptedCredentials } = await import('../src/security/credentialStore');
    const creds = await getEncryptedCredentials('leetcode', 'black_sheep_7');
    expect(creds).toMatchObject({ username: 'black_sheep_7', password: 'integ-secret-pw' });
  }, 35_000);

  it('does not retry permanent Capzy errors (ERROR_ZERO_BALANCE) and never marks account ACTIVE', async () => {
    capzyCreateHandler = () => ({
      body: {
        errorId: 1,
        errorCode: 'ERROR_ZERO_BALANCE',
        errorDescription: 'Insufficient balance',
        status: 'failed',
      },
    });

    await driveTelegramLogin(
      'perm_err_acct',
      'perm_err_acct',
      'pw123',
      /Manual Verification Required|Reconnect Account/i,
    );

    const creates = capzyEvents.filter(e => e.endpoint === '/createTask');
    expect(creates).toHaveLength(1);
    expect(accountMap.get('perm_err_acct')).toBeUndefined();
  }, 20_000);

  it('aborts Capzy 10s retry wait immediately when /cancel is sent via Telegram', async () => {
    delete process.env.CAPZY_RETRY_DELAY_MS; // 10s delay so /cancel definitely lands mid-wait
    let attempt1ResultAt = 0;
    capzyResultHandler = () => {
      attempt1ResultAt = Date.now();
      return {
        body: {
          errorId: 1,
          errorCode: 'ERROR_CAPTCHA_UNSOLVABLE',
          errorDescription: 'Retryable fail',
          status: 'failed',
        },
      };
    };

    const bot = await import('../src/notifications/telegramBot');
    const chatId = 'integ-chat' as unknown as number;
    let seq = 0;
    await bot.handleMessage({ message_id: ++seq, chat: { id: chatId }, text: '/lclogin cancel_acct' });
    await bot.handleMessage({ message_id: ++seq, chat: { id: chatId }, text: 'cancel_acct' });
    await bot.handleMessage({ message_id: ++seq, chat: { id: chatId }, text: 'pw_cancel' });

    // Wait for attempt 1 result to arrive and enter 10s sleep, then immediately send /cancel
    const waitDeadline = Date.now() + 10_000;
    while (!attempt1ResultAt && Date.now() < waitDeadline) {
      await new Promise(r => setTimeout(r, 40));
    }
    expect(attempt1ResultAt).toBeGreaterThan(0);

    const cancelSentAt = Date.now();
    await bot.handleMessage({ message_id: ++seq, chat: { id: chatId }, text: '/cancel' });

    const doneDeadline = Date.now() + 5_000;
    while (Date.now() < doneDeadline) {
      if (tgMessages.some(m => /Login Cancelled|LOGIN_CANCELLED|LeetCode Login Failed/i.test(m.text))) {
        break;
      }
      await new Promise(r => setTimeout(r, 40));
    }

    expect(Date.now() - cancelSentAt).toBeLessThan(3_000);
    expect(capzyEvents.filter(e => e.endpoint === '/createTask')).toHaveLength(1);
    expect(tgMessages.some(m => m.text.includes('Cancelling'))).toBe(true);
    expect(accountMap.get('cancel_acct')).toBeUndefined();
  }, 20_000);

  it('caps nested interstitial+Turnstile retries at 3 total tasks and preserves an existing ACTIVE session after failed verification', async () => {
    expectedUsername = 'existing_ok';
    accountMap.set('existing_ok', {
      id: 'existing-id',
      label: 'existing_ok',
      username: 'existing_ok',
      status: AccountStatus.ACTIVE,
      storageState: JSON.stringify({
        cookies: [{
          name: 'LEETCODE_SESSION',
          value: 'valid_existing_cookie',
          domain: '.leetcode.com',
          path: '/',
          expires: Math.floor(Date.now() / 1000) + 86400,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        }],
        origins: [],
      }),
      lastError: null,
      checkedAt: new Date(),
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Simulate transient 502 on BOTH pre-login GraphQL checks (handleLeetCodeLoginCommand x2 + handleExecuteLogin x2)
    // followed by 403 interstitial (cleared on attempt 2) -> form Turnstile (fails attempt 3)
    transientGraphqlErrorCount = 4;
    serveInterstitialOnce = true;

    const { getRecoveryService, setRecoveryServiceForTests } = await import('../src/recovery/runtime');
    const mockRecovery = {
      requestRecovery: vi.fn(async () => 'cooldown' as const),
    };
    setRecoveryServiceForTests(mockRecovery as any);
    expect(Boolean(getRecoveryService())).toBe(true);

    let callSeq = 0;
    capzyResultHandler = () => {
      callSeq += 1;
      if (callSeq === 1) {
        return { body: { errorId: 1, errorCode: 'ERROR_CAPTCHA_UNSOLVABLE', errorDescription: 'Try 1 failed', status: 'failed' } };
      }
      if (callSeq === 2) {
        // Clears interstitial on attempt 2, leaving only 1 attempt in the 3-attempt budget for the form Turnstile
        return { body: { errorId: 0, status: 'ready', solution: { cookies: { cf_clearance: 'cleared_1' } } } };
      }
      return { body: { errorId: 1, errorCode: 'ERROR_CAPTCHA_UNSOLVABLE', errorDescription: 'Try 3 failed', status: 'failed' } };
    };

    await driveTelegramLogin(
      'existing_ok',
      'existing_ok',
      'pw_existing',
      /Manual Verification Required|Reconnect Account/i,
    );

    const creates = capzyEvents.filter(e => e.endpoint === '/createTask');
    expect(creates.length).toBeLessThanOrEqual(3);
    expect(maxConcurrentCapzy).toBe(1);

    const preserved = accountMap.get('existing_ok');
    expect(preserved?.status).toBe(AccountStatus.ACTIVE);
    expect(preserved?.storageState).toContain('valid_existing_cookie');

    setRecoveryServiceForTests(null);
  }, 25_000);
});
