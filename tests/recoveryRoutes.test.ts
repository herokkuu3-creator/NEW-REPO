import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RECOVERY_COOKIE,
  WindowLimiter,
  registerRecoveryRoutes,
} from '../src/recovery/routes';
import type { RecoveryService } from '../src/recovery/service';

describe('Recovery Routes', () => {
  let app: FastifyInstance;
  let mockService: Partial<RecoveryService>;

  beforeEach(async () => {
    mockService = {
      inspectToken: vi.fn(async (token: string) => {
        if (token === 'valid-token-1234567890123456789012345678901') {
          return { state: 'valid', label: 'black_sheep_7' };
        }
        if (token === 'expired-token-1234567890123456789012345678') {
          return { state: 'expired' };
        }
        if (token === 'used-token-12345678901234567890123456789012') {
          return { state: 'used' };
        }
        if (token === 'cancelled-token-123456789012345678901234567') {
          return { state: 'cancelled' };
        }
        return { state: 'invalid' };
      }),
      openPortalSession: vi.fn(async (token: string) => {
        if (token === 'valid-token-1234567890123456789012345678901') {
          return { ok: true, secret: 'secret-session-key-12345678901234567890', label: 'black_sheep_7' };
        }
        if (token === 'used-token-12345678901234567890123456789012') {
          return { ok: false, reason: 'used' };
        }
        return { ok: false, reason: 'invalid' };
      }),
      portalStatus: vi.fn((secret) => {
        if (secret === 'secret-session-key-12345678901234567890') {
          return {
            phase: 'awaiting_verification' as const,
            message: 'Complete the verification shown below.',
            label: 'black_sheep_7',
            final: false,
            viewport: { width: 1024, height: 720 },
          };
        }
        return null;
      }),
      portalFrame: vi.fn(async (secret) => {
        if (secret === 'secret-session-key-12345678901234567890') {
          return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
        }
        return null;
      }),
      portalInput: vi.fn(async (secret, ev) => {
        return secret === 'secret-session-key-12345678901234567890';
      }),
      portalCancel: vi.fn(async (secret) => {
        return secret === 'secret-session-key-12345678901234567890';
      }),
    };

    app = Fastify();
    registerRecoveryRoutes(app, mockService as RecoveryService);
    await app.ready();
  });

  describe('GET /auth/recover/:token', () => {
    it('returns 200 with confirmation form for a valid token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/recover/valid-token-1234567890123456789012345678901',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-security-policy']).toBeDefined();
      expect(res.body).toContain('Reconnect <code>black_sheep_7</code>');
      expect(res.body).toContain('action="/auth/recover/valid-token-1234567890123456789012345678901/start"');
      expect(res.body).toContain('<button type="submit">Start recovery</button>');
    });

    it('returns 404 for an invalid token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/recover/non-existent-token-12345678901234567890123',
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).toContain('Link not valid');
    });

    it('returns 410 for an expired token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/recover/expired-token-1234567890123456789012345678',
      });
      expect(res.statusCode).toBe(410);
      expect(res.body).toContain('Link expired');
    });

    it('returns 409 for an already used token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/recover/used-token-12345678901234567890123456789012',
      });
      expect(res.statusCode).toBe(409);
      expect(res.body).toContain('Link already used');
    });

    it('returns 410 for a cancelled recovery token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/recover/cancelled-token-123456789012345678901234567',
      });
      expect(res.statusCode).toBe(410);
      expect(res.body).toContain('Recovery cancelled');
    });
  });

  describe('POST /auth/recover/:token/start', () => {
    it('consumes valid token, sets HttpOnly cookie, and 303 redirects to /auth/recover/session', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/recover/valid-token-1234567890123456789012345678901/start',
      });

      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/auth/recover/session');
      const setCookie = res.headers['set-cookie'] as string;
      expect(setCookie).toBeDefined();
      expect(setCookie).toContain(`${RECOVERY_COOKIE}=secret-session-key-12345678901234567890`);
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Strict');
      expect(setCookie).toContain('Path=/auth/recover');
    });

    it('returns 409 when attempting to consume an already used token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/recover/used-token-12345678901234567890123456789012/start',
      });

      expect(res.statusCode).toBe(409);
      expect(res.body).toContain('Link already used');
    });
  });

  describe('GET /auth/recover/session & Status/Frame endpoints', () => {
    it('returns 200 with HTML viewer and nonce-based CSP when session cookie is present', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/recover/session',
        headers: {
          cookie: `${RECOVERY_COOKIE}=secret-session-key-12345678901234567890`,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('Reconnect <code>black_sheep_7</code>');
      expect(res.body).toContain('<img id="screen"');
      expect(res.headers['content-security-policy']).toContain('nonce-');
    });

    it('returns 401 when accessing viewer without valid session cookie', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/recover/session',
      });

      expect(res.statusCode).toBe(401);
      expect(res.body).toContain('No active recovery');
    });

    it('returns JSON status for active session', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/recover/session/status',
        headers: {
          cookie: `${RECOVERY_COOKIE}=secret-session-key-12345678901234567890`,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.label).toBe('black_sheep_7');
      expect(json.phase).toBe('awaiting_verification');
      expect(json.viewport).toEqual({ width: 1024, height: 720 });
    });

    it('returns 401 status for unauthenticated status request', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/recover/session/status',
      });
      expect(res.statusCode).toBe(401);
    });

    it('streams JPEG frame from active browser session', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/recover/session/frame',
        headers: {
          cookie: `${RECOVERY_COOKIE}=secret-session-key-12345678901234567890`,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.rawPayload.length).toBeGreaterThan(0);
    });
  });

  describe('POST /auth/recover/session/input & /cancel', () => {
    it('accepts valid mouse input and routes to service', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/recover/session/input',
        headers: {
          cookie: `${RECOVERY_COOKIE}=secret-session-key-12345678901234567890`,
          'content-type': 'application/json',
        },
        payload: {
          type: 'down',
          x: 250,
          y: 400,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });
      expect(mockService.portalInput).toHaveBeenCalledWith(
        'secret-session-key-12345678901234567890',
        { type: 'down', x: 250, y: 400 },
      );
    });

    it('rejects keyboard or invalid input events with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/recover/session/input',
        headers: {
          cookie: `${RECOVERY_COOKIE}=secret-session-key-12345678901234567890`,
          'content-type': 'application/json',
        },
        payload: {
          type: 'keypress',
          key: 'a',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('cancels active recovery on request', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/recover/session/cancel',
        headers: {
          cookie: `${RECOVERY_COOKIE}=secret-session-key-12345678901234567890`,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(mockService.portalCancel).toHaveBeenCalledWith('secret-session-key-12345678901234567890');
    });
  });

  describe('Rate Limiting (WindowLimiter)', () => {
    it('blocks repeated requests exceeding configured limit', async () => {
      const limiter = new WindowLimiter(3, 1000);
      const testApp = Fastify();
      registerRecoveryRoutes(testApp, mockService as RecoveryService, { tokenLimiter: limiter });
      await testApp.ready();

      // Requests 1, 2, 3 should succeed
      for (let i = 0; i < 3; i++) {
        const res = await testApp.inject({
          method: 'GET',
          url: '/auth/recover/valid-token-1234567890123456789012345678901',
        });
        expect(res.statusCode).toBe(200);
      }

      // Request 4 from same IP blocked with 429
      const blockedRes = await testApp.inject({
        method: 'GET',
        url: '/auth/recover/valid-token-1234567890123456789012345678901',
      });
      expect(blockedRes.statusCode).toBe(429);
      expect(blockedRes.body).toContain('Too many requests');
    });
  });

  describe('Local-IP Recovery Routes', () => {
    const validToken = 'valid-token-1234567890123456789012345678901';
    const usedToken = 'used-token-12345678901234567890123456789012';

    beforeEach(() => {
      mockService.bootstrapLocalRecovery = vi.fn(async (token: string) => {
        if (token === validToken) {
          return {
            ok: true as const,
            label: 'black_sheep_7',
            expectedUsername: 'black_sheep_7',
            credentials: { identifier: 'black_sheep_7', password: 'secret-password' },
          };
        }
        return { ok: false as const, reason: 'expired' as const };
      });
      mockService.getRecoveryPollStatus = vi.fn(async (token: string) => {
        if (token === usedToken) {
          return { state: 'recovered' as const, label: 'black_sheep_7', username: 'black_sheep_7' };
        }
        if (token === validToken) {
          return { state: 'valid' as const, label: 'black_sheep_7', username: 'black_sheep_7' };
        }
        return { state: 'invalid' as const };
      });
      mockService.completeLocalRecovery = vi.fn(async (token: string, body: unknown) => {
        if (token !== validToken) {
          return {
            ok: false as const,
            httpStatus: 410 as const,
            reason: 'expired' as const,
            error: 'This recovery link has expired.',
          };
        }
        if (!body || (typeof body === 'object' && !('storageState' in body) && !('cookies' in body))) {
          return {
            ok: false as const,
            httpStatus: 400 as const,
            reason: 'invalid_payload' as const,
            error: 'Missing session payload.',
          };
        }
        return {
          ok: true as const,
          httpStatus: 200 as const,
          label: 'black_sheep_7',
          username: 'black_sheep_7',
          serverVerified: true,
        };
      });
    });

    it('renders local-IP recovery options and collapsible server-browser fallback on GET /auth/recover/:token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/auth/recover/${validToken}`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(`/auth/recover/${validToken}/launch.cmd`);
      expect(res.body).toContain(`/auth/recover/${validToken}/script.ps1`);
      expect(res.body).toContain('/auth/recover/userscript.user.js');
      expect(res.body).toContain('id="directUploadForm"');
      expect(res.body).toContain('<details class="card">');
    });

    it('renders Session Restored page for GET /auth/recover/:token?completed=1 when token was used', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/auth/recover/${usedToken}?completed=1`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Session Restored');
    });

    it('returns poll status on GET /auth/recover/:token/poll', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/auth/recover/${validToken}/poll`,
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        state: 'valid',
        label: 'black_sheep_7',
        username: 'black_sheep_7',
      });
    });

    it('returns bootstrap details with Cache-Control: no-store on POST /auth/recover/:token/bootstrap', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/auth/recover/${validToken}/bootstrap`,
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(JSON.parse(res.body)).toEqual({
        ok: true,
        label: 'black_sheep_7',
        expectedUsername: 'black_sheep_7',
        credentials: { identifier: 'black_sheep_7', password: 'secret-password' },
      });
    });

    it('handles POST /auth/recover/:token/complete and POST /auth/recover/:token', async () => {
      const resComplete = await app.inject({
        method: 'POST',
        url: `/auth/recover/${validToken}/complete`,
        payload: { cookies: 'LEETCODE_SESSION=abc; csrftoken=xyz' },
      });
      expect(resComplete.statusCode).toBe(200);
      expect(JSON.parse(resComplete.body)).toEqual({
        ok: true,
        httpStatus: 200,
        label: 'black_sheep_7',
        username: 'black_sheep_7',
        serverVerified: true,
        redirectUrl: `/auth/recover/${validToken}?completed=1`,
      });

      const resDirect = await app.inject({
        method: 'POST',
        url: `/auth/recover/${validToken}`,
        payload: { storageState: { cookies: [{ name: 'LEETCODE_SESSION', value: 'abc' }], origins: [] } },
      });
      expect(resDirect.statusCode).toBe(200);
      expect(JSON.parse(resDirect.body).redirectUrl).toBe(`/auth/recover/${validToken}?completed=1`);

      const resBad = await app.inject({
        method: 'POST',
        url: `/auth/recover/${validToken}/complete`,
        payload: {},
      });
      expect(resBad.statusCode).toBe(400);

      const resExpired = await app.inject({
        method: 'POST',
        url: `/auth/recover/expired-token-1234567890123456789012345678/complete`,
        payload: { cookies: 'LEETCODE_SESSION=abc' },
      });
      expect(resExpired.statusCode).toBe(410);
    });

    it('serves launch.cmd, script.ps1, script.sh, and userscript.user.js', async () => {
      const cmdRes = await app.inject({ method: 'GET', url: `/auth/recover/${validToken}/launch.cmd` });
      expect(cmdRes.statusCode).toBe(200);
      expect(cmdRes.headers['content-type']).toContain('application/x-bat');
      expect(cmdRes.body).toContain('ExecutionPolicy Bypass');
      expect(cmdRes.body).toContain(`/auth/recover/${validToken}/script.ps1`);

      const psRes = await app.inject({ method: 'GET', url: `/auth/recover/${validToken}/script.ps1` });
      expect(psRes.statusCode).toBe(200);
      expect(psRes.headers['content-type']).toContain('text/plain');
      expect(psRes.body).toContain('FromBase64String');

      const shRes = await app.inject({ method: 'GET', url: `/auth/recover/${validToken}/script.sh` });
      expect(shRes.statusCode).toBe(200);
      expect(shRes.headers['content-type']).toContain('text/plain');
      expect(shRes.body).toContain('exec node');

      const userJsRes = await app.inject({ method: 'GET', url: '/auth/recover/userscript.user.js' });
      expect(userJsRes.statusCode).toBe(200);
      expect(userJsRes.headers['content-type']).toContain('text/javascript');
      expect(userJsRes.body).toContain('==UserScript==');
      expect(userJsRes.body).toContain('GM_cookie');

      const setupRes = await app.inject({ method: 'GET', url: '/auth/recover/termux-setup.sh' });
      expect(setupRes.statusCode).toBe(200);
      expect(setupRes.headers['content-type']).toContain('text/x-shellscript');
      expect(setupRes.body).toContain('tunnel-client.mjs');

      const clientRes = await app.inject({ method: 'GET', url: '/auth/recover/tunnel-client.mjs' });
      expect(clientRes.statusCode).toBe(200);
      expect(clientRes.headers['content-type']).toContain('text/javascript');
      expect(clientRes.body).toContain('TUNNEL_TOKEN');
    });

    it('prioritizes Mobile Chrome verification, handles tap input, surfaces egress status, and passes mobile viewport on /start', async () => {
      mockService.getEgressStatus = vi.fn(async () => ({
        mode: 'mobile_tunnel' as const,
        label: 'Phone IP tunnel active',
      }));

      const portalRes = await app.inject({
        method: 'GET',
        url: `/auth/recover/${validToken}`,
      });
      expect(portalRes.statusCode).toBe(200);
      expect(portalRes.body).toContain('Phone-IP Tunnel ACTIVE');
      const startIdx = portalRes.body.indexOf('<button type="submit">Start recovery</button>');
      const detailsIdx = portalRes.body.indexOf('<details class="card">');
      expect(startIdx).toBeGreaterThan(-1);
      expect(detailsIdx).toBeGreaterThan(startIdx);

      const pollRes = await app.inject({
        method: 'GET',
        url: `/auth/recover/${validToken}/poll`,
      });
      expect(pollRes.statusCode).toBe(200);
      expect(JSON.parse(pollRes.body)).toEqual({
        state: 'valid',
        label: 'black_sheep_7',
        username: 'black_sheep_7',
        egress: { mode: 'mobile_tunnel', label: 'Phone IP tunnel active' },
      });

      const mobileStart = await app.inject({
        method: 'POST',
        url: `/auth/recover/${validToken}/start?mobile=1`,
      });
      expect(mobileStart.statusCode).toBe(303);
      expect(mockService.openPortalSession).toHaveBeenCalledWith(validToken, { mobile: true });

      const uaMobileStart = await app.inject({
        method: 'POST',
        url: `/auth/recover/${validToken}/start`,
        headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36' },
      });
      expect(uaMobileStart.statusCode).toBe(303);
      expect(mockService.openPortalSession).toHaveBeenCalledWith(validToken, { mobile: true });

      const tapRes = await app.inject({
        method: 'POST',
        url: '/auth/recover/session/input',
        headers: { cookie: `${RECOVERY_COOKIE}=secret-session-key-12345678901234567890` },
        payload: { type: 'tap', x: 145, y: 310 },
      });
      expect(tapRes.statusCode).toBe(200);
      expect(mockService.portalInput).toHaveBeenCalledWith(
        'secret-session-key-12345678901234567890',
        { type: 'tap', x: 145, y: 310 },
      );
    });
  });
});
