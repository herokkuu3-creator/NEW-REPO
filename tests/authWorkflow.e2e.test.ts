import { afterEach, expect, it, vi } from 'vitest';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { chromium, request } from 'playwright';
import { AccountStatus } from '@prisma/client';
import { openRemoteBrowser } from '../src/recovery/remoteBrowser';
import { MemoryRecoveryStore } from '../src/recovery/memoryStore';
import { RecoveryService } from '../src/recovery/service';
import { openLightweightLeetCodeSession } from '../src/leetcode/sessionManager';
import { checkSession } from '../src/browser/sessionCheck';

afterEach(() => vi.restoreAllMocks());

// Owned HTTPS fixture behind a loopback CONNECT proxy. No connection is ever
// forwarded to LeetCode. Real Chromium, HTTP, cookies and API transport;
// memory persistence and captured Telegram notifications, NOT live auth/PG.
it('recovers through human handoff, captures, commits, restores in another process, and detects expiry', async () => {
  let posts = 0, expired = false, graphChecks = 0;
  const sockets = new Set<net.Socket>();
  const fixture = https.createServer({
    key: readFileSync(new URL('./fixtures/auth/key.pem', import.meta.url)),
    cert: readFileSync(new URL('./fixtures/auth/cert.pem', import.meta.url)),
  }, (req, res) => {
    if (req.url?.startsWith('/graphql')) {
      graphChecks++;
      const authenticated = !expired && req.headers.cookie?.includes('LEETCODE_SESSION=owned-fixture-session') && req.headers['x-csrftoken'] === 'owned-csrf';
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: { userStatus: { isSignedIn: !!authenticated, username: authenticated ? 'sks7501' : null } } }));
    }
    if (req.url === '/complete-owned-verification') {
      res.setHeader('Set-Cookie', ['LEETCODE_SESSION=owned-fixture-session; Path=/; Secure; HttpOnly', 'csrftoken=owned-csrf; Path=/; Secure']);
      return res.end('done');
    }
    if (req.method === 'POST') { posts++; res.writeHead(403); return res.end('Verification required'); }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<form><input id="id_login"><input id="id_password" type="password"><button type="submit">Sign In</button></form>
      <button id="human" hidden>Complete owned fixture verification</button><script>
      document.querySelector('form').onsubmit=async e=>{e.preventDefault();await fetch('/accounts/login/',{method:'POST'});document.querySelector('#human').hidden=false;};
      document.querySelector('#human').onclick=async()=>{await fetch('/complete-owned-verification');document.body.innerHTML='Signed in';};
      </script>`);
  });
  await new Promise<void>(r => fixture.listen(0, '127.0.0.1', r));
  const fixturePort = (fixture.address() as net.AddressInfo).port;
  const proxy = http.createServer((_q, r) => { r.writeHead(403); r.end(); });
  proxy.on('connect', (req, socket, head) => {
    if (req.url !== 'leetcode.com:443') return socket.destroy();
    const upstream = net.connect(fixturePort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    sockets.add(socket); sockets.add(upstream);
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
  });
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
  const launch = chromium.launch.bind(chromium), newRequest = request.newContext.bind(request);
  vi.spyOn(chromium, 'launch').mockImplementation(async options => {
    const browser = await launch(options), newContext = browser.newContext.bind(browser);
    vi.spyOn(browser, 'newContext').mockImplementation(opts => newContext({ ...opts, ignoreHTTPSErrors: true }));
    return browser;
  });
  vi.spyOn(request, 'newContext').mockImplementation(opts => newRequest({ ...opts, ignoreHTTPSErrors: true }));
  const row = { id: 'owned-account', label: 'sks7501', username: 'sks7501', status: AccountStatus.EXPIRED, storageState: 'old-state' };
  const accounts = new Map([[row.id, row]]), store = new MemoryRecoveryStore(accounts);
  let link = '', remote: Awaited<ReturnType<typeof openRemoteBrowser>>;
  const svc = new RecoveryService({
    store, now: () => new Date(), chatId: () => 'owned-chat', baseUrl: () => 'https://portal.example.test',
    listAccounts: async () => [...accounts.values()], getAccount: async id => accounts.get(id) ?? null,
    markAccount: async (_id, status) => { row.status = status; },
    getCredentials: async () => ({ username: 'sks7501', password: 'owned-fixture-password' }),
    verifyStoredSession: async () => ({ authenticated: false, cause: 'signed-out' }),
    verifyCapturedSession: async state => {
      const session = await openLightweightLeetCodeSession(state);
      try { return await checkSession(session.api); } finally { await session.close(); }
    },
    openBrowser: async () => remote = await openRemoteBrowser({ headless: true, proxyUrl }),
    sendTelegram: async (_text, markup) => { link = (markup as any)?.inline_keyboard?.[0]?.[0]?.url ?? link; return true; },
    limits: { reminderIntervalMs: 60000, tokenTtlMs: 60000, sessionTimeoutMs: 15000, maxConcurrency: 1, pollMs: 25, finalStatusRetentionMs: 1 },
  });
  try {
    expect(await svc.requestRecovery('sks7501')).toBe('sent');
    const opened = await svc.openPortalSession(link.split('/').at(-1)!);
    expect(opened.ok).toBe(true);
    await vi.waitFor(() => expect(posts).toBe(1), { timeout: 10000 });
    await vi.waitFor(() => expect(svc.portalStatus((opened as any).secret)?.phase).toBe('awaiting_verification'));
    expect(row.storageState).toBe('old-state');
    expect(remote!.page.isClosed()).toBe(false);
    // This click is ONLY on our owned fixture, simulating the human handoff.
    await remote!.page.locator('#human').click();
    await svc.drain();
    expect(store.commits).toBe(1);
    expect(row.status).toBe(AccountStatus.ACTIVE);
    expect(posts).toBe(1);
    const state = JSON.parse(row.storageState);
    expect(state.transport.proxyUrl).toBe(proxyUrl);
    const childResult = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '-e', `
        const {request}=require('playwright'); const original=request.newContext.bind(request);
        request.newContext=opts=>original({...opts,ignoreHTTPSErrors:true});
        const {openLightweightLeetCodeSession}=require('./src/leetcode/sessionManager.ts');
        const {checkSession}=require('./src/browser/sessionCheck.ts');
        let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',async()=>{
          const s=await openLightweightLeetCodeSession(JSON.parse(input));
          try{console.log('RESULT:'+JSON.stringify(await checkSession(s.api)));}finally{await s.close();}
        });`], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test' }, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = ''; child.stdout.on('data', c => out += c); child.stderr.on('data', () => undefined);
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve(out) : reject(new Error(`child exit ${code}`)));
      child.stdin.end(row.storageState);
    });
    expect(childResult).toContain('RESULT:{"authenticated":true,"username":"sks7501"}');
    expired = true;
    const restored = await openLightweightLeetCodeSession(state);
    try { expect(await checkSession(restored.api)).toEqual({ authenticated: false, cause: 'signed-out' }); }
    finally { await restored.close(); }
    expect(graphChecks).toBeGreaterThanOrEqual(4);
  } finally {
    await svc.shutdown();
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise<void>(r => proxy.close(() => r())), new Promise<void>(r => fixture.close(() => r()))]);
  }
});
