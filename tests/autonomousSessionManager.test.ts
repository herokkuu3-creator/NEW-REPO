import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountStatus } from '@prisma/client';

vi.mock('../src/database/accounts', async (original) => ({
  ...((await original()) as object),
  saveAccount: vi.fn(),
  listAccounts: vi.fn(async () => []),
  getAccountByLabel: vi.fn(async () => null),
  getAccountById: vi.fn(async () => null),
  patchAccount: vi.fn(),
}));

vi.mock('../src/database/models', async (original) => ({
  ...((await original()) as object),
  getSystemState: vi.fn(async () => null),
  setSystemState: vi.fn(async () => undefined),
}));

vi.mock('../src/security/credentialStore', async (original) => ({
  ...((await original()) as object),
  saveEncryptedCredentials: vi.fn(),
  findCredentialsForAccount: vi.fn(async () => null),
}));

vi.mock('../src/leetcode/auth', () => ({
  loginToLeetCode: vi.fn(),
}));

vi.mock('../src/security/sessionAutoRefresh', async (original) => ({
  ...((await original()) as object),
  refreshLeetCodeAccount: vi.fn(async (acc: any) => ({
    site: 'leetcode',
    label: acc.label,
    username: acc.username,
    status: 'valid',
  })),
}));

import {
  getAccountByLabel,
  listAccounts,
  patchAccount,
  saveAccount,
} from '../src/database/accounts';
import {
  findCredentialsForAccount,
  saveEncryptedCredentials,
} from '../src/security/credentialStore';
import { loginToLeetCode } from '../src/leetcode/auth';
import {
  clearLeetCodeLoginCooldownsForTests,
  formatRemainingTtl,
  getLeetCodeLoginCooldown,
  persistRotatedCookiesFromContext,
  recordLeetCodeLoginCooldown,
  verifyStoredLeetCodeAccount,
  withSingleFlightLogin,
  type LightweightLeetCodeSession,
} from '../src/leetcode/sessionManager';
import {
  handleExecuteLogin,
  handleLeetCodeLoginCommand,
  setPendingLeetCodeVerificationHandoff,
} from '../src/notifications/telegramBot';

function buildJwtCookie(username: string, refreshedAt: number, expirySeconds = 1209600): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      username,
      refreshed_at: refreshedAt,
      _session_expiry: expirySeconds,
    }),
  ).toString('base64url');
  return `${header}.${payload}.signature`;
}

