import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { resolvePublicBaseUrl } from '../leetcode/loginHandoff';
import { buildMobileTunnelClientJs, buildTermuxSetupSh } from './mobileTunnel';
import type { EgressStatus, RecoveryService } from './service';

/**
 * Recovery portal HTTP surface.
 *
 *   GET  /auth/recover/:token             local-IP verification portal + remote fallback (read-only)
 *   GET  /auth/recover/:token/poll        live JSON status for the open portal tab
 *   POST /auth/recover/:token/bootstrap   returns target label & saved credentials for local runner
 *   POST /auth/recover/:token             accepts locally captured cookies/storageState
 *   POST /auth/recover/:token/complete    accepts locally captured cookies/storageState
 *   GET  /auth/recover/:token/launch.cmd  1-click Windows local-IP verifier launcher
 *   GET  /auth/recover/:token/script.ps1  PowerShell local-IP verifier script
 *   GET  /auth/recover/:token/script.sh   macOS/Linux shell local-IP verifier script
 *   GET  /auth/recover/userscript.user.js Tampermonkey/Violentmonkey in-browser redirect automation
 *   POST /auth/recover/:token/start       consumes the one-time token, starts the isolated
 *                                         server browser, sets an HttpOnly session cookie and
 *                                         redirects to /auth/recover/session (token leaves the URL)
 *   GET  /auth/recover/session            live viewer
 *   GET  /auth/recover/session/frame      latest JPEG frame
 *   GET  /auth/recover/session/status     JSON phase
 *   POST /auth/recover/session/input      mouse events only
 *   POST /auth/recover/session/cancel     explicit cancellation
 *
 * Nothing here logs request URLs, tokens, cookies or credentials.
 */

export const RECOVERY_COOKIE = 'rcv_session';

/** Small fixed-window limiter keyed by caller IP (in-memory is enough for one instance). */
export class WindowLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}
  allow(key: string): boolean {
    const t = this.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      if (this.hits.size > 5000) this.prune(t);
      return true;
    }
    entry.count += 1;
    return entry.count <= this.max;
  }
  private prune(t: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}

const inputSchema = z.object({
  type: z.enum(['move', 'down', 'up', 'tap', 'wheel']),
  x: z.number().finite().min(-5).max(5000),
  y: z.number().finite().min(-5).max(5000),
  deltaY: z.number().finite().optional(),
});

function isMobileRequest(req: FastifyRequest): boolean {
  const q = req.query as { mobile?: string } | undefined;
  if (q?.mobile === '1') return true;
  const b = req.body as { mobile?: unknown } | undefined;
  if (b && typeof b === 'object' && b.mobile === '1') return true;
  const ua = String(req.headers['user-agent'] ?? '');
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
}

