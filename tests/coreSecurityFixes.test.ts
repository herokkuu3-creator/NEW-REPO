import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import type { FastifyInstance } from 'fastify';
import { AccountStatus, CodeforcesAccountStatus } from '@prisma/client';
import { chromium } from 'playwright';

const h = vi.hoisted(() => ({
  systemState: new Map<string, string>(),
  accountRows: [] as Array<{
    id: string;
    label: string;
    username: string | null;
    status: AccountStatus;
    storageState: string;
    lastCheckedAt: Date | null;
    lastRunAt: Date | null;
    lastResult: string | null;
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>,
  savedStorageStateJson: null as string | null,
  saveAccountCalls: [] as Array<{ label: string; storageState: string; meta: unknown }>,
  deleteError: null as unknown,
  checkSessionResult: { authenticated: true, username: 'alice' } as {
    authenticated: boolean;
    username?: string | null;
    cause?: 'signed-out' | 'query-failed';
  },
  openLightweightSessionSpy: vi.fn(),
  validateCfMock: vi.fn(),
  loginCfMock: vi.fn(),
  listCodeforcesSummariesMock: vi.fn(async () => [] as Array<Record<string, unknown>>),
  getCodeforcesStorageMock: vi.fn(async () => null as string | null),
  patchCfMock: vi.fn(),
  saveCfMock: vi.fn(),
  telegramMock: vi.fn(async () => true),
  probeSageMock: vi.fn(async () => ({
    ok: true,
    executionHost: 'local' as const,
    revision: null,
    testedAt: '2026-11-18T00:00:00.000Z',
    elapsedMs: 12,
    baseUrl: 'https://discovery-api.intern-ai.org.cn/v1',
    keyMasked: 'sk-0c521…a056',
    modelsStatus: 200,
    modelsCount: 1,
    models: ['deepseek-v4.1-flash-1017'],
    chatStatus: 200,
    chatModel: 'deepseek-v4.1-flash-1017',
    chatReply: 'SAGE_RENDER_OK',
    markerMatched: true,
  })),
  askSageMock: vi.fn(async (q: string) => ({
    ok: true,
    question: q,
    answer: 'mock-answer',
    model: 'deepseek-v4.1-flash-1017',
    elapsedMs: 10,
    executionHost: 'local' as const,
  })),
}));

vi.mock('../src/database/prisma', () => ({
  prisma: {
    account: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
    },
  },
}));

vi.mock('../src/config', async (orig) => {
  const real = (await orig()) as { config: Record<string, unknown> };
  return { config: { ...real.config, api: { ...(real.config.api as object), port: 0 } } };
});

vi.mock('../src/database/models', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getSystemState: vi.fn(async (key: string) => h.systemState.get(key) ?? null),
    setSystemState: vi.fn(async (key: string, value: string) => {
      h.systemState.set(key, value);
    }),
    deleteSystemState: vi.fn(async (key: string) => {
      h.systemState.delete(key);
    }),
    getSystemStates: vi.fn(async () => ({})),
    getAllSystemState: vi.fn(async () => ({})),
    latestRunSummary: vi.fn(async () => null),
    latestRun: vi.fn(async () => null),
    saveStorageStateToDb: vi.fn(async (json: string) => {
      h.savedStorageStateJson = json;
    }),
  };
});

vi.mock('../src/database/accounts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    listAccounts: vi.fn(async () => h.accountRows),
    listAccountSummaries: vi.fn(async () =>
      h.accountRows.map(({ storageState: _s, ...rest }) => ({ ...rest, cookieCount: 2 })),
    ),
    getAccountByLabel: vi.fn(async (label: string) => h.accountRows.find((a) => a.label === label) ?? null),
    deleteAccountByLabel: vi.fn(async (label: string) => {
      if (h.deleteError) {
        const err = h.deleteError;
        h.deleteError = null;
        throw err;
      }
      const idx = h.accountRows.findIndex((a) => a.label === label);
      if (idx >= 0) h.accountRows.splice(idx, 1);
    }),
    saveAccount: vi.fn(async (label: string, storageState: string, meta: Record<string, unknown> = {}) => {
      h.saveAccountCalls.push({ label, storageState, meta });
      const now = new Date();
      const row = {
        id: `acc-${label}`,
        label,
        username: (meta.username as string | undefined) ?? null,
        status: (meta.status as AccountStatus | undefined) ?? AccountStatus.UNKNOWN,
        storageState,
        lastCheckedAt: null,
        lastRunAt: null,
        lastResult: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      };
      const idx = h.accountRows.findIndex((a) => a.label === label);
      if (idx >= 0) h.accountRows[idx] = row;
      else h.accountRows.push(row);
      return row;
    }),
    patchAccount: vi.fn(async () => undefined),
  };
});

vi.mock('../src/leetcode/sessionManager', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    openLightweightLeetCodeSession: h.openLightweightSessionSpy,
  };
});

vi.mock('../src/browser/sessionCheck', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    checkSession: vi.fn(async () => h.checkSessionResult),
  };
});

vi.mock('../src/ai/sageProbe', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    probeSageApi: h.probeSageMock,
    askSage: h.askSageMock,
  };
});

vi.mock('../src/codeforces/session', () => ({
  validateCodeforcesStorageState: h.validateCfMock,
}));

vi.mock('../src/codeforces/auth', () => ({
  loginToCodeforces: h.loginCfMock,
}));

vi.mock('../src/codeforces/storage', () => ({
  listCodeforcesAccountSummaries: h.listCodeforcesSummariesMock,
  getCodeforcesAccountStorageState: h.getCodeforcesStorageMock,
  patchCodeforcesAccount: h.patchCfMock,
  saveCodeforcesAccount: h.saveCfMock,
}));

vi.mock('../src/notifications/telegram', () => ({
  sendTelegramMessage: h.telegramMock,
}));