describe('Autonomous Server-Side LeetCode Session Manager & Orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearLeetCodeLoginCooldownsForTests();
    setPendingLeetCodeVerificationHandoff(null);
  });

  it('verifies a stored LeetCode account via GraphQL userStatus and persists rotated cookies automatically', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const initialToken = buildJwtCookie('broZEdex', nowSec - 86_400);
    const rotatedToken = buildJwtCookie('broZEdex', nowSec);

    const initialState = {
      cookies: [
        { name: 'LEETCODE_SESSION', value: initialToken, domain: '.leetcode.com', path: '/', expires: nowSec + 100000 },
        { name: 'csrftoken', value: 'csrf_old', domain: '.leetcode.com', path: '/', expires: nowSec + 100000 },
      ],
      origins: [],
    };
    const rotatedState = {
      cookies: [
        { name: 'LEETCODE_SESSION', value: rotatedToken, domain: '.leetcode.com', path: '/', expires: nowSec + 1209600 },
        { name: 'csrftoken', value: 'csrf_new', domain: '.leetcode.com', path: '/', expires: nowSec + 1209600 },
      ],
      origins: [],
    };

    const closeMock = vi.fn(async () => undefined);
    const persistMock = vi.fn(async () => {
      await saveAccount('broZEdex', JSON.stringify(rotatedState), {
        username: 'broZEdex',
        status: AccountStatus.ACTIVE,
      });
      return true;
    });

    const fakeSession: LightweightLeetCodeSession = {
      api: {
        graphql: vi.fn(async () => ({
          userStatus: { isSignedIn: true, username: 'broZEdex' },
        })),
      } as any,
      request: {} as any,
      getStorageState: vi.fn(async () => rotatedState),
      persistUpdatedCookiesIfChanged: persistMock,
      close: closeMock,
    };

    const diag = await verifyStoredLeetCodeAccount(
      {
        id: 'acc-bro',
        label: 'broZEdex',
        username: 'broZEdex',
        storageState: JSON.stringify(initialState),
        status: AccountStatus.ACTIVE,
        lastError: null,
        lastCheckedAt: null,
        lastRunAt: null,
        lastResult: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        openSession: vi.fn(async () => fakeSession),
      },
    );

    expect(diag.authenticated).toBe(true);
    expect(diag.username).toBe('broZEdex');
    expect(diag.status).toBe(AccountStatus.ACTIVE);
    expect(diag.cookiesRotated).toBe(true);
    expect(diag.remainingTtlSeconds).toBeGreaterThan(1_200_000);
    expect(formatRemainingTtl(diag.remainingTtlSeconds)).toMatch(/^(13|14)d/);
    expect(persistMock).toHaveBeenCalledOnce();
    expect(patchAccount).toHaveBeenCalledWith(
      'acc-bro',
      expect.objectContaining({
        username: 'broZEdex',
        status: AccountStatus.ACTIVE,
        checked: true,
      }),
    );
    expect(closeMock).toHaveBeenCalledOnce();
  });

  it('persists rotated cookies from an active BrowserContext when Set-Cookie updates LEETCODE_SESSION or csrftoken', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const oldJwt = buildJwtCookie('scale5555', nowSec - 3600);
    const newJwt = buildJwtCookie('scale5555', nowSec);

    const initialState = {
      cookies: [
        { name: 'LEETCODE_SESSION', value: oldJwt, domain: '.leetcode.com', path: '/' },
        { name: 'csrftoken', value: 'csrf_1', domain: '.leetcode.com', path: '/' },
      ],
      origins: [],
    };

    const updatedCookies = [
      { name: 'LEETCODE_SESSION', value: newJwt, domain: '.leetcode.com', path: '/' },
      { name: 'csrftoken', value: 'csrf_2', domain: '.leetcode.com', path: '/' },
    ];

    const changed = await persistRotatedCookiesFromContext(
      { id: 'acc-1', label: 'scale5555', username: 'scale5555', status: AccountStatus.ACTIVE },
      initialState,
      {
        storageState: vi.fn(async () => ({ cookies: updatedCookies, origins: [] })),
      },
    );

    expect(changed).toBe(true);
    expect(saveAccount).toHaveBeenCalledWith(
      'scale5555',
      expect.stringContaining('csrf_2'),
      expect.objectContaining({
        username: 'scale5555',
        status: AccountStatus.ACTIVE,
      }),
    );
  });

  it('retries transient query-failed errors with bounded backoff and preserves ACTIVE account status', async () => {
    let callCount = 0;
    const openSession = vi.fn(async (): Promise<LightweightLeetCodeSession> => {
      callCount += 1;
      return {
        api: {
          graphql: vi.fn(async () => {
            if (callCount < 3) {
              throw new Error('Transient network timeout');
            }
            return { userStatus: { isSignedIn: true, username: 'thor_77' } };
          }),
        } as any,
        request: {} as any,
        getStorageState: vi.fn(async () => ({ cookies: [], origins: [] })),
        persistUpdatedCookiesIfChanged: vi.fn(async () => false),
        close: vi.fn(async () => undefined),
      };
    });

    const diag = await verifyStoredLeetCodeAccount(
      {
        id: 'acc-thor',
        label: 'thor_77',
        username: 'thor_77',
        storageState: JSON.stringify({
          cookies: [{ name: 'LEETCODE_SESSION', value: buildJwtCookie('thor_77', Math.floor(Date.now() / 1000)), domain: '.leetcode.com', path: '/' }],
          origins: [],
        }),
        status: AccountStatus.ACTIVE,
        lastError: null,
        lastCheckedAt: null,
        lastRunAt: null,
        lastResult: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        maxAttempts: 3,
        baseBackoffMs: 10,
        openSession,
      },
    );

    expect(diag.authenticated).toBe(true);
    expect(diag.attempts).toBe(3);
    expect(diag.username).toBe('thor_77');
  });

  it('deduplicates concurrent login attempts via withSingleFlightLogin and enforces login cooldown after VERIFICATION_REQUIRED', async () => {
    let underlyingCalls = 0;
    const task = () =>
      withSingleFlightLogin('black_sheep_7', async () => {
        underlyingCalls += 1;
        await new Promise((r) => setTimeout(r, 20));
        return { ok: true, attempt: underlyingCalls };
      });

    const [r1, r2, r3] = await Promise.all([task(), task(), task()]);
    expect(underlyingCalls).toBe(1);
    expect(r1).toEqual({ ok: true, attempt: 1 });
    expect(r2).toEqual({ ok: true, attempt: 1 });
    expect(r3).toEqual({ ok: true, attempt: 1 });

    const now = Date.now();
    await recordLeetCodeLoginCooldown(
      'black_sheep_7',
      'VERIFICATION_REQUIRED',
      'Cloudflare HTTP 403',
      60_000,
      now,
    );

    const status = await getLeetCodeLoginCooldown('black_sheep_7', now + 15_000);
    expect(status.coolingDown).toBe(true);
    expect(status.remainingSeconds).toBe(45);
    expect(status.code).toBe('VERIFICATION_REQUIRED');

    const expiredStatus = await getLeetCodeLoginCooldown('black_sheep_7', now + 61_000);
    expect(expiredStatus.coolingDown).toBe(false);
  });

  it('blocks redundant /lclogin browser launches while an account is in Cloudflare login cooldown', async () => {
    await recordLeetCodeLoginCooldown(
      'cooldown_user',
      'VERIFICATION_REQUIRED',
      'Cloudflare challenge on /accounts/login/',
      30 * 60 * 1000,
    );

    const reply = vi.fn(async (_msg: string) => undefined);
    await handleExecuteLogin('leetcode', 'cooldown_user', 'cooldown_user', 'pw123', reply);

    expect(loginToLeetCode).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
    expect(reply.mock.calls[0]?.[0]).toContain('LeetCode Login Cooldown Active');
  });

  it('executes autonomous server-side verification on /lclogin without asking for a password when accounts are stored', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const validJwt = buildJwtCookie('watch_me_win', nowSec);
    const storedAccount = {
      id: 'acc-watch',
      label: 'watch_me_win',
      username: 'watch_me_win',
      storageState: JSON.stringify({
        cookies: [{ name: 'LEETCODE_SESSION', value: validJwt, domain: '.leetcode.com', path: '/' }],
        origins: [],
      }),
      status: AccountStatus.ACTIVE,
      lastError: null,
      lastCheckedAt: new Date(),
      lastRunAt: new Date(),
      lastResult: 'SUCCESS',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    vi.mocked(listAccounts).mockResolvedValue([storedAccount]);
    vi.mocked(getAccountByLabel).mockResolvedValue(storedAccount);
    vi.mocked(findCredentialsForAccount).mockResolvedValue(null);

    const replies: string[] = [];
    await handleLeetCodeLoginCommand(undefined, async (msg) => {
      replies.push(msg);
    });

    expect(loginToLeetCode).not.toHaveBeenCalled();
    expect(replies.at(0)).toContain('Autonomous Server-Side LeetCode Authentication');
    expect(replies.at(-1)).toContain('watch_me_win');
    expect(replies.at(-1)).toContain('100% server-side via authenticated GraphQL/REST APIs');
  });
});
