import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountStatus } from '@prisma/client';

vi.mock('../src/database/accounts', async (original) => ({
  ...((await original()) as object),
  saveAccount: vi.fn(),
  listAccounts: vi.fn(async () => []),
  patchAccount: vi.fn(),
}));

vi.mock('../src/security/credentialStore', async (original) => ({
  ...((await original()) as object),
  saveEncryptedCredentials: vi.fn(),
}));

import { listAccounts, patchAccount, saveAccount } from '../src/database/accounts';
import { saveEncryptedCredentials } from '../src/security/credentialStore';
import {
  cancelAllLeetCodePairingSessions,
  clearLeetCodePairingSessionsForTests,
  completeLeetCodePairingSession,
  createLeetCodePairingSession,
  formatTelegramPairingPrompt,
  getLeetCodePairingSession,
  renderLeetCodePairingPortalHtml,
} from '../src/leetcode/loginHandoff';
import { parseCompanionCliArgs, pushSessionToPairingEndpoint } from '../scripts/auth-setup';

const SAMPLE_JWT_COOKIE =
  'LEETCODE_SESSION=eyJhbGciOiJIUzI1NiJ9.eyJ1c2VybmFtZSI6ImJsYWNrX3NoZWVwXzciLCJyZWZyZXNoZWRfYXQiOjE3OTM5MzAwMDAsIl9zZXNzaW9uX2V4cGlyeSI6MTIwOTYwMH0.sig; csrftoken=csrf12345';

