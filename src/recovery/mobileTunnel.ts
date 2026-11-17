import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { getSystemState, setSystemState, SystemKeys } from '../database/models';
import { logger } from '../logger';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_WS_PAYLOAD = 2 * 1024 * 1024;
const MAX_STREAMS = 128;
const STREAM_CONNECT_TIMEOUT_MS = 15_000;
const AUTH_TIMEOUT_MS = 8_000;
const PING_INTERVAL_MS = 20_000;

export const ALLOWED_TUNNEL_HOST_RE =
  /^(?:[a-z0-9-]+\.)*(?:leetcode\.com|leetcode\.cn|cloudflare\.com|challenges\.cloudflare\.com|cloudflareinsights\.com|gstatic\.com|google\.com|hcaptcha\.com|recaptcha\.net)$/i;

export function isAllowedTunnelTarget(host: string, port: number): boolean {
  if (port !== 443) return false;
  const clean = host.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!clean || net.isIP(clean) !== 0) return false;
  return ALLOWED_TUNNEL_HOST_RE.test(clean);
}

export function sha256Equal(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

export interface DecodedWsFrame {
  opcode: number;
  fin: boolean;
  payload: Buffer;
}

export function encodeWsFrame(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 0x1_0000_0000), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  return Buffer.concat([header, payload]);
}

export function decodeWsFrames(buffer: Buffer): {
  frames: DecodedWsFrame[];
  remaining: Buffer;
  protocolError?: string;
} {
  const frames: DecodedWsFrame[] = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset]!;
    const b1 = buffer[offset + 1]!;
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7f;
    let cursor = offset + 2;

    if (payloadLen === 126) {
      if (cursor + 2 > buffer.length) break;
      payloadLen = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (payloadLen === 127) {
      if (cursor + 8 > buffer.length) break;
      const hi = buffer.readUInt32BE(cursor);
      const lo = buffer.readUInt32BE(cursor + 4);
      const total = hi * 0x1_0000_0000 + lo;
      if (!Number.isSafeInteger(total) || total > MAX_WS_PAYLOAD) {
        return { frames, remaining: Buffer.alloc(0), protocolError: 'payload too large' };
      }
      payloadLen = total;
      cursor += 8;
    }

    if (payloadLen > MAX_WS_PAYLOAD) {
      return { frames, remaining: Buffer.alloc(0), protocolError: 'payload too large' };
    }

    const maskLen = masked ? 4 : 0;
    if (cursor + maskLen + payloadLen > buffer.length) break;

    let payload = Buffer.from(buffer.subarray(cursor + maskLen, cursor + maskLen + payloadLen));
    if (masked) {
      const mask = buffer.subarray(cursor, cursor + 4);
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] = payload[i]! ^ mask[i & 3]!;
      }
    }

    frames.push({ opcode, fin, payload });
    offset = cursor + maskLen + payloadLen;
  }

  return {
    frames,
    remaining: offset > 0 ? Buffer.from(buffer.subarray(offset)) : buffer,
  };
}

interface TunnelStream {
  id: number;
  socket: net.Socket;
  opened: boolean;
  leftover: Buffer;
  timer: ReturnType<typeof setTimeout>;
}

export interface MobileTunnelStatus {
  connected: boolean;
  connectedAt: string | null;
  remoteIp: string | null;
  activeStreams: number;
  proxyPort: number | null;
}

export interface MobileTunnelOptions {
  validateToken: (candidate: string) => Promise<boolean> | boolean;
  isAllowedTarget?: (host: string, port: number) => boolean;
}

/**
 * WebSocket-backed reverse HTTP CONNECT tunnel bound only to 127.0.0.1 inside
 * this server process. Allows the user's phone (e.g. Android Termux) or home
 * machine to serve as the clean residential/mobile exit IP for Playwright's
 * recovery browser while the user taps verification inside Mobile Chrome.
 */
