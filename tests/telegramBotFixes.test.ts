import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountStatus } from '@prisma/client';

vi.mock('../src/config', async (orig) => {
  const real = (await orig()) as { config: Record<string, unknown> };
  return {
    config: {
      ...real.config,
      telegram: {
        ...(real.config.telegram as object),
        chatId: '9999',
        enabled: true,
        commands: true,
        botToken: 'TEST_TOKEN',
      },
    },
  };
});

vi.mock('../src/database/accounts', async (orig) => ({
  ...(await orig() as object),
  listAccounts: vi.fn(async () => []),
  listEnabledAccounts: vi.fn(async () => []),
  getAccountById: vi.fn(async () => null),
  saveAccount: vi.fn(async (label: string, _state: string, meta?: Record<string, unknown>) => ({
    id: `id-${label}`,
    label,
    username: (meta?.username as string | null) ?? null,
    status: (meta?.status as AccountStatus | undefined) ?? AccountStatus.UNKNOWN,
  })),
  deleteAccountById: vi.fn(async () => true),
  deleteAllAccounts: vi.fn(async () => 0),
  patchAccount: vi.fn(async () => undefined),
}));

vi.mock('../src/security/credentialStore', async (orig) => ({
  ...(await orig() as object),
  saveEncryptedCredentials: vi.fn(async () => undefined),
  deleteEncryptedCredentials: vi.fn(async () => true),
  listCredentialLabels: vi.fn(async () => []),
  findCredentialsForAccount: vi.fn(async () => null),
}));

vi.mock('../src/database/models', async (orig) => ({
  ...(await orig() as object),
  getAllSystemState: vi.fn(async () => ({})),
  getSystemState: vi.fn(async () => null),
  setSystemState: vi.fn(async () => undefined),
  deleteSystemState: vi.fn(async () => undefined),
  latestRun: vi.fn(async () => null),
  latestAcceptedRun: vi.fn(async () => null),
}));

vi.mock('../src/database/prisma', () => ({
  prisma: {
    solutionPost: { findFirst: vi.fn(async () => null) },
    codeforcesProgress: { upsert: vi.fn(async () => ({})) },
  },
}));

vi.mock('../src/leetcode/auth', () => ({ loginToLeetCode: vi.fn() }));
vi.mock('../src/codeforces/auth', () => ({ loginToCodeforces: vi.fn(async () => ({ ok: false, error: 'mock' })) }));
vi.mock('../src/codeforces/sourceRepo', async (orig) => ({
  ...(await orig() as object),
  loadRuntimeSourceIndex: vi.fn(async () => ({ entries: [], queue: [] })),
}));
vi.mock('../src/codeforces/storage', async (orig) => ({
  ...(await orig() as object),
  listCodeforcesAccounts: vi.fn(async () => []),
  getCodeforcesProgress: vi.fn(async () => ({ nextKey: null, lastVerdict: null })),
  saveUsernameProgress: vi.fn(async () => null),
}));
vi.mock('../src/codechef/storage', async (orig) => ({
  ...(await orig() as object),
  listCodeChefAccounts: vi.fn(async () => []),
  getCodeChefProgress: vi.fn(async () => ({ nextKey: null, lastVerdict: null })),
}));
vi.mock('../src/codeforces/capzyKeyManager', async (orig) => ({
  ...(await orig() as object),
  saveCapzyApiKeys: vi.fn(async () => undefined),
  addCapzyApiKeys: vi.fn(async () => ({ added: 1, total: 1 })),
  getCapzyApiKeys: vi.fn(async () => []),
  isLikelyCapzyKey: vi.fn((t: string) => /^capzy_[a-zA-Z0-9_-]{8,}$/i.test(t.trim())),
  checkCapzyKeyBalance: vi.fn(async () => ({ ok: true, balance: 1 })),
}));
vi.mock('../src/solutionPosts/keyPool', async (orig) => ({
  ...(await orig() as object),
  appendSolutionApiKeys: vi.fn(async () => ({ added: 1, total: 1 })),
  solutionKeyPoolStatus: vi.fn(async () => ({ total: 0, active: null, source: 'db', keys: [] })),
}));
vi.mock('../src/solutionPosts/service', async (orig) => ({
  ...(await orig() as object),
  createPostRouter: vi.fn(),
}));
vi.mock('../src/ai/sageProbe', async (orig) => ({
  ...(await orig() as object),
  askSage: vi.fn(async () => ({ ok: true, answer: 'ok', model: 'm', elapsedMs: 1 })),
  probeSageApi: vi.fn(async () => ({
    executionHost: 'local',
    revision: null,
    testedAt: new Date().toISOString(),
    baseUrl: 'https://sage.test',
    keyMasked: 'sk-123…789',
    chatModel: 'm',
    ok: true,
    elapsedMs: 1,
    modelsStatus: 200,
    modelsCount: 1,
    models: ['m'],
    chatStatus: 200,
  })),
}));
vi.mock('../src/solutionPosts/upvote', async (orig) => ({
  ...(await orig() as object),
  boostSolutionArticleViews: vi.fn(async () => ({ accountsProcessed: 0, liveHitCount: 0 })),
  fetchLiveSolutionMetrics: vi.fn(async () => null),
}));
vi.mock('../src/scheduler/rangeSubmission', async (orig) => ({
  ...(await orig() as object),
  startRangeJob: vi.fn(async () => ({ started: false, reason: 'no-accounts' })),
  currentRangeJob: vi.fn(() => null),
  cancelRangeJob: vi.fn(() => false),
  rangeQueueLength: vi.fn(() => 0),
}));
vi.mock('../src/scheduler/dailyWorker', async (orig) => ({
  ...(await orig() as object),
  isRunInProgress: vi.fn(() => false),
  triggerRun: vi.fn(async () => ({ started: false, message: 'mock' })),
}));

