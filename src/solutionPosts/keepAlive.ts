import { config } from '../config';

let owners = 0;
let timer: ReturnType<typeof setInterval> | undefined;

/** Keep active article work alive across a daily cooldown; release when idle. */
export function startArticleWorkKeepAlive(): () => void {
  let url: URL;
  try { url = new URL('/health', config.api.publicUrl); } catch { return () => undefined; }
  if (!process.env.RENDER_INSTANCE_ID || url.protocol !== 'https:' || url.username || url.password) return () => undefined;
  if (owners++ === 0) {
    const ping = () => { void fetch(url, { signal: AbortSignal.timeout(20000) }).catch(() => undefined); };
    ping();
    timer = setInterval(ping, 8 * 60 * 1000);
    timer.unref();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--owners === 0 && timer) { clearInterval(timer); timer = undefined; }
  };
}
