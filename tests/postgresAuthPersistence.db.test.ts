import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { chromium, request, type Browser } from 'playwright';
import { AccountStatus, RecoveryStatus } from '@prisma/client';

const DB = process.env.TEST_DATABASE_URL;
const suite = DB ? describe : describe.skip;
if (DB) process.env.DATABASE_URL = DB;

const TEST_LABELS = ['pg_auth_test_1', 'pg_auth_test_2'] as const;

suite('PostgreSQL Real Persistence, Process-Restart Restore & Recovery Lifecycle', async () => {
  const { prisma } = await import('../src/database/prisma');
  const { getAccountByLabel, parseStoredStorageState, saveAccount } = await import('../src/database/accounts');
  const { PrismaRecoveryStore } = await import('../src/recovery/prismaStore');
  const { getRecoveryService, setRecoveryServiceForTests } = await import('../src/recovery/runtime');
  const { initCapzyKeys } = await import('../src/codeforces/capzyKeyManager');
  const proxyMgr = await import('../src/codeforces/proxyManager');
  const bot = await import('../src/notifications/telegramBot');

  let fixture: https.Server;
  let proxy: http.Server;
  let proxyUrl = '';
  const sockets = new Set<net.Socket>();
  let capzyBehavior: 'solve' | 'zero_balance' = 'solve';
  let transientGraphqlErrors = 0;

  async function cleanupScopedRows() {
    await prisma.accountRecovery.deleteMany({
      where: { account: { label: { in: [...TEST_LABELS] } } },
    });
    await prisma.account.deleteMany({
      where: { label: { in: [...TEST_LABELS] } },
    });
    for (const lbl of TEST_LABELS) {
      await prisma.systemState.deleteMany({
        where: {
          OR: [
            { key: `leetcode_login_cooldown_${lbl}` },
            { key: `creds:leetcode:${lbl}` },
          ],
        },
      });
    }
    const idxRow = await prisma.systemState.findUnique({ where: { key: 'creds:leetcode:_index' } });
    if (idxRow) {
      try {
        const arr = JSON.parse(idxRow.value);
        if (Array.isArray(arr)) {
          const next = arr.filter((x: unknown) => !TEST_LABELS.includes(String(x) as any));
          if (next.length === 0) {
            await prisma.systemState.delete({ where: { key: 'creds:leetcode:_index' } });
          } else {
            await prisma.systemState.update({ where: { key: 'creds:leetcode:_index' }, data: { value: JSON.stringify(next) } });
          }
        }
      } catch {}
    }
  }

  beforeAll(async () => {
    await prisma.$connect();
    await cleanupScopedRows();

    fixture = https.createServer(
      {
        key: readFileSync(new URL('./fixtures/auth/key.pem', import.meta.url)),
        cert: readFileSync(new URL('./fixtures/auth/cert.pem', import.meta.url)),
      },
      (req, res) => {
        if (req.url?.startsWith('/graphql')) {
          if (transientGraphqlErrors > 0) {
            transientGraphqlErrors -= 1;
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            return res.end('Bad Gateway');
          }
          const cookie = req.headers.cookie || '';
          const ok = cookie.includes('LEETCODE_SESSION=pg_sess_valid') && req.headers['x-csrftoken'] === 'pg_csrf';
          res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify({
            data: { userStatus: { isSignedIn: ok, username: ok ? 'pg_auth_test_1' : null } },
          }));
        }

        if (req.url?.startsWith('/accounts/login') && req.method === 'POST') {
          res.setHeader('Set-Cookie', [
            'LEETCODE_SESSION=pg_sess_valid; Path=/; Secure; HttpOnly',
            'csrftoken=pg_csrf; Path=/; Secure',
          ]);
          res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify({ ok: true }));
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
                <input type="hidden" name="cf-turnstile-response" id="cf-chl-widget-pg_response">
              </div>
              <div class="w-full">
                <button id="signin_btn" data-cy="sign-in-btn" type="button" disabled>Sign In</button>
              </div>
              <script>
                window.turnstile = {
                  render: function(_el, params) { if (params && params.callback) window.__cb = params.callback; }
                };
                window.turnstile.render('#cf-turnstile', {
                  sitekey: '0x4AAAAAAAQrSHUTor4iGTpW',
                  callback: function(tok) {
                    var inp = document.getElementById('cf-chl-widget-pg_response');
                    if (inp) inp.value = tok;
                    document.getElementById('signin_btn').disabled = false;
                  }
                });
                document.getElementById('signin_btn').addEventListener('click', function() {
                  fetch('/accounts/login/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
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

  afterEach(async () => {
    setRecoveryServiceForTests(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await cleanupScopedRows();
  });

  afterAll(async () => {
    for (const s of sockets) s.destroy();
    await Promise.all([
      new Promise<void>(r => proxy.close(() => r())),
      new Promise<void>(r => fixture.close(() => r())),
    ]);
    await prisma.$disconnect();
  });

  function installRuntimeStubs() {
    delete process.env.CPSOLVER_URL;
    process.env.CAPZY_API_KEY = 'capzy_pg_integ_key_0000';
    initCapzyKeys(['capzy_pg_integ_key_0000'], 0);
    capzyBehavior = 'solve';
    transientGraphqlErrors = 0;

    vi.spyOn(proxyMgr, 'resolveLeetCodeResidentialProxy').mockResolvedValue({
      proxy: { index: 1, url: proxyUrl, masked: proxyUrl, hash: 'pg', isRemoved: false, isCustom: true, isPreferred: true },
      url: proxyUrl,
      host: new URL(proxyUrl).host,
      fromPreferred: true,
      fallbackOccurred: false,
    });

    const launch = chromium.launch.bind(chromium);
    const newRequest = request.newContext.bind(request);
    vi.spyOn(chromium, 'launch').mockImplementation(async options => {
      const browser: Browser = await launch(options);
      const newContext = browser.newContext.bind(browser);
      vi.spyOn(browser, 'newContext').mockImplementation(opts => newContext({ ...opts, ignoreHTTPSErrors: true }));
      return browser;
    });
    vi.spyOn(request, 'newContext').mockImplementation(opts => newRequest({ ...opts, ignoreHTTPSErrors: true }));

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://api.telegram.org/')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === 'https://api.capzy.ai/createTask') {
        if (capzyBehavior === 'zero_balance') {
          return new Response(JSON.stringify({ errorId: 1, errorCode: 'ERROR_ZERO_BALANCE', errorDescription: 'Zero balance' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ errorId: 0, taskId: 'pg-task-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === 'https://api.capzy.ai/getTaskResult') {
        return new Response(JSON.stringify({ errorId: 0, status: 'ready', solution: { token: 'pg_valid_turnstile_tok_1' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    }));
  }

  it('persists authenticated session to PostgreSQL, restores in a cold process, and executes authenticated GraphQL requests', async () => {
    installRuntimeStubs();
    const replies: string[] = [];
    await bot.handleExecuteLogin('leetcode', 'pg_auth_test_1', 'pg_auth_test_1', 'pg-secret-pw', async (t) => {
      replies.push(t);
    });

    const persisted = await getAccountByLabel('pg_auth_test_1');
    expect(persisted).not.toBeNull();
    expect(persisted?.status).toBe(AccountStatus.ACTIVE);
    expect(persisted?.username).toBe('pg_auth_test_1');
    const parsedState = parseStoredStorageState(persisted!.storageState);
    expect(parsedState.ok).toBe(true);
    if (parsedState.ok) {
      expect(parsedState.state.transport?.proxyUrl).toBe(proxyUrl);
      expect(parsedState.state.cookies.some(c => c.name === 'LEETCODE_SESSION' && c.value === 'pg_sess_valid')).toBe(true);
    }
    expect(replies.at(-1)).toContain('LeetCode Login Successful');

    // Fresh Node child process reads directly from PostgreSQL and executes GraphQL userStatus
    const childOut = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          '-e',
          `
          const { request } = require('playwright');
          const origNewCtx = request.newContext.bind(request);
          request.newContext = (opts) => origNewCtx({ ...opts, ignoreHTTPSErrors: true });
          const { prisma } = require('./src/database/prisma.ts');
          const { getAccountByLabel, parseStoredStorageState } = require('./src/database/accounts.ts');
          const { openLightweightLeetCodeSession } = require('./src/leetcode/sessionManager.ts');
          const { checkSession } = require('./src/browser/sessionCheck.ts');
          (async () => {
            const acc = await getAccountByLabel('pg_auth_test_1');
            const parsed = parseStoredStorageState(acc.storageState);
            const session = await openLightweightLeetCodeSession(parsed.state);
            try {
              const res = await checkSession(session.api);
              console.log('PG_RESTORE:' + JSON.stringify({ status: acc.status, username: acc.username, check: res }));
            } finally {
              await session.close();
              await prisma.$disconnect();
            }
          })();`,
        ],
        { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: DB, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      let err = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve(out) : reject(new Error(`child exit ${code}: ${err}`)));
    });

    expect(childOut).toContain('PG_RESTORE:{"status":"ACTIVE","username":"pg_auth_test_1","check":{"authenticated":true,"username":"pg_auth_test_1"}}');

    // Confirm subsequent Telegram login reuses stored session without launching browser
    const reuseReplies: string[] = [];
    await bot.handleLeetCodeLoginCommand('pg_auth_test_1', async (t) => { reuseReplies.push(t); });
    expect(reuseReplies.join('\n')).toContain('Account Already Authenticated on Server');
  }, 30_000);

  it('persists AccountRecovery rows on verification failure without destroying a pre-existing valid ACTIVE session', async () => {
    installRuntimeStubs();
    capzyBehavior = 'zero_balance';
    // Cover both handleExecuteLogin (2 attempts) and RecoveryService.requestRecovery (3 attempts)
    transientGraphqlErrors = 5;

    const existingRow = await saveAccount(
      'pg_auth_test_2',
      JSON.stringify({
        cookies: [{
          name: 'LEETCODE_SESSION',
          value: 'pg_existing_valid_cookie',
          domain: '.leetcode.com',
          path: '/',
          expires: Math.floor(Date.now() / 1000) + 86400,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        }],
        origins: [],
        transport: { proxyUrl },
      }),
      { username: 'pg_auth_test_2', status: AccountStatus.ACTIVE },
    );

    const recStore = new PrismaRecoveryStore();
    getRecoveryService();
    const replies: string[] = [];
    await bot.handleExecuteLogin('leetcode', 'pg_auth_test_2', 'pg_auth_test_2', 'pw-pg-2', async (t) => {
      replies.push(t);
    });

    // Transient GraphQL failure + failed verification must NOT overwrite valid ACTIVE session
    const afterTransient = await getAccountByLabel('pg_auth_test_2');
    expect(afterTransient?.status).toBe(AccountStatus.ACTIVE);
    expect(afterTransient?.storageState).toContain('pg_existing_valid_cookie');

    // Now simulate confirmed signed-out session -> opens persistent AccountRecovery row
    initCapzyKeys(['capzy_pg_integ_key_0000'], 0);
    transientGraphqlErrors = 0;
    await bot.handleExecuteLogin('leetcode', 'pg_auth_test_2', 'pg_auth_test_2', 'pw-pg-2', async (t) => {
      replies.push(t);
    });

    const openRecovery = await recStore.findOpenByAccount(existingRow.id);
    expect(openRecovery).not.toBeNull();
    expect(openRecovery?.status).toBe(RecoveryStatus.RECOVERY_PENDING);
    expect(openRecovery?.reason).toBe('VERIFICATION_REQUIRED');

    // Exercise PrismaRecoveryStore token lifecycle directly against real PostgreSQL
    await recStore.issueToken(openRecovery!.id, 'hash_pg_test_1', new Date(Date.now() + 60_000));
    const consumed = await recStore.consumeToken('hash_pg_test_1', new Date());
    expect(consumed.ok).toBe(true);
    if (consumed.ok) {
      expect(consumed.recovery.id).toBe(openRecovery!.id);
    }
    await recStore.markFailed(openRecovery!.id, 'TEST_CLEANUP', 'test_cleanup', new Date());
  }, 30_000);
});