import { prisma } from '../src/database/prisma';
import { loginToLeetCode } from '../src/leetcode/auth';
import {
  deleteAccountById,
  deleteAllAccounts,
  getAccountById,
  listAccounts,
  listEnabledAccounts,
  saveAccount,
} from '../src/database/accounts';
import {
  deleteEncryptedCredentials,
  listCredentialLabels,
  saveEncryptedCredentials,
} from '../src/security/credentialStore';
import { loadRuntimeSourceIndex } from '../src/codeforces/sourceRepo';
import { listCodeforcesAccounts, saveUsernameProgress } from '../src/codeforces/storage';
import { saveCapzyApiKeys, addCapzyApiKeys } from '../src/codeforces/capzyKeyManager';
import { appendSolutionApiKeys } from '../src/solutionPosts/keyPool';
import { createPostRouter } from '../src/solutionPosts/service';
import { askSage, probeSageApi } from '../src/ai/sageProbe';
import { currentRangeJob, startRangeJob } from '../src/scheduler/rangeSubmission';
import { triggerRun } from '../src/scheduler/dailyWorker';
import {
  clearLeetCodePairingSessionsForTests,
  completeLeetCodePairingSession,
  DEFAULT_PAIRING_TTL_MS,
} from '../src/leetcode/loginHandoff';
import { answerSageChat, isSensitiveChatText } from '../src/notifications/aiChat';
import { editTelegramMessage, sendTelegramMessage } from '../src/notifications/telegram';
import {
  cfRangeSelections,
  clearCommandQueue,
  clearPendingLeetCodeVerificationHandoff,
  coinClaimSelections,
  contestSolutionSelections,
  dailySolutionSelections,
  defaultCodeforcesSubmitUiDeps,
  defaultCoinClaimUiDeps,
  defaultRemovalDeps,
  executeQueuedCommand,
  getActiveLeetCodePairingSession,
  getCommandQueue,
  getPendingLeetCodeVerificationHandoff,
  getPendingRenewalLabel,
  handleAskSage,
  handleBoostSolutionViews,
  handleCfSetProgress,
  handleCodeforcesManualButton,
  handleCodeforcesRangeButton,
  handleExecuteLogin,
  handleIncompleteButton,
  handleIncompleteQuestionsCommand,
  handleMessage,
  handleQuestionRangeCommand,
  handleQuestionRangeTrigger,
  handleRangeButton,
  isPendingAddCapzyPrompt,
  isPendingCapzyPrompt,
  isPendingQueuePrompt,
  isPendingSolutionKeysPrompt,
  lcIncompleteSelections,
  lcRangeSelections,
  manualSolutionSelections,
  processCookieMessage,
  resetQueueForTest,
  setActiveLoginPrompt,
  setPendingCapzyPrompt,
  setPendingLeetCodeVerificationHandoff,
  setPendingPromptType,
  setPendingQueuePrompt,
  setPendingRenewalLabel,
  startTelegramBot,
  truncateHtml,
  validateQueueCommand,
  type RangeTriggerDeps,
  type RangeUiDeps,
  type RemovalDeps,
} from '../src/notifications/telegramBot';

interface RecordedFetch {
  method: string;
  body: Record<string, unknown>;
}

function installTelegramFetchMock(
  responder?: (method: string, body: Record<string, unknown>, callIdx: number) => Response | Promise<Response>,
): { calls: RecordedFetch[]; mock: ReturnType<typeof vi.fn> } {
  const calls: RecordedFetch[] = [];
  const mock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = url.toString();
    const methodMatch = /\/bot[^/]+\/([^/?]+)/.exec(u);
    const method = methodMatch?.[1] ?? 'unknown';
    let body: Record<string, unknown> = {};
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }
    const idx = calls.length;
    calls.push({ method, body });
    if (responder) {
      return responder(method, body, idx);
    }
    if (method === 'getUpdates') {
      return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: idx + 1 } }), { status: 200 });
  });
  vi.stubGlobal('fetch', mock);
  return { calls, mock };
}

function makeAccount(id: string, label: string, username: string | null = label, status: AccountStatus = AccountStatus.ACTIVE) {
  return {
    id,
    label,
    username,
    status,
    storageState: '{}',
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastVerifiedAt: null,
    lastRunAt: null,
  } as any;
}

const SAMPLE_JWT_COOKIE =
  'LEETCODE_SESSION=eyJhbGciOiJIUzI1NiJ9.eyJ1c2VybmFtZSI6ImFsaWNlIiwicmVmcmVzaGVkX2F0IjoxNzkzOTMwMDAwLCJfc2Vzc2lvbl9leHBpcnkiOjEyMDk2MDB9.sig; csrftoken=csrf12345';