function cookieOf(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0 && part.slice(0, idx).trim() === name) {
      const value = part.slice(idx + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return undefined;
}

function secure(reply: FastifyReply, nonce?: string): void {
  reply.header('Cache-Control', 'no-store');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('X-Robots-Tag', 'noindex, nofollow');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header(
    'Content-Security-Policy',
    `default-src 'none'; img-src 'self' blob:; connect-src 'self'; style-src 'unsafe-inline'; script-src ${nonce ? `'nonce-${nonce}'` : "'none'"}; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
  );
}

const esc = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SAFE_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

function requestOrigin(req: FastifyRequest): string {
  const protoRaw = req.headers['x-forwarded-proto'];
  const proto = (typeof protoRaw === 'string' ? protoRaw.split(',')[0]?.trim() : '') || req.protocol || 'https';
  const hostRaw = req.headers['x-forwarded-host'] ?? req.headers.host;
  const host = typeof hostRaw === 'string' ? hostRaw.split(',')[0]?.trim() : '';
  if (host && host !== 'localhost:80' && /^[A-Za-z0-9.:-]+$/.test(host)) {
    return `${proto === 'http' ? 'http' : 'https'}://${host}`;
  }
  return resolvePublicBaseUrl();
}

const PAGE_CSS = `*{box-sizing:border-box}body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:20px 16px;display:flex;justify-content:center}
main{max-width:780px;width:100%}h1{font-size:1.35rem;margin:0 0 12px}h2{font-size:1.05rem;margin:0 0 8px;color:#38bdf8}p{line-height:1.55;margin:0 0 12px}
.card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:18px;margin-bottom:16px}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin:10px 0}
button,.btn{display:inline-block;background:#2563eb;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-size:.95rem;font-weight:600;cursor:pointer;text-decoration:none}
button:hover,.btn:hover{background:#1d4ed8}button.secondary,.btn.secondary{background:#475569}button.secondary:hover,.btn.secondary:hover{background:#334155}
button:disabled{opacity:.6;cursor:not-allowed}
pre{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px 12px;overflow-x:auto;color:#4ade80;font-size:.84rem;margin:8px 0}
textarea{width:100%;min-height:110px;background:#0f172a;border:1px solid #475569;border-radius:8px;color:#f8fafc;padding:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.82rem;margin:8px 0 10px}
input[type=file]{color:#cbd5e1;font-size:.86rem;margin-bottom:6px;display:block}
summary{cursor:pointer;font-weight:600;color:#94a3b8}
#screenWrap{position:relative;display:inline-block;width:100%;max-width:1024px}
#screen{width:100%;display:block;border-radius:8px;background:#fff;touch-action:none;user-select:none;-webkit-user-select:none;cursor:pointer}
#tapDot{position:absolute;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:999px;border:3px solid #38bdf8;background:rgba(56,189,248,.3);pointer-events:none;opacity:0;transform:scale(.6);transition:opacity .28s ease,transform .28s ease}
#tapDot.on{opacity:1;transform:scale(1.15)}
#banner,.banner{padding:11px 14px;border-radius:8px;background:#0b3b8c;margin-bottom:14px;font-size:.94rem}
.banner.ok,#banner.ok{background:#14532d;border:1px solid #22c55e}.banner.bad,#banner.bad{background:#7f1d1d;border:1px solid #ef4444}
@media (max-width:600px){body{padding:10px 8px}.card{padding:14px}h1{font-size:1.18rem}}`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body><main>${body}</main></body></html>`;
}

function messagePage(title: string, text: string, ok = false): string {
  return shell(
    title,
    `<div class="card"><div class="banner ${ok ? 'ok' : ''}" style="${ok ? '' : 'display:none'}"></div><h1>${esc(title)}</h1><p>${esc(text)}</p></div>`,
  );
}

function restoredPage(label: string, username?: string | null): string {
  const who = username ? ` (${esc(username)})` : '';
  return shell(
    'LeetCode Session Restored',
    `<div class="card">
      <div class="banner ok">✅ Session Restored and Active!</div>
      <h1>Reconnect <code>${esc(label)}</code></h1>
      <p>Your LeetCode session${who} has been verified from your local IP and saved to the bot.</p>
      <p>Automated daily tasks can now resume. You can close this browser tab and check Telegram for confirmation.</p>
    </div>`,
  );
}

function formatEgressBanner(egress?: EgressStatus): { cls: string; text: string } {
  if (egress?.mode === 'mobile_tunnel') {
    return {
      cls: 'banner ok',
      text: '🟢 Phone-IP Tunnel ACTIVE — your Mobile Chrome verification routes through your own phone IP.',
    };
  }
  if (egress?.mode === 'residential_proxy') {
    return {
      cls: 'banner ok',
      text: '🟢 Residential Proxy ACTIVE — tap "Start recovery" below to verify directly in Mobile Chrome.',
    };
  }
  return {
    cls: 'banner',
    text: '📱 Mobile Chrome Ready — tap "Start recovery" below and complete only LeetCode Cloudflare verification.',
  };
}

function recoveryPortalPage(
  nonce: string,
  origin: string,
  token: string,
  label: string,
  egress?: EgressStatus,
): string {
  const recoverUrl = `${origin}/auth/recover/${token}`;
  const bootstrapUrl = `${recoverUrl}/bootstrap`;
  const completeUrl = `${recoverUrl}/complete`;
  const psCmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm '${recoverUrl}/script.ps1' | iex"`;
  const shCmd = `curl -fsSL '${recoverUrl}/script.sh' | sh`;
  const npmCmd = `npm.cmd run auth:login -- "${recoverUrl}"`;
  const hashPayload = Buffer.from(
    JSON.stringify({ token, label, origin, bootstrapUrl, completeUrl }),
    'utf8',
  ).toString('base64url');
  const egressBanner = formatEgressBanner(egress);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reconnect LeetCode account</title><style>${PAGE_CSS}</style></head><body><main>
<div class="card">
  <h1>Reconnect <code>${esc(label)}</code></h1>
  <div id="recoverStatusBanner" class="${egressBanner.cls}">${esc(egressBanner.text)}</div>
  <p>Your saved credentials and cookies are handled automatically. Just tap <b>Start recovery</b> and solve LeetCode's Cloudflare check if prompted.</p>
  <form id="startRecoveryForm" method="post" action="/auth/recover/${esc(token)}/start"><button type="submit">Start recovery</button></form>
  ${egress?.mode === 'datacenter' || !egress ? '<p style="font-size:.86rem;opacity:.82;margin-top:10px;margin-bottom:0">Using a blocked datacenter IP? Enable the one-time <b>Phone-IP Tunnel</b> below (or send <code>/mobile</code> in Telegram) so Mobile Chrome always exits through your phone IP.</p>' : ''}
</div>
<div id="local-recover-config" hidden data-token="${esc(token)}" data-label="${esc(label)}" data-origin="${esc(origin)}" data-bootstrap-url="${esc(bootstrapUrl)}" data-complete-url="${esc(completeUrl)}"></div>

<details class="card">
  <summary>Phone-IP Tunnel (One-Time Android Setup — avoids Cloudflare datacenter blocks)</summary>
  <p style="margin-top:12px">Run our tiny background tunnel once on Android (via Termux) so every Mobile Chrome recovery automatically uses your phone's IP address instead of Render's datacenter IP.</p>
  <p style="font-size:.9rem">Send <code>/mobile</code> to the Telegram bot to get your personalized 1-line Android setup command, which installs and connects <a class="btn secondary" style="padding:4px 8px;font-size:.82rem" href="/auth/recover/termux-setup.sh">termux-setup.sh</a>.</p>
</details>

<details class="card">
  <summary>Alternative: Mobile Extension Browser or Cookie Upload</summary>
  <h2 style="margin-top:12px">Browser Extension Redirect (Edge Canary / Firefox / Desktop)</h2>
  <p>Install the one-time userscript below in Tampermonkey/Violentmonkey to verify directly on <code>leetcode.com</code> and auto-sync cookies back to the bot:</p>
  <div class="actions">
    <a class="btn secondary" href="/auth/recover/userscript.user.js" target="_blank" rel="noopener">🧩 Install Userscript (One-Time)</a>
    <a class="btn" id="redirectLeetCodeBtn" href="https://leetcode.com/accounts/login/#lc_recover=${esc(hashPayload)}">🚀 Verify on LeetCode.com</a>
  </div>
  <div id="userscriptHint" style="font-size:.86rem;opacity:.8"></div>

  <h2 style="margin-top:16px">Direct Cookie / storageState Upload</h2>
  <p>Already signed in to LeetCode in another tab? Paste Cookie-Editor JSON, Playwright <code>storageState.json</code>, or <code>LEETCODE_SESSION=...; csrftoken=...</code> (or select a file):</p>
  <form id="directUploadForm">
    <input type="file" id="cookieFile" accept=".json,.txt">
    <textarea id="cookieInput" placeholder="Paste storageState JSON, Cookie-Editor JSON array, or LEETCODE_SESSION=...; csrftoken=..."></textarea>
    <button type="submit" id="directSubmitBtn">🔗 Verify &amp; Restore Session</button>
  </form>
  <div id="directStatus" class="banner" style="display:none;margin-top:12px"></div>
</details>

<details class="card">
  <summary>Desktop / Laptop Verifier (Windows, macOS, Linux)</summary>
  <p style="margin-top:12px">Optional if you happen to be on a PC/laptop:</p>
  <div class="actions">
    <a class="btn" href="/auth/recover/${esc(token)}/launch.cmd">⚡ Download &amp; Run 1-Click Verifier (.cmd)</a>
  </div>
  <pre id="psCmd">${esc(psCmd)}</pre>
  <button type="button" class="secondary" data-copy-target="psCmd">📋 Copy PowerShell Command</button>
  <pre id="shCmd">${esc(shCmd)}</pre>
  <button type="button" class="secondary" data-copy-target="shCmd">📋 Copy macOS / Linux Command</button>
  <pre id="npmCmd">${esc(npmCmd)}</pre>
  <button type="button" class="secondary" data-copy-target="npmCmd">📋 Copy Repo npm Command</button>
</details>

<script nonce="${nonce}">
(function(){
  var done=false;
  var banner=document.getElementById('recoverStatusBanner');
  var startForm=document.getElementById('startRecoveryForm');
  var isMobile=(window.matchMedia&&window.matchMedia('(pointer:coarse)').matches)||/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent||'');
  if(startForm&&isMobile){startForm.action='/auth/recover/${esc(token)}/start?mobile=1';}
  document.querySelectorAll('[data-copy-target]').forEach(function(btn){
    btn.addEventListener('click',function(){
      var target=document.getElementById(btn.getAttribute('data-copy-target'));
      if(!target)return;
      var orig=btn.textContent;
      navigator.clipboard.writeText(target.textContent||'').then(function(){
        btn.textContent='✅ Copied!';
        setTimeout(function(){btn.textContent=orig;},1800);
      }).catch(function(){});
    });
  });
  var fileInput=document.getElementById('cookieFile');
  var cookieInput=document.getElementById('cookieInput');
  var form=document.getElementById('directUploadForm');
  var submitBtn=document.getElementById('directSubmitBtn');
  var directStatus=document.getElementById('directStatus');
  fileInput.addEventListener('change',function(e){
    var f=e.target.files&&e.target.files[0];
    if(!f)return;
    f.text().then(function(txt){cookieInput.value=txt;}).catch(function(){});
  });
  form.addEventListener('submit',function(e){
    e.preventDefault();
    var raw=(cookieInput.value||'').trim();
    if(!raw){
      directStatus.style.display='block';
      directStatus.className='banner bad';
      directStatus.textContent='Please paste cookies/storageState JSON or choose a file first.';
      return;
    }
    submitBtn.disabled=true;
    submitBtn.textContent='Verifying & syncing...';
    directStatus.style.display='none';
    fetch('/auth/recover/${esc(token)}/complete',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({cookies:raw,userAgent:navigator.userAgent})
    }).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d};});}).then(function(res){
      directStatus.style.display='block';
      if(res.ok&&res.data&&res.data.ok){
        done=true;
        directStatus.className='banner ok';
        directStatus.textContent='✅ Session restored for '+(res.data.username||res.data.label)+'! Check Telegram for confirmation.';
        banner.className='banner ok';
        banner.textContent='✅ Session restored and ACTIVE! You can close this tab.';
      }else{
        directStatus.className='banner bad';
        directStatus.textContent='❌ '+((res.data&&res.data.error)||'Could not verify cookies.');
      }
    }).catch(function(){
      directStatus.style.display='block';
      directStatus.className='banner bad';
      directStatus.textContent='❌ Network error while sending cookies.';
    }).then(function(){
      submitBtn.disabled=false;
      submitBtn.textContent='🔗 Verify & Restore Session';
    });
  });
  function poll(){
    if(done)return;
    fetch('/auth/recover/${esc(token)}/poll',{cache:'no-store'}).then(function(r){return r.ok?r.json():null;}).then(function(s){
      if(!s)return;
      if(s.state==='recovered'){
        done=true;
        banner.className='banner ok';
        banner.textContent='✅ Session restored for '+(s.username||s.label||'account')+'! Check Telegram for confirmation. You can close this tab.';
      }else if(s.state==='cancelled'){
        done=true;
        banner.className='banner bad';
        banner.textContent='Recovery was cancelled.';
      }else if(s.state==='expired'){
        done=true;
        banner.className='banner bad';
        banner.textContent='This recovery link expired. Use the latest link from Telegram.';
      }else if(s.egress&&s.egress.mode){
        if(s.egress.mode==='mobile_tunnel'){
          banner.className='banner ok';
          banner.textContent='🟢 Phone-IP Tunnel ACTIVE — your Mobile Chrome verification routes through your own phone IP.';
        }else if(s.egress.mode==='residential_proxy'){
          banner.className='banner ok';
          banner.textContent='🟢 Residential Proxy ACTIVE — tap "Start recovery" below to verify directly in Mobile Chrome.';
        }
      }
    }).catch(function(){});
  }
  setInterval(poll,2000);
})();
</script></main></body></html>`;
}

function buildStandaloneRunnerJs(origin: string, token: string): string {
  const defaultUrl = `${origin}/auth/recover/${token}`;
  return `import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const recoverUrl = (process.argv[2] || ${JSON.stringify(defaultUrl)}).replace(/\\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

function findPlaywrightChrome() {
  const roots = process.platform === 'win32'
    ? [path.join(process.env.LOCALAPPDATA || '', 'ms-playwright')]
    : [path.join(os.homedir(), '.cache', 'ms-playwright'), path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')];
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse();
    for (const d of dirs) {
      const candidates = process.platform === 'win32'
        ? [path.join(root, d, 'chrome-win', 'chrome.exe'), path.join(root, d, 'chrome-win64', 'chrome.exe')]
        : process.platform === 'darwin'
          ? [path.join(root, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')]
          : [path.join(root, d, 'chrome-linux', 'chrome')];
      for (const c of candidates) if (fs.existsSync(c)) return c;
    }
  }
  return null;
}

function findBrowserExecutable() {
  const candidates = process.platform === 'win32'
    ? [
        'C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe',
        'C:\\\\Program Files (x86)\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google\\\\Chrome\\\\Application\\\\chrome.exe'),
        'C:\\\\Program Files (x86)\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe',
        'C:\\\\Program Files\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\\\Edge\\\\Application\\\\msedge.exe'),
      ]
    : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/usr/bin/microsoft-edge',
        ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return findPlaywrightChrome();
}

async function createCdpClient(port) {
  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await fetch('http://127.0.0.1:' + port + '/json/list').then((r) => r.json());
      const target = Array.isArray(list) ? list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) : null;
      if (target) { wsUrl = target.webSocketDebuggerUrl; break; }
    } catch {}
    await sleep(300);
  }
  if (!wsUrl) throw new Error('Could not connect to browser DevTools port.');
  if (typeof WebSocket !== 'function') throw new Error('Node.js 22+ is required (built-in WebSocket missing).');
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', (e) => reject(new Error('WebSocket error: ' + (e.message || 'failed'))), { once: true });
  });
  let seq = 0;
  const pending = new Map();
  const rejectAllPending = (reason) => {
    for (const p of pending.values()) {
      p.reject(new Error(reason));
    }
    pending.clear();
  };
  ws.addEventListener('close', () => rejectAllPending('CDP WebSocket closed'));
  ws.addEventListener('error', () => rejectAllPending('CDP WebSocket error'));
  ws.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
        else p.resolve(msg.result);
      }
    } catch {}
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (ws.readyState !== 1) {
        reject(new Error('CDP WebSocket closed'));
        return;
      }
      const id = ++seq;
      pending.set(id, { resolve, reject });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        pending.delete(id);
        reject(err);
      }
    });
  }
  async function evalPage(expression) {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return res && res.result ? res.result.value : undefined;
  }
  return { send, evalPage, close: () => { try { ws.close(); } catch {} } };
}