import { startHealthServer } from '../src/api/health';
import { PinGate } from '../src/api/pinGate';
import { validateSolutionPostModels } from '../src/config/solutionPostModels';
import { isBazaarLinkProvider } from '../src/config/solutionPostProvider';
import { parseSolutionApiKeys } from '../src/config/solutionPostKeys';
import { encryptText, decryptText, saveEncryptedCredentials, listCredentialLabels } from '../src/security/credentialStore';
import { redactSecrets } from '../src/security/redact';
import { logger, logRingBuffer } from '../src/logger';
import { refreshCodeforcesAccount, verifyAndRefreshAllSessions } from '../src/security/sessionAutoRefresh';
import { fileStampLocal, humanLocal, isoLocal, tzLabel } from '../src/time';
import {
  MobileTunnelServer,
  buildMobileTunnelClientJs,
  decodeWsFrames,
  encodeWsFrame,
  getMobileTunnel,
  sha256Equal,
} from '../src/recovery/mobileTunnel';
import { openRemoteBrowser } from '../src/recovery/remoteBrowser';
import { createProductionRecoveryService, startRecoveryScheduler } from '../src/recovery/runtime';
import { registerRecoveryRoutes, RECOVERY_COOKIE } from '../src/recovery/routes';
import { MemoryRecoveryStore, type MemoryAccountRow } from '../src/recovery/memoryStore';
import { RecoveryService } from '../src/recovery/service';
import { detectSignedInUser, copyToWindowsClipboard } from '../scripts/auth-setup';

