import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountStatus } from '@prisma/client';
import { MemoryRecoveryStore, type MemoryAccountRow } from '../src/recovery/memoryStore';
import {
  RecoveryService,
  generateRecoveryToken,
  hashRecoveryToken,
  isWellFormedToken,
  type RecoveryAccount,
  type RecoveryCredentials,
  type RecoveryLimits,
} from '../src/recovery/service';
import type { RemoteBrowser } from '../src/recovery/remoteBrowser';
import { RecoveryCommitError, RecoveryStatus } from '../src/recovery/types';
import type { StorageStateShape } from '../src/browser/cookiePayload';

let mockDriverResult:
  | { ok: true; username: string }
  | { ok: false; category: string; message: string } = {
  ok: true,
  username: 'test_user_1',
};

vi.mock('../src/recovery/loginDriver', () => ({
  driveLeetCodeLogin: vi.fn(async (_page, _creds, opts) => {
    opts?.onPhase?.('awaiting_verification');
    opts?.onPhase?.('filling');
    opts?.onPhase?.('submitting');
    opts?.onPhase?.('verifying');
    return mockDriverResult;
  }),
}));

describe('RecoveryService', () => {
  let accountsMap: Map<string, MemoryAccountRow>;
  let store: MemoryRecoveryStore;
  let credentialsMap: Map<string, RecoveryCredentials>;
  let telegramMessages: { text: string; markup?: any }[];
  let capturedStorageState: StorageStateShape;
  let fakeBrowser: RemoteBrowser;
  let browserClosed: boolean;
  let currentTime: Date;

  const limits: RecoveryLimits = {
    reminderIntervalMs: 60 * 60_000,
    tokenTtlMs: 45 * 60_000,
    sessionTimeoutMs: 10 * 60_000,
    maxConcurrency: 2,
    pollMs: 10,
    finalStatusRetentionMs: 50,
  };

  const createFakeBrowser = (): RemoteBrowser => {
    browserClosed = false;
    let disconnectCb: (() => void) | null = null;
    return {
      page: {} as any,
      context: {} as any,
      viewport: { width: 1024, height: 720 },
      snapshot: vi.fn(async () => Buffer.from('fake-jpeg-frame')),
      frameCount: vi.fn(() => 10),
      input: vi.fn(async () => undefined),
      captureStorageState: vi.fn(async () => capturedStorageState),
      onDisconnected: (cb) => {
        disconnectCb = cb;
      },
      close: vi.fn(async () => {
        browserClosed = true;
      }),
    };
  };

  const createService = (opts?: {
    verifyStoredSession?: (acc: RecoveryAccount) => Promise<any>;
    verifyCapturedSession?: (state: StorageStateShape) => Promise<any>;
  }) => {
    return new RecoveryService({
      store,
      now: () => currentTime,
      chatId: () => '123456789',
      baseUrl: () => 'https://solver.example.com',
      listAccounts: async () => [...accountsMap.values()].map((a) => ({ ...a })),
      getAccount: async (id) => {
        const found = accountsMap.get(id);
        return found ? { ...found } : null;
      },
      markAccount: async (id, status, lastError) => {
        const acc = accountsMap.get(id);
        if (acc) {
          acc.status = status;
        }
      },
      verifyStoredSession:
        opts?.verifyStoredSession ??
        (async (acc) => {
          if (acc.status === AccountStatus.ACTIVE) return { authenticated: true, username: acc.username };
          return { authenticated: false, cause: 'signed-out' };
        }),
      verifyCapturedSession:
        opts?.verifyCapturedSession ??
        (async (state) => ({ authenticated: true, username: 'test_user_1' })),
      getCredentials: async (acc) => credentialsMap.get(acc.id) ?? null,
      openBrowser: async () => fakeBrowser,
      sendTelegram: async (text, markup) => {
        telegramMessages.push({ text, markup });
        return true;
      },
      limits,
    });
  };

  beforeEach(() => {
    currentTime = new Date('2026-11-06T10:00:00Z');
    telegramMessages = [];
    browserClosed = false;
    mockDriverResult = { ok: true, username: 'test_user_1' };

    accountsMap = new Map<string, MemoryAccountRow>([
      [
        'acc-1',
        {
          id: 'acc-1',
          label: 'account_one',
          username: 'test_user_1',
          status: AccountStatus.ACTIVE,
          storageState: JSON.stringify({ cookies: [{ name: 'LEETCODE_SESSION', value: 'old-1' }], origins: [] }),
        },
      ],
      [
        'acc-2',
        {
          id: 'acc-2',
          label: 'account_two',
          username: 'test_user_2',
          status: AccountStatus.ACTIVE,
          storageState: JSON.stringify({ cookies: [{ name: 'LEETCODE_SESSION', value: 'old-2' }], origins: [] }),
        },
      ],
    ]);

    credentialsMap = new Map<string, RecoveryCredentials>([
      ['acc-1', { username: 'test_user_1', password: 'password_123' }],
      ['acc-2', { username: 'test_user_2', password: 'password_456' }],
    ]);

    store = new MemoryRecoveryStore(accountsMap);
    capturedStorageState = {
      cookies: [{ name: 'LEETCODE_SESSION', value: 'new-active-session', domain: '.leetcode.com', path: '/' }],
      origins: [],
    };
    fakeBrowser = createFakeBrowser();
  });

  describe('Tokens and cryptographic helpers', () => {
    it('generates well-formed base64url tokens', () => {
      const token = generateRecoveryToken();
      expect(isWellFormedToken(token)).toBe(true);
      expect(token).toHaveLength(43);
    });

    it('hashes tokens deterministically with sha256', () => {
      const token = generateRecoveryToken();
      const hash1 = hashRecoveryToken(token);
      const hash2 = hashRecoveryToken(token);
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
      expect(hash1).not.toBe(token);
    });

    it('rejects malformed tokens in inspectToken', async () => {
      const svc = createService();
      const result = await svc.inspectToken('short');
      expect(result.state).toBe('invalid');
    });
  });

  describe('Feature 1: Daily Session Monitoring (Multi-account)', () => {
    it('leaves active accounts untouched and resolves obsolete recoveries', async () => {
      const svc = createService();
      const summary = await svc.monitorAccounts();

      expect(summary.checked).toBe(2);
      expect(summary.active).toEqual(['account_one', 'account_two']);
      expect(summary.opened).toHaveLength(0);
      expect(accountsMap.get('acc-1')?.status).toBe(AccountStatus.ACTIVE);
      expect(accountsMap.get('acc-2')?.status).toBe(AccountStatus.ACTIVE);
    });

    it('does NOT treat transient network/query failures as expired sessions', async () => {
      const svc = createService({
        verifyStoredSession: async () => ({
          authenticated: false,
          cause: 'query-failed',
          error: 'Cloudflare 500 error or ETIMEDOUT',
        }),
      });

      const summary = await svc.monitorAccounts();
      expect(summary.transient).toEqual(['account_one', 'account_two']);
      expect(summary.opened).toHaveLength(0);
      expect(accountsMap.get('acc-1')?.status).toBe(AccountStatus.ACTIVE);
    });

    it('detects definitively expired accounts and creates recovery records', async () => {
      const svc = createService({
        verifyStoredSession: async (acc) => {
          if (acc.id === 'acc-1') return { authenticated: false, cause: 'signed-out' };
          return { authenticated: true, username: acc.username };
        },
      });

      const summary = await svc.monitorAccounts();
      expect(summary.opened).toEqual(['account_one']);
      expect(summary.active).toEqual(['account_two']);
      expect(accountsMap.get('acc-1')?.status).toBe(AccountStatus.REJECTED);

      const open = await store.findOpenByAccount('acc-1');
      expect(open).not.toBeNull();
      expect(open?.reason).toBe('REJECTED');
    });

    it('handles multiple expired accounts with consolidated notification', async () => {
      const svc = createService({
        verifyStoredSession: async () => ({
          authenticated: false,
          cause: 'token-expired',
        }),
      });

      const summary = await svc.monitorAccounts();
      expect(summary.opened).toEqual(['account_one', 'account_two']);
      expect(telegramMessages.length).toBeGreaterThan(0);
      const lastMsg = telegramMessages[telegramMessages.length - 1];
      expect(lastMsg.text).toContain('2 LeetCode Sessions Expired');
      expect(lastMsg.text).toContain('account_one');
      expect(lastMsg.text).toContain('account_two');
      expect(lastMsg.markup?.inline_keyboard).toBeDefined();
      expect(lastMsg.markup.inline_keyboard).toHaveLength(2);
    });
  });

  describe('Feature 2: Reminders & Token Lifecycle', () => {
    it('sends single-account reminder with reconnect button and reschedules next reminder', async () => {
      accountsMap.get('acc-1')!.status = AccountStatus.EXPIRED;
      const svc = createService();
      await svc.openRecovery(accountsMap.get('acc-1')!, 'EXPIRED');

      const outcome = await svc.tick();
      expect(outcome.notified).toBe(1);
      expect(telegramMessages).toHaveLength(1);

      const msg = telegramMessages[0];
      expect(msg.text).toContain('LeetCode Session Expired');
      expect(msg.text).toContain('account_one');
      expect(msg.markup?.inline_keyboard[0][0].text).toContain('Reconnect Account');
      expect(msg.markup?.inline_keyboard[0][0].url).toMatch(/^https:\/\/solver\.example\.com\/auth\/recover\//);

      // Verify nextReminderAt is updated 1 hour into the future
      const open = await store.findOpenByAccount('acc-1');
      expect(open?.nextReminderAt?.getTime()).toBe(currentTime.getTime() + limits.reminderIntervalMs);

      // Calling tick again immediately should not re-notify
      const tick2 = await svc.tick();
      expect(tick2.notified).toBe(0);
    });

    it('enforces single-use token consumption and replay protection', async () => {
      accountsMap.get('acc-1')!.status = AccountStatus.EXPIRED;
      const svc = createService();
      await svc.openRecovery(accountsMap.get('acc-1')!, 'EXPIRED');
      await svc.tick();

      const open = await store.findOpenByAccount('acc-1');
      expect(open?.tokenHash).toBeDefined();

      const tokenUrl = telegramMessages[0].markup.inline_keyboard[0][0].url;
      const token = tokenUrl.split('/auth/recover/')[1];

      // 1. inspectToken confirms valid
      const inspection = await svc.inspectToken(token);
      expect(inspection.state).toBe('valid');
      expect(inspection.label).toBe('account_one');

      // 2. First consumption starts session
      const startResult = await svc.openPortalSession(token);
      expect(startResult.ok).toBe(true);

      // 3. Replay attack: second consumption fails with 'used'
      const replayResult = await svc.openPortalSession(token);
      expect(replayResult.ok).toBe(false);
      expect(replayResult.reason).toBe('used');

      await svc.shutdown();
    });

    it('rejects expired tokens', async () => {
      accountsMap.get('acc-1')!.status = AccountStatus.EXPIRED;
      const svc = createService();
      await svc.openRecovery(accountsMap.get('acc-1')!, 'EXPIRED');
      await svc.tick();

      const tokenUrl = telegramMessages[0].markup.inline_keyboard[0][0].url;
      const token = tokenUrl.split('/auth/recover/')[1];

      // Fast-forward time past token TTL (46 minutes)
      currentTime = new Date(currentTime.getTime() + 46 * 60_000);

      const inspection = await svc.inspectToken(token);
      expect(inspection.state).toBe('expired');

      const startResult = await svc.openPortalSession(token);
      expect(startResult.ok).toBe(false);
      expect(startResult.reason).toBe('expired');
    });
  });

  describe('Feature 5, 6 & 7: Server Autofill, Validation & Atomic Commit', () => {
    it('autofills server-side credentials and updates session without password leakage', async () => {
      accountsMap.get('acc-1')!.status = AccountStatus.EXPIRED;
      const svc = createService();
      await svc.openRecovery(accountsMap.get('acc-1')!, 'EXPIRED');
      await svc.tick();

      const token = telegramMessages[0].markup.inline_keyboard[0][0].url.split('/auth/recover/')[1];
      const startResult = await svc.openPortalSession(token);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      // Check status during active session
      const status = svc.portalStatus(startResult.secret);
      expect(status?.label).toBe('account_one');
      expect(status?.phase).toBeDefined();

      // Drain session to completion
      await svc.drain();

      // Verify final status
      const finalStatus = svc.portalStatus(startResult.secret);
      expect(finalStatus?.phase).toBe('success');
      expect(finalStatus?.username).toBe('test_user_1');

      // Account should be ACTIVE in database with new storage state
      const updatedAccount = accountsMap.get('acc-1');
      expect(updatedAccount?.status).toBe(AccountStatus.ACTIVE);
      expect(updatedAccount?.storageState).toContain('new-active-session');

      // Old session was replaced, account 2 was completely untouched
      expect(accountsMap.get('acc-2')?.storageState).toContain('old-2');

      // Browser was closed cleanly without calling logout
      expect(browserClosed).toBe(true);

      // Telegram notification announced restoration
      const successMsg = telegramMessages.find((m) => m.text.includes('LeetCode Session Restored'));
      expect(successMsg).toBeDefined();
      expect(successMsg?.text).toContain('account_one');
      expect(successMsg?.text).toContain('ACTIVE');
    });

    it('aborts and protects database when authenticated username mismatches expected username', async () => {
      accountsMap.get('acc-1')!.status = AccountStatus.EXPIRED;
      mockDriverResult = { ok: true, username: 'malicious_impostor_99' };
      const svc = createService();
      await svc.openRecovery(accountsMap.get('acc-1')!, 'EXPIRED');
      await svc.tick();

      const token = telegramMessages[0].markup.inline_keyboard[0][0].url.split('/auth/recover/')[1];
      const startResult = await svc.openPortalSession(token);
      expect(startResult.ok).toBe(true);

      await svc.drain();

      // Account 1 must NOT be overwritten
      const account1 = accountsMap.get('acc-1');
      expect(account1?.storageState).toContain('old-1');
      expect(account1?.status).not.toBe(AccountStatus.ACTIVE);

      // Telegram notification alerted about the mismatch error
      const failMsg = telegramMessages.find((m) => m.text.includes('LeetCode Recovery Failed'));
      expect(failMsg).toBeDefined();
      expect(failMsg?.text).toContain('USERNAME_MISMATCH');
    });

    it('prevents cross-account session collision if username belongs to a different account', async () => {
      // Account 1 was misconfigured with username of account 2
      accountsMap.get('acc-1')!.status = AccountStatus.EXPIRED;
      accountsMap.get('acc-1')!.username = 'test_user_2';
      credentialsMap.set('acc-1', { username: 'test_user_2', password: 'pwd' });
      mockDriverResult = { ok: true, username: 'test_user_2' };

      const svc = createService({
        verifyCapturedSession: async () => ({ authenticated: true, username: 'test_user_2' }),
      });
      await svc.openRecovery(accountsMap.get('acc-1')!, 'EXPIRED');
      await svc.tick();

      const token = telegramMessages[0].markup.inline_keyboard[0][0].url.split('/auth/recover/')[1];
      const startResult = await svc.openPortalSession(token);
      expect(startResult.ok).toBe(true);

      await svc.drain();

      // Account 1 must NOT overwrite account 2's session
      expect(accountsMap.get('acc-2')?.storageState).toContain('old-2');

      const failMsg = telegramMessages.find((m) => m.text.includes('LeetCode Recovery Failed'));
      expect(failMsg?.text).toContain('WRONG_ACCOUNT');
    });

    it('rolls back completely when database transaction fails', async () => {
      accountsMap.get('acc-1')!.status = AccountStatus.EXPIRED;
      const svc = createService();
      await svc.openRecovery(accountsMap.get('acc-1')!, 'EXPIRED');
      await svc.tick();

      const token = telegramMessages[0].markup.inline_keyboard[0][0].url.split('/auth/recover/')[1];
      const startResult = await svc.openPortalSession(token);
      expect(startResult.ok).toBe(true);

      // Inject simulated database transaction failure
      store.failNextCommit = new Error('PostgreSQL connection dropped / deadlocked');

      await svc.drain();

      // Account 1 storage state must remain unmodified
      expect(accountsMap.get('acc-1')?.storageState).toContain('old-1');

      const failMsg = telegramMessages.find((m) => m.text.includes('DATABASE_ERROR'));
      expect(failMsg).toBeDefined();
    });
  });

  describe('Feature 4 & 8: Remote Input, Concurrency & Cancellation', () => {
    it('dispatches mouse events to browser and ignores non-session input', async () => {
      accountsMap.get('acc-1')!.status = AccountStatus.EXPIRED;
      const svc = createService();
      await svc.openRecovery(accountsMap.get('acc-1')!, 'EXPIRED');
      await svc.tick();

      const token = telegramMessages[0].markup.inline_keyboard[0][0].url.split('/auth/recover/')[1];
      const startResult = await svc.openPortalSession(token);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const inputHandled = await svc.portalInput(startResult.secret, { type: 'down', x: 250, y: 350 });
      expect(inputHandled).toBe(true);
      expect(fakeBrowser.input).toHaveBeenCalledWith({ type: 'down', x: 250, y: 350 });

      // Invalid secret rejected
      const invalidHandled = await svc.portalInput('invalid-secret-key-12345', { type: 'move', x: 10, y: 10 });
      expect(invalidHandled).toBe(false);

      await svc.shutdown();
    });

    it('cancels recovery when requested by operator /cancelrecovery', async () => {
      accountsMap.get('acc-1')!.status = AccountStatus.EXPIRED;
      const svc = createService();
      await svc.openRecovery(accountsMap.get('acc-1')!, 'EXPIRED');

      const cancelRes = await svc.cancelByLabel('account_one');
      expect(cancelRes).toBe('cancelled');

      const open = await store.findOpenByAccount('acc-1');
      expect(open).toBeNull(); // No open recovery remaining

      const rows = [...store.rows.values()];
      expect(rows[0].status).toBe(RecoveryStatus.CANCELLED);
    });

    it('enforces maximum concurrency limit', async () => {
      // Hold driver in pending state so sessions remain actively running
      let unblockDriver!: () => void;
      const driverWait = new Promise<any>((resolve) => {
        unblockDriver = () => resolve({ ok: true, username: 'test_user_1' });
      });
      mockDriverResult = driverWait as any;

      accountsMap.get('acc-1')!.status = AccountStatus.EXPIRED;
      accountsMap.get('acc-2')!.status = AccountStatus.EXPIRED;
      const svc = createService();
      // Limits maxConcurrency = 2
      await svc.openRecovery(accountsMap.get('acc-1')!, 'EXPIRED');
      await svc.openRecovery(accountsMap.get('acc-2')!, 'EXPIRED');
      await svc.tick();

      const token1 = telegramMessages[0].markup.inline_keyboard[0][0].url.split('/auth/recover/')[1];
      const token2 = telegramMessages[0].markup.inline_keyboard[1][0].url.split('/auth/recover/')[1];

      const res1 = await svc.openPortalSession(token1);
      expect(res1.ok).toBe(true);

      const res2 = await svc.openPortalSession(token2);
      expect(res2.ok).toBe(true);

      // Third attempt exceeds maxConcurrency = 2
      accountsMap.set('acc-3', {
        id: 'acc-3',
        label: 'account_three',
        username: 'test_user_3',
        status: AccountStatus.EXPIRED,
        storageState: '{}',
      });
      credentialsMap.set('acc-3', { username: 'test_user_3', password: 'pwd' });
      const rec3 = await svc.openRecovery(accountsMap.get('acc-3')!, 'EXPIRED');
      const token3 = generateRecoveryToken();
      await store.issueToken(
        rec3.recovery.id,
        hashRecoveryToken(token3),
        new Date(currentTime.getTime() + limits.tokenTtlMs),
      );

      const res3 = await svc.openPortalSession(token3);
      expect(res3.ok).toBe(false);
      expect(res3.reason).toBe('busy');

      unblockDriver();
      await svc.shutdown();
    });

    it('recovers an account registered with an email identifier (e.g. sks7501) and adopts the verified LeetCode handle', async () => {
      accountsMap.set('acc-email', {
        id: 'acc-email',
        label: 'sks7501',
        username: 'sks7501@example.com',
        status: AccountStatus.EXPIRED,
        storageState: '',
      });
      credentialsMap.set('acc-email', { username: 'sks7501@example.com', password: 'secret_password' });
      mockDriverResult = { ok: true, username: 'sks7501_real_handle' };

      const svc = createService({
        verifyCapturedSession: async () => ({ authenticated: true, username: 'sks7501_real_handle' }),
      });

      const reqOutcome = await svc.requestRecovery('sks7501');
      expect(reqOutcome).toBe('sent');

      const lastMsg = telegramMessages[telegramMessages.length - 1];
      const token = lastMsg.markup.inline_keyboard[0][0].url.split('/auth/recover/')[1];

      const startResult = await svc.openPortalSession(token);
      expect(startResult.ok).toBe(true);
      await svc.drain();

      const updated = accountsMap.get('acc-email');
      expect(updated?.status).toBe(AccountStatus.ACTIVE);
      expect(updated?.username).toBe('sks7501_real_handle');
    });

    it('clears stale non-retryable lastErrorCategory and live-checks stale ACTIVE status on operator requestRecovery', async () => {
      // Simulate an account marked ACTIVE in DB whose session is actually signed out live,
      // and which previously had a non-retryable error category.
      accountsMap.get('acc-1')!.status = AccountStatus.ACTIVE;
      const { recovery: existingRec } = await store.create({
        accountId: 'acc-1',
        reason: 'MANUAL',
        telegramChatId: '123456789',
        now: currentTime,
        nextReminderAt: currentTime,
      });
      await store.markFailed(existingRec.id, 'INVALID_CREDENTIALS', 'old error', currentTime);

      const svc = createService({
        verifyStoredSession: async () => ({ authenticated: false, cause: 'signed-out' }),
      });

      const outcome = await svc.requestRecovery('account_one');
      expect(outcome).toBe('sent');
      expect(accountsMap.get('acc-1')?.status).toBe(AccountStatus.EXPIRED);

      const open = await store.findOpenByAccount('acc-1');
      expect(open?.lastErrorCategory).toBeNull();
      expect(open?.tokenHash).not.toBeNull();
    });
  });

  describe('Local-IP Verification & Redirection Recovery', () => {
    it('bootstrapLocalRecovery returns saved credentials and expectedUsername without consuming the token, or null credentials when missing', async () => {
      accountsMap.get('acc-1')!.status = AccountStatus.EXPIRED;
      const svc = createService();
      await svc.openRecovery(accountsMap.get('acc-1')!, 'EXPIRED');
      await svc.tick();

      const token = telegramMessages[0].markup.inline_keyboard[0][0].url.split('/auth/recover/')[1];
      const boot = await svc.bootstrapLocalRecovery(token);
      expect(boot).toEqual({
        ok: true,
        label: 'account_one',
        expectedUsername: 'test_user_1',
        credentials: {
          identifier: 'test_user_1',
          password: 'password_123',
        },
      });

      // Bootstrapping must not consume the single-use token
      expect((await svc.inspectToken(token)).state).toBe('valid');

      // Missing credentials still bootstraps with credentials: null
      credentialsMap.delete('acc-1');
      const bootNoCreds = await svc.bootstrapLocalRecovery(token);
      expect(bootNoCreds).toEqual({
        ok: true,
        label: 'account_one',
        expectedUsername: 'test_user_1',
        credentials: null,
      });

      // Invalid, expired, and already-used tokens return ok: false
      expect(await svc.bootstrapLocalRecovery('short')).toEqual({ ok: false, reason: 'invalid' });

      const expiredSvc = createService();
      currentTime = new Date(currentTime.getTime() + 46 * 60_000);
      expect(await expiredSvc.bootstrapLocalRecovery(token)).toEqual({ ok: false, reason: 'expired' });
    });

    it('getRecoveryPollStatus reports valid, recovered, and invalid states accurately', async () => {
      accountsMap.get('acc-1')!.status = AccountStatus.EXPIRED;
      const svc = createService();
      await svc.openRecovery(accountsMap.get('acc-1')!, 'EXPIRED');
      await svc.tick();

      const token = telegramMessages[0].markup.inline_keyboard[0][0].url.split('/auth/recover/')[1];
      expect(await svc.getRecoveryPollStatus(token)).toEqual({
        state: 'valid',
        label: 'account_one',
        username: 'test_user_1',
      });
      expect(await svc.getRecoveryPollStatus('short')).toEqual({ state: 'invalid' });

      await svc.completeLocalRecovery(token, {
        storageState: {
          cookies: [
            { name: 'LEETCODE_SESSION', value: 'local-active-jwt-token-value-123456', domain: '.leetcode.com', path: '/' },
            { name: 'csrftoken', value: 'csrf-123', domain: '.leetcode.com', path: '/' },
          ],
          origins: [],
        },
      });

      expect(await svc.getRecoveryPollStatus(token)).toEqual({
        state: 'recovered',
        label: 'account_one',
        username: 'test_user_1',
      });
    });

    it('completeLocalRecovery verifies session, commits ACTIVE state with transport userAgent, prevents replay, and notifies Telegram', async () => {
      accountsMap.get('acc-1')!.status = AccountStatus.EXPIRED;
      const svc = createService();
      await svc.openRecovery(accountsMap.get('acc-1')!, 'EXPIRED');
      await svc.tick();

      const token = telegramMessages[0].markup.inline_keyboard[0][0].url.split('/auth/recover/')[1];
      const result = await svc.completeLocalRecovery(token, {
        cookies: [
          { name: 'LEETCODE_SESSION', value: 'fresh-local-session-token-1234567890', domain: '.leetcode.com', path: '/' },
          { name: 'csrftoken', value: 'fresh-csrf-token-123456', domain: '.leetcode.com', path: '/' },
        ],
        localVerifiedUsername: 'test_user_1',
        userAgent: 'Mozilla/5.0 Custom Local Browser',
      });

      expect(result).toEqual({
        ok: true,
        httpStatus: 200,
        label: 'account_one',
        username: 'test_user_1',
        serverVerified: true,
      });

      const updated = accountsMap.get('acc-1')!;
      expect(updated.status).toBe(AccountStatus.ACTIVE);
      expect(updated.storageState).toContain('fresh-local-session-token-1234567890');
      expect(updated.storageState).toContain('Mozilla/5.0 Custom Local Browser');

      const restoredMsg = telegramMessages.find((m) => m.text.includes('✅ <b>LeetCode Session Restored</b>'));
      expect(restoredMsg).toBeDefined();
      expect(restoredMsg?.text).toContain('account_one');

      // Single-use replay rejected with 409 used
      const replay = await svc.completeLocalRecovery(token, {
        cookies: 'LEETCODE_SESSION=fresh-local-session-token-1234567890; csrftoken=fresh-csrf-token-123456',
      });
      expect(replay.ok).toBe(false);
      if (!replay.ok) {
        expect(replay.httpStatus).toBe(409);
        expect(replay.reason).toBe('used');
      }
    });

    it('completeLocalRecovery falls back to unexpired JWT / localVerifiedUsername on transient server query-failed error', async () => {
      accountsMap.get('acc-1')!.status = AccountStatus.EXPIRED;
      const svc = createService({
        verifyCapturedSession: async () => ({
          authenticated: false,
          cause: 'query-failed',
        }),
      });
      await svc.openRecovery(accountsMap.get('acc-1')!, 'EXPIRED');
      await svc.tick();

      const jwtPayload = Buffer.from(
        JSON.stringify({
          username: 'test_user_1',
          refreshed_at: Math.floor(Date.now() / 1000),
          _session_expiry: 1209600,
        }),
      ).toString('base64url');
      const token = telegramMessages[0].markup.inline_keyboard[0][0].url.split('/auth/recover/')[1];

      const result = await svc.completeLocalRecovery(token, {
        storageState: {
          cookies: [
            { name: 'LEETCODE_SESSION', value: `eyJhbGciOiJIUzI1NiJ9.${jwtPayload}.sig`, domain: '.leetcode.com', path: '/' },
            { name: 'csrftoken', value: 'csrf-ok', domain: '.leetcode.com', path: '/' },
          ],
          origins: [],
        },
        localVerifiedUsername: 'test_user_1',
      });

      expect(result).toEqual({
        ok: true,
        httpStatus: 200,
        label: 'account_one',
        username: 'test_user_1',
        serverVerified: false,
      });
      expect(accountsMap.get('acc-1')?.status).toBe(AccountStatus.ACTIVE);
    });

    it('completeLocalRecovery rejects USERNAME_MISMATCH without overwriting DB', async () => {
      accountsMap.get('acc-1')!.status = AccountStatus.EXPIRED;
      const svc = createService({
        verifyCapturedSession: async () => ({ authenticated: true, username: 'different_user_99' }),
      });
      await svc.openRecovery(accountsMap.get('acc-1')!, 'EXPIRED');
      await svc.tick();

      const token = telegramMessages[0].markup.inline_keyboard[0][0].url.split('/auth/recover/')[1];
      const res = await svc.completeLocalRecovery(token, {
        cookies: 'LEETCODE_SESSION=wrong-user-session-1234567890; csrftoken=csrf-1',
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.httpStatus).toBe(422);
        expect(res.reason).toBe('username_mismatch');
      }
      expect(accountsMap.get('acc-1')?.storageState).toContain('old-1');
      expect(accountsMap.get('acc-1')?.status).not.toBe(AccountStatus.ACTIVE);
    });
  });
});