async function main() {
  console.log('Bootstrapping local-IP recovery...');
  const bootRes = await fetch(recoverUrl + '/bootstrap', { method: 'POST', signal: AbortSignal.timeout(30000) });
  const boot = await bootRes.json().catch(() => ({ ok: false }));
  if (!bootRes.ok || !boot.ok) {
    throw new Error(boot.message || boot.reason || 'Recovery link is invalid, expired, or already used.');
  }

  const exe = findBrowserExecutable();
  if (!exe) throw new Error('Could not find Chrome, Edge, or Chromium installed on this machine.');

  const safeLabel = String(boot.label || 'default').replace(/[^a-zA-Z0-9_.-]/g, '_');
  const profileDir = path.join(os.homedir(), '.leetcode-agent-profiles', safeLabel);
  fs.mkdirSync(profileDir, { recursive: true });
  const port = await findFreePort();

  console.log('Opening real browser on your local IP for account: ' + boot.label);
  const proc = spawn(exe, [
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profileDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1200,850',
    'https://leetcode.com/accounts/login/',
  ], { stdio: 'ignore', detached: false });

  let browserExited = false;
  proc.on('exit', () => { browserExited = true; });

  const cdp = await createCdpClient(port);
  await cdp.send('Network.enable');
  await cdp.send('Page.enable');

  const checkUser = async () => cdp.evalPage(\`(async () => {
    try {
      if (!location.hostname.endsWith('leetcode.com')) return null;
      const r = await fetch('https://leetcode.com/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ query: 'query { userStatus { isSignedIn username } }', variables: {} })
      });
      const j = await r.json();
      const u = j && j.data && j.data.userStatus;
      return u && u.isSignedIn ? (u.username || 'unknown') : null;
    } catch { return null; }
  })()\`).catch(() => null);

  let checkedInitial = false;
  let autoFilled = false;
  let autoSubmitted = false;
  let verifiedUser = null;
  const deadline = Date.now() + 10 * 60_000;

  console.log('Waiting for Cloudflare verification and LeetCode sign-in...');
  while (Date.now() < deadline && !browserExited) {
    await sleep(1800);
    const u = await checkUser();
    if (!checkedInitial) {
      checkedInitial = true;
      if (u && boot.expectedUsername && u.toLowerCase() !== boot.expectedUsername.toLowerCase()) {
        console.log('Cached profile signed in as ' + u + ', clearing cookies for ' + boot.expectedUsername + '...');
        await cdp.send('Network.clearBrowserCookies');
        await cdp.send('Page.navigate', { url: 'https://leetcode.com/accounts/login/' });
        continue;
      }
    }
    if (u) {
      if (!boot.expectedUsername || u.toLowerCase() === boot.expectedUsername.toLowerCase()) {
        verifiedUser = u;
        break;
      }
    }
    if (boot.credentials && (!autoFilled || !autoSubmitted)) {
      const credsJson = JSON.stringify(boot.credentials);
      const flagsJson = JSON.stringify({ autoFilled, autoSubmitted });
      const step = await cdp.evalPage('(() => {' +
        'const creds = ' + credsJson + ';' +
        'const flags = ' + flagsJson + ';' +
        'if (!location.hostname.endsWith("leetcode.com") || !location.pathname.startsWith("/accounts/login")) return { filled: false, submitted: false };' +
        'if (document.querySelector("#challenge-stage, #cf-challenge-running")) return { filled: false, submitted: false };' +
        'const userEl = document.querySelector("input#id_login, input[name=login], input[name=username], input[autocomplete=username]");' +
        'const passEl = document.querySelector("input#id_password, input[name=password], input[type=password]");' +
        'if (!userEl || !passEl || !userEl.offsetParent || !passEl.offsetParent) return { filled: false, submitted: false };' +
        'const setVal = (el, val) => {' +
        '  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");' +
        '  if (desc && desc.set) desc.set.call(el, val); else el.value = val;' +
        '  el.dispatchEvent(new Event("input", { bubbles: true }));' +
        '  el.dispatchEvent(new Event("change", { bubbles: true }));' +
        '};' +
        'let filled = flags.autoFilled;' +
        'if (!flags.autoFilled || !userEl.value || !passEl.value) {' +
        '  setVal(userEl, creds.identifier);' +
        '  setVal(passEl, creds.password);' +
        '  filled = true;' +
        '}' +
        'const cfResp = document.querySelector("input[name=cf-turnstile-response]");' +
        'const cfReady = !cfResp || (cfResp.value && cfResp.value.trim().length > 0);' +
        'const btn = document.querySelector("button#signin_btn, button[type=submit], input[type=submit]");' +
        'let submitted = flags.autoSubmitted;' +
        'if (!flags.autoSubmitted && cfReady && btn && !btn.disabled && btn.offsetParent) {' +
        '  btn.click();' +
        '  submitted = true;' +
        '}' +
        'return { filled, submitted };' +
      '})()').catch(() => ({ filled: false, submitted: false }));
      if (step && step.filled) autoFilled = true;
      if (step && step.submitted && !autoSubmitted) {
        autoSubmitted = true;
        console.log('Credentials filled and Sign In clicked. Completing sign-in...');
      }
    }
  }

  if (!verifiedUser) {
    cdp.close();
    try { proc.kill(); } catch {}
    throw new Error('Sign-in was not completed before timeout or browser closed.');
  }

  console.log('Signed in locally as ' + verifiedUser + '! Capturing cookies...');
  await sleep(1000);
  let cookieRes = await cdp.send('Network.getAllCookies');
  if (!(cookieRes.cookies || []).some((c) => c.domain && c.domain.includes('leetcode.com') && c.name === 'csrftoken')) {
    await cdp.evalPage("fetch('https://leetcode.com/api/problems/algorithms/', { credentials: 'include' }).catch(() => null)").catch(() => null);
    await sleep(500);
    cookieRes = await cdp.send('Network.getAllCookies');
  }
  const userAgent = await cdp.evalPage('navigator.userAgent').catch(() => undefined);
  const lcCookies = (cookieRes.cookies || [])
    .filter((c) => c.domain && c.domain.includes('leetcode.com'))
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      expires: typeof c.expires === 'number' && c.expires > 0 ? c.expires : -1,
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
      sameSite: c.sameSite === 'Strict' || c.sameSite === 'None' ? c.sameSite : 'Lax',
    }));

  const storageState = {
    cookies: lcCookies,
    origins: [],
    ...(userAgent ? { transport: { userAgent } } : {}),
  };

  console.log('Uploading verified session to bot...');
  const upRes = await fetch(recoverUrl + '/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storageState, localVerifiedUsername: verifiedUser, userAgent }),
    signal: AbortSignal.timeout(45000),
  });
  const upBody = await upRes.json().catch(() => ({ ok: false, error: 'HTTP ' + upRes.status }));
  if (!upRes.ok || !upBody.ok) {
    cdp.close();
    try { proc.kill(); } catch {}
    throw new Error(upBody.error || 'Server rejected session upload.');
  }

  await cdp.send('Page.navigate', { url: recoverUrl + '?completed=1' }).catch(() => undefined);
  await sleep(2500);
  cdp.close();
  try { proc.kill(); } catch {}
  console.log('SUCCESS! Session restored for ' + (upBody.username || verifiedUser) + '. Check Telegram!');
}

main().catch((err) => {
  console.error('Recovery failed:', err && err.message ? err.message : err);
  process.exit(1);
});
`;
}

function buildUserscript(): string {
  return `// ==UserScript==
// @name         LeetCode Daily Agent - Local IP Session Recovery
// @namespace    https://leetcode-daily-agent
// @version      1.0.0
// @description  Redirects recovery links to leetcode.com on your local IP, auto-fills saved credentials after Cloudflare clears, and pushes cookies back to the bot.
// @match        *://*/auth/recover/*
// @match        https://leetcode.com/*
// @grant        GM_cookie
// @grant        GM.cookie
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function() {
  'use strict';
  const KEY = 'lc_active_recovery_v1';

  function gmGet(k) {
    return typeof GM_getValue === 'function' ? Promise.resolve(GM_getValue(k, '')) : Promise.resolve('');
  }
  function gmSet(k, v) {
    if (typeof GM_setValue === 'function') GM_setValue(k, v);
  }
  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        ...opts,
        onload: (res) => resolve(res),
        onerror: (err) => reject(err),
      });
    });
  }
  function gmCookies() {
    if (typeof GM !== 'undefined' && GM.cookie && typeof GM.cookie.list === 'function') {
      return GM.cookie.list({ domain: 'leetcode.com' });
    }
    if (typeof GM_cookie !== 'undefined' && typeof GM_cookie.list === 'function') {
      return new Promise((resolve, reject) => {
        GM_cookie.list({ domain: 'leetcode.com' }, (cookies, err) => {
          if (err) reject(err);
          else resolve(cookies || []);
        });
      });
    }
    return Promise.reject(new Error('GM_cookie API unavailable (use Tampermonkey with Cookie access or the 1-Click .cmd Verifier).'));
  }

  function showToast(text, bg) {
    let el = document.getElementById('lc-agent-recovery-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'lc-agent-recovery-toast';
      el.style.cssText = 'position:fixed;top:14px;right:14px;z-index:2147483647;max-width:360px;padding:12px 16px;border-radius:10px;color:#fff;font:600 13px/1.45 system-ui,sans-serif;box-shadow:0 10px 25px rgba(0,0,0,.35);';
      document.body.appendChild(el);
    }
    el.style.background = bg || '#1d4ed8';
    el.textContent = text;
  }

  if (location.pathname.indexOf('/auth/recover/') !== -1) {
    if (location.search.indexOf('completed=1') !== -1) {
      gmSet(KEY, '');
      return;
    }
    const cfgEl = document.getElementById('local-recover-config');
    if (!cfgEl) return;
    const cfg = {
      token: cfgEl.dataset.token,
      label: cfgEl.dataset.label,
      origin: cfgEl.dataset.origin,
      bootstrapUrl: cfgEl.dataset.bootstrapUrl,
      completeUrl: cfgEl.dataset.completeUrl,
      createdAt: Date.now(),
    };
    gmSet(KEY, JSON.stringify(cfg));
    const btn = document.getElementById('redirectLeetCodeBtn');
    const hint = document.getElementById('userscriptHint');
    if (hint) hint.textContent = 'Userscript detected! Redirecting to LeetCode.com on your local IP...';
    if (btn) {
      setTimeout(() => { location.href = btn.href; }, 700);
    }
    return;
  }

  if (location.hostname === 'leetcode.com') {
    (async function runOnLeetCode() {
      let cfg = null;
      const hashMatch = /#lc_recover=([A-Za-z0-9_-]+)/.exec(location.hash || '');
      if (hashMatch) {
        try {
          let b64 = hashMatch[1].replace(/-/g, '+').replace(/_/g, '/');
          b64 += '='.repeat((4 - (b64.length % 4)) % 4);
          cfg = JSON.parse(atob(b64));
          cfg.createdAt = Date.now();
          gmSet(KEY, JSON.stringify(cfg));
        } catch {}
      }
      if (!cfg) {
        const raw = await gmGet(KEY);
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.token && Date.now() - (parsed.createdAt || 0) < 45 * 60_000) cfg = parsed;
          } catch {}
        }
      }
      if (!cfg || !cfg.bootstrapUrl || !cfg.completeUrl) return;

      showToast('🤖 Recovering LeetCode (' + (cfg.label || 'account') + ') on your local IP...', '#0b3b8c');

      let boot = null;
      try {
        const bRes = await gmRequest({ method: 'POST', url: cfg.bootstrapUrl });
        boot = JSON.parse(bRes.responseText || '{}');
      } catch {}
      if (!boot || !boot.ok) {
        showToast('Recovery link expired or already used.', '#991b1b');
        gmSet(KEY, '');
        return;
      }

      let filled = false;
      let submitted = false;
      const setVal = (el, val) => {
        const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        if (desc && desc.set) desc.set.call(el, val);
        else el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };

      const timer = setInterval(async () => {
        try {
          const gql = await fetch('https://leetcode.com/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ query: 'query { userStatus { isSignedIn username } }', variables: {} }),
          }).then((r) => r.json()).catch(() => null);
          const u = gql && gql.data && gql.data.userStatus;
          if (u && u.isSignedIn && u.username) {
            if (boot.expectedUsername && u.username.toLowerCase() !== boot.expectedUsername.toLowerCase()) {
              showToast('Signed in as ' + u.username + ' instead of ' + boot.expectedUsername + '. Please sign out and log in as ' + boot.expectedUsername + '.', '#92400e');
              return;
            }
            clearInterval(timer);
            showToast('✅ Signed in as ' + u.username + '! Syncing session to bot...', '#14532d');
            let cookies = await gmCookies();
            if (!cookies.some((c) => c.name === 'csrftoken')) {
              await fetch('https://leetcode.com/api/problems/algorithms/', { credentials: 'include' }).catch(() => null);
              cookies = await gmCookies();
            }
            const mapped = cookies.map((c) => ({
              name: c.name,
              value: c.value,
              domain: c.domain || '.leetcode.com',
              path: c.path || '/',
              expires: typeof c.expirationDate === 'number' ? c.expirationDate : -1,
              httpOnly: Boolean(c.httpOnly),
              secure: Boolean(c.secure),
              sameSite: c.sameSite === 'strict' ? 'Strict' : c.sameSite === 'no_restriction' ? 'None' : 'Lax',
            }));
            const up = await gmRequest({
              method: 'POST',
              url: cfg.completeUrl,
              headers: { 'Content-Type': 'application/json' },
              data: JSON.stringify({
                storageState: { cookies: mapped, origins: [], transport: { userAgent: navigator.userAgent } },
                localVerifiedUsername: u.username,
                userAgent: navigator.userAgent,
              }),
            });
            const body = JSON.parse(up.responseText || '{}');
            if (up.status >= 200 && up.status < 300 && body.ok) {
              gmSet(KEY, '');
              showToast('✅ Session synced! Redirecting back...', '#14532d');
              location.href = cfg.origin + '/auth/recover/' + cfg.token + '?completed=1';
            } else {
              showToast('❌ Upload failed: ' + (body.error || 'HTTP ' + up.status), '#991b1b');
            }
            return;
          }

          if (boot.credentials && location.pathname.indexOf('/accounts/login') === 0) {
            const userEl = document.querySelector('input#id_login, input[name="login"], input[name="username"], input[autocomplete="username"]');
            const passEl = document.querySelector('input#id_password, input[name="password"], input[type="password"]');
            if (userEl && passEl && userEl.offsetParent && passEl.offsetParent) {
              if (!filled || !userEl.value || !passEl.value) {
                setVal(userEl, boot.credentials.identifier);
                setVal(passEl, boot.credentials.password);
                filled = true;
              }
              const cfResp = document.querySelector('input[name="cf-turnstile-response"]');
              const cfReady = !cfResp || (cfResp.value && cfResp.value.trim().length > 0);
              const btn = document.querySelector('button#signin_btn, button[type="submit"], input[type="submit"]');
              if (cfReady && btn && !btn.disabled && !submitted) {
                submitted = true;
                btn.click();
              }
            }
          }
        } catch (err) {
          showToast('⚠️ ' + (err && err.message ? err.message : 'Recovery error'), '#991b1b');
        }
      }, 1500);
    })();
  }
})();
`;
}

function viewerPage(nonce: string, label: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><title>Reconnect LeetCode account</title><style>${PAGE_CSS}</style></head><body><main>
<h1>Reconnect <code>${esc(label)}</code></h1>
<div id="banner">Starting a secure browser…</div>
<div id="screenWrap"><img id="screen" alt="Remote browser view" draggable="false"><div id="tapDot"></div></div>
<p style="margin-top:10px"><button class="secondary" id="cancel">Cancel recovery</button></p>
<p style="font-size:.85rem;opacity:.75">Tap LeetCode's Cloudflare checkbox above when it appears. Your saved credentials and session sync happen automatically.</p>
<script nonce="${nonce}">
(function(){
  var img=document.getElementById('screen'),dot=document.getElementById('tapDot'),banner=document.getElementById('banner'),vw=430,vh=760,done=false,busy=false,last=null,lastMove=0,lastTouchAt=0,touchStart=null,q=Promise.resolve();
  function pos(cx,cy){var r=img.getBoundingClientRect();return{x:(cx-r.left)*vw/Math.max(1,r.width),y:(cy-r.top)*vh/Math.max(1,r.height)};}
  function showDot(cx,cy){var r=img.getBoundingClientRect();dot.style.left=(cx-r.left)+'px';dot.style.top=(cy-r.top)+'px';dot.classList.add('on');setTimeout(function(){dot.classList.remove('on');},280);}
  function send(ev){if(done)return;q=q.then(function(){return fetch('/auth/recover/session/input',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(ev)}).catch(function(){});});}
  img.addEventListener('mousedown',function(e){e.preventDefault();if(Date.now()-lastTouchAt<700)return;var p=pos(e.clientX,e.clientY);showDot(e.clientX,e.clientY);send({type:'down',x:p.x,y:p.y});});
  img.addEventListener('mouseup',function(e){e.preventDefault();if(Date.now()-lastTouchAt<700)return;var p=pos(e.clientX,e.clientY);send({type:'up',x:p.x,y:p.y});});
  img.addEventListener('mousemove',function(e){if(Date.now()-lastTouchAt<700)return;var t=Date.now();if(t-lastMove<80)return;lastMove=t;var p=pos(e.clientX,e.clientY);send({type:'move',x:p.x,y:p.y});});
  img.addEventListener('wheel',function(e){e.preventDefault();var p=pos(e.clientX,e.clientY);send({type:'wheel',x:p.x,y:p.y,deltaY:e.deltaY});},{passive:false});
  img.addEventListener('touchstart',function(e){e.preventDefault();lastTouchAt=Date.now();var t=e.changedTouches[0];if(!t)return;touchStart={cx:t.clientX,cy:t.clientY};},{passive:false});
  img.addEventListener('touchend',function(e){e.preventDefault();lastTouchAt=Date.now();var t=e.changedTouches[0];if(!t)return;var dx=touchStart?t.clientX-touchStart.cx:0,dy=touchStart?t.clientY-touchStart.cy:0;touchStart=null;var p=pos(t.clientX,t.clientY);if(Math.hypot(dx,dy)<=18){showDot(t.clientX,t.clientY);send({type:'tap',x:p.x,y:p.y});}else{send({type:'wheel',x:p.x,y:p.y,deltaY:-dy*1.4});}},{passive:false});
  document.getElementById('cancel').addEventListener('click',function(){fetch('/auth/recover/session/cancel',{method:'POST',credentials:'same-origin'}).catch(function(){});});
  function frame(){if(done||busy)return;busy=true;fetch('/auth/recover/session/frame?'+Date.now(),{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.ok?r.blob():null;}).then(function(b){if(b){var u=URL.createObjectURL(b);img.src=u;if(last)URL.revokeObjectURL(last);last=u;}}).catch(function(){}).then(function(){busy=false;});}
  function status(){fetch('/auth/recover/session/status',{credentials:'same-origin',cache:'no-store'}).then(function(r){if(r.status===401){banner.textContent='This session is no longer active.';banner.className='bad';done=true;return null;}return r.json();}).then(function(s){if(!s)return;vw=s.viewport.width;vh=s.viewport.height;banner.textContent=s.message+(s.username?' ('+s.username+')':'');if(s.phase==='success'){banner.className='ok';}else if(s.phase==='failed'||s.phase==='cancelled'){banner.className='bad';}if(s.final){done=true;}}).catch(function(){});}
  setInterval(frame,400);setInterval(status,1000);frame();status();
})();
</script></main></body></html>`;
}

const REASON_PAGES: Record<string, { code: number; title: string; text: string }> = {
  invalid: { code: 404, title: 'Link not valid', text: 'This recovery link is not valid.' },
  expired: { code: 410, title: 'Link expired', text: 'This recovery link has expired. A fresh one is sent to Telegram hourly.' },
  used: { code: 409, title: 'Link already used', text: 'This single-use link was already opened. Wait for the next Telegram reminder for a new link.' },
  cancelled: { code: 410, title: 'Recovery cancelled', text: 'This recovery was cancelled.' },
  busy: { code: 503, title: 'Server busy', text: 'Another recovery is running right now. The link was not used — try again in a minute.' },
  unavailable: { code: 422, title: 'Recovery unavailable', text: 'This account cannot be recovered right now. Check Telegram for details.' },
};

export function registerRecoveryRoutes(
  app: FastifyInstance,
  service: RecoveryService,
  opts: { tokenLimiter?: WindowLimiter; sessionLimiter?: WindowLimiter } = {},
): void {
  // 30 token-route hits / 10 min / IP; the session endpoints need a higher budget for streaming.
  const tokenLimiter = opts.tokenLimiter ?? new WindowLimiter(30, 10 * 60_000);
  const sessionLimiter = opts.sessionLimiter ?? new WindowLimiter(1200, 60_000);

  const tooMany = (reply: FastifyReply) => {
    secure(reply);
    return reply.code(429).type('text/html; charset=utf-8').send(messagePage('Too many requests', 'Please wait a few minutes and try again.'));
  };

  app.get('/auth/recover/session', async (req, reply) => {
    if (!sessionLimiter.allow(req.ip)) return tooMany(reply);
    const status = service.portalStatus(cookieOf(req, RECOVERY_COOKIE));
    const nonce = randomBytes(16).toString('base64');
    secure(reply, nonce);
    if (!status) {
      return reply.code(401).type('text/html; charset=utf-8').send(messagePage('No active recovery', 'Open a fresh recovery link from Telegram.'));
    }
    return reply.type('text/html; charset=utf-8').send(viewerPage(nonce, status.label));
  });

  app.get('/auth/recover/session/status', async (req, reply) => {
    if (!sessionLimiter.allow(req.ip)) return tooMany(reply);
    secure(reply);
    const status = service.portalStatus(cookieOf(req, RECOVERY_COOKIE));
    if (!status) return reply.code(401).send({ ok: false });
    return reply.send(status);
  });

  app.get('/auth/recover/session/frame', async (req, reply) => {
    if (!sessionLimiter.allow(req.ip)) return tooMany(reply);
    secure(reply);
    const secret = cookieOf(req, RECOVERY_COOKIE);
    if (!service.portalStatus(secret)) return reply.code(401).send();
    const frame = await service.portalFrame(secret);
    if (!frame) return reply.code(204).send();
    return reply.type('image/jpeg').send(frame);
  });

  app.post('/auth/recover/session/input', async (req, reply) => {
    if (!sessionLimiter.allow(req.ip)) return tooMany(reply);
    secure(reply);
    const parsed = inputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false });
    const ok = await service.portalInput(cookieOf(req, RECOVERY_COOKIE), parsed.data);
    return reply.code(ok ? 200 : 401).send({ ok });
  });

  app.post('/auth/recover/session/cancel', async (req, reply) => {
    if (!sessionLimiter.allow(req.ip)) return tooMany(reply);
    secure(reply);
    const ok = await service.portalCancel(cookieOf(req, RECOVERY_COOKIE));
    return reply.code(ok ? 200 : 401).send({ ok });
  });

  app.get('/auth/recover/userscript.user.js', async (req, reply) => {
    if (!sessionLimiter.allow(req.ip)) return tooMany(reply);
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.type('text/javascript; charset=utf-8').send(buildUserscript());
  });

  app.get('/auth/recover/tunnel-client.mjs', async (req, reply) => {
    if (!sessionLimiter.allow(req.ip)) return tooMany(reply);
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.type('text/javascript; charset=utf-8').send(buildMobileTunnelClientJs());
  });

  app.get('/auth/recover/termux-setup.sh', async (req, reply) => {
    if (!sessionLimiter.allow(req.ip)) return tooMany(reply);
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.type('text/x-shellscript; charset=utf-8').send(buildTermuxSetupSh(requestOrigin(req)));
  });

  app.get('/auth/recover/:token/poll', async (req, reply) => {
    secure(reply);
    if (!sessionLimiter.allow(req.ip)) return tooMany(reply);
    const { token } = req.params as { token: string };
    const status =
      typeof service.getRecoveryPollStatus === 'function'
        ? await service.getRecoveryPollStatus(token)
        : await service.inspectToken(token);
    if (typeof service.getEgressStatus === 'function') {
      return reply.send({ ...status, egress: await service.getEgressStatus() });
    }
    return reply.send(status);
  });

  app.post('/auth/recover/:token/bootstrap', async (req, reply) => {
    secure(reply);
    if (!tokenLimiter.allow(req.ip)) return reply.code(429).send({ ok: false, reason: 'rate_limited' });
    const { token } = req.params as { token: string };
    const boot = await service.bootstrapLocalRecovery(token);
    if (!boot.ok) {
      const code = boot.reason === 'invalid' ? 404 : boot.reason === 'used' ? 409 : boot.reason === 'unavailable' ? 422 : 410;
      return reply.code(code).send(boot);
    }
    return reply.send(boot);
  });

  const handleLocalComplete = async (req: FastifyRequest, reply: FastifyReply) => {
    secure(reply);
    if (!tokenLimiter.allow(req.ip)) return reply.code(429).send({ ok: false, error: 'Too many requests' });
    const { token } = req.params as { token: string };
    const result = await service.completeLocalRecovery(token, req.body);
    if (result.ok) {
      return reply.code(result.httpStatus).send({
        ...result,
        redirectUrl: `/auth/recover/${token}?completed=1`,
      });
    }
    return reply.code(result.httpStatus).send(result);
  };

  app.post('/auth/recover/:token/complete', handleLocalComplete);
  app.post('/auth/recover/:token', handleLocalComplete);

  app.get('/auth/recover/:token/launch.cmd', async (req, reply) => {
    secure(reply);
    if (!tokenLimiter.allow(req.ip)) return tooMany(reply);
    const { token } = req.params as { token: string };
    if (!SAFE_TOKEN_RE.test(token)) {
      const page = REASON_PAGES.invalid!;
      return reply.code(page.code).type('text/html; charset=utf-8').send(messagePage(page.title, page.text));
    }
    const inspected = await service.inspectToken(token);
    if (inspected.state !== 'valid') {
      const page = REASON_PAGES[inspected.state]!;
      return reply.code(page.code).type('text/html; charset=utf-8').send(messagePage(page.title, page.text));
    }
    const origin = requestOrigin(req);
    const safeLabel = (inspected.label ?? 'account').replace(/[^a-zA-Z0-9_.-]/g, '_');
    const psUrl = `${origin}/auth/recover/${token}/script.ps1`;
    const cmdBody = [
      '@echo off',
      'setlocal',
      `title LeetCode Local-IP Recovery (${safeLabel})`,
      'echo Starting LeetCode local-IP verification (bypasses datacenter Cloudflare)...',
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm '${psUrl}' | iex"`,
      'if errorlevel 1 (',
      '  echo.',
      '  echo Recovery did not complete. Check the message above and press any key to close...',
      '  pause >nul',
      ')',
      '',
    ].join('\r\n');
    reply.header('Content-Disposition', `attachment; filename="recover-${safeLabel}.cmd"`);
    return reply.type('application/x-bat; charset=utf-8').send(cmdBody);
  });

  app.get('/auth/recover/:token/script.ps1', async (req, reply) => {
    secure(reply);
    if (!tokenLimiter.allow(req.ip)) return reply.code(429).type('text/plain; charset=utf-8').send('Write-Error "Too many requests"');
    const { token } = req.params as { token: string };
    if (!SAFE_TOKEN_RE.test(token)) {
      return reply.code(404).type('text/plain; charset=utf-8').send('Write-Error "Invalid recovery link"');
    }
    const inspected = await service.inspectToken(token);
    if (inspected.state !== 'valid') {
      const page = REASON_PAGES[inspected.state]!;
      return reply.code(page.code).type('text/plain; charset=utf-8').send(`Write-Error "${page.title}: ${page.text}"`);
    }
    const origin = requestOrigin(req);
    const recoverUrl = `${origin}/auth/recover/${token}`;
    const b64 = Buffer.from(buildStandaloneRunnerJs(origin, token), 'utf8').toString('base64');
    const shortId = token.slice(0, 8);
    const ps1 = [
      "$ErrorActionPreference = 'Stop'",
      '$node = Get-Command node -ErrorAction SilentlyContinue',
      'if (-not $node) {',
      '  Write-Host "Node.js 22+ is required. Install from https://nodejs.org/" -ForegroundColor Red',
      '  exit 1',
      '}',
      `$dir = Join-Path $env:TEMP "lc-recover-${shortId}"`,
      'New-Item -ItemType Directory -Force -Path $dir | Out-Null',
      '$scriptPath = Join-Path $dir "recover.mjs"',
      `[IO.File]::WriteAllBytes($scriptPath, [Convert]::FromBase64String("${b64}"))`,
      `& $node.Source $scriptPath "${recoverUrl}"`,
      'exit $LASTEXITCODE',
      '',
    ].join('\r\n');
    return reply.type('text/plain; charset=utf-8').send(ps1);
  });

  app.get('/auth/recover/:token/script.sh', async (req, reply) => {
    secure(reply);
    if (!tokenLimiter.allow(req.ip)) return reply.code(429).type('text/plain; charset=utf-8').send('echo "Too many requests" >&2; exit 1');
    const { token } = req.params as { token: string };
    if (!SAFE_TOKEN_RE.test(token)) {
      return reply.code(404).type('text/plain; charset=utf-8').send('echo "Invalid recovery link" >&2; exit 1');
    }
    const inspected = await service.inspectToken(token);
    if (inspected.state !== 'valid') {
      const page = REASON_PAGES[inspected.state]!;
      return reply.code(page.code).type('text/plain; charset=utf-8').send(`echo "${page.title}: ${page.text}" >&2; exit 1`);
    }
    const origin = requestOrigin(req);
    const recoverUrl = `${origin}/auth/recover/${token}`;
    const b64 = Buffer.from(buildStandaloneRunnerJs(origin, token), 'utf8').toString('base64');
    const shortId = token.slice(0, 8);
    const sh = [
      '#!/usr/bin/env sh',
      'set -eu',
      'if ! command -v node >/dev/null 2>&1; then',
      '  echo "Node.js 22+ is required. Install from https://nodejs.org/" >&2',
      '  exit 1',
      'fi',
      `DIR="\${TMPDIR:-/tmp}/lc-recover-${shortId}"`,
      'mkdir -p "$DIR"',
      'SCRIPT_PATH="$DIR/recover.mjs"',
      `printf '%s' "${b64}" | base64 -d > "$SCRIPT_PATH" 2>/dev/null || printf '%s' "${b64}" | base64 -D > "$SCRIPT_PATH"`,
      `exec node "$SCRIPT_PATH" "${recoverUrl}"`,
      '',
    ].join('\n');
    return reply.type('text/plain; charset=utf-8').send(sh);
  });

  app.get('/auth/recover/:token', async (req, reply) => {
    const nonce = randomBytes(16).toString('base64');
    secure(reply, nonce);
    if (!tokenLimiter.allow(req.ip)) return tooMany(reply);
    const { token } = req.params as { token: string };
    const query = (req.query ?? {}) as { completed?: string };
    if (typeof service.getRecoveryPollStatus === 'function') {
      const poll = await service.getRecoveryPollStatus(token);
      if (poll.state === 'recovered') {
        return reply.type('text/html; charset=utf-8').send(restoredPage(poll.label ?? 'account', poll.username));
      }
    }
    const inspected = await service.inspectToken(token);
    if (inspected.state !== 'valid') {
      if (query.completed === '1' && inspected.state === 'used') {
        return reply.type('text/html; charset=utf-8').send(restoredPage(inspected.label ?? 'account'));
      }
      const page = REASON_PAGES[inspected.state]!;
      return reply.code(page.code).type('text/html; charset=utf-8').send(messagePage(page.title, page.text));
    }
    const origin = requestOrigin(req);
    const egress = typeof service.getEgressStatus === 'function' ? await service.getEgressStatus() : undefined;
    return reply.type('text/html; charset=utf-8').send(recoveryPortalPage(nonce, origin, token, inspected.label ?? 'account', egress));
  });

  app.post('/auth/recover/:token/start', async (req, reply) => {
    secure(reply);
    if (!tokenLimiter.allow(req.ip)) return tooMany(reply);
    const { token } = req.params as { token: string };
    const result = isMobileRequest(req)
      ? await service.openPortalSession(token, { mobile: true })
      : await service.openPortalSession(token);
    if (!result.ok) {
      const page = REASON_PAGES[result.reason]!;
      return reply.code(page.code).type('text/html; charset=utf-8').send(messagePage(page.title, result.message ?? page.text));
    }
    reply.header(
      'Set-Cookie',
      `${RECOVERY_COOKIE}=${encodeURIComponent(result.secret)}; Max-Age=1800; Path=/auth/recover; HttpOnly; SameSite=Strict${req.protocol === 'https' ? '; Secure' : ''}`,
    );
    return reply.redirect('/auth/recover/session', 303);
  });
}