describe('Telegram-Initiated LeetCode Interactive Pairing & Companion Flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearLeetCodePairingSessionsForTests();
  });

  it('creates a cryptographically random, single-use, short-lived pairing session and formats the Telegram prompt', () => {
    const session = createLeetCodePairingSession({
      label: 'black_sheep_7',
      baseUrl: 'https://leetcode-daily-agent-ascq.onrender.com',
      ttlMs: 10 * 60 * 1000,
    });

    expect(session.token.length).toBeGreaterThanOrEqual(40);
    expect(session.status).toBe('pending');
    expect(session.pairingUrl).toBe(
      `https://leetcode-daily-agent-ascq.onrender.com/auth/leetcode/${session.token}`,
    );
    expect(session.companionCommand).toBe(
      `npm run auth:login -- "https://leetcode-daily-agent-ascq.onrender.com/auth/leetcode/${session.token}"`,
    );

    const prompt = formatTelegramPairingPrompt(session, { reason: 'command' });
    expect(prompt).toContain('Connect your LeetCode account');
    expect(prompt).toContain(session.pairingUrl);
    expect(prompt).toContain('npm run auth:login --');
    expect(prompt).toContain('black_sheep_7');

    const portalHtml = renderLeetCodePairingPortalHtml(session);
    expect(portalHtml).toContain('Connect Your LeetCode Account');
    expect(portalHtml).toContain(session.pairingUrl);
    expect(portalHtml).toContain('npm run auth:login --');
  });

  it('completes a pairing session, validates live against LeetCode GraphQL, marks ACTIVE, and sends Telegram confirmation', async () => {
    vi.mocked(saveAccount).mockResolvedValue({
      id: 'acc-1',
      label: 'black_sheep_7',
      username: 'black_sheep_7',
      status: AccountStatus.UNKNOWN,
    } as any);
    vi.mocked(listAccounts).mockResolvedValue([
      {
        id: 'acc-1',
        label: 'black_sheep_7',
        username: 'black_sheep_7',
        status: AccountStatus.ACTIVE,
      } as any,
    ]);

    const session = createLeetCodePairingSession({
      label: 'black_sheep_7',
      identifier: 'black_sheep_7',
      password: 'secret_password_123',
    });

    const notifyTelegram = vi.fn(async () => true);
    const validator = vi.fn(async () => ({
      ok: true as const,
      username: 'black_sheep_7',
    }));

    const outcome = await completeLeetCodePairingSession(
      session.token,
      {
        cookies: SAMPLE_JWT_COOKIE,
        localVerifiedUsername: 'black_sheep_7',
      },
      { validator, notifyTelegram },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('Expected pairing completion to succeed');

    expect(outcome.httpStatus).toBe(200);
    expect(outcome.username).toBe('black_sheep_7');
    expect(outcome.accountStatus).toBe(AccountStatus.ACTIVE);
    expect(outcome.serverVerified).toBe(true);
    expect(outcome.localVsServerMismatch).toBe(false);

    expect(validator).toHaveBeenCalledOnce();
    expect(patchAccount).toHaveBeenCalledWith(
      'acc-1',
      expect.objectContaining({
        username: 'black_sheep_7',
        status: AccountStatus.ACTIVE,
        checked: true,
      }),
    );
    expect(saveEncryptedCredentials).toHaveBeenCalledWith('leetcode', 'black_sheep_7', {
      username: 'black_sheep_7',
      password: 'secret_password_123',
      label: 'black_sheep_7',
    });
    expect(notifyTelegram).toHaveBeenCalledOnce();
    expect(outcome.telegramMessage).toContain('✅ <b>LeetCode login successful!</b>');
    expect(outcome.telegramMessage).toContain('black_sheep_7');
    expect(outcome.telegramMessage).toContain('/triggersubmission');
  });

  it('prevents replay attacks by rejecting reuse of an already-completed pairing token with HTTP 409', async () => {
    vi.mocked(saveAccount).mockResolvedValue({
      id: 'acc-1',
      label: 'black_sheep_7',
      username: 'black_sheep_7',
      status: AccountStatus.UNKNOWN,
    } as any);

    const session = createLeetCodePairingSession({ label: 'black_sheep_7' });
    const validator = vi.fn(async () => ({ ok: true as const, username: 'black_sheep_7' }));
    const notifyTelegram = vi.fn(async () => true);

    const first = await completeLeetCodePairingSession(
      session.token,
      { cookies: SAMPLE_JWT_COOKIE },
      { validator, notifyTelegram },
    );
    expect(first.ok).toBe(true);

    const replay = await completeLeetCodePairingSession(
      session.token,
      { cookies: SAMPLE_JWT_COOKIE },
      { validator, notifyTelegram },
    );
    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error('Expected replay to be rejected');
    expect(replay.httpStatus).toBe(409);
    expect(replay.code).toBe('TOKEN_ALREADY_USED');
    expect(validator).toHaveBeenCalledOnce();
  });

  it('rejects expired and cancelled pairing tokens with HTTP 410 and unknown tokens with HTTP 404', async () => {
    const unknown = await completeLeetCodePairingSession('unknown_token_value_1234567890', {
      cookies: SAMPLE_JWT_COOKIE,
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.httpStatus).toBe(404);
      expect(unknown.code).toBe('INVALID_TOKEN');
    }

    const session = createLeetCodePairingSession({ label: 'user1', ttlMs: 60_000 });
    const expiredLookup = getLeetCodePairingSession(session.token, session.expiresAt + 1);
    expect(expiredLookup?.status).toBe('expired');

    const expiredAttempt = await completeLeetCodePairingSession(session.token, {
      cookies: SAMPLE_JWT_COOKIE,
    });
    expect(expiredAttempt.ok).toBe(false);
    if (!expiredAttempt.ok) {
      expect(expiredAttempt.httpStatus).toBe(410);
      expect(expiredAttempt.code).toBe('TOKEN_EXPIRED');
    }

    const cancellable = createLeetCodePairingSession({ label: 'user2' });
    expect(cancelAllLeetCodePairingSessions()).toBe(1);
    const cancelledAttempt = await completeLeetCodePairingSession(cancellable.token, {
      cookies: SAMPLE_JWT_COOKIE,
    });
    expect(cancelledAttempt.ok).toBe(false);
    if (!cancelledAttempt.ok) {
      expect(cancelledAttempt.httpStatus).toBe(410);
      expect(cancelledAttempt.code).toBe('TOKEN_CANCELLED');
    }
  });

  it('detects when a session is valid locally in the companion browser but rejected on Render, without marking ACTIVE', async () => {
    vi.mocked(saveAccount).mockResolvedValue({
      id: 'acc-mismatch',
      label: 'black_sheep_7',
      username: 'black_sheep_7',
      status: AccountStatus.UNKNOWN,
    } as any);

    const session = createLeetCodePairingSession({
      label: 'black_sheep_7',
      identifier: 'black_sheep_7',
      password: 'secret_password_123',
    });

    const notifyTelegram = vi.fn(async () => true);
    const validator = vi.fn(async () => ({
      ok: false as const,
      reason: 'signed-out' as const,
      error: 'LeetCode reported userStatus.isSignedIn = false',
    }));

    const outcome = await completeLeetCodePairingSession(
      session.token,
      {
        cookies: SAMPLE_JWT_COOKIE,
        localVerifiedUsername: 'black_sheep_7',
      },
      { validator, notifyTelegram },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('Expected server rejection to return ok: false');

    expect(outcome.httpStatus).toBe(422);
    expect(outcome.code).toBe('SERVER_VERIFICATION_FAILED');
    expect(outcome.localVerifiedUsername).toBe('black_sheep_7');
    expect(outcome.accountStatus).toBe(AccountStatus.REJECTED);
    expect(outcome.serverVerified).toBe(false);
    expect(outcome.localVsServerMismatch).toBe(true);

    // Must NOT mark ACTIVE or store credentials when server verification fails
    expect(patchAccount).toHaveBeenCalledWith(
      'acc-mismatch',
      expect.objectContaining({
        status: AccountStatus.REJECTED,
      }),
    );
    expect(saveEncryptedCredentials).not.toHaveBeenCalled();
    expect(notifyTelegram).toHaveBeenCalledOnce();
    expect(outcome.telegramMessage).toContain('Verified Locally, Rejected on Server');
    expect(outcome.telegramMessage).toContain('not</b> marked ACTIVE');
  });

  it('parses CLI arguments and uploads storageState from the local browser companion', async () => {
    const parsed = parseCompanionCliArgs([
      'https://leetcode-daily-agent-ascq.onrender.com/auth/leetcode/abcDEF1234567890_token',
    ]);
    expect(parsed.pairingUrl).toBe(
      'https://leetcode-daily-agent-ascq.onrender.com/auth/leetcode/abcDEF1234567890_token',
    );

    const mockFetch = vi.fn(async () => ({
      status: 200,
      json: async () => ({
        ok: true,
        username: 'black_sheep_7',
        accountStatus: 'ACTIVE',
        serverVerified: true,
      }),
    })) as unknown as typeof fetch;

    const upload = await pushSessionToPairingEndpoint(
      parsed.pairingUrl!,
      JSON.stringify({ cookies: [], origins: [] }),
      'black_sheep_7',
      mockFetch,
    );

    expect(upload.httpStatus).toBe(200);
    expect(upload.body.ok).toBe(true);
    expect(upload.body.username).toBe('black_sheep_7');
    expect(mockFetch).toHaveBeenCalledWith(
      parsed.pairingUrl,
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });
});
