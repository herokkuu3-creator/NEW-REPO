import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkCapzyKeyBalance,
  getCandidateCapzyKeys,
  getCapzyApiKeys,
  getActiveCapzyKeyIndex,
  initCapzyKeys,
  isCapzyKeyError,
  isLikelyCapzyKey,
  maskApiKey,
  parseCapzyApiKeys,
  rotateToNextCapzyKey,
  saveCapzyApiKeys,
  setActiveCapzyKeyIndex,
} from '../src/codeforces/capzyKeyManager';
import { solveTurnstileWithCapzy } from '../src/codeforces/browserForm';
import {
  formatCapzyStatusMessage,
  handleCapSolverCommand,
  isPendingCapzyPrompt,
  setPendingCapzyPrompt,
  HELP_TEXT,
} from '../src/notifications/telegramBot';

describe('Capzy / CapSolver API Key Manager & Rotation', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    initCapzyKeys([]);
    setActiveCapzyKeyIndex(0);
    setPendingCapzyPrompt(false);
  });

  describe('parseCapzyApiKeys', () => {
    it('parses single, comma-separated, and newline-separated keys', () => {
      const input = 'capzy_key111111111111111111111111111111, capzy_key222222222222222222222222222222\ncapzy_key333333333333333333333333333333';
      const parsed = parseCapzyApiKeys(input);
      expect(parsed).toEqual([
        'capzy_key111111111111111111111111111111',
        'capzy_key222222222222222222222222222222',
        'capzy_key333333333333333333333333333333',
      ]);
    });

    it('strips surrounding quotes and brackets and deduplicates', () => {
      const input = '["capzy_keyAAA", \'capzy_keyBBB\', "capzy_keyAAA"]';
      const parsed = parseCapzyApiKeys(input);
      expect(parsed).toEqual(['capzy_keyAAA', 'capzy_keyBBB']);
    });

    it('discards placeholder values', () => {
      const input = 'capzy_validKey, none, null, test, fixture';
      const parsed = parseCapzyApiKeys(input);
      expect(parsed).toEqual(['capzy_validKey']);
    });
  });

  describe('maskApiKey', () => {
    it('masks long API keys correctly for secure Telegram display', () => {
      expect(maskApiKey('capzy_b1680657df2e72f365f078303446b985a2aa59c49adf5abe')).toBe('capzy_b1...5abe');
      expect(maskApiKey('capzy_696cff0b8e4ba932cf5af125cc3367489ee969291f61709f')).toBe('capzy_69...709f');
    });

    it('handles short keys and empty values safely', () => {
      expect(maskApiKey('')).toBe('(empty)');
      expect(maskApiKey('123456')).toBe('1234...56');
    });
  });

  describe('isLikelyCapzyKey', () => {
    it('identifies valid Capzy key strings', () => {
      expect(isLikelyCapzyKey('capzy_b1680657df2e72f365f078303446b985a2aa59c49adf5abe')).toBe(true);
      expect(isLikelyCapzyKey('capzy_b1680657df2e72f365f078303446b985a2aa59c49adf5abe, capzy_696cff0b8e4ba932cf5af125cc3367489ee969291f61709f')).toBe(true);
    });

    it('rejects bot commands, json, and regular text', () => {
      expect(isLikelyCapzyKey('/capsolver')).toBe(false);
      expect(isLikelyCapzyKey('{"key": "value"}')).toBe(false);
      expect(isLikelyCapzyKey('hello world')).toBe(false);
    });
  });

  describe('isCapzyKeyError', () => {
    it('detects insufficient balance and expired key error codes', () => {
      expect(isCapzyKeyError(1, 'ERROR_ZERO_BALANCE', 'Balance is zero')).toBe(true);
      expect(isCapzyKeyError(1, 'ERROR_KEY_DOES_NOT_EXIST', 'Invalid API key')).toBe(true);
      expect(isCapzyKeyError(1, 'ERROR_WRONG_USER_KEY', 'Key does not exist')).toBe(true);
      expect(isCapzyKeyError(1, 'ERROR_CREDIT_NOT_ENOUGH', 'Insufficient credits')).toBe(true);
      expect(isCapzyKeyError(1, 'PAYMENT_REQUIRED', 'Payment required')).toBe(true);
    });

    it('detects key error descriptions even without explicit code', () => {
      expect(isCapzyKeyError(1, null, 'Account has zero balance')).toBe(true);
      expect(isCapzyKeyError(1, null, 'Your API key is expired')).toBe(true);
      expect(isCapzyKeyError(1, null, 'Unauthorized access')).toBe(true);
    });

    it('returns false for non-key errors', () => {
      expect(isCapzyKeyError(0, null, null)).toBe(false);
      expect(isCapzyKeyError(2, 'TIMEOUT', 'Task execution timed out')).toBe(false);
    });
  });

  describe('Key rotation logic', () => {
    it('rotates to next key and advances active index', async () => {
      const keys = ['key1', 'key2', 'key3'];
      initCapzyKeys(keys, 0);

      expect(await getActiveCapzyKeyIndex()).toBe(0);
      let candidates = await getCandidateCapzyKeys(keys);
      expect(candidates).toEqual(['key1', 'key2', 'key3']);

      // Rotate after key1 failure
      const rot1 = await rotateToNextCapzyKey('key1', 'Zero balance', keys);
      expect(rot1.newKey).toBe('key2');
      expect(rot1.newIndex).toBe(1);
      expect(await getActiveCapzyKeyIndex()).toBe(1);

      candidates = await getCandidateCapzyKeys(keys);
      expect(candidates).toEqual(['key2', 'key3']);

      // Rotate after key2 failure
      const rot2 = await rotateToNextCapzyKey('key2', 'Out of funds', keys);
      expect(rot2.newKey).toBe('key3');
      expect(rot2.newIndex).toBe(2);
      expect(await getActiveCapzyKeyIndex()).toBe(2);

      candidates = await getCandidateCapzyKeys(keys);
      expect(candidates).toEqual(['key3']);

      // Exhaustion
      const rot3 = await rotateToNextCapzyKey('key3', 'Expired', keys);
      expect(rot3.newKey).toBeNull();
      expect(rot3.newIndex).toBe(3);
    });
  });

  describe('checkCapzyKeyBalance', () => {
    it('queries Capzy getBalance endpoint', async () => {
      const fetchStub = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ errorId: 0, balance: 0.1 }),
      });
      vi.stubGlobal('fetch', fetchStub);

      const res = await checkCapzyKeyBalance('capzy_test123');
      expect(res.ok).toBe(true);
      expect(res.balance).toBe(0.1);
      expect(fetchStub).toHaveBeenCalled();
      const call = fetchStub.mock.calls[0];
      expect(call[0]).toBe('https://api.capzy.ai/getBalance');
      expect(JSON.parse(call[1].body)).toEqual({ clientKey: 'capzy_test123' });
    });

    it('reports zero balance as error', async () => {
      const fetchStub = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ errorId: 0, balance: 0 }),
      });
      vi.stubGlobal('fetch', fetchStub);

      const res = await checkCapzyKeyBalance('capzy_testZero');
      expect(res.ok).toBe(false);
      expect(res.balance).toBe(0);
      expect(res.error).toContain('Zero balance');
    });
  });

  describe('Automatic Solver Rotation on Key Error', () => {
    it('detects key error on createTask, rotates to key 2, and succeeds', async () => {
      const key1 = 'capzy_depletedKey';
      const key2 = 'capzy_fundedKey';
      const keys = [key1, key2];
      initCapzyKeys(keys, 0);

      const fetchStub = vi.fn()
        // 1. First key fails createTask with ZERO_BALANCE
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ errorId: 1, errorCode: 'ERROR_ZERO_BALANCE', errorDescription: 'Account balance is zero' }),
        })
        // 2. Second key succeeds createTask
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ errorId: 0, taskId: 'task-rot-2' }),
        })
        // 3. Second key polls getTaskResult and succeeds
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ errorId: 0, status: 'ready', solution: { token: 'solved-with-key2' } }),
        });
      vi.stubGlobal('fetch', fetchStub);

      const result = await solveTurnstileWithCapzy('https://codeforces.com', 'real-sitekey-abc', undefined, undefined, 5_000, undefined, undefined, keys);
      expect(result).toEqual({ token: 'solved-with-key2', cookies: undefined });

      // Verifies active index rotated to 1 (key2) so future calls start with key2!
      expect(await getActiveCapzyKeyIndex()).toBe(1);

      // Verifies first call used key1, second call used key2
      const firstCallBody = JSON.parse(fetchStub.mock.calls[0][1].body);
      expect(firstCallBody.clientKey).toBe(key1);
      const secondCallBody = JSON.parse(fetchStub.mock.calls[1][1].body);
      expect(secondCallBody.clientKey).toBe(key2);
    });
  });

  describe('Telegram Bot Integration', () => {
    it('includes /capsolver and /capsolverstatus in HELP_TEXT', () => {
      expect(HELP_TEXT).toContain('<b>🧩 𝗖𝗔𝗣𝗧𝗖𝗛𝗔 𝗦𝗢𝗟𝗩𝗘𝗥</b>');
      expect(HELP_TEXT).toContain('/capsolver');
      expect(HELP_TEXT).toContain('/capsolverstatus');
    });

    it('formats solver status message correctly', async () => {
      initCapzyKeys(['capzy_aaa111111111111111111111111111111', 'capzy_bbb222222222222222222222222222222'], 0);

      const fetchStub = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ errorId: 0, balance: 0.05 }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ errorId: 0, balance: 0.1 }) });
      vi.stubGlobal('fetch', fetchStub);

      const status = await formatCapzyStatusMessage();
      expect(status).toContain('Total configured keys: <b>2</b>');
      expect(status).toContain('Active key');
      expect(status).toContain('[ACTIVE]');
    });
  });
});