describe('Telegram Bot & Notifications Regression Fixes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    clearLeetCodePairingSessionsForTests();
    resetQueueForTest();
    clearCommandQueue();
    setActiveLoginPrompt(null);
    setPendingRenewalLabel(undefined);
    setPendingLeetCodeVerificationHandoff(null);
    setPendingPromptType(null);
    contestSolutionSelections.clear();
    dailySolutionSelections.clear();
    manualSolutionSelections.clear();
    cfRangeSelections.clear();
    coinClaimSelections.clear();
    lcIncompleteSelections.clear();
    lcRangeSelections.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setPendingPromptType(null);
    setActiveLoginPrompt(null);
    setPendingLeetCodeVerificationHandoff(null);
    setPendingRenewalLabel(undefined);
  });

  describe('Bug 1: /lclogin handoff TTL, /renew mismatch, and credential guard', () => {
    it('expires pendingLeetCodeVerificationHandoff after DEFAULT_PAIRING_TTL_MS (10 min)', () => {
      const expiredCreatedAt = Date.now() - DEFAULT_PAIRING_TTL_MS - 1_000;
      setPendingLeetCodeVerificationHandoff({
        label: 'main',
        identifier: 'alice',
        password: 'pw',
        createdAt: expiredCreatedAt,
      });
      expect(getPendingLeetCodeVerificationHandoff()).toBeNull();

      setPendingLeetCodeVerificationHandoff({
        label: 'main',
        identifier: 'alice',
        password: 'pw',
        createdAt: Date.now() - 1_000,
      });
      expect(getPendingLeetCodeVerificationHandoff()?.label).toBe('main');
    });

    it('clears handoff when pairing session completes or clearPendingLeetCodeVerificationHandoff is called', async () => {
      vi.mocked(loginToLeetCode).mockResolvedValue({ ok: false, code: 'VERIFICATION_REQUIRED', error: 'verify' });
      const reply = vi.fn(async () => undefined);
      await handleExecuteLogin('leetcode', 'acct_one', 'alice', 'secret', reply);

      const session = getActiveLeetCodePairingSession();
      expect(session).not.toBeNull();
      expect(getPendingLeetCodeVerificationHandoff()?.label).toBe('acct_one');

      vi.mocked(listAccounts).mockResolvedValue([makeAccount('1', 'acct_one', 'alice')]);
      const outcome = await completeLeetCodePairingSession(
        session!.token,
        { cookies: SAMPLE_JWT_COOKIE, localVerifiedUsername: 'alice' },
        {
          validator: async () => ({ ok: true, username: 'alice' }),
          onVerifiedSuccess: ({ label }) => clearPendingLeetCodeVerificationHandoff(label),
        },
      );
      expect(outcome.ok).toBe(true);
      expect(getPendingLeetCodeVerificationHandoff()).toBeNull();
    });

    it('clears handoff when /renew specifies a different label instead of overwriting .label', async () => {
      installTelegramFetchMock();
      setPendingLeetCodeVerificationHandoff({
        label: 'account_a',
        identifier: 'alice',
        password: 'pw',
        createdAt: Date.now(),
      });

      await handleMessage({
        message_id: 10,
        chat: { id: '9999' },
        text: '/renew account_b',
      });

      expect(getPendingRenewalLabel()).toBe('account_b');
      expect(getPendingLeetCodeVerificationHandoff()).toBeNull();
    });

    it('skips saving handoff credentials on label or non-email username mismatch and saves on email match', async () => {
      const validator = vi.fn(async () => ({ ok: true as const, username: 'bob_other' }));
      vi.mocked(saveAccount).mockResolvedValue(makeAccount('1', 'account_b', 'bob_other', AccountStatus.ACTIVE));
      vi.mocked(listAccounts).mockResolvedValue([]);

      setPendingLeetCodeVerificationHandoff({
        label: 'account_a',
        identifier: 'alice',
        password: 'pw_a',
        createdAt: Date.now(),
      });

      await processCookieMessage(SAMPLE_JWT_COOKIE, { label: 'account_b', validator });
      expect(saveEncryptedCredentials).not.toHaveBeenCalled();
      expect(getPendingLeetCodeVerificationHandoff()?.label).toBe('account_a');

      vi.mocked(saveAccount).mockResolvedValue(makeAccount('2', 'account_a', 'bob_other', AccountStatus.ACTIVE));
      vi.mocked(listAccounts).mockResolvedValue([]);
      await processCookieMessage(SAMPLE_JWT_COOKIE, { label: 'account_a', validator });
      expect(saveEncryptedCredentials).not.toHaveBeenCalled();
      expect(getPendingLeetCodeVerificationHandoff()).toBeNull();

      setPendingLeetCodeVerificationHandoff({
        label: 'account_email',
        identifier: 'alice@example.com',
        password: 'pw_email',
        createdAt: Date.now(),
      });
      vi.mocked(saveAccount).mockResolvedValue(makeAccount('3', 'account_email', 'alice_lc', AccountStatus.ACTIVE));
      vi.mocked(listAccounts).mockResolvedValue([]);
      await processCookieMessage(SAMPLE_JWT_COOKIE, {
        label: 'account_email',
        validator: async () => ({ ok: true as const, username: 'alice_lc' }),
      });
      expect(saveEncryptedCredentials).toHaveBeenCalledWith('leetcode', 'account_email', {
        username: 'alice_lc',
        password: 'pw_email',
        label: 'account_email',
      });
    });
  });

  describe('Bug 2: Unhandled rejections & leaked timers', () => {
    it('catches prisma.solutionPost.findFirst errors inside handleBoostSolutionViews', async () => {
      const { calls } = installTelegramFetchMock();
      vi.mocked(prisma.solutionPost.findFirst).mockRejectedValueOnce(new Error('DB unreachable'));

      await expect(
        handleBoostSolutionViews({ message_id: 1, chat: { id: '9999' } }, '8603495'),
      ).resolves.toBeUndefined();

      const sent = calls.map((c) => String(c.body.text ?? '')).join('\n');
      expect(sent).toContain('Failed to boost views: DB unreachable');
    });

    it('attaches .catch handlers on fire-and-forget AI/Sage/Boost calls in handleMessage', async () => {
      installTelegramFetchMock();
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      try {
        vi.mocked(createPostRouter).mockRejectedValue(new Error('router exploded'));
        vi.mocked(askSage).mockRejectedValue(new Error('sage exploded'));
        vi.mocked(probeSageApi).mockRejectedValue(new Error('probe exploded'));
        vi.mocked(prisma.solutionPost.findFirst).mockRejectedValue(new Error('db exploded'));

        await handleMessage({ message_id: 1, chat: { id: '9999' }, text: '/asksage hello' });
        await handleMessage({ message_id: 2, chat: { id: '9999' }, text: '/testsage' });
        await handleMessage({ message_id: 3, chat: { id: '9999' }, text: '/boostviews' });
        await handleMessage({ message_id: 4, chat: { id: '9999' }, text: 'what is two sum?' });
        await new Promise((r) => setTimeout(r, 30));

        expect(unhandled).toHaveLength(0);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('clears pendingEditTimer in handleQuestionRangeTrigger catch blocks before error edit', async () => {
      vi.useFakeTimers();
      const { calls } = installTelegramFetchMock();
      const acc = makeAccount('a1', 'acc1');
      let rejectDone!: (err: Error) => void;
      const donePromise = new Promise<any[]>((_, reject) => {
        rejectDone = reject;
      });

      const deps: RangeTriggerDeps = {
        listAccounts: async () => [acc],
        getAccount: async () => acc,
        startJob: async (_range, _target, rangeDeps) => {
          rangeDeps.onProgress?.({
            accIndex: 0,
            label: acc.label,
            username: acc.username,
            phase: 'submitting',
            questionNumber: 1,
            stepIndex: 1,
            stepTotal: 1,
          });
          return {
            started: true,
            range: { from: 1, to: 1 },
            mode: 'sequential',
            accounts: [acc],
            done: donePromise,
          };
        },
      };

      const res = await handleQuestionRangeTrigger({ from: 1, to: 1 }, 'a1', deps, '9999');
      expect(res.started).toBe(true);
      if (res.started) {
        rejectDone(new Error('range failed'));
        await expect(res.done).rejects.toThrow('range failed');
      }

      const editsBeforeTimer = calls.filter((c) => c.method === 'editMessageText').length;
      expect(editsBeforeTimer).toBe(1);
      expect(String(calls.filter((c) => c.method === 'editMessageText')[0]?.body.text)).toContain('⚠️ Error: range failed');

      await vi.advanceTimersByTimeAsync(2_000);
      const editsAfterTimer = calls.filter((c) => c.method === 'editMessageText').length;
      expect(editsAfterTimer).toBe(1);
    });

    it('attaches .done.catch on fire-and-forget range and incomplete UI handlers', async () => {
      installTelegramFetchMock();
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      try {
        const acc = makeAccount('a1', 'acc1');
        const ui: RangeUiDeps = {
          start: vi.fn(async () => ({
            started: true as const,
            range: { from: 1, to: 5 },
            mode: 'sequential' as const,
            accounts: [acc],
            done: Promise.reject(new Error('background boom')),
          })),
          current: () => null,
          cancel: () => false,
          now: () => Date.now(),
        };
        const deps: RemovalDeps = {
          listAccounts: async () => [acc],
          deleteAccountById: async () => true,
          deleteAllAccounts: async () => 1,
          clearLegacySession: async () => undefined,
          isRunInProgress: () => false,
          send: vi.fn(async () => undefined),
          edit: vi.fn(async () => undefined),
          answer: vi.fn(async () => undefined),
        };

        await handleIncompleteQuestionsCommand('5 a1', deps, ui, '9999');
        await handleIncompleteButton('9999', 1, 'cb1', 'lcincomp:all:seq', deps, ui);
        await handleQuestionRangeCommand('1-5 a1', deps, ui, '9999');
        await handleRangeButton('9999', 2, 'cb2', 'qr:1-5:all', deps, ui);
        await new Promise((r) => setTimeout(r, 20));

        expect(unhandled).toHaveLength(0);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('unrefs batchRunTimer and clears it when startTelegramBot stop() is invoked', async () => {
      installTelegramFetchMock();
      vi.mocked(saveAccount).mockResolvedValue(makeAccount('1', 'main', 'alice', AccountStatus.ACTIVE));
      vi.mocked(listAccounts).mockResolvedValue([]);

      let seenUnref = false;
      const origSetTimeout = globalThis.setTimeout;
      (globalThis as any).setTimeout = ((fn: (...args: any[]) => void, ms?: number, ...rest: any[]) => {
        const handle = origSetTimeout(fn, ms, ...rest);
        if (ms === 30_000) {
          const origUnref = handle.unref?.bind(handle);
          handle.unref = () => {
            seenUnref = true;
            return origUnref ? origUnref() : handle;
          };
        }
        return handle;
      }) as typeof setTimeout;

      let stop: (() => void) | undefined;
      try {
        stop = startTelegramBot({
          getUpdates: () => new Promise(() => undefined),
          handle: async () => undefined,
        });

        await handleMessage({
          message_id: 22,
          chat: { id: '9999' },
          text: SAMPLE_JWT_COOKIE,
        });
        expect(seenUnref).toBe(true);
      } finally {
        (globalThis as any).setTimeout = origSetTimeout;
        stop?.();
      }

      vi.useFakeTimers();
      try {
        const stopFake = startTelegramBot({
          getUpdates: () => new Promise(() => undefined),
          handle: async () => undefined,
        });
        await handleMessage({
          message_id: 23,
          chat: { id: '9999' },
          text: SAMPLE_JWT_COOKIE,
        });
        expect(vi.getTimerCount()).toBe(1);
        stopFake();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(35_000);
        expect(triggerRun).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('Bug 3: Split cookie paste & /asksage exfiltration guard', () => {
    it('detects JSON cookie fragments, cf_clearance/JSESSIONID/39ce7, and Capzy keys in isSensitiveChatText', () => {
      expect(isSensitiveChatText('{"name": "LEETCODE_SESSION", "value": "abc"}')).toBe(true);
      expect(isSensitiveChatText('"httpOnly": true, "secure": true')).toBe(true);
      expect(isSensitiveChatText('"JSESSIONID": "XYZ123"')).toBe(true);
      expect(isSensitiveChatText('"39ce7": "cookieval"')).toBe(true);
      expect(isSensitiveChatText('cf_clearance=some_long_cookie')).toBe(true);
      expect(isSensitiveChatText('capzy_abcdefghijklmnop')).toBe(true);
      expect(isSensitiveChatText('CAP-abcdefghijklmnop')).toBe(true);
      expect(isSensitiveChatText('Explain binary search complexity')).toBe(false);
    });

    it('blocks sensitive input in answerSageChat and handleAskSage before calling askSage', async () => {
      const { calls } = installTelegramFetchMock();

      const sageRes = await answerSageChat('"LEETCODE_SESSION" "httpOnly": true capzy_secretkey12345');
      expect(sageRes).toBe('Please remove credentials or session data before asking the AI.');
      expect(askSage).not.toHaveBeenCalled();

      await handleAskSage('"httpOnly": true, "cf_clearance": "secret"');
      expect(askSage).not.toHaveBeenCalled();
      expect(String(calls[0]?.body.text)).toBe('Please remove credentials or session data before asking the AI.');
    });

    it('routes mid-JSON cookie paste fragments to cookie ingestion instead of AI chat', async () => {
      const { calls } = installTelegramFetchMock();
      await handleMessage({
        message_id: 30,
        chat: { id: '9999' },
        text: '  "domain": ".leetcode.com",\n  "httpOnly": true,\n  "JSESSIONID": "abc"\n',
      });

      expect(createPostRouter).not.toHaveBeenCalled();
      const text = calls.map((c) => String(c.body.text ?? '')).join('\n');
      expect(text).toContain('Could not read these cookies');
    });
  });

  describe('Bug 4: Command queue & prompt state fixes', () => {
    it('splits comma-separated targets in executeQueuedCommand and resolves label/username fallback', async () => {
      installTelegramFetchMock();
      const acc1 = makeAccount('cuid-1', 'label_one', 'user_one');
      const acc2 = makeAccount('cuid-2', 'label_two', 'user_two');
      vi.mocked(listEnabledAccounts).mockResolvedValue([acc1, acc2]);
      vi.mocked(listAccounts).mockResolvedValue([acc1, acc2]);

      await executeQueuedCommand({
        id: 'q1',
        rawText: '/questionrangesubmission 1-5 label_one,user_two parallel',
        command: '/questionrangesubmission',
        arg: '1-5 label_one,user_two parallel',
        queuedAt: Date.now(),
      });

      expect(startRangeJob).toHaveBeenCalledWith(
        { from: 1, to: 5 },
        ['label_one', 'user_two'],
        expect.any(Object),
        { mode: 'parallel' },
      );

      vi.mocked(startRangeJob).mockClear();
      const labelMatchDeps: RangeTriggerDeps = {
        listAccounts: async () => [acc1, acc2],
        getAccount: async () => null,
        startJob: startRangeJob,
      };
      await handleQuestionRangeTrigger({ from: 1, to: 3 }, 'user_two', labelMatchDeps, '9999');
      expect(startRangeJob).toHaveBeenCalledWith(
        { from: 1, to: 3 },
        'user_two',
        expect.any(Object),
        { mode: 'sequential' },
      );
    });

    it('accepts /solveincomplete + aliases in queue validation and awaits done on direct queued run', async () => {
      for (const alias of [
        '/completeincomplete', '/complete_incomplete', '/solveincomplete', '/solve_incomplete',
        '/incomplete', '/unsolved', '/solveunsolved', '/solve_unsolved',
      ]) {
        expect(validateQueueCommand(`${alias} 5 acc1`).valid).toBe(true);
      }

      installTelegramFetchMock();
      const acc1 = makeAccount('a1', 'acc1');
      vi.mocked(listAccounts).mockResolvedValue([acc1]);
      let resolved = false;
      let finishDone!: () => void;
      vi.mocked(startRangeJob).mockResolvedValueOnce({
        started: true,
        range: { from: 1, to: 5 },
        mode: 'sequential',
        accounts: [acc1],
        done: new Promise<any[]>((resolve) => {
          finishDone = () => {
            resolved = true;
            resolve([]);
          };
        }),
      });

      const execPromise = executeQueuedCommand({
        id: 'q2',
        rawText: '/solveincomplete 5 a1',
        command: '/solveincomplete',
        arg: '5 a1',
        queuedAt: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 15));
      expect(resolved).toBe(false);
      finishDone();
      await execPromise;
      expect(resolved).toBe(true);
    });

    it('selectively bypasses queue capture only for commands needing interactive pickers and clears pendingQueuePrompt', async () => {
      installTelegramFetchMock();
      const acc = makeAccount('a1', 'acc1');
      vi.mocked(listAccounts).mockResolvedValue([acc]);
      vi.mocked(listCodeforcesAccounts).mockResolvedValue([{ id: 'cf1', label: 'cf1', username: 'cf1' } as any]);

      setPendingQueuePrompt(true);
      await handleMessage({ message_id: 40, chat: { id: '9999' }, text: '/status' });
      expect(getCommandQueue().map((q) => q.rawText)).toContain('/status');
      expect(isPendingQueuePrompt()).toBe(false);

      clearCommandQueue();
      setPendingQueuePrompt(true);
      await handleMessage({ message_id: 41, chat: { id: '9999' }, text: '/cfrange 5' });
      expect(getCommandQueue()).toHaveLength(0);
      expect(isPendingQueuePrompt()).toBe(false);
      expect(cfRangeSelections.has('9999')).toBe(true);
      cfRangeSelections.clear();

      setPendingQueuePrompt(true);
      await handleMessage({ message_id: 42, chat: { id: '9999' }, text: '/questionrangesubmission 1-10' });
      expect(getCommandQueue()).toHaveLength(0);
      expect(isPendingQueuePrompt()).toBe(false);
      expect(lcRangeSelections.has('9999')).toBe(true);
    });

    it('passes bypassInteractivePrompts when executing queued default commands under an active prompt', async () => {
      const { calls } = installTelegramFetchMock();
      setPendingCapzyPrompt(true);

      await executeQueuedCommand({
        id: 'q3',
        rawText: '/status',
        command: '/status',
        arg: '',
        queuedAt: Date.now(),
      });

      expect(saveCapzyApiKeys).not.toHaveBeenCalled();
      expect(isPendingCapzyPrompt()).toBe(true);
      expect(calls.some((c) => String(c.body.text ?? '').includes('AGENT PULSE'))).toBe(true);
    });

    it('handles /cancel@bot, slash commands & documents under API-key prompts, setPendingPromptType sync, start queue order, and /cancel clearing', async () => {
      const { calls } = installTelegramFetchMock();

      setPendingPromptType('addcapzy');
      expect(isPendingAddCapzyPrompt()).toBe(true);
      await handleMessage({ message_id: 50, chat: { id: '9999' }, text: '/cancel@my_bot' });
      expect(isPendingAddCapzyPrompt()).toBe(false);
      expect(String(calls.at(-1)?.body.text)).toContain('cancelled');

      setPendingPromptType('solutionkeys');
      expect(isPendingSolutionKeysPrompt()).toBe(true);
      setPendingPromptType(null);
      expect(isPendingSolutionKeysPrompt()).toBe(false);

      setPendingPromptType('addcapzy');
      await handleMessage({ message_id: 51, chat: { id: '9999' }, text: '/status' });
      expect(addCapzyApiKeys).not.toHaveBeenCalled();
      expect(isPendingAddCapzyPrompt()).toBe(false);
      expect(calls.some((c) => String(c.body.text ?? '').includes('AGENT PULSE'))).toBe(true);

      setPendingPromptType('solutionkeys');
      await handleMessage({
        message_id: 52,
        chat: { id: '9999' },
        document: { file_id: 'doc1', file_name: 'big.json', file_size: 99_999_999 },
      });
      expect(appendSolutionApiKeys).not.toHaveBeenCalled();
      expect(isPendingSolutionKeysPrompt()).toBe(false);
      expect(String(calls.at(-1)?.body.text)).toContain('Could not download file (big.json): file too large');

      // start queue during awaiting_password must be treated as password, not queue prompt
      setActiveLoginPrompt({ site: 'codeforces', step: 'awaiting_password', label: 'cf', identifier: 'u' });
      await handleMessage({ message_id: 53, chat: { id: '9999' }, text: 'start queue' });
      expect(isPendingQueuePrompt()).toBe(false);

      // /cancel clears all 7 selection maps including `${chatKey}:*` keys
      contestSolutionSelections.set('9999', { step: 'accounts', contests: [], selectedQuestions: new Set(), selectedAccountIds: new Set() });
      dailySolutionSelections.set('9999', new Set(['a1']));
      manualSolutionSelections.set('9999', new Set(['a1']));
      cfRangeSelections.set('9999', { count: 5, selectedAccountIds: new Set(['c1']) });
      coinClaimSelections.set('9999', new Set(['a1']));
      lcIncompleteSelections.set('9999', { count: 5, selectedAccountIds: new Set(['a1']) });
      lcRangeSelections.set('9999:1-10', { range: { from: 1, to: 10 }, selectedAccountIds: new Set(['a1']) });

      await handleMessage({ message_id: 54, chat: { id: '9999' }, text: '/cancel@my_bot' });
      expect(contestSolutionSelections.size).toBe(0);
      expect(dailySolutionSelections.size).toBe(0);
      expect(manualSolutionSelections.size).toBe(0);
      expect(cfRangeSelections.size).toBe(0);
      expect(coinClaimSelections.size).toBe(0);
      expect(lcIncompleteSelections.size).toBe(0);
      expect(lcRangeSelections.size).toBe(0);
    });
  });

  describe('Bug 5: HTML escaping, 4096-char limits, tgApi non-JSON handling, DB & CF/LC integrity', () => {
    it('handles >4096 splitting/truncation, entity parse fallback, and message is not modified in telegram.ts', async () => {
      const { calls } = installTelegramFetchMock((method, body, idx) => {
        if (method === 'sendMessage' && body.parse_mode === 'HTML' && String(body.text).includes('<bad>')) {
          return new Response(JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" }), { status: 400 });
        }
        if (method === 'editMessageText' && String(body.text) === 'SAME_TEXT') {
          return new Response(JSON.stringify({ ok: false, description: 'Bad Request: message is not modified' }), { status: 400 });
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: idx + 1 } }), { status: 200 });
      });

      const longMultiline = Array.from({ length: 120 }, (_, i) => `Line ${i}: ${'x'.repeat(50)}`).join('\n');
      expect(await sendTelegramMessage(longMultiline)).toBe(true);
      const splitCalls = calls.filter((c) => c.method === 'sendMessage');
      expect(splitCalls.length).toBeGreaterThan(1);
      for (const c of splitCalls) {
        expect(String(c.body.text).length).toBeLessThanOrEqual(4096);
      }

      calls.length = 0;
      expect(await sendTelegramMessage(longMultiline, { replyMarkup: { inline_keyboard: [] } })).toBe(true);
      expect(calls).toHaveLength(1);
      expect(String(calls[0]!.body.text).length).toBeLessThanOrEqual(4096);

      calls.length = 0;
      expect(await sendTelegramMessage('<b>hi</b> & <bad>', { parseMode: 'HTML' })).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[1]!.body.parse_mode).toBeUndefined();
      expect(calls[1]!.body.text).toBe('hi & <bad>');

      expect(await editTelegramMessage(10, 'SAME_TEXT')).toBe(true);
    });

    it('escapes HTML in manual/range CF handlers, uses auto-HTML + entity fallback in UI deps, and cleans truncateHtml boundaries', async () => {
      const { calls } = installTelegramFetchMock((method, body, idx) => {
        if (body.parse_mode === 'HTML' && String(body.text).includes('TRIGGER_PARSE_ERR')) {
          return new Response(JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" }), { status: 400 });
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: idx + 1 } }), { status: 200 });
      });

      const edited: string[] = [];
      await handleCodeforcesManualButton('9999', 1, 'cb1', 'cfmanual:c1', {
        listAccounts: async () => [{ id: 'c1', label: 'A<B>&C', username: 'u<1>' } as any],
        nextEntry: async () => ({
          key: '2A',
          path: '2A.cpp',
          fileName: '2A.cpp',
          language: 'cpp',
          kind: 'CODEFORCES',
          contestId: 2,
          problemIndex: 'A',
          problemName: '<Title & More>',
          rawUrl: 'https://example.com/?a=1&b=2',
        }),
        send: async () => undefined,
        edit: async (_c, _m, text) => { edited.push(text); },
        answer: async () => undefined,
      });
      expect(edited[0]).toContain('A&lt;B&gt;&amp;C (u&lt;1&gt;)');
      expect(edited[0]).toContain('&lt;Title &amp; More&gt;');

      cfRangeSelections.set('9999', { count: 5, selectedAccountIds: new Set(['c1']) });
      const rangeEdits: string[] = [];
      await handleCodeforcesRangeButton(
        '9999',
        2,
        'cb2',
        'cfrange:run',
        {
          listAccounts: async () => [{ id: 'c1', label: 'cf<bad>', username: null } as any],
          inProgress: () => false,
          runner: vi.fn(async () => null),
          send: async () => undefined,
          edit: async (_c, _m, text) => { rangeEdits.push(text); },
          answer: async () => undefined,
        },
        vi.fn(async () => undefined) as any,
      );
      expect(rangeEdits[0]).toContain('cf&lt;bad&gt;');

      calls.length = 0;
      await defaultRemovalDeps.send('<b>Bold</b> TRIGGER_PARSE_ERR');
      expect(calls[0]!.body.parse_mode).toBe('HTML');
      expect(calls[1]!.body.parse_mode).toBeUndefined();

      await defaultCodeforcesSubmitUiDeps.send('<b>CF</b> TRIGGER_PARSE_ERR');
      await defaultCoinClaimUiDeps.edit('9999', 5, '<b>Coin</b> TRIGGER_PARSE_ERR');

      const broken = truncateHtml('<b><u>Hello &amp; WorldExtraPadding1234567890</u></b>', 35);
      expect(broken).not.toContain('&am');
      expect(broken).toContain('</u></b>');
      expect(broken.length).toBeLessThanOrEqual(35);
    });

    it('deletes encrypted LeetCode credentials and checks active range jobs in defaultRemovalDeps', async () => {
      const a1 = makeAccount('acc-1', 'lbl_one');
      const a2 = makeAccount('acc-2', 'lbl_two');
      vi.mocked(getAccountById).mockResolvedValueOnce(a1);
      vi.mocked(deleteAccountById).mockResolvedValueOnce(true);
      expect(await defaultRemovalDeps.deleteAccountById('acc-1')).toBe(true);
      expect(deleteEncryptedCredentials).toHaveBeenCalledWith('leetcode', 'lbl_one');

      vi.mocked(listAccounts).mockResolvedValueOnce([a1, a2]);
      vi.mocked(listCredentialLabels).mockResolvedValueOnce(['lbl_two', 'lbl_orphan']);
      vi.mocked(deleteAllAccounts).mockResolvedValueOnce(2);
      expect(await defaultRemovalDeps.deleteAllAccounts()).toBe(2);
      expect(deleteEncryptedCredentials).toHaveBeenCalledWith('leetcode', 'lbl_one');
      expect(deleteEncryptedCredentials).toHaveBeenCalledWith('leetcode', 'lbl_two');
      expect(deleteEncryptedCredentials).toHaveBeenCalledWith('leetcode', 'lbl_orphan');

      vi.mocked(currentRangeJob).mockReturnValueOnce({ id: 'job1' } as any);
      expect(defaultRemovalDeps.isRunInProgress()).toBe(true);
    });

    it('filters DISABLED accounts in pickers and rejects DISABLED accounts in single-ID range trigger', async () => {
      const active = makeAccount('a1', 'active_acc', 'active_acc', AccountStatus.ACTIVE);
      const disabled = makeAccount('d1', 'disabled_acc', 'disabled_acc', AccountStatus.DISABLED);
      const sent: Array<{ text: string; buttons?: any[][] }> = [];
      const deps: RemovalDeps = {
        listAccounts: async () => [active, disabled],
        deleteAccountById: async () => true,
        deleteAllAccounts: async () => 1,
        clearLegacySession: async () => undefined,
        isRunInProgress: () => false,
        send: async (text, buttons) => { sent.push({ text, buttons }); },
        edit: async () => undefined,
        answer: async () => undefined,
      };

      await handleQuestionRangeCommand('1-5', deps, {
        start: startRangeJob,
        current: () => null,
        cancel: () => false,
        now: () => Date.now(),
      }, '9999');
      const buttonLabels = (sent[0]?.buttons ?? []).flat().map((b) => String(b.text)).join('\n');
      expect(buttonLabels).toContain('active_acc');
      expect(buttonLabels).not.toContain('disabled_acc');
      expect(sent[0]?.text).not.toContain('disabled_acc');

      const singleDisabled = await handleQuestionRangeTrigger(
        { from: 1, to: 5 },
        'd1',
        {
          listAccounts: async () => [active, disabled],
          getAccount: async () => disabled,
          startJob: startRangeJob,
        },
        '9999',
      );
      expect(singleDisabled).toEqual({ started: false, reason: 'account-not-found' });
    });

    it('validates problemKey in handleCfSetProgress and updates all rows matching username or label', async () => {
      const { calls } = installTelegramFetchMock();
      vi.mocked(loadRuntimeSourceIndex).mockResolvedValue({
        entries: [],
        queue: [
          {
            key: '628B',
            path: '628B.cpp',
            fileName: '628B.cpp',
            language: 'cpp',
            kind: 'CODEFORCES',
            contestId: 628,
            problemIndex: 'B',
            rawUrl: 'https://raw.example/628B.cpp',
          },
        ],
      });

      await handleCfSetProgress('pts003 NONEXISTENT_999Z');
      expect(saveUsernameProgress).not.toHaveBeenCalled();
      expect(prisma.codeforcesProgress.upsert).not.toHaveBeenCalled();
      expect(String(calls.at(-1)?.body.text)).toContain('was not found in the Codeforces source queue');

      vi.mocked(listCodeforcesAccounts).mockResolvedValue([
        { id: 'cf-1', label: 'primary', username: 'pts003' } as any,
        { id: 'cf-2', label: 'pts003', username: 'other_handle' } as any,
      ]);

      await handleCfSetProgress('pts003 628B');
      expect(saveUsernameProgress).toHaveBeenCalledWith('pts003', { nextKey: '628B' });
      expect(prisma.codeforcesProgress.upsert).toHaveBeenCalledTimes(2);
    });

    it('reads tgApi error body via .json().catch(() => null) without crashing on HTML gateway errors', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: false,
          status: 502,
          json: async () => {
            throw new SyntaxError('Unexpected token < in JSON');
          },
        }) as unknown as Response),
      );

      await expect(defaultCoinClaimUiDeps.answer('cb-err')).rejects.toThrow(
        'telegram answerCallbackQuery failed: HTTP 502',
      );
    });
  });
});
