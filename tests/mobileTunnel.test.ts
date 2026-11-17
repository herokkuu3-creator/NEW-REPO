import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MobileTunnelServer,
  buildMobileTunnelClientJs,
  buildTermuxSetupSh,
  decodeWsFrames,
  encodeWsFrame,
  isAllowedTunnelTarget,
  sha256Equal,
} from '../src/recovery/mobileTunnel';

describe('MobileTunnelServer & helpers', () => {
  const servers: http.Server[] = [];
  const tcpServers: net.Server[] = [];
  const tcpSockets: net.Socket[] = [];
  const tunnels: MobileTunnelServer[] = [];

  afterEach(async () => {
    for (const sock of tcpSockets.splice(0)) {
      if (!sock.destroyed) sock.destroy();
    }
    for (const t of tunnels.splice(0)) {
      await t.close().catch(() => undefined);
    }
    for (const s of servers.splice(0)) {
      s.closeAllConnections?.();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    for (const ts of tcpServers.splice(0)) {
      await new Promise<void>((resolve) => ts.close(() => resolve()));
    }
  });

  it('validates allowed LeetCode / Cloudflare hostnames on port 443 only', () => {
    expect(isAllowedTunnelTarget('leetcode.com', 443)).toBe(true);
    expect(isAllowedTunnelTarget('challenges.cloudflare.com', 443)).toBe(true);
    expect(isAllowedTunnelTarget('accounts.google.com', 443)).toBe(true);
    expect(isAllowedTunnelTarget('leetcode.com', 80)).toBe(false);
    expect(isAllowedTunnelTarget('127.0.0.1', 443)).toBe(false);
    expect(isAllowedTunnelTarget('169.254.169.254', 443)).toBe(false);
    expect(isAllowedTunnelTarget('[::1]', 443)).toBe(false);
    expect(isAllowedTunnelTarget('evil.example.com', 443)).toBe(false);
  });

  it('compares tokens in constant time via sha256Equal', () => {
    expect(sha256Equal('secret-token-abc', 'secret-token-abc')).toBe(true);
    expect(sha256Equal('secret-token-abc', 'secret-token-abd')).toBe(false);
    expect(sha256Equal('', '')).toBe(false);
  });

  it('encodes, decodes, unmasks, and handles partial WebSocket frames', () => {
    const payload = Buffer.from('hello-mobile-tunnel', 'utf8');
    const serverFrame = encodeWsFrame(0x01, payload);
    const decoded = decodeWsFrames(serverFrame);
    expect(decoded.protocolError).toBeUndefined();
    expect(decoded.remaining.length).toBe(0);
    expect(decoded.frames).toHaveLength(1);
    expect(decoded.frames[0]!.opcode).toBe(0x01);
    expect(decoded.frames[0]!.payload.toString('utf8')).toBe('hello-mobile-tunnel');

    // Masked client frame split across two chunks
    const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
    const rawMsg = Buffer.from('tunnel-data-frame', 'utf8');
    const maskedPayload = Buffer.alloc(rawMsg.length);
    for (let i = 0; i < rawMsg.length; i += 1) {
      maskedPayload[i] = rawMsg[i]! ^ mask[i & 3]!;
    }
    const header = Buffer.from([0x82, 0x80 | rawMsg.length]);
    const fullMasked = Buffer.concat([header, mask, maskedPayload]);
    const half1 = decodeWsFrames(fullMasked.subarray(0, 8));
    expect(half1.frames).toHaveLength(0);
    expect(half1.remaining.length).toBe(8);

    const half2 = decodeWsFrames(Buffer.concat([half1.remaining, fullMasked.subarray(8)]));
    expect(half2.frames).toHaveLength(1);
    expect(half2.frames[0]!.opcode).toBe(0x02);
    expect(half2.frames[0]!.payload.toString('utf8')).toBe('tunnel-data-frame');
  });

  it('generates valid Termux setup and standalone client scripts without embedding secrets', () => {
    const clientJs = buildMobileTunnelClientJs();
    expect(clientJs).toContain('TUNNEL_TOKEN');
    expect(clientJs).toContain('new WebSocket');
    expect(clientJs).toContain('isPrivateIp');

    const setupSh = buildTermuxSetupSh('https://bot.example.com');
    expect(setupSh).toContain('https://bot.example.com/auth/recover/tunnel-client.mjs');
    expect(setupSh).toContain('wss://bot.example.com/auth/recover/tunnel');
    expect(setupSh).toContain('TOKEN="${1:-}"');
  });

  it('authenticates WebSocket tunnel, blocks disallowed CONNECT hosts, and relays TCP streams end-to-end', async () => {
    const validToken = 'tunnel-secret-token-123456789012';
    const echoServer = net.createServer((sock) => {
      tcpSockets.push(sock);
      sock.on('data', (chunk) => sock.write(Buffer.concat([Buffer.from('echo:'), chunk])));
    });
    tcpServers.push(echoServer);
    await new Promise<void>((resolve) => echoServer.listen(0, '127.0.0.1', resolve));
    const echoPort = (echoServer.address() as net.AddressInfo).port;

    const tunnel = new MobileTunnelServer({
      validateToken: (candidate) => sha256Equal(candidate, validToken),
      isAllowedTarget: (host, port) => host === 'allowed.leetcode.test' && port === 443,
    });
    tunnels.push(tunnel);

    const httpSrv = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    httpSrv.on('upgrade', (req, socket, head) => {
      if (req.url === '/auth/recover/tunnel') tunnel.handleUpgrade(req, socket, head);
      else socket.destroy();
    });
    servers.push(httpSrv);
    await new Promise<void>((resolve) => httpSrv.listen(0, '127.0.0.1', resolve));
    const srvPort = (httpSrv.address() as net.AddressInfo).port;

    // 1. Invalid token should be closed with 4001 and stay disconnected
    await new Promise<void>((resolve) => {
      const badWs = new WebSocket(`ws://127.0.0.1:${srvPort}/auth/recover/tunnel`);
      badWs.addEventListener('open', () => {
        badWs.send(JSON.stringify({ t: 'auth', token: 'wrong-token' }));
      });
      badWs.addEventListener('close', (ev) => {
        expect(ev.code).toBe(4001);
        resolve();
      });
    });
    expect(tunnel.isConnected()).toBe(false);

    // 2. Valid client connects and acts as a relay to our echo TCP server
    const relaySockets = new Map<number, net.Socket>();
    const ws = new WebSocket(`ws://127.0.0.1:${srvPort}/auth/recover/tunnel`);
    ws.binaryType = 'arraybuffer';

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('auth timeout')), 5000);
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ t: 'auth', token: validToken }));
      });
      ws.addEventListener('message', (ev) => {
        if (typeof ev.data === 'string') {
          const msg = JSON.parse(ev.data) as { t: string; id?: number };
          if (msg.t === 'auth_ok') {
            clearTimeout(timer);
            resolve();
            return;
          }
          if (msg.t === 'open' && typeof msg.id === 'number') {
            const id = msg.id;
            const targetSock = net.connect(echoPort, '127.0.0.1', () => {
              ws.send(JSON.stringify({ t: 'opened', id }));
            });
            tcpSockets.push(targetSock);
            relaySockets.set(id, targetSock);
            targetSock.on('data', (chunk) => {
              const out = new Uint8Array(4 + chunk.length);
              new DataView(out.buffer).setUint32(0, id, false);
              out.set(chunk, 4);
              ws.send(out);
            });
            targetSock.on('close', () => {
              relaySockets.delete(id);
              if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'close', id }));
            });
            return;
          }
          if (msg.t === 'close' && typeof msg.id === 'number') {
            relaySockets.get(msg.id)?.end();
            relaySockets.delete(msg.id);
          }
          return;
        }
        const buf = new Uint8Array(ev.data as ArrayBuffer);
        const id = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, false);
        const targetSock = relaySockets.get(id);
        targetSock?.write(Buffer.from(buf.buffer, buf.byteOffset + 4, buf.byteLength - 4));
      });
      ws.addEventListener('close', () => {
        for (const s of relaySockets.values()) {
          if (!s.destroyed) s.destroy();
        }
        relaySockets.clear();
      });
    });

    expect(tunnel.isConnected()).toBe(true);
    const proxyUrl = await tunnel.ensureProxyListening();
    expect(proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const proxyPort = Number(new URL(proxyUrl!).port);

    // 3. Disallowed CONNECT target returns 403 Forbidden
    const blockedReply = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(proxyPort, '127.0.0.1', () => {
        sock.write('CONNECT evil.com:443 HTTP/1.1\r\nHost: evil.com:443\r\n\r\n');
      });
      let data = '';
      sock.on('data', (c) => { data += c.toString('utf8'); });
      sock.on('close', () => resolve(data));
      sock.on('error', reject);
    });
    expect(blockedReply).toContain('403 Forbidden');

    // 4. Allowed CONNECT target tunnels bidirectional bytes cleanly
    const echoed = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(proxyPort, '127.0.0.1', () => {
        sock.write('CONNECT allowed.leetcode.test:443 HTTP/1.1\r\nHost: allowed.leetcode.test:443\r\n\r\n');
      });
      let buf = '';
      let established = false;
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (!established && buf.includes('\r\n\r\n')) {
          established = true;
          expect(buf).toContain('200 Connection Established');
          buf = buf.split('\r\n\r\n')[1] ?? '';
          sock.write('ping-from-browser');
        } else if (established && buf.includes('echo:ping-from-browser')) {
          sock.end();
          resolve(buf);
        }
      });
      sock.on('error', reject);
    });
    expect(echoed).toBe('echo:ping-from-browser');

    ws.close();
  });
});