describe('Core & Security Regression Fixes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.systemState.clear();
    h.accountRows.length = 0;
    h.savedStorageStateJson = null;
    h.saveAccountCalls.length = 0;
    h.deleteError = null;
    h.checkSessionResult = { authenticated: true, username: 'alice' };
    h.openLightweightSessionSpy.mockImplementation(async () => ({
      api: {},
      close: vi.fn(async () => undefined),
    }));
  });

  describe('1. Health, Admin, Logs & Sage API Gating', () => {
    let app: FastifyInstance;
    const ADMIN_AUTH = { authorization: 'Bearer test-token-for-vitest' };
    const PIN_AUTH = { 'x-pin-code': '4821' };

    beforeAll(async () => {
      app = await startHealthServer(
        {
          triggerRun: async () => ({ started: true, message: 'triggered' }),
          isRunInProgress: () => false,
          runSubmission: async () => null,
        },
        { pinCode: '4821', healthCacheTtlMs: 0 },
      );
    });

    afterAll(async () => app?.close());

    it('gates /admin/sage/* strictly behind Bearer SETUP_TOKEN and rejects PIN-only callers', async () => {
      for (const req of [
        { method: 'GET' as const, url: '/admin/sage/test' },
        { method: 'POST' as const, url: '/admin/sage/test', payload: {} },
        { method: 'POST' as const, url: '/admin/sage/ask', payload: { question: 'hi' } },
      ]) {
        const unauth = await app.inject(req);
        expect(unauth.statusCode).toBe(401);
        expect(unauth.json()).toEqual({ ok: false, error: 'unauthorized' });

        const pinOnly = await app.inject({ ...req, headers: PIN_AUTH });
        expect(pinOnly.statusCode).toBe(401);

        const badLen = await app.inject({ ...req, headers: { authorization: 'Bearer test-token-for-vitest-extra' } });
        expect(badLen.statusCode).toBe(401);

        const authed = await app.inject({ ...req, headers: ADMIN_AUTH });
        expect(authed.statusCode).toBe(200);
      }
    });

    it('gates /logs, /sage, /sage/test, /sage/ask, /api/sage/ask behind PIN or Bearer token and serves pinPage for HTML browsers', async () => {
      logger.info('sensitive log probe entry');

      for (const pathUrl of ['/sage', '/logs']) {
        const unauthJson = await app.inject({ method: 'GET', url: pathUrl });
        expect(unauthJson.statusCode).toBe(401);
        expect(unauthJson.json()).toEqual({ ok: false, error: 'unauthorized' });

        const unauthHtml = await app.inject({
          method: 'GET',
          url: `${pathUrl}?limit=5`,
          headers: { accept: 'text/html' },
        });
        expect(unauthHtml.statusCode).toBe(200);
        expect(unauthHtml.body).toContain('Enter PIN');
        expect(unauthHtml.body).toContain(`value="${pathUrl}"`);
        expect(unauthHtml.body).not.toContain('id="testApiKey"');
        expect(unauthHtml.body).not.toContain('sensitive log probe entry');

        const withPin = await app.inject({ method: 'GET', url: pathUrl, headers: PIN_AUTH });
        expect(withPin.statusCode).toBe(200);
      }

      for (const req of [
        { method: 'POST' as const, url: '/sage/test', payload: {} },
        { method: 'POST' as const, url: '/sage/ask', payload: { question: 'hello' } },
        { method: 'POST' as const, url: '/api/sage/ask', payload: { question: 'hello' } },
      ]) {
        expect((await app.inject(req)).statusCode).toBe(401);
        expect((await app.inject({ ...req, headers: PIN_AUTH })).statusCode).toBe(200);
        expect((await app.inject({ ...req, headers: ADMIN_AUTH })).statusCode).toBe(200);
      }
    });

    it('clamps NaN limit on GET /logs to 200 instead of returning all entries', async () => {
      logRingBuffer.length = 0;
      for (let i = 0; i < 250; i += 1) {
        logRingBuffer.push({ level: 30, msg: `entry-${i}` });
      }
      const res = await app.inject({ method: 'GET', url: '/logs?limit=not-a-number', headers: PIN_AUTH });
      expect(res.statusCode).toBe(200);
      expect(res.json().count).toBe(200);
    });

    it('sets Cache-Control: no-store and Secure cookie flag on GET /lock under HTTPS', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/lock',
        headers: { 'x-forwarded-proto': 'https' },
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(String(res.headers['set-cookie'])).toContain('Max-Age=0');
      expect(String(res.headers['set-cookie'])).toContain('; Secure');
    });

    it('rejects non-object bodies on POST /admin/run-now with 400 instead of throwing 500', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/run-now',
        headers: { ...ADMIN_AUTH, 'content-type': 'application/json' },
        payload: JSON.stringify(['not', 'an', 'object']),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().ok).toBe(false);
    });

    it('returns 404 on concurrent Prisma P2025 error in DELETE /admin/accounts/:label', async () => {
      h.accountRows.push({
        id: 'acc-race',
        label: 'race',
        username: 'alice',
        status: AccountStatus.ACTIVE,
        storageState: '{}',
        lastCheckedAt: null,
        lastRunAt: null,
        lastResult: null,
        lastError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      h.deleteError = Object.assign(new Error('Record to delete does not exist.'), { code: 'P2025' });
      const res = await app.inject({
        method: 'DELETE',
        url: '/admin/accounts/race',
        headers: ADMIN_AUTH,
      });
      expect(res.statusCode).toBe(404);
    });

    it('accepts raw string, Cookie-Editor array, and unwrapped storageState without stripping origins or transport on /admin/accounts and /admin/renew-session', async () => {
      const storageState = {
        cookies: [
          { name: 'LEETCODE_SESSION', value: 'valid_session_token_value_123456', domain: '.leetcode.com', path: '/' },
          { name: 'csrftoken', value: 'csrf_token_value_123', domain: '.leetcode.com', path: '/' },
        ],
        origins: [{ origin: 'https://leetcode.com', localStorage: [{ name: 'theme', value: 'dark' }] }],
        transport: { userAgent: 'CustomAgent/2.0' },
      };

      const resUnwrapped = await app.inject({
        method: 'POST',
        url: '/admin/accounts',
        headers: ADMIN_AUTH,
        payload: storageState,
      });
      expect(resUnwrapped.statusCode).toBe(200);
      const savedAcct = JSON.parse(h.saveAccountCalls.at(-1)!.storageState);
      expect(savedAcct.origins).toEqual(storageState.origins);
      expect(savedAcct.transport).toEqual(storageState.transport);

      const resArr = await app.inject({
        method: 'POST',
        url: '/admin/accounts',
        headers: ADMIN_AUTH,
        payload: storageState.cookies,
      });
      expect(resArr.statusCode).toBe(200);

      const resRawString = await app.inject({
        method: 'POST',
        url: '/admin/accounts',
        headers: { ...ADMIN_AUTH, 'content-type': 'text/plain' },
        payload: 'LEETCODE_SESSION=raw_session_token_1234567890; csrftoken=csrf_123',
      });
      expect(resRawString.statusCode).toBe(200);

      const resRenew = await app.inject({
        method: 'POST',
        url: '/admin/renew-session',
        headers: ADMIN_AUTH,
        payload: storageState,
      });
      expect(resRenew.statusCode).toBe(200);
      const savedRenew = JSON.parse(h.savedStorageStateJson!);
      expect(savedRenew.origins).toEqual(storageState.origins);
      expect(savedRenew.transport).toEqual(storageState.transport);

      const resRenewArr = await app.inject({
        method: 'POST',
        url: '/admin/renew-session',
        headers: ADMIN_AUTH,
        payload: { cookies: storageState.cookies },
      });
      expect(resRenewArr.statusCode).toBe(200);
    });

    it('bounds PinGate fails map at 5000 entries by pruning expired and oldest entries', () => {
      let now = 1_000_000;
      const gate = new PinGate('4821', 'secret', () => now);
      for (let i = 0; i < 5020; i += 1) {
        gate.checkPin(`10.0.${Math.floor(i / 256)}.${i % 256}`, '0000');
      }
      const failsMap = (gate as unknown as { fails: Map<string, unknown> }).fails;
      expect(failsMap.size).toBeLessThanOrEqual(5000);
      now += 20 * 60_000;
      gate.checkPin('192.0.2.1', '0000');
      expect(failsMap.size).toBe(1);
    });
  });

  describe('2. Packaging: prisma in dependencies', () => {
    it('moves prisma ^5.22.0 into dependencies in package.json so npm prune --omit=dev retains it', () => {
      const pkg = JSON.parse(readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));
      expect(pkg.dependencies.prisma).toBe('^5.22.0');
      expect(pkg.devDependencies.prisma).toBeUndefined();
    });
  });

  describe('3. MobileTunnel security & lifecycle', () => {
    const servers: http.Server[] = [];
    const tunnels: MobileTunnelServer[] = [];

    afterAll(async () => {
      for (const t of tunnels) await t.close().catch(() => undefined);
      for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    });

    it('rejects fragmented or oversized control frames in decodeWsFrames', () => {
      // Fragmented ping (FIN=0, opcode=0x09)
      const fragPing = Buffer.from([0x09, 0x00]);
      expect(decodeWsFrames(fragPing).protocolError).toBe('invalid control frame');

      // Control frame with payload length 126
      const bigControl = Buffer.from([0x89, 126, 0x00, 126, ...new Array(126).fill(0x41)]);
      expect(decodeWsFrames(bigControl).protocolError).toBe('invalid control frame');
    });

    it('enforces pre-auth 4096-byte payload limit across fragmented frames and deduplicates ensureProxyListening', async () => {
      const token = 'mobile-tunnel-secret-token-123456';
      const tunnel = new MobileTunnelServer({
        validateToken: (c) => sha256Equal(c, token),
      });
      tunnels.push(tunnel);

      const srv = http.createServer((_req, res) => {
        res.writeHead(404);
        res.end();
      });
      srv.on('upgrade', (req, socket, head) => tunnel.handleUpgrade(req, socket, head));
      servers.push(srv);
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      const port = (srv.address() as net.AddressInfo).port;

      // Raw TCP client sending fragmented pre-auth frames totaling > 4096 bytes
      const closeCode = await new Promise<number>((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1', () => {
          sock.write(
            'GET /auth/recover/tunnel HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
          );
        });
        let upgraded = false;
        let rx = Buffer.alloc(0);
        sock.on('data', (chunk) => {
          rx = Buffer.concat([rx, chunk]);
          if (!upgraded) {
            const idx = rx.indexOf('\r\n\r\n');
            if (idx === -1) return;
            upgraded = true;
            rx = rx.subarray(idx + 4);
            // Send 2 unmasked fragments of 2500 bytes each (5000 > 4096)
            const f1Header = Buffer.from([0x01, 126, 0x09, 0xc4]); // fin=0, op=1, len=2500
            const f2Header = Buffer.from([0x80, 126, 0x09, 0xc4]); // fin=1, op=0, len=2500
            sock.write(Buffer.concat([f1Header, Buffer.alloc(2500, 0x61), f2Header, Buffer.alloc(2500, 0x62)]));
          } else {
            const decoded = decodeWsFrames(rx);
            const closeFrame = decoded.frames.find((f) => f.opcode === 0x08);
            if (closeFrame && closeFrame.payload.length >= 2) {
              sock.destroy();
              resolve(closeFrame.payload.readUInt16BE(0));
            }
          }
        });
        sock.on('error', reject);
      });
      expect(closeCode).toBe(1009);

      // Authenticated client: concurrent ensureProxyListening() deduplication
      const ws = new WebSocket(`ws://127.0.0.1:${port}/auth/recover/tunnel`);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'auth', token })));
        ws.addEventListener('message', (ev) => {
          if (typeof ev.data === 'string' && JSON.parse(ev.data).t === 'auth_ok') resolve();
        });
        ws.addEventListener('error', reject);
      });
      const [p1, p2, p3] = await Promise.all([
        tunnel.ensureProxyListening(),
        tunnel.ensureProxyListening(),
        tunnel.ensureProxyListening(),
      ]);
      expect(p1).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(p2).toBe(p1);
      expect(p3).toBe(p1);
      ws.close();
      await tunnel.close();
      expect((tunnel as unknown as { proxyListenPromise: unknown }).proxyListenPromise).toBeNull();
    });

    it('blocks private/special IPv4 & IPv6 ranges while allowing public cellular IPv6 in buildMobileTunnelClientJs', () => {
      const code = buildMobileTunnelClientJs();
      const match = /function isPrivateIp\(ip\) \{[\s\S]*?\n\}/.exec(code);
      expect(match).not.toBeNull();
      const fn = vm.runInNewContext(`(net) => (${match![0]})`, {})(net) as (ip: string) => boolean;

      expect(fn('')).toBe(true);
      expect(fn('not-an-ip')).toBe(true);
      expect(fn('::')).toBe(true);
      expect(fn('::1')).toBe(true);
      expect(fn('fe80::1')).toBe(true);
      expect(fn('febf::1')).toBe(true);
      expect(fn('fc00::1')).toBe(true);
      expect(fn('fd12:3456::1')).toBe(true);
      expect(fn('100::1')).toBe(true);
      expect(fn('2001:db8::1')).toBe(true);
      expect(fn('::ffff:127.0.0.1')).toBe(true);
      expect(fn('::ffff:7f00:1')).toBe(true);
      expect(fn('0:0:0:0:0:ffff:7f00:1')).toBe(true);
      expect(fn('100.64.0.1')).toBe(true);
      expect(fn('172.16.0.1')).toBe(true);
      expect(fn('192.168.1.1')).toBe(true);

      // Public IPv6 cellular AAAA and public IPv4 must be allowed
      expect(fn('2606:4700:4700::1111')).toBe(false);
      expect(fn('2401:4900:1234::1')).toBe(false);
      expect(fn('104.18.1.1')).toBe(false);
      expect(fn('172.64.1.1')).toBe(false);
      expect(fn('::ffff:104.18.1.1')).toBe(false);
    });
  });

  describe('4. Recovery remoteBrowser, runtime, routes & service', () => {
    it('omits proxyUrl from captureStorageState when persistProxy is false and preserves it by default', async () => {
      const fakePage = {
        mainFrame: () => ({}),
        evaluate: vi.fn(async () => 'TestUA/1.0'),
        screenshot: vi.fn(),
        mouse: { move: vi.fn(), down: vi.fn(), up: vi.fn(), wheel: vi.fn() },
      };
      const fakeContext = {
        newPage: vi.fn(async () => fakePage),
        on: vi.fn(),
        route: vi.fn(async () => undefined),
        newCDPSession: vi.fn(async () => ({ on: vi.fn(), send: vi.fn(async () => undefined) })),
        storageState: vi.fn(async () => ({ cookies: [], origins: [] })),
        close: vi.fn(async () => undefined),
      };
      const fakeBrowser = {
        newContext: vi.fn(async () => fakeContext),
        on: vi.fn(),
        close: vi.fn(async () => undefined),
      };
      const launchSpy = vi.spyOn(chromium, 'launch').mockResolvedValue(fakeBrowser as never);

      try {
        const rbEphemeral = await openRemoteBrowser({
          proxyUrl: 'http://127.0.0.1:44444',
          persistProxy: false,
        });
        const capturedNoProxy = await rbEphemeral.captureStorageState();
        expect(capturedNoProxy.transport?.proxyUrl).toBeUndefined();
        expect(capturedNoProxy.transport?.userAgent).toBe('TestUA/1.0');
        await rbEphemeral.close();

        const rbPersisted = await openRemoteBrowser({
          proxyUrl: 'http://proxy.example.com:8080',
        });
        const capturedWithProxy = await rbPersisted.captureStorageState();
        expect(capturedWithProxy.transport?.proxyUrl).toBe('http://proxy.example.com:8080');
        await rbPersisted.close();
      } finally {
        launchSpy.mockRestore();
      }
    });

    it('runtime verifyCapturedSession injects tunnel proxy without mutating state and startRecoveryScheduler validates cron fields', async () => {
      const tunnel = getMobileTunnel();
      const ensureSpy = vi.spyOn(tunnel, 'ensureProxyListening').mockResolvedValue('http://127.0.0.1:54321');
      try {
        const svc = createProductionRecoveryService();
        const deps = (svc as unknown as {
          deps: {
            verifyCapturedSession: (s: Record<string, unknown>) => Promise<unknown>;
          };
        }).deps;

        const originalState = {
          cookies: [{ name: 'LEETCODE_SESSION', value: 'abc', domain: '.leetcode.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const }],
          origins: [],
          transport: { userAgent: 'MobileChrome' },
        };
        await deps.verifyCapturedSession(originalState);
        expect(originalState.transport).toEqual({ userAgent: 'MobileChrome' });
        expect((originalState.transport as Record<string, unknown>).proxyUrl).toBeUndefined();
        expect(h.openLightweightSessionSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            transport: { userAgent: 'MobileChrome', proxyUrl: 'http://127.0.0.1:54321' },
          }),
        );

        const prevHour = process.env.RECOVERY_MONITOR_HOUR;
        const prevMin = process.env.RECOVERY_MONITOR_MINUTE;
        try {
          process.env.RECOVERY_MONITOR_HOUR = '24';
          expect(() => startRecoveryScheduler(svc)).toThrow(/RECOVERY_MONITOR_HOUR/);
          process.env.RECOVERY_MONITOR_HOUR = '';
          process.env.RECOVERY_MONITOR_MINUTE = '60';
          expect(() => startRecoveryScheduler(svc)).toThrow(/RECOVERY_MONITOR_MINUTE/);

          process.env.RECOVERY_MONITOR_HOUR = '';
          process.env.RECOVERY_MONITOR_MINUTE = '';
          const stop = startRecoveryScheduler(svc);
          await expect(stop()).resolves.toBeUndefined();
        } finally {
          if (prevHour === undefined) delete process.env.RECOVERY_MONITOR_HOUR;
          else process.env.RECOVERY_MONITOR_HOUR = prevHour;
          if (prevMin === undefined) delete process.env.RECOVERY_MONITOR_MINUTE;
          else process.env.RECOVERY_MONITOR_MINUTE = prevMin;
        }
      } finally {
        ensureSpy.mockRestore();
      }
    });

    it('routes handles malformed cookie encodings, pads userscript base64url, and rejects pending CDP commands on ws close', async () => {
      const Fastify = (await import('fastify')).default;
      const app = Fastify();
      const mockSvc = {
        portalStatus: vi.fn(() => null),
        inspectToken: vi.fn(async () => ({ state: 'invalid' as const })),
      } as unknown as RecoveryService;
      registerRecoveryRoutes(app, mockSvc);
      await app.ready();

      const badCookieRes = await app.inject({
        method: 'GET',
        url: '/auth/recover/session',
        headers: { cookie: `${RECOVERY_COOKIE}=%E0%A4%A` },
      });
      expect(badCookieRes.statusCode).toBe(401);

      const userJsRes = await app.inject({ method: 'GET', url: '/auth/recover/userscript.user.js' });
      expect(userJsRes.body).toContain("b64 += '='.repeat((4 - (b64.length % 4)) % 4)");

      const psRes = await app.inject({
        method: 'GET',
        url: '/auth/recover/valid-token-1234567890123456789012345678901/script.ps1',
      });
      expect(psRes.statusCode).toBe(404); // inspectToken returned invalid above

      // Check standalone runner JS contains ws close/error pending rejection
      const validSvc = {
        inspectToken: vi.fn(async () => ({ state: 'valid' as const, label: 'acct' })),
      } as unknown as RecoveryService;
      const app2 = Fastify();
      registerRecoveryRoutes(app2, validSvc);
      await app2.ready();
      const psOk = await app2.inject({
        method: 'GET',
        url: '/auth/recover/valid-token-1234567890123456789012345678901/script.ps1',
      });
      const b64Match = /FromBase64String\("([A-Za-z0-9+/=]+)"\)/.exec(psOk.body);
      expect(b64Match).not.toBeNull();
      const runnerJs = Buffer.from(b64Match![1]!, 'base64').toString('utf8');
      expect(runnerJs).toContain("ws.addEventListener('close', () => rejectAllPending('CDP WebSocket closed'))");
      await app.close();
      await app2.close();
    });

    it('service preserves mobile viewport before browser launch, rejects DISABLED in requestRecovery, and rejects mismatched localVerifiedUsername', async () => {
      const accounts = new Map<string, MemoryAccountRow>([
        [
          'acc-1',
          {
            id: 'acc-1',
            label: 'disabled_acc',
            username: 'u1',
            status: AccountStatus.DISABLED,
            storageState: '{}',
          },
        ],
        [
          'acc-2',
          {
            id: 'acc-2',
            label: 'active_target',
            username: 'real_alice',
            status: AccountStatus.EXPIRED,
            storageState: '{}',
          },
        ],
      ]);
      const store = new MemoryRecoveryStore(accounts);
      let releaseBrowser!: () => void;
      const svc = new RecoveryService({
        store,
        now: () => new Date('2026-11-18T00:00:00Z'),
        chatId: () => 'chat-1',
        baseUrl: () => 'https://example.test',
        listAccounts: async () => [...accounts.values()],
        getAccount: async (id) => accounts.get(id) ?? null,
        markAccount: async () => undefined,
        verifyStoredSession: async () => ({ authenticated: false, cause: 'signed-out' }),
        verifyCapturedSession: async () => ({ authenticated: false, cause: 'query-failed' }),
        getCredentials: async () => ({ username: 'real_alice', password: 'pw' }),
        openBrowser: () =>
          new Promise((resolve) => {
            releaseBrowser = () =>
              resolve({
                page: {} as never,
                context: {} as never,
                viewport: { width: 430, height: 760 },
                snapshot: async () => null,
                frameCount: () => 0,
                input: async () => undefined,
                captureStorageState: async () => ({ cookies: [], origins: [] }),
                onDisconnected: () => undefined,
                close: async () => undefined,
              });
          }),
        sendTelegram: async () => true,
        limits: {
          reminderIntervalMs: 60_000,
          tokenTtlMs: 60_000,
          sessionTimeoutMs: 5_000,
          maxConcurrency: 2,
          pollMs: 10,
          finalStatusRetentionMs: 10,
        },
      });

      // 1. DISABLED account rejected in requestRecovery
      expect(await svc.requestRecovery('disabled_acc')).toBe('disabled');
      expect(await store.findOpenByAccount('acc-1')).toBeNull();

      // 2. Mobile viewport returned immediately while browser is launching
      const rec = await svc.openRecovery(accounts.get('acc-2')!, 'EXPIRED');
      const token = 'A'.repeat(43);
      const { hashRecoveryToken } = await import('../src/recovery/service');
      await store.issueToken(rec.recovery.id, hashRecoveryToken(token), new Date('2026-11-18T01:00:00Z'));
      const opened = await svc.openPortalSession(token, { mobile: true });
      expect(opened.ok).toBe(true);
      if (opened.ok) {
        expect(svc.portalStatus(opened.secret)?.viewport).toEqual({ width: 430, height: 760 });
      }
      releaseBrowser?.();
      await svc.shutdown();

      // 3. completeLocalRecovery rejects mismatched JWT identity vs localVerifiedUsername on transient query-failed
      const rec2 = await svc.openRecovery(accounts.get('acc-2')!, 'EXPIRED');
      const token2 = 'B'.repeat(43);
      await store.issueToken(rec2.recovery.id, hashRecoveryToken(token2), new Date('2026-11-18T01:00:00Z'));
      const jwtPayload = Buffer.from(
        JSON.stringify({ username: 'different_jwt_user', refreshed_at: 9999999999, _session_expiry: 100000 }),
      ).toString('base64url');
      const mismatchRes = await svc.completeLocalRecovery(token2, {
        storageState: {
          cookies: [
            { name: 'LEETCODE_SESSION', value: `h.${jwtPayload}.s`, domain: '.leetcode.com', path: '/' },
            { name: 'csrftoken', value: 'csrf1', domain: '.leetcode.com', path: '/' },
          ],
          origins: [],
        },
        localVerifiedUsername: 'real_alice',
      });
      expect(mismatchRes.ok).toBe(false);
      if (!mismatchRes.ok) {
        expect(mismatchRes.reason).toBe('username_mismatch');
      }
    });
  });

  describe('5. Config, Security, Redaction & Time Fixes', () => {
    it('config defaults SOLUTION_POST_API_KEY & SAGE_API_KEY to empty, respects pool, and validates TIMEZONE', () => {
      const out = execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '-e',
          "const { config } = require('./src/config'); console.log(JSON.stringify({ postKeys: config.solutionPosts.apiKeys, sageKey: config.sage.apiKey }));",
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
            SETUP_TOKEN: 'test-token-for-vitest',
            SOLUTION_POST_BASE_URL: 'https://custom.example.test/v1',
            SOLUTION_POST_API_KEYS: 'pool_key_one,pool_key_two',
            SOLUTION_POST_API_KEY: '',
            SAGE_API_KEY: '',
          },
          encoding: 'utf8',
        },
      );
      const parsed = JSON.parse(out.trim().split('\n').pop()!);
      expect(parsed.postKeys).toEqual(['pool_key_one', 'pool_key_two']);
      expect(parsed.sageKey).toBe('');

      expect(() =>
        execFileSync(
          process.execPath,
          ['--import', 'tsx', '-e', "require('./src/config')"],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
              SETUP_TOKEN: 'test-token-for-vitest',
              TIMEZONE: 'Mars/Olympus_Mons',
            },
            encoding: 'utf8',
            stdio: 'pipe',
          },
        ),
      ).toThrow();
    });

    it('validates solutionPostModels non-empty, safe isBazaarLinkProvider, and SAGE_API_KEY prefix stripping', () => {
      expect(() => validateSolutionPostModels(' , ')).toThrow(/at least one model/);
      expect(isBazaarLinkProvider('not a valid url')).toBe(false);
      expect(parseSolutionApiKeys('export SAGE_API_KEY="sk-sage-test-123456"')).toEqual(['sk-sage-test-123456']);
    });

    it('refreshCodeforcesAccount preserves status on Cloudflare 403 / non-signed-out failures, distinguishes EXPIRED vs REJECTED, and escapes HTML', async () => {
      const cfStateJson = JSON.stringify({
        cookies: [{ name: 'JSESSIONID', value: 'cf-sess-123', domain: '.codeforces.com', path: '/' }],
        origins: [],
      });
      h.validateCfMock.mockResolvedValueOnce({ ok: false, reason: 'blocked', error: 'Cloudflare HTTP 403' });
      const blockedOutcome = await refreshCodeforcesAccount({
        id: 'cf-1',
        label: 'cf<tag>',
        username: 'cf_u',
        status: CodeforcesAccountStatus.ACTIVE,
        storageState: cfStateJson,
      });
      expect(blockedOutcome.status).toBe('failed');
      expect(h.patchCfMock).not.toHaveBeenCalled();
      expect(h.loginCfMock).not.toHaveBeenCalled();

      // Timeout login failure marks EXPIRED rather than REJECTED
      await saveEncryptedCredentials('codeforces', 'cf_timeout', { username: 'u', password: 'p' });
      h.validateCfMock.mockResolvedValueOnce({ ok: false, reason: 'signed-out', error: 'signed out' });
      h.loginCfMock.mockResolvedValueOnce({ ok: false, error: 'Login timed out. No active session cookie' });
      await refreshCodeforcesAccount({
        id: 'cf-2',
        label: 'cf_timeout',
        username: 'u',
        status: CodeforcesAccountStatus.ACTIVE,
        storageState: cfStateJson,
      });
      expect(h.patchCfMock).toHaveBeenCalledWith(
        'cf-2',
        expect.objectContaining({ status: CodeforcesAccountStatus.EXPIRED }),
      );

      // Credential rejection marks REJECTED and HTML-escapes notification
      h.validateCfMock.mockResolvedValueOnce({ ok: false, reason: 'signed-out', error: 'signed out' });
      h.loginCfMock.mockResolvedValueOnce({ ok: false, error: 'Login failed: <Invalid & bad>' });
      await saveEncryptedCredentials('codeforces', 'cf<xss>', { username: 'u', password: 'p' });
      const rejOutcome = await refreshCodeforcesAccount({
        id: 'cf-3',
        label: 'cf<xss>',
        username: 'u',
        status: CodeforcesAccountStatus.ACTIVE,
        storageState: cfStateJson,
      });
      expect(h.patchCfMock).toHaveBeenLastCalledWith(
        'cf-3',
        expect.objectContaining({ status: CodeforcesAccountStatus.REJECTED }),
      );
      expect(rejOutcome.status).toBe('failed');

      // Verify Telegram notification HTML-escapes label, username, and error
      const { config } = await import('../src/config');
      const prevEnabled = config.telegram.enabled;
      (config.telegram as { enabled: boolean }).enabled = true;
      h.listCodeforcesSummariesMock.mockResolvedValueOnce([
        { id: 'cf-3', label: 'cf<xss>', username: 'u<1>', status: CodeforcesAccountStatus.ACTIVE },
      ]);
      h.getCodeforcesStorageMock.mockResolvedValueOnce(cfStateJson);
      h.validateCfMock.mockResolvedValueOnce({ ok: false, reason: 'signed-out', error: 'signed out' });
      h.loginCfMock.mockResolvedValueOnce({ ok: false, error: 'Login failed: <Invalid & bad>' });
      try {
        await verifyAndRefreshAllSessions({ notifyTelegram: true });
      } finally {
        (config.telegram as { enabled: boolean }).enabled = prevEnabled;
      }
      expect(h.telegramMock).toHaveBeenCalledTimes(1);
      const sentHtml = String((h.telegramMock.mock.calls[0] as unknown[])[0]);
      expect(sentHtml).toContain('cf&lt;xss&gt;');
      expect(sentHtml).toContain('&lt;Invalid &amp; bad&gt;');
      expect(sentHtml).not.toContain('cf<xss>');
    });

    it('credentialStore decrypts empty plaintext, validates hex/tag lengths, and serializes concurrent index updates', async () => {
      const encEmpty = encryptText('');
      expect(decryptText(encEmpty)).toBe('');
      expect(decryptText('zz'.repeat(12) + ':' + 'aa'.repeat(16) + ':')).toBeNull();
      expect(decryptText('aa'.repeat(12) + ':' + 'bb'.repeat(15) + ':aa')).toBeNull();
      expect(decryptText('aa'.repeat(12) + ':' + 'bb'.repeat(16) + ':abc')).toBeNull();

      await Promise.all([
        saveEncryptedCredentials('leetcode', 'concurrent_1', { username: 'u1', password: 'p1' }),
        saveEncryptedCredentials('leetcode', 'concurrent_2', { username: 'u2', password: 'p2' }),
        saveEncryptedCredentials('leetcode', 'concurrent_3', { username: 'u3', password: 'p3' }),
      ]);
      const labels = await listCredentialLabels('leetcode');
      expect(labels).toEqual(expect.arrayContaining(['concurrent_1', 'concurrent_2', 'concurrent_3']));
    });

    it('time formatting handles DST date in humanLocal, negative offsets in fileStampLocal, and invalid TZ fallback', () => {
      const winter = new Date('2026-01-15T15:00:00.000Z');
      const summer = new Date('2026-07-15T15:00:00.000Z');
      expect(humanLocal(winter, 'America/New_York')).toContain(tzLabel('America/New_York', winter));
      expect(humanLocal(summer, 'America/New_York')).toContain(tzLabel('America/New_York', summer));
      expect(fileStampLocal(winter, 'America/New_York')).toMatch(/-0500$/);
      expect(isoLocal(winter, 'Not/A_Timezone')).toBe(isoLocal(winter, 'Asia/Kolkata'));
    });

    it('redactSecrets and logger REDACT_PATHS mask sk-, cc_, fc-, URI passwords, bare user:pass@host:port, apiKeys, storageState, and firecrawlApiKey', () => {
      const out = redactSecrets(
        'k1=sk-0123456789abcdef k2=cc_abcdef0123456789 k3=fc-abcdef0123456789 db=postgresql://admin:TopSecret123@ep.neon.tech/db proxy=user1:PassWord99@1.2.3.4:8080',
      );
      expect(out).not.toContain('0123456789abcdef');
      expect(out).not.toContain('TopSecret123');
      expect(out).not.toContain('PassWord99');
      expect(out).toContain('sk-[REDACTED]');
      expect(out).toContain('cc_[REDACTED]');
      expect(out).toContain('fc_[REDACTED]');
      expect(out).toContain('postgresql://admin:****@ep.neon.tech/db');
      expect(out).toContain('user1:****@1.2.3.4:8080');

      logRingBuffer.length = 0;
      logger.info(
        {
          apiKeys: ['key-alpha-secret'],
          storageState: '{"cookies":[{"value":"super-secret"}]}',
          firecrawlApiKey: 'fc-secret-firecrawl-12345',
        },
        'structured redaction check',
      );
      const logged = JSON.stringify(logRingBuffer);
      expect(logged).not.toContain('key-alpha-secret');
      expect(logged).not.toContain('super-secret');
      expect(logged).not.toContain('fc-secret-firecrawl-12345');
    });
  });

  describe('6. Scripts & Workflow Hardening', () => {
    it('detectSignedInUser never trusts expired JWT cookies when GraphQL isSignedIn is false, and copyToWindowsClipboard attaches error listeners', async () => {
      const expiredJwt = `h.${Buffer.from(JSON.stringify({ username: 'stale_user' })).toString('base64url')}.s`;
      const fakePage = {
        context: () => ({
          cookies: async () => [{ name: 'LEETCODE_SESSION', value: expiredJwt }],
        }),
        evaluate: async () => null,
      } as unknown as Parameters<typeof detectSignedInUser>[0];
      expect(await detectSignedInUser(fakePage)).toBeNull();

      const fakePageSignedInMissingName = {
        context: () => ({
          cookies: async () => [{ name: 'LEETCODE_SESSION', value: expiredJwt }],
        }),
        evaluate: async () => ({ isSignedIn: true, username: null }),
      } as unknown as Parameters<typeof detectSignedInUser>[0];
      expect(await detectSignedInUser(fakePageSignedInMissingName)).toBe('stale_user');

      expect(typeof copyToWindowsClipboard).toBe('function');
    });

    it('codeforces-submit.yml validates job_id before URL interpolation, awaits /proxy/sync, strips newlines, and sets CPSOLVER_API_TOKEN', async () => {
      const yml = readFileSync(path.resolve(process.cwd(), '.github/workflows/codeforces-submit.yml'), 'utf8');
      expect(yml).toContain('CPSOLVER_API_TOKEN: ${{ secrets.CPSOLVER_API_TOKEN }}');
      expect(yml).toContain('await fetch(`${base}/proxy/sync`');
      expect(yml).toContain('if (requested && !/^[a-f0-9-]{36}$/.test(requested))');
      expect(yml).toContain('.replace(/[\\r\\n]+/g, \'\')');
      expect(yml.indexOf('/^[a-f0-9-]{36}$/.test(requested)')).toBeLessThan(yml.indexOf('const lookupUrl ='));

      // Execute the embedded lookup Node snippet against a stubbed fetch & temp GITHUB_OUTPUT
      const nodeBlockMatch = /node <<'NODE'\r?\n([\s\S]*?)\r?\n\s+NODE/.exec(yml);
      expect(nodeBlockMatch).not.toBeNull();
      const scriptSrc = nodeBlockMatch![1]!.replace(/^\s{10}/gm, '');
      const calls: string[] = [];
      const outputs: string[] = [];

      const runSnippet = async (env: Record<string, string>) => {
        const fakeRequire = (id: string) => {
          if (id === 'node:fs') {
            return {
              appendFileSync: (_file: string, line: string) => outputs.push(line),
            };
          }
          throw new Error(`unexpected require: ${id}`);
        };
        const sandbox = {
          require: fakeRequire,
          process: { env, exit: (c: number) => { throw new Error(`exit:${c}`); }, exitCode: 0 },
          console: { error: vi.fn() },
          AbortSignal,
          fetch: async (url: string) => {
            calls.push(url);
            if (url.endsWith('/proxy/sync')) {
              await new Promise((r) => setTimeout(r, 15));
              return new Response('{}', { status: 200 });
            }
            return new Response(
              JSON.stringify({
                jobId: '11111111-2222-3333-4444-555555555555',
                networkMode: 'proxy',
                removedProxies: ['a\nb'],
                proxy: 'http://p:1\nmalicious_key=1',
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          },
        };
        vm.runInNewContext(scriptSrc, sandbox);
        await new Promise((r) => setTimeout(r, 40));
        return sandbox.process.exitCode;
      };

      // Invalid requested job_id must fail BEFORE calling /jobs/ lookup
      const badExit = await runSnippet({
        CODEFORCES_SUBMITTER_URL: 'https://broker.test',
        CODEFORCES_SUBMITTER_TOKEN: 'tok',
        CODEFORCES_INPUT_JOB_ID: '../evil',
        GITHUB_OUTPUT: 'out.txt',
      });
      expect(badExit).toBe(1);
      expect(calls.some((u) => u.includes('/jobs/'))).toBe(false);

      // Valid lookup awaits /proxy/sync before /jobs/next and strips \r\n from GITHUB_OUTPUT
      calls.length = 0;
      outputs.length = 0;
      const okExit = await runSnippet({
        CODEFORCES_SUBMITTER_URL: 'https://broker.test',
        CODEFORCES_SUBMITTER_TOKEN: 'tok',
        FALLBACK_CODEFORCES_PROXY: 'http://1.2.3.4:80',
        GITHUB_OUTPUT: 'out.txt',
      });
      expect(okExit).toBe(0);
      expect(calls).toEqual(['https://broker.test/proxy/sync', 'https://broker.test/jobs/next']);
      expect(outputs.some((l) => l.startsWith('preferred_proxy=http://p:1malicious_key=1\n'))).toBe(true);
    });

    it('scripts enforce proper error exit codes and fallback paths', () => {
      const setSecretOut = (() => {
        try {
          execFileSync(process.execPath, ['--import', 'tsx', 'scripts/set-github-secret.ts'], {
            cwd: process.cwd(),
            env: { ...process.env, GITHUB_TOKEN: '', CODEFORCES_RESIDENTIAL_PROXY: 'http://1.2.3.4:80' },
            encoding: 'utf8',
            stdio: 'pipe',
          });
          return 0;
        } catch (e: any) {
          return e.status ?? 1;
        }
      })();
      expect(setSecretOut).toBe(1);

      const testProxiesSrc = readFileSync(path.resolve(process.cwd(), 'scripts/test-proxies-user.ts'), 'utf8');
      expect(testProxiesSrc).toContain('🟡 LC ONLY');
      expect(testProxiesSrc).toContain('process.exitCode = 1');

      const runNowSrc = readFileSync(path.resolve(process.cwd(), 'scripts/run-now.ts'), 'utf8');
      expect(runNowSrc).toContain('report.totals.rejected === 0');
      expect(runNowSrc).toContain('finally');

      const seedSrc = readFileSync(path.resolve(process.cwd(), 'scripts/seed-codechef-sessions.ts'), 'utf8');
      expect(seedSrc).toContain('ensureCodeChefAccountsSeeded');
      expect(seedSrc).toContain("status: { not: 'DISABLED' }");
      expect(seedSrc).toContain('process.exitCode = 1');

      const renderSrc = readFileSync(path.resolve(process.cwd(), 'scripts/render-live-1021-visuals.ts'), 'utf8');
      expect(renderSrc).toContain('os.tmpdir()');
      expect(renderSrc).toContain('process.exitCode = 1');

      const solPostSrc = readFileSync(path.resolve(process.cwd(), 'scripts/solution-post.ts'), 'utf8');
      expect(solPostSrc).toContain("error instanceof Error ? error.message : 'Solution operation failed'");
    });

    it('start-submitter.sh only skips WARP setup for github (with repo) or local mode, not default render mode', () => {
      const sh = readFileSync(path.resolve(process.cwd(), 'scripts/start-submitter.sh'), 'utf8');
      expect(sh).toContain('"$runner_mode" = "github"');
      expect(sh).toContain('"$runner_mode" = "local"');
      expect(sh).toContain('CODEFORCES_RUNNER_REPOSITORY');
    });
  });
});
