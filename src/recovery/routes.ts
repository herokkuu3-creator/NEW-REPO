import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RecoveryService } from './service';

/**
 * Recovery portal HTTP surface.
 *
 *   GET  /auth/recover/:token         confirm page (read-only; never consumes the link)
 *   POST /auth/recover/:token/start   consumes the one-time token, starts the isolated
 *                                     browser, sets an HttpOnly session cookie and
 *                                     redirects to /auth/recover/session (token leaves the URL)
 *   GET  /auth/recover/session        live viewer
 *   GET  /auth/recover/session/frame  latest JPEG frame
 *   GET  /auth/recover/session/status JSON phase
 *   POST /auth/recover/session/input  mouse events only
 *   POST /auth/recover/session/cancel explicit cancellation
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
  type: z.enum(['move', 'down', 'up', 'wheel']),
  x: z.number().finite().min(-5).max(5000),
  y: z.number().finite().min(-5).max(5000),
  deltaY: z.number().finite().optional(),
});

function cookieOf(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0 && part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
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

const PAGE_CSS = `body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:16px;display:flex;justify-content:center}
main{max-width:1040px;width:100%}h1{font-size:1.2rem}p{line-height:1.5}
.card{background:#1e293b;border-radius:12px;padding:18px}button{background:#2563eb;color:#fff;border:0;border-radius:8px;padding:12px 18px;font-size:1rem;cursor:pointer}
button.secondary{background:#475569}#screen{width:100%;max-width:1024px;border-radius:8px;background:#fff;touch-action:none;user-select:none;cursor:pointer}
#banner{padding:10px 14px;border-radius:8px;background:#0b3b8c;margin-bottom:12px}#banner.ok{background:#14532d}#banner.bad{background:#7f1d1d}`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body><main>${body}</main></body></html>`;
}

function messagePage(title: string, text: string): string {
  return shell(title, `<div class="card"><h1>${esc(title)}</h1><p>${esc(text)}</p></div>`);
}

function viewerPage(nonce: string, label: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reconnect LeetCode account</title><style>${PAGE_CSS}</style></head><body><main>
<h1>Reconnect <code>${esc(label)}</code></h1>
<div id="banner">Starting a secure browser…</div>
<img id="screen" alt="Remote browser view" draggable="false">
<p><button class="secondary" id="cancel">Cancel recovery</button></p>
<p style="font-size:.85rem;opacity:.75">You only interact with LeetCode's own verification. Your saved password never reaches this page; the server enters it after verification.</p>
<script nonce="${nonce}">
(function(){
  var img=document.getElementById('screen'),banner=document.getElementById('banner'),vw=1024,vh=720,done=false,busy=false,last=null,lastMove=0;
  function pos(cx,cy){var r=img.getBoundingClientRect();return{x:(cx-r.left)*vw/r.width,y:(cy-r.top)*vh/r.height};}
  function send(ev){if(done)return;fetch('/auth/recover/session/input',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(ev)}).catch(function(){});}
  img.addEventListener('mousedown',function(e){e.preventDefault();var p=pos(e.clientX,e.clientY);send({type:'down',x:p.x,y:p.y});});
  img.addEventListener('mouseup',function(e){e.preventDefault();var p=pos(e.clientX,e.clientY);send({type:'up',x:p.x,y:p.y});});
  img.addEventListener('mousemove',function(e){var t=Date.now();if(t-lastMove<80)return;lastMove=t;var p=pos(e.clientX,e.clientY);send({type:'move',x:p.x,y:p.y});});
  img.addEventListener('wheel',function(e){e.preventDefault();var p=pos(e.clientX,e.clientY);send({type:'wheel',x:p.x,y:p.y,deltaY:e.deltaY});},{passive:false});
  img.addEventListener('touchstart',function(e){e.preventDefault();var t=e.changedTouches[0],p=pos(t.clientX,t.clientY);send({type:'move',x:p.x,y:p.y});send({type:'down',x:p.x,y:p.y});},{passive:false});
  img.addEventListener('touchend',function(e){e.preventDefault();var t=e.changedTouches[0],p=pos(t.clientX,t.clientY);send({type:'up',x:p.x,y:p.y});},{passive:false});
  document.getElementById('cancel').addEventListener('click',function(){fetch('/auth/recover/session/cancel',{method:'POST',credentials:'same-origin'}).catch(function(){});});
  function frame(){if(done||busy)return;busy=true;fetch('/auth/recover/session/frame?'+Date.now(),{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.ok?r.blob():null;}).then(function(b){if(b){var u=URL.createObjectURL(b);img.src=u;if(last)URL.revokeObjectURL(last);last=u;}}).catch(function(){}).then(function(){busy=false;});}
  function status(){fetch('/auth/recover/session/status',{credentials:'same-origin',cache:'no-store'}).then(function(r){if(r.status===401){banner.textContent='This session is no longer active.';banner.className='bad';done=true;return null;}return r.json();}).then(function(s){if(!s)return;vw=s.viewport.width;vh=s.viewport.height;banner.textContent=s.message+(s.username?' ('+s.username+')':'');if(s.phase==='success'){banner.className='ok';}else if(s.phase==='failed'||s.phase==='cancelled'){banner.className='bad';}if(s.final){done=true;}}).catch(function(){});}
  setInterval(frame,450);setInterval(status,1000);frame();status();
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

  app.get('/auth/recover/:token', async (req, reply) => {
    secure(reply);
    if (!tokenLimiter.allow(req.ip)) return tooMany(reply);
    const { token } = req.params as { token: string };
    const inspected = await service.inspectToken(token);
    if (inspected.state !== 'valid') {
      const page = REASON_PAGES[inspected.state]!;
      return reply.code(page.code).type('text/html; charset=utf-8').send(messagePage(page.title, page.text));
    }
    // POST target keeps the token in the path only; no query strings, no referrer.
    return reply.type('text/html; charset=utf-8').send(
      shell(
        'Reconnect LeetCode account',
        `<div class="card"><h1>Reconnect <code>${esc(inspected.label ?? 'account')}</code></h1>
<p>A secure browser will open on the server. Complete LeetCode's verification when it appears; the server then signs in with your saved credentials and stores the new session.</p>
<form method="post" action="/auth/recover/${esc(token)}/start"><button type="submit">Start recovery</button></form></div>`,
      ),
    );
  });

  app.post('/auth/recover/:token/start', async (req, reply) => {
    secure(reply);
    if (!tokenLimiter.allow(req.ip)) return tooMany(reply);
    const { token } = req.params as { token: string };
    const result = await service.openPortalSession(token);
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
