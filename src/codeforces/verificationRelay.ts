import { randomBytes } from 'node:crypto';

export type VerificationAction = { type: 'click'; x: number; y: number } | { type: 'scroll'; delta: number } | { type: 'cancel' };
export const VERIFICATION_LIFETIME_MS = 4 * 60_000;

/** Private, ephemeral relay. Browser images never enter logs, files or artifacts. */
export class VerificationRelay {
  private session: { id: string; token: string; expiresAt: number; image: Buffer | null; width: number; height: number; actions: VerificationAction[] } | null = null;
  constructor(private readonly now = Date.now) {}

  metadata(id: string): { token: string; expiresAt: number } | undefined {
    this.expire();
    if (this.session?.id !== id) return undefined;
    return { token: this.session.token, expiresAt: this.session.expiresAt };
  }

  publish(id: string, image: string, width: number, height: number) {
    this.expire();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image) || image.length > 600_000
      || !Number.isInteger(width) || width < 1 || width > 1920
      || !Number.isInteger(height) || height < 1 || height > 1200) throw new Error('invalid frame');
    const bytes = Buffer.from(image, 'base64');
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error('invalid JPEG');
    if (!this.session || this.session.id !== id) {
      this.session = { id, token: randomBytes(32).toString('hex'), expiresAt: this.now() + VERIFICATION_LIFETIME_MS, image: null, width, height, actions: [] };
    }
    this.session.image = bytes;
    this.session.width = width;
    this.session.height = height;
    const actions = this.session.actions.splice(0);
    return { ...this.metadata(id)!, actions };
  }

  frame(token: string) {
    this.expire();
    return this.session?.token === token ? this.session : null;
  }

  queue(token: string, value: unknown): boolean {
    const session = this.frame(token);
    if (!session || !value || typeof value !== 'object' || session.actions.length >= 8) return false;
    const action = value as VerificationAction;
    if (action.type === 'cancel') session.actions.push({ type: 'cancel' });
    else if (action.type === 'scroll' && Number.isFinite(action.delta) && Math.abs(action.delta) <= 400) session.actions.push({ type: 'scroll', delta: action.delta });
    else if (action.type === 'click' && Number.isFinite(action.x) && Number.isFinite(action.y)
      && action.x >= 0 && action.x < session.width && action.y >= 0 && action.y < session.height) session.actions.push({ type: 'click', x: action.x, y: action.y });
    else return false;
    return true;
  }

  close(id: string): void { if (this.session?.id === id) this.session = null; }
  private expire(): void { if (this.session && this.now() >= this.session.expiresAt) this.session = null; }
}

export const verificationHtml = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codeforces verification</title>
<style>body{margin:0;background:#101827;color:#eef3ff;font:16px system-ui}main{max-width:950px;margin:auto;padding:16px}button{padding:12px;margin:6px;border:0;border-radius:12px;background:#dae6ff}img{width:100%;border-radius:12px;touch-action:manipulation}p{line-height:1.5}#status{color:#a9c6ff}</style></head>
<body><main><h2>Codeforces verification</h2><p>This is the bot’s cloud browser. Tap the verification shown below. Submission resumes automatically after verification succeeds.</p>
<p id="status">Connecting…</p><img id="screen" alt="Live verification browser"><div><button id="up">Scroll up</button><button id="down">Scroll down</button><button id="cancel">Cancel</button></div><p>Only verification clicks are allowed. Keep this private link to yourself.</p></main>
<script>
const token=location.hash.slice(1); history.replaceState(null,'','/verify');
const screen=document.getElementById('screen'), status=document.getElementById('status');
let stopped=false, busy=false, objectUrl, frameTime=0;
const headers={'x-verification-token':token};
async function action(value){if(stopped||busy||Date.now()-frameTime>5000)return;busy=true;try{const r=await fetch('/verification/action',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(value)});if(!r.ok)status.textContent='Interaction unavailable; wait for the next frame.';}catch{status.textContent='Connection interrupted. Reconnecting…';}finally{busy=false;}}
screen.onclick=e=>{const rect=screen.getBoundingClientRect();action({type:'click',x:Math.floor((e.clientX-rect.left)*screen.naturalWidth/rect.width),y:Math.floor((e.clientY-rect.top)*screen.naturalHeight/rect.height)});};
document.getElementById('up').onclick=()=>action({type:'scroll',delta:-350});
document.getElementById('down').onclick=()=>action({type:'scroll',delta:350});
document.getElementById('cancel').onclick=()=>action({type:'cancel'});
async function refresh(){if(stopped)return;try{const r=await fetch('/verification/frame',{headers,cache:'no-store'});if(r.status===404||r.status===410){stopped=true;screen.removeAttribute('src');status.textContent='This verification session has ended. Check Telegram for the result.';return;}if(r.ok){const next=URL.createObjectURL(await r.blob());screen.onload=()=>{if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=next;frameTime=Date.now();};screen.src=next;status.textContent='Live browser · '+Math.max(0,Math.ceil((Number(r.headers.get('x-expires-at'))-Date.now())/1000))+' seconds remaining';}}catch{status.textContent='Connection interrupted. Reconnecting…';}setTimeout(refresh,1200);}
if(/^[a-f0-9]{64}$/.test(token))refresh();else status.textContent='Open the private link sent by your Telegram bot.';
</script></body></html>`;
