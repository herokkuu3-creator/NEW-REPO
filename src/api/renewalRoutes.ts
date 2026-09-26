import { FastifyInstance } from 'fastify';
import { config } from '../config';
import { logger } from '../logger';
import {
  captureFrame,
  closeCurrent,
  currentPhase,
  ensureSession,
  forwardInput,
  isValidRenewalKey,
  viewportSize,
  RemoteInput,
} from '../browser/remoteBrowser';

/**
 * The /renew web surface — "tap the link, sign in, done."
 *
 *   GET  /renew?key=…        the renewal page (streamed browser, mobile-first)
 *   GET  /renew/api/frame    latest screenshot + phase (polled ~1/s by the page)
 *   POST /renew/api/input    a tap / keystroke / scroll from the user
 *   POST /renew/api/close    end the session early
 *
 * Authorization is the per-renewal token from SystemState (NOT the admin
 * SETUP_TOKEN — this link travels to the user's phone). The token rotates
 * after every successful renewal; the just-used token stays valid until the
 * page has seen the success state, then dies.
 *
 * The streamed browser is a real Chromium instance and every action inside
 * it is the user's own tap or keystroke — including any verification step a
 * site may present. Nothing about a bot check is automated or bypassed.
 */

export function registerRenewalRoutes(app: FastifyInstance): void {
  const keyValid = isValidRenewalKey;

  app.get('/renew', async (req, reply) => {
    const key = (req.query as { key?: string }).key;
    if (!(await keyValid(key))) {
      return reply
        .code(403)
        .type('text/html')
        .send(errorPage('This renewal link is invalid or has already been used. Ask the bot for a fresh one with /renew.'));
    }
    // Start the browser in the background; the page polls until it's ready.
    void ensureSession().catch((err) =>
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'renewal session start failed'),
    );
    return reply.type('text/html').send(renewalPage(key as string));
  });

  app.get('/renew/api/frame', async (req, reply) => {
    const key = (req.query as { key?: string }).key;
    if (!(await keyValid(key))) return reply.code(401).send({ error: 'unauthorized' });

    const { phase, username } = currentPhase();
    const frame = phase === 'ready' ? await captureFrame() : null;
    return reply.send({ phase, username, frame, viewport: viewportSize() });
  });

  app.post('/renew/api/input', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!(await keyValid(body.key))) return reply.code(401).send({ error: 'unauthorized' });
    await forwardInput(sanitizeInput(body));
    return reply.send({ ok: true });
  });

  app.post('/renew/api/close', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!(await keyValid(body.key))) return reply.code(401).send({ error: 'unauthorized' });
    await closeCurrent('idle');
    return reply.send({ ok: true });
  });
}

function sanitizeInput(body: Record<string, unknown>): RemoteInput {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  switch (body.type) {
    case 'click':
      return { type: 'click', x: num(body.x), y: num(body.y) };
    case 'type':
      return { type: 'type', text: typeof body.text === 'string' ? body.text : '' };
    case 'key':
      return { type: 'key', key: typeof body.key === 'string' ? body.key : '' };
    case 'scroll':
    default:
      return { type: 'scroll', dy: num(body.dy) };
  }
}

function errorPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Session renewal</title>
<style>body{background:#0f141b;color:#e6edf3;font-family:-apple-system,Segoe UI,Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box}
.card{max-width:420px;background:#1a2230;border:1px solid #2b3648;border-radius:14px;padding:28px;line-height:1.5}
h1{font-size:20px;margin:0 0 12px}</style></head>
<body><div class="card"><h1>🔑 Link expired</h1><p>${message}</p></div></body></html>`;
}

/**
 * The renewal page. Deliberately dependency-free (no external JS/CSS — the
 * free service must render it without a CDN). The image element is driven
 * by fetch → blob → objectURL, and taps are mapped from displayed pixels to
 * the remote viewport by the scale ratio, so any phone screen works.
 */
function renewalPage(key: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>LeetCode sign-in</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{background:#0f141b;color:#e6edf3;font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:0;display:flex;flex-direction:column;min-height:100vh}
header{padding:12px 16px;font-weight:600;font-size:15px;display:flex;align-items:center;gap:8px}
#status{font-weight:400;font-size:13px;color:#9fb0c3}
#stage{flex:1;display:flex;align-items:flex-start;justify-content:center;padding:0 8px;overflow:auto}
#frame{width:100%;max-width:1280px;border-radius:10px;border:1px solid #2b3648;background:#000;cursor:pointer;touch-action:manipulation;user-select:none}
#toolbar{padding:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;background:#141b26;border-top:1px solid #2b3648}
#typebox{flex:1;min-width:140px;padding:10px;border-radius:8px;border:1px solid #2b3648;background:#0f141b;color:#e6edf3;font-size:16px}
button{padding:10px 14px;border-radius:8px;border:1px solid #2b3648;background:#22304a;color:#e6edf3;font-size:14px;cursor:pointer}
button:active{background:#2e4165}
#done{display:none;text-align:center;padding:40px 20px;line-height:1.6}
</style></head>
<body>
<header>🔑 LeetCode sign-in <span id="status">starting browser…</span></header>
<div id="stage"><img id="frame" alt="remote browser" draggable="false"></div>
<div id="done">
  <div style="font-size:44px">✅</div>
  <h2 id="donetitle">Session renewed</h2>
  <p>The new cookies are saved and today's challenge run is starting.<br>You can close this tab.</p>
</div>
<div id="toolbar">
  <input id="typebox" type="text" placeholder="Type here, then tap Send" autocomplete="off" autocapitalize="off">
  <button onclick="sendText()">Send</button>
  <button onclick="sendKey('Enter')">⏎</button>
  <button onclick="sendKey('Backspace')">⌫</button>
  <button onclick="sendKey('Tab')">⇥</button>
  <button onclick="scrollPage(-600)">▲</button>
  <button onclick="scrollPage(600)">▼</button>
</div>
<script>
const KEY = ${JSON.stringify(key)};
const frame = document.getElementById('frame');
const statusEl = document.getElementById('status');
let vw = 1280, vh = 800, dead = false, lastUrl = null;

// Tap-to-click: map displayed pixels to remote viewport coordinates.
frame.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const r = frame.getBoundingClientRect();
  const x = (e.clientX - r.left) * (vw / r.width);
  const y = (e.clientY - r.top) * (vh / r.height);
  post({ type: 'click', x, y });
});

// Physical keyboards (desktop) type straight through.
document.addEventListener('keydown', (e) => {
  if (e.target === document.getElementById('typebox')) return;
  if (e.key.length === 1) { post({ type: 'type', text: e.key }); e.preventDefault(); }
  else { post({ type: 'key', key: e.key }); e.preventDefault(); }
});

function sendText() {
  const box = document.getElementById('typebox');
  if (box.value) post({ type: 'type', text: box.value });
  box.value = '';
}
function sendKey(k) { post({ type: 'key', key: k }); }
function scrollPage(dy) { post({ type: 'scroll', dy }); }

function post(body) {
  body.key = KEY;
  fetch('/renew/api/input', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

async function poll() {
  if (dead) return;
  try {
    const res = await fetch('/renew/api/frame?key=' + encodeURIComponent(KEY) + '&t=' + Date.now());
    if (res.status === 401) { finish('⚠️ This link has expired.', 'Ask the bot for a fresh one with /renew.'); return; }
    const data = await res.json();
    vw = data.viewport.width; vh = data.viewport.height;

    if (data.phase === 'success') {
      finish('✅', 'Signed in as ' + (data.username || 'you') + ' — session renewed.');
      return;
    }
    if (data.phase === 'timeout') { finish('⏱️ Session timed out.', 'Send /renew to the bot for a new link.'); return; }
    if (data.phase === 'error') { finish('❌ Browser failed to start.', 'Try again with /renew.'); return; }

    statusEl.textContent = data.phase === 'ready'
      ? 'live — sign into LeetCode below. If you see a “verify you are human” check, just tap it yourself.'
      : 'starting browser…';

    if (data.frame) {
      const blob = await (await fetch('data:image/jpeg;base64,' + data.frame)).blob();
      const url = URL.createObjectURL(blob);
      frame.src = url;
      if (lastUrl) URL.revokeObjectURL(lastUrl);
      lastUrl = url;
    }
  } catch (e) { /* transient — next tick retries */ }
  setTimeout(poll, 1100);
}

function finish(icon, text) {
  dead = true;
  document.getElementById('stage').style.display = 'none';
  document.getElementById('toolbar').style.display = 'none';
  const done = document.getElementById('done');
  done.style.display = 'block';
  done.querySelector('div').textContent = icon;
  document.getElementById('donetitle').textContent = text;
  statusEl.textContent = '';
}
poll();
</script>
</body></html>`;
}