export class MobileTunnelServer {
  private proxyServer: net.Server | null = null;
  private proxyPort: number | null = null;
  private activeClient: Duplex | null = null;
  private clientAuthed = false;
  private clientConnectedAt: Date | null = null;
  private clientIp: string | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private nextStreamId = 1;
  private readonly streams = new Map<number, TunnelStream>();
  private readonly proxySockets = new Set<net.Socket>();
  private readonly isAllowedTarget: (host: string, port: number) => boolean;

  constructor(private readonly opts: MobileTunnelOptions) {
    this.isAllowedTarget = opts.isAllowedTarget ?? isAllowedTunnelTarget;
  }

  isConnected(): boolean {
    return this.activeClient !== null && this.clientAuthed && !this.activeClient.destroyed;
  }

  getStatus(): MobileTunnelStatus {
    return {
      connected: this.isConnected(),
      connectedAt: this.clientConnectedAt ? this.clientConnectedAt.toISOString() : null,
      remoteIp: this.isConnected() ? this.clientIp : null,
      activeStreams: this.streams.size,
      proxyPort: this.proxyPort,
    };
  }

  async ensureProxyListening(): Promise<string | null> {
    if (!this.isConnected()) return null;
    if (this.proxyServer && this.proxyPort) {
      return `http://127.0.0.1:${this.proxyPort}`;
    }
    await new Promise<void>((resolve, reject) => {
      const srv = net.createServer((sock) => this.handleProxySocket(sock));
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (addr && typeof addr === 'object') {
          this.proxyServer = srv;
          this.proxyPort = addr.port;
          resolve();
        } else {
          reject(new Error('Failed to bind local tunnel proxy port'));
        }
      });
    });
    return this.proxyPort ? `http://127.0.0.1:${this.proxyPort}` : null;
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || !key.trim()) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(`${key.trim()}${WS_GUID}`).digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    );

    const forwardedFor = req.headers['x-forwarded-for'];
    const rawIp = Array.isArray(forwardedFor)
      ? forwardedFor[0]
      : typeof forwardedFor === 'string'
        ? forwardedFor.split(',')[0]?.trim()
        : req.socket.remoteAddress;

    let rx: Buffer = head && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
    let fragOpcode = 0;
    let fragChunks: Buffer[] = [];
    let closed = false;
    let authedHere = false;

    const closeWs = (code = 1000, reason = '') => {
      if (closed) return;
      closed = true;
      clearTimeout(authTimer);
      try {
        const body = Buffer.alloc(2 + Buffer.byteLength(reason));
        body.writeUInt16BE(code, 0);
        if (reason) body.write(reason, 2, 'utf8');
        socket.write(encodeWsFrame(0x08, body));
      } catch {
        // ignore
      }
      socket.destroy();
      if (this.activeClient === socket) {
        this.clearActiveClient();
      }
    };

    const authTimer = setTimeout(() => {
      if (!authedHere) closeWs(4001, 'auth timeout');
    }, AUTH_TIMEOUT_MS);

    const sendJson = (msg: Record<string, unknown>) => {
      if (closed || socket.destroyed) return;
      socket.write(encodeWsFrame(0x01, Buffer.from(JSON.stringify(msg), 'utf8')));
    };

    const onMessage = async (opcode: number, data: Buffer) => {
      if (opcode === 0x01) {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
        } catch {
          return;
        }
        const t = msg.t;
        if (!authedHere) {
          if (t !== 'auth' || typeof msg.token !== 'string') {
            closeWs(4001, 'auth required');
            return;
          }
          const ok = await Promise.resolve(this.opts.validateToken(msg.token)).catch(() => false);
          if (!ok || closed) {
            closeWs(4001, 'invalid token');
            return;
          }
          authedHere = true;
          clearTimeout(authTimer);
          this.setActiveClient(socket, rawIp ?? null);
          sendJson({ t: 'auth_ok' });
          void this.ensureProxyListening().catch(() => undefined);
          logger.info({ remoteIp: rawIp ?? null }, 'mobile recovery IP tunnel connected');
          return;
        }

        if (t === 'ping') {
          sendJson({ t: 'pong' });
          return;
        }
        if (t === 'pong') return;

        const id = typeof msg.id === 'number' ? msg.id : -1;
        const stream = this.streams.get(id);
        if (!stream) return;

        if (t === 'opened') {
          stream.opened = true;
          clearTimeout(stream.timer);
          if (!stream.socket.destroyed) {
            stream.socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (stream.leftover.length > 0) {
              this.sendStreamData(stream.id, stream.leftover);
              stream.leftover = Buffer.alloc(0);
            }
            stream.socket.resume();
          }
        } else if (t === 'err') {
          clearTimeout(stream.timer);
          this.streams.delete(id);
          if (!stream.socket.destroyed) {
            stream.socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
            stream.socket.destroy();
          }
        } else if (t === 'close') {
          clearTimeout(stream.timer);
          this.streams.delete(id);
          if (!stream.socket.destroyed) stream.socket.end();
        }
        return;
      }

      if (opcode === 0x02 && authedHere) {
        if (data.length < 4) return;
        const id = data.readUInt32BE(0);
        const chunk = data.subarray(4);
        const stream = this.streams.get(id);
        if (stream && stream.opened && !stream.socket.destroyed) {
          stream.socket.write(chunk);
        }
      }
    };

    socket.on('data', (chunk: Buffer) => {
      rx = rx.length > 0 ? Buffer.concat([rx, chunk]) : chunk;
      const decoded = decodeWsFrames(rx);
      if (decoded.protocolError) {
        closeWs(1002, decoded.protocolError);
        return;
      }
      rx = decoded.remaining;

      for (const f of decoded.frames) {
        if (f.opcode === 0x08) {
          closeWs(1000, 'client close');
          return;
        }
        if (f.opcode === 0x09) {
          if (!closed && !socket.destroyed) socket.write(encodeWsFrame(0x0a, f.payload));
          continue;
        }
        if (f.opcode === 0x0a) continue;

        if (f.opcode === 0x01 || f.opcode === 0x02) {
          if (f.fin) {
            void onMessage(f.opcode, f.payload);
          } else {
            fragOpcode = f.opcode;
            fragChunks = [f.payload];
          }
        } else if (f.opcode === 0x00 && fragOpcode !== 0) {
          fragChunks.push(f.payload);
          if (f.fin) {
            const full = Buffer.concat(fragChunks);
            const op = fragOpcode;
            fragOpcode = 0;
            fragChunks = [];
            void onMessage(op, full);
          }
        }
      }
    });

    socket.on('error', () => {
      closed = true;
      clearTimeout(authTimer);
      if (this.activeClient === socket) this.clearActiveClient();
    });

    socket.on('close', () => {
      closed = true;
      clearTimeout(authTimer);
      if (this.activeClient === socket) this.clearActiveClient();
    });
  }

  private setActiveClient(socket: Duplex, ip: string | null): void {
    if (this.activeClient && this.activeClient !== socket) {
      const old = this.activeClient;
      this.clearActiveClient();
      try {
        old.write(encodeWsFrame(0x08, Buffer.from('\x0f\xa2superseded', 'latin1')));
      } catch {
        // ignore
      }
      old.destroy();
    }
    this.activeClient = socket;
    this.clientAuthed = true;
    this.clientConnectedAt = new Date();
    this.clientIp = ip;
    this.pingTimer = setInterval(() => {
      if (!this.isConnected()) return;
      try {
        this.activeClient!.write(encodeWsFrame(0x09));
      } catch {
        this.clearActiveClient();
      }
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  private clearActiveClient(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.activeClient = null;
    this.clientAuthed = false;
    this.clientConnectedAt = null;
    this.clientIp = null;
    for (const [id, st] of this.streams.entries()) {
      clearTimeout(st.timer);
      this.streams.delete(id);
      if (!st.socket.destroyed) st.socket.destroy();
    }
  }

  private sendControl(msg: Record<string, unknown>): void {
    if (!this.isConnected()) return;
    this.activeClient!.write(encodeWsFrame(0x01, Buffer.from(JSON.stringify(msg), 'utf8')));
  }

  private sendStreamData(id: number, chunk: Buffer): void {
    if (!this.isConnected()) return;
    const framed = Buffer.allocUnsafe(4 + chunk.length);
    framed.writeUInt32BE(id, 0);
    chunk.copy(framed, 4);
    this.activeClient!.write(encodeWsFrame(0x02, framed));
  }

  private handleProxySocket(socket: net.Socket): void {
    this.proxySockets.add(socket);
    socket.once('close', () => this.proxySockets.delete(socket));
    let headerBuf: Buffer = Buffer.alloc(0);
    let handled = false;

    const cleanup = () => {
      headerBuf = Buffer.alloc(0);
    };

    const onData = (chunk: Buffer) => {
      if (handled) return;
      headerBuf = headerBuf.length > 0 ? Buffer.concat([headerBuf, chunk]) : chunk;
      const idx = headerBuf.indexOf('\r\n\r\n');
      if (idx === -1) {
        if (headerBuf.length > 8192) {
          socket.write('HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n');
          socket.destroy();
          cleanup();
        }
        return;
      }

      handled = true;
      socket.pause();
      socket.removeListener('data', onData);

      const headerStr = headerBuf.subarray(0, idx).toString('utf8');
      const leftover = Buffer.from(headerBuf.subarray(idx + 4));
      cleanup();

      const firstLine = headerStr.split('\r\n')[0] ?? '';
      const m = /^CONNECT\s+([^:\s]+|\[[^\]]+\]):(\d+)\s+HTTP\/1\.[01]$/i.exec(firstLine.trim());
      if (!m) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      const host = m[1]!;
      const port = Number(m[2]);
      if (!this.isAllowedTarget(host, port)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      if (!this.isConnected() || this.streams.size >= MAX_STREAMS) {
        socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      const id = this.nextStreamId;
      this.nextStreamId = (this.nextStreamId % 0x7fff_ffff) + 1;

      const timer = setTimeout(() => {
        const st = this.streams.get(id);
        if (st && !st.opened) {
          this.streams.delete(id);
          if (!st.socket.destroyed) {
            st.socket.write('HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\n\r\n');
            st.socket.destroy();
          }
          this.sendControl({ t: 'close', id });
        }
      }, STREAM_CONNECT_TIMEOUT_MS);

      const stream: TunnelStream = { id, socket, opened: false, leftover, timer };
      this.streams.set(id, stream);

      socket.on('data', (data: Buffer) => {
        if (stream.opened) {
          this.sendStreamData(id, data);
        } else {
          stream.leftover = Buffer.concat([stream.leftover, data]);
        }
      });

      const teardown = () => {
        clearTimeout(stream.timer);
        if (this.streams.delete(id)) {
          this.sendControl({ t: 'close', id });
        }
      };

      socket.on('close', teardown);
      socket.on('error', () => {
        teardown();
        socket.destroy();
      });

      this.sendControl({ t: 'open', id, host: host.replace(/^\[|\]$/g, ''), port });
    };

    socket.on('data', onData);
    socket.on('error', () => socket.destroy());
  }

  async close(): Promise<void> {
    if (this.activeClient) {
      const sock = this.activeClient;
      this.clearActiveClient();
      sock.destroy();
    }
    const srv = this.proxyServer;
    this.proxyServer = null;
    this.proxyPort = null;
    for (const sock of this.proxySockets) {
      if (!sock.destroyed) sock.destroy();
    }
    this.proxySockets.clear();
    if (srv) {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  }
}

let singletonTunnel: MobileTunnelServer | null = null;
let cachedTunnelToken: string | null = null;

export async function getOrCreateRecoveryTunnelToken(): Promise<string> {
  const fromEnv = process.env.RECOVERY_TUNNEL_TOKEN?.trim();
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  if (cachedTunnelToken) return cachedTunnelToken;
  try {
    const existing = await getSystemState(SystemKeys.recoveryTunnelToken);
    if (existing && existing.length >= 16) {
      cachedTunnelToken = existing;
      return existing;
    }
    const generated = randomBytes(24).toString('base64url');
    await setSystemState(SystemKeys.recoveryTunnelToken, generated);
    cachedTunnelToken = generated;
    return generated;
  } catch {
    // Fallback if database is temporarily unreachable during unit tests
    if (!cachedTunnelToken) cachedTunnelToken = randomBytes(24).toString('base64url');
    return cachedTunnelToken;
  }
}

export function getMobileTunnel(): MobileTunnelServer {
  if (!singletonTunnel) {
    singletonTunnel = new MobileTunnelServer({
      validateToken: async (candidate) => {
        const expectedTunnel = await getOrCreateRecoveryTunnelToken();
        if (sha256Equal(candidate, expectedTunnel)) return true;
        const setupToken = process.env.SETUP_TOKEN?.trim() || '';
        if (setupToken && sha256Equal(candidate, setupToken)) return true;
        return false;
      },
    });
  }
  return singletonTunnel;
}

export function buildMobileTunnelClientJs(): string {
  return `// Auto-generated Phone/Local IP Recovery Tunnel Client (Node 22+)
import net from 'node:net';
import dns from 'node:dns/promises';

const serverUrl = (process.env.TUNNEL_URL || process.argv[2] || '').trim();
const token = (process.env.TUNNEL_TOKEN || process.argv[3] || '').trim();

if (!serverUrl || !token) {
  console.error('Usage: TUNNEL_URL=wss://host/auth/recover/tunnel TUNNEL_TOKEN=... node tunnel-client.mjs');
  process.exit(1);
}
if (typeof WebSocket !== 'function') {
  console.error('Node.js 22+ is required (built-in WebSocket missing).');
  process.exit(1);
}

const ALLOWED_RE = /^(?:[a-z0-9-]+\\.)*(?:leetcode\\.com|leetcode\\.cn|cloudflare\\.com|challenges\\.cloudflare\\.com|cloudflareinsights\\.com|gstatic\\.com|google\\.com|hcaptcha\\.com|recaptcha\\.net)$/i;

function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(Number.isNaN)) return ip.includes(':');
  if (p[0] === 127 || p[0] === 10 || p[0] === 0) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
  return false;
}

let backoff = 2000;

function connectOnce() {
  console.log('[' + new Date().toISOString() + '] Connecting phone IP tunnel to ' + serverUrl);
  const ws = new WebSocket(serverUrl);
  ws.binaryType = 'arraybuffer';
  const sockets = new Map();
  let pingTimer = null;

  const cleanupAll = () => {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    for (const s of sockets.values()) { try { s.destroy(); } catch {} }
    sockets.clear();
  };

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ t: 'auth', token }));
  });

  ws.addEventListener('message', async (ev) => {
    if (typeof ev.data === 'string') {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'auth_ok') {
        backoff = 2000;
        console.log('[' + new Date().toISOString() + '] READY: Your phone IP tunnel is active! Keep Termux open/wakelocked; verify LeetCode right in Mobile Chrome.');
        pingTimer = setInterval(() => {
          try { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'ping' })); } catch {}
        }, 20000);
        return;
      }
      if (msg.t === 'open') {
        const id = msg.id;
        const host = String(msg.host || '').trim().toLowerCase();
        const port = Number(msg.port);
        if (port !== 443 || !ALLOWED_RE.test(host)) {
          ws.send(JSON.stringify({ t: 'err', id, msg: 'blocked host' }));
          return;
        }
        try {
          const addrs = await dns.lookup(host, { all: true });
          const pub = addrs.find((a) => !isPrivateIp(a.address));
          if (!pub) {
            ws.send(JSON.stringify({ t: 'err', id, msg: 'private ip blocked' }));
            return;
          }
          const sock = net.connect({ host: pub.address, port, family: pub.family });
          sock.setTimeout(15000, () => sock.destroy(new Error('timeout')));
          sockets.set(id, sock);
          sock.on('connect', () => {
            sock.setTimeout(0);
            if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'opened', id }));
          });
          sock.on('data', (chunk) => {
            if (ws.readyState !== 1) return;
            const out = new Uint8Array(4 + chunk.length);
            new DataView(out.buffer).setUint32(0, id, false);
            out.set(chunk, 4);
            ws.send(out);
          });
          sock.on('close', () => {
            sockets.delete(id);
            if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'close', id }));
          });
          sock.on('error', (err) => {
            const wasNew = !sock.remoteAddress;
            sockets.delete(id);
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ t: wasNew ? 'err' : 'close', id, msg: err.message }));
            }
          });
        } catch (err) {
          if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'err', id, msg: err.message || 'dial failed' }));
        }
        return;
      }
      if (msg.t === 'close') {
        const sock = sockets.get(msg.id);
        if (sock) { sockets.delete(msg.id); sock.end(); }
      }
      return;
    }

    const buf = new Uint8Array(ev.data);
    if (buf.byteLength < 4) return;
    const id = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, false);
    const sock = sockets.get(id);
    if (sock && !sock.destroyed) {
      sock.write(Buffer.from(buf.buffer, buf.byteOffset + 4, buf.byteLength - 4));
    }
  });

  ws.addEventListener('close', (ev) => {
    cleanupAll();
    console.log('[' + new Date().toISOString() + '] Disconnected (' + ev.code + '). Reconnecting in ' + Math.round(backoff / 1000) + 's...');
    setTimeout(connectOnce, backoff);
    backoff = Math.min(30000, Math.round(backoff * 1.5));
  });
  ws.addEventListener('error', () => {});
}

connectOnce();
`;
}

export function buildTermuxSetupSh(origin: string): string {
  const wsOrigin = origin.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  const tunnelUrl = `${wsOrigin}/auth/recover/tunnel`;
  const clientUrl = `${origin}/auth/recover/tunnel-client.mjs`;
  return `#!/usr/bin/env sh
set -eu
TOKEN="\${1:-}"
if [ -z "$TOKEN" ]; then
  echo "Usage: curl -fsSL '${origin}/auth/recover/termux-setup.sh' | sh -s -- '<TOKEN>'" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  if command -v pkg >/dev/null 2>&1; then
    echo "Installing Node.js in Termux..."
    pkg update -y && pkg install -y nodejs
  else
    echo "Node.js 22+ is required. Install Node.js first." >&2
    exit 1
  fi
fi

DIR="$HOME/lc-mobile-tunnel"
mkdir -p "$DIR"
curl -fsSL "${clientUrl}" -o "$DIR/tunnel-client.mjs"
umask 077
printf 'TUNNEL_URL=%s\nTUNNEL_TOKEN=%s\n' "${tunnelUrl}" "$TOKEN" > "$DIR/.env"

cat > "$DIR/start.sh" <<'EOF'
#!/usr/bin/env sh
set -eu
DIR="$HOME/lc-mobile-tunnel"
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock || true
fi
set -a
. "$DIR/.env"
set +a
exec node "$DIR/tunnel-client.mjs"
EOF
chmod +x "$DIR/start.sh"

# Auto-start on phone boot if Termux:Boot is installed
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/lc-mobile-tunnel.sh" <<'EOF'
#!/usr/bin/env sh
nohup "$HOME/lc-mobile-tunnel/start.sh" > "$HOME/lc-mobile-tunnel/tunnel.log" 2>&1 &
EOF
chmod +x "$HOME/.termux/boot/lc-mobile-tunnel.sh"

# 1-tap Termux:Widget shortcut if installed
mkdir -p "$HOME/.shortcuts"
cp "$DIR/start.sh" "$HOME/.shortcuts/LeetCode-IP-Tunnel"
chmod +x "$HOME/.shortcuts/LeetCode-IP-Tunnel"

echo "Starting Phone IP Tunnel now (press Ctrl+C to stop)..."
exec "$DIR/start.sh"
`;
}
