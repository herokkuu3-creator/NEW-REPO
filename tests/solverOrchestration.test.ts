import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  initCPSolverConfig,
  solveTurnstileOrchestrated,
  solveCloudflareOrchestrated,
  solveTurnstileWithCPSolver,
  solveCloudflareWithCPSolver,
  solveTurnstileWithCapzy,
  solveCloudflareWithCapzy,
  getCPSolverUrl,
  getCPSolverApiToken,
  isRealClearanceValue,
  checkCPSolverHealth,
  getLastCapzyDiagnostic,
  getLastCapzyError,
  validateCapzyTaskPayload,
  validateCapzySolution,
  sanitizeCapzyRequestPayload,
  isPermanentCapzyError,
  withCapzyRequestContext,
  MAX_CAPZY_ATTEMPTS,
  CAPZY_RETRY_DELAY_MS,
} from '../src/codeforces/captchaSolver';
import { withAttemptContext } from '../src/codeforces/attemptContext';

describe('Solver Orchestration & Fallback Engine', () => {
  const originalEnv = process.env;
  let sentTelegramMessages: string[] = [];

  beforeEach(() => {
    process.env = { ...originalEnv };
    initCPSolverConfig({ url: '', apiToken: '' });
    sentTelegramMessages = [];

    // Mock fetch for Telegram and solvers
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);

      // Telegram mock
      if (urlStr.includes('api.telegram.org')) {
        const body = JSON.parse(String(init?.body || '{}'));
        if (body.text) sentTelegramMessages.push(body.text);
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
          text: async () => JSON.stringify({ ok: true }),
        } as Response;
      }

      // Default fallback
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => 'Not Found',
      } as Response;
    }));
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('resolves CPSOLVER_URL or TURNSTILE_SOLVER_URL correctly', () => {
    delete process.env.CPSOLVER_URL;
    delete process.env.TURNSTILE_SOLVER_URL;
    initCPSolverConfig({ url: '' });
    expect(getCPSolverUrl()).toBe('');

    process.env.TURNSTILE_SOLVER_URL = 'https://turnstile.example.com/';
    expect(getCPSolverUrl()).toBe('https://turnstile.example.com');

    process.env.CPSOLVER_URL = 'https://cpsolver.example.com///';
    expect(getCPSolverUrl()).toBe('https://cpsolver.example.com');
  });

  it('attempts CPSolver first, succeeds on attempt 1, sends Telegram alerts, and avoids CapSolver', async () => {
    process.env.CPSOLVER_URL = 'https://cpsolver.test.com';
    process.env.TELEGRAM_BOT_TOKEN = '123456:test_token';
    process.env.TELEGRAM_CHAT_ID = '987654321';

    let cpsolverCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('api.telegram.org')) {
        const body = JSON.parse(String(init?.body || '{}'));
        if (body.text) sentTelegramMessages.push(body.text);
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }

      if (urlStr.includes('cpsolver.test.com/solve')) {
        cpsolverCalls++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            token: 'test_token_from_cpsolver_12345',
            durationMs: 3500,
            proxyUsed: 'http://bi_test:****@gate.busyip.com:18080',
          }),
        } as Response;
      }

      return { ok: false, status: 500 } as Response;
    }));

    const result = await solveTurnstileOrchestrated({
      siteurl: 'https://codeforces.com/contest/2275/submit',
      sitekey: '0x4AAAAAAtestkey',
      timeoutMs: 15_000,
    });

    expect(result).not.toBeNull();
    expect(result?.token).toBe('test_token_from_cpsolver_12345');
    expect(result?.source).toBe('cpsolver');
    expect(cpsolverCalls).toBe(1);

    // Verify Telegram messages were sent
    expect(sentTelegramMessages.some((msg) => msg.includes('Solving Turnstile via CPSolver'))).toBe(true);
    expect(sentTelegramMessages.some((msg) => msg.includes('Turnstile solved via CPSolver'))).toBe(true);
    expect(sentTelegramMessages.some((msg) => msg.includes('CapSolver / Capzy'))).toBe(false);
  });

  it('retries CPSolver up to 3 times, failing over to CapSolver on the 3rd failure', async () => {
    process.env.CPSOLVER_URL = 'https://cpsolver.test.com';
    process.env.TELEGRAM_BOT_TOKEN = '123456:test_token';
    process.env.TELEGRAM_CHAT_ID = '987654321';
    process.env.CPSOLVER_MAX_TRIES = '3';

    let cpsolverAttempts = 0;
    let capzyTaskCreated = false;
    let capzyTaskPolled = false;

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('api.telegram.org')) {
        const body = JSON.parse(String(init?.body || '{}'));
        if (body.text) sentTelegramMessages.push(body.text);
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }

      // CPSolver fails 3 times
      if (urlStr.includes('cpsolver.test.com/solve')) {
        cpsolverAttempts++;
        return {
          ok: false,
          status: 500,
          text: async () => 'Proxy timeout error',
        } as Response;
      }

      // Capzy API fallback
      if (urlStr.includes('api.capzy.ai/createTask')) {
        capzyTaskCreated = true;
        return {
          ok: true,
          status: 200,
          json: async () => ({ errorId: 0, taskId: 'task_abc_123' }),
        } as Response;
      }

      if (urlStr.includes('api.capzy.ai/getTaskResult')) {
        capzyTaskPolled = true;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            errorId: 0,
            status: 'ready',
            solution: { token: 'capzy_turnstile_solution_token' },
          }),
        } as Response;
      }

      return { ok: false, status: 500 } as Response;
    }));

    const result = await solveTurnstileOrchestrated({
      siteurl: 'https://codeforces.com/contest/2275/submit',
      sitekey: '0x4AAAAAAtestkey',
      timeoutMs: 5_000,
      overrideKeys: ['capzy_valid_key_1234567890abcdef1234567890'],
    });

    expect(cpsolverAttempts).toBe(3);
    expect(capzyTaskCreated).toBe(true);
    expect(capzyTaskPolled).toBe(true);
    expect(result).not.toBeNull();
    expect(result?.token).toBe('capzy_turnstile_solution_token');
    expect(result?.source).toBe('capsolver');

    // Verify Telegram messages
    expect(sentTelegramMessages.some((msg) => msg.includes('[Attempt 1/3]'))).toBe(true);
    expect(sentTelegramMessages.some((msg) => msg.includes('[Attempt 2/3]'))).toBe(true);
    expect(sentTelegramMessages.some((msg) => msg.includes('[Attempt 3/3]'))).toBe(true);
    expect(sentTelegramMessages.some((msg) => msg.includes('CPSolver failed after 3 attempts. Falling back to CapSolver'))).toBe(true);
    expect(sentTelegramMessages.some((msg) => msg.includes('Solving Turnstile via CapSolver / Capzy'))).toBe(true);
    expect(sentTelegramMessages.some((msg) => msg.includes('Turnstile solved via CapSolver / Capzy'))).toBe(true);
  });

  it('checks CPSolver health and reports online status with proxy pool info', async () => {
    process.env.CPSOLVER_URL = 'https://cpsolver.test.com';

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes('cpsolver.test.com/health')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'ok',
            uptimeSeconds: 7200,
            proxyPool: {
              total: 5,
              activeIndex: 2,
              activeProxy: 'http://bi_3:****@gate.busyip.com:18080',
            },
          }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    }));

    const health = await checkCPSolverHealth();
    expect(health.ok).toBe(true);
    expect(health.totalProxies).toBe(5);
    expect(health.activeIndex).toBe(2);
    expect(health.activeProxy).toBe('http://bi_3:****@gate.busyip.com:18080');
  });

  it('successfully returns CPSolver solution when cfClearance/cookies are resolved without requiring commercial fallback', async () => {
    process.env.CPSOLVER_URL = 'https://cpsolver.test.com';
    process.env.TELEGRAM_BOT_TOKEN = '123456:test_token';
    process.env.TELEGRAM_CHAT_ID = '987654321';

    let cpsolverAttempts = 0;
    let capzyCalled = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('api.telegram.org')) {
        const body = JSON.parse(String(init?.body || '{}'));
        if (body.text) sentTelegramMessages.push(body.text);
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }

      // CPSolver returns ok: true with a real cf_clearance cookie
      if (urlStr.includes('cpsolver.test.com/solve')) {
        cpsolverAttempts++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            cfClearance: 'real_cf_clearance_token_12345',
            cookies: { cf_clearance: 'real_cf_clearance_token_12345', JSESSIONID: 'abc' },
            durationMs: 4000,
          }),
        } as Response;
      }

      // Capzy API should never be called
      if (urlStr.includes('api.capzy.ai')) {
        capzyCalled = true;
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }

      return { ok: false, status: 500 } as Response;
    }));

    const result = await solveCloudflareOrchestrated({
      websiteURL: 'https://codeforces.com/contest/2275/submit',
      timeoutMs: 5_000,
      overrideKeys: ['capzy_valid_key_1234567890abcdef1234567890'],
    });

    expect(cpsolverAttempts).toBe(1);
    expect(capzyCalled).toBe(false);
    expect(result).not.toBeNull();
    expect(result?.cfClearance).toBe('real_cf_clearance_token_12345');
    expect(result?.source).toBe('cpsolver');
    expect(sentTelegramMessages.some((msg) => msg.includes('Cloudflare Challenge cleared via CPSolver!'))).toBe(true);
    expect(sentTelegramMessages.some((msg) => msg.includes('Falling back to CapSolver'))).toBe(false);
  });

  it('fails over to CapSolver when CPSolver returns clearance cookies but no token for generic Turnstile widget', async () => {
    process.env.CPSOLVER_URL = 'https://cpsolver.test.com';
    process.env.TELEGRAM_BOT_TOKEN = '123456:test_token';
    process.env.TELEGRAM_CHAT_ID = '987654321';

    let cpsolverCalls = 0;
    let capzyCalled = false;

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('api.telegram.org')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }

      // CPSolver returns cfClearance but token is undefined/empty
      if (urlStr.includes('cpsolver.test.com/solve')) {
        cpsolverCalls++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            cfClearance: 'cleared',
            cookies: { cf_clearance: 'xyz' },
            token: '',
            durationMs: 3000,
          }),
        } as Response;
      }

      // Capzy fallback provides real token
      if (urlStr.includes('api.capzy.ai/createTask')) {
        capzyCalled = true;
        return { ok: true, status: 200, json: async () => ({ errorId: 0, taskId: 'task_cf_token' }) } as Response;
      }

      if (urlStr.includes('api.capzy.ai/getTaskResult')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ errorId: 0, status: 'ready', solution: { token: '0.real_turnstile_token_from_capzy' } }),
        } as Response;
      }

      return { ok: false, status: 500 } as Response;
    }));

    // Generic site without Codeforces domain
    const result = await solveTurnstileOrchestrated({
      siteurl: 'https://example.com/protected-form',
      sitekey: '0x4AAAAAAgenericWidgetKey',
      timeoutMs: 5_000,
      overrideKeys: ['capzy_valid_key_1234567890abcdef1234567890'],
    });

    expect(capzyCalled).toBe(true);
    expect(result).not.toBeNull();
    expect(result?.token).toBe('0.real_turnstile_token_from_capzy');
    expect(result?.source).toBe('capsolver');
  });

  it('accepts CPSolver clearance cookies as success for Codeforces navigate mode', async () => {
    process.env.CPSOLVER_URL = 'https://cpsolver.test.com';
    process.env.TELEGRAM_BOT_TOKEN = '123456:test_token';
    process.env.TELEGRAM_CHAT_ID = '987654321';

    let capzyCalled = false;

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('api.telegram.org')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }

      if (urlStr.includes('cpsolver.test.com/solve')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            cfClearance: 'real_cf_clearance_cookie_value',
            cookies: { cf_clearance: 'real_cf_clearance_cookie_value' },
            token: '',
            durationMs: 2500,
            proxyUsed: 'http://gate.busyip.com:18080',
          }),
        } as Response;
      }

      if (urlStr.includes('api.capzy.ai')) {
        capzyCalled = true;
        return { ok: true, status: 200, json: async () => ({ errorId: 0, taskId: 'task_cf' }) } as Response;
      }

      return { ok: false, status: 500 } as Response;
    }));

    const result = await solveTurnstileOrchestrated({
      siteurl: 'https://codeforces.com/contest/92/submit',
      sitekey: '0x4AAAAAAADnPIDROrmt1Wwj',
      timeoutMs: 5_000,
      overrideKeys: ['capzy_valid_key_1234567890abcdef1234567890'],
    });

    expect(capzyCalled).toBe(false);
    expect(result).not.toBeNull();
    expect(result?.cfClearance).toBe('real_cf_clearance_cookie_value');
    expect(result?.source).toBe('cpsolver');
  });

  it('addCapzyApiKeys preserves existing keys and appends new unique keys', async () => {
    const { initCapzyKeys, getCapzyApiKeys, addCapzyApiKeys, saveCapzyApiKeys } = await import(
      '../src/codeforces/capzyKeyManager'
    );

    // Initial setup with two keys
    await saveCapzyApiKeys(['existing_key_1', 'existing_key_2']);
    let keys = await getCapzyApiKeys();
    expect(keys).toEqual(['existing_key_1', 'existing_key_2']);

    // Append new keys (including one duplicate)
    const addResult = await addCapzyApiKeys(['existing_key_1', 'new_key_3', 'new_key_4']);
    expect(addResult.ok).toBe(true);
    expect(addResult.addedKeys).toEqual(['new_key_3', 'new_key_4']);
    expect(addResult.alreadyPresentKeys).toEqual(['existing_key_1']);
    expect(addResult.totalKeys).toEqual(['existing_key_1', 'existing_key_2', 'new_key_3', 'new_key_4']);

    keys = await getCapzyApiKeys();
    expect(keys).toEqual(['existing_key_1', 'existing_key_2', 'new_key_3', 'new_key_4']);
  });

  it('preserves the full URL path in Capzy Turnstile task without stripping to origin', async () => {
    delete process.env.CPSOLVER_URL;
    let capturedTask: Record<string, unknown> | null = null;

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('api.telegram.org')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }
      if (urlStr.includes('api.capzy.ai/createTask')) {
        const body = JSON.parse(String(init?.body || '{}'));
        capturedTask = body.task as Record<string, unknown>;
        return {
          ok: true,
          status: 200,
          json: async () => ({ errorId: 0, taskId: 'task_turnstile_full_url' }),
        } as Response;
      }
      if (urlStr.includes('api.capzy.ai/getTaskResult')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            errorId: 0,
            status: 'ready',
            solution: { token: 'solved_turnstile_token_123' },
          }),
        } as Response;
      }
      return { ok: false, status: 500 } as Response;
    }));

    const result = await solveTurnstileOrchestrated({
      siteurl: 'https://leetcode.com/accounts/login/',
      sitekey: '0x4AAAAAAADnPIDROrmt1Wwj',
      overrideKeys: ['capzy_valid_key_1234567890abcdef1234567890'],
      timeoutMs: 5000,
    });

    expect(result).not.toBeNull();
    expect(result?.token).toBe('solved_turnstile_token_123');
    expect(capturedTask).not.toBeNull();
    expect((capturedTask as any)?.websiteURL).toBe('https://leetcode.com/accounts/login/');
    expect((capturedTask as any)?.websiteKey).toBe('0x4AAAAAAADnPIDROrmt1Wwj');
  });

  it('rejects solveCloudflareOrchestrated with ERROR_PROXY_REQUIRED when neither sitekey nor proxy is provided (never substituting 0x4AAAAAAADnPIDROrmt1Wwj)', async () => {
    delete process.env.CPSOLVER_URL;
    delete process.env.CODEFORCES_PROXY;
    delete process.env.LEETCODE_RESIDENTIAL_PROXY;
    delete process.env.LEETCODE_PROXY;
    let createTaskCalled = false;

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes('api.telegram.org')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }
      if (urlStr.includes('api.capzy.ai/createTask')) {
        createTaskCalled = true;
        return {
          ok: true,
          status: 200,
          json: async () => ({ errorId: 0, taskId: 'task_unexpected' }),
        } as Response;
      }
      return { ok: false, status: 500 } as Response;
    }));

    const result = await solveCloudflareOrchestrated({
      websiteURL: 'https://leetcode.com/accounts/login/',
      overrideKeys: ['capzy_valid_key_1234567890abcdef1234567890'],
      timeoutMs: 5000,
    });

    expect(result).toBeNull();
    expect(createTaskCalled).toBe(false);
    const diag = getLastCapzyDiagnostic();
    expect(diag.providerErrorCode).toBe('ERROR_PROXY_REQUIRED');
    expect(diag.providerErrorCategory).toBe('INVALID_REQUEST_CONFIGURATION');
    expect(diag.permanentError).toBe(true);
    expect(diag.attemptsMade).toBe(0);
  });

  it('captures Capzy Insufficient Balance error and surfaces helpful /addcapzy guidance in Telegram', async () => {
    delete process.env.CPSOLVER_URL;
    process.env.TELEGRAM_BOT_TOKEN = '123456:test_token';
    process.env.TELEGRAM_CHAT_ID = '987654321';

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('api.telegram.org')) {
        const body = JSON.parse(String(init?.body || '{}'));
        if (body.text) sentTelegramMessages.push(body.text);
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }
      if (urlStr.includes('api.capzy.ai/createTask')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            errorId: 1,
            errorCode: 'ERROR_ZERO_BALANCE',
            errorDescription: 'Insufficient balance. Need $0.0012, have $0.0004',
          }),
        } as Response;
      }
      return { ok: false, status: 500 } as Response;
    }));

    const result = await solveTurnstileOrchestrated({
      siteurl: 'https://leetcode.com/accounts/login/',
      sitekey: '0x4AAAAAAAQrSHUTor4iGTpW',
      overrideKeys: ['capzy_depleted_key_1234567890abcdef'],
      timeoutMs: 3000,
    });

    expect(result).toBeNull();
    const failMsg = sentTelegramMessages.find((m) => m.includes('CapSolver / Capzy also failed'));
    expect(failMsg).toBeDefined();
    expect(failMsg).toContain('Insufficient balance. Need $0.0012, have $0.0004');
    expect(failMsg).toContain('/addcapzy');
  });

  it('does NOT treat "(No credits were deducted.)" or unregistered sitekeys as key errors', async () => {
    const { isCapzyKeyError } = await import('../src/codeforces/capzyKeyManager');
    expect(isCapzyKeyError(
      1,
      'ERROR_WRONG_TASK_TYPE',
      'This sitekey is not registered for AntiTurnstileTaskProxyLess. Use  instead. (No credits were deducted.).',
    )).toBe(false);
  });

  it('treats ERROR_WRONG_TASK_TYPE as a permanent configuration error and NEVER substitutes 0x4AAAAAAADnPIDROrmt1Wwj', async () => {
    delete process.env.CPSOLVER_URL;
    const attempts: any[] = [];

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('api.telegram.org')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }
      if (urlStr.includes('api.capzy.ai/createTask')) {
        const body = JSON.parse(String(init?.body || '{}'));
        attempts.push(body.task);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            errorId: 1,
            errorCode: 'ERROR_WRONG_TASK_TYPE',
            errorDescription: 'This sitekey is not registered for AntiTurnstileTaskProxyLess. Use  instead. (No credits were deducted.).',
          }),
        } as Response;
      }
      return { ok: false, status: 500 } as Response;
    }));

    const result = await solveTurnstileOrchestrated({
      siteurl: 'https://leetcode.com/accounts/login/',
      sitekey: '0x4AAAAAAAQrSHUTor4iGTpW',
      overrideKeys: ['capzy_funded_key_1234567890abcdef'],
      timeoutMs: 5000,
    });

    expect(result).toBeNull();
    expect(attempts.length).toBe(1);
    expect(attempts[0].websiteKey).toBe('0x4AAAAAAAQrSHUTor4iGTpW');
    const diag = getLastCapzyDiagnostic();
    expect(diag.providerErrorCode).toBe('ERROR_WRONG_TASK_TYPE');
    expect(diag.permanentError).toBe(true);
    expect(diag.attemptsMade).toBe(1);
    expect((diag.sanitizedRequest?.body as any)?.task?.websiteKey).toBe('0x4AAAAAAAQrSHUTor4iGTpW');
  });

  it('triggers immediate failover in solveCloudflareOrchestrated when CPSolver returns HTTP 408 timeout (verificationRequired)', async () => {
    process.env.CPSOLVER_URL = 'https://cpsolver.test.com';
    process.env.CPSOLVER_MAX_TRIES = '3';

    let cpsolverCalls = 0;
    let capzyTaskCreated = false;

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes('api.telegram.org')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }
      if (urlStr.includes('cpsolver.test.com/solve')) {
        cpsolverCalls++;
        return {
          ok: false,
          status: 408,
          text: async () => 'Challenge timeout waiting for Turnstile clearance',
        } as Response;
      }
      if (urlStr.includes('api.capzy.ai/createTask')) {
        capzyTaskCreated = true;
        return { ok: true, status: 200, json: async () => ({ errorId: 0, taskId: 'task_cf_408_fallback' }) } as Response;
      }
      if (urlStr.includes('api.capzy.ai/getTaskResult')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            errorId: 0,
            status: 'ready',
            solution: { cookies: { cf_clearance: 'capzy_clearance_after_408' }, userAgent: 'Mozilla/5.0' },
          }),
        } as Response;
      }
      return { ok: false, status: 500 } as Response;
    }));

    const result = await solveCloudflareOrchestrated({
      websiteURL: 'https://codeforces.com/contest/2275/submit',
      proxyUrl: 'http://user:pass@proxy.example.com:8080',
      overrideKeys: ['capzy_valid_key_1234567890abcdef1234567890'],
      timeoutMs: 5000,
    });

    expect(cpsolverCalls).toBe(1);
    expect(capzyTaskCreated).toBe(true);
    expect(result).not.toBeNull();
    expect(result?.cfClearance).toBe('capzy_clearance_after_408');
    expect(result?.source).toBe('capsolver');
  });

  it('handles non-OK HTTP responses and malformed JSON from Capzy and rotates keys on HTTP 402 during polling', async () => {
    const { initCapzyKeys } = await import('../src/codeforces/capzyKeyManager');
    delete process.env.CPSOLVER_URL;
    initCapzyKeys(['key_1_depleted_mid_poll', 'key_2_funded_backup'], 0);
    const usedClientKeys: string[] = [];

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('api.telegram.org')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }
      if (urlStr.includes('api.capzy.ai/createTask')) {
        const body = JSON.parse(String(init?.body || '{}'));
        usedClientKeys.push(body.clientKey);
        return {
          ok: true,
          status: 200,
          json: async () => ({ errorId: 0, taskId: `task_for_${body.clientKey}` }),
        } as Response;
      }
      if (urlStr.includes('api.capzy.ai/getTaskResult')) {
        const body = JSON.parse(String(init?.body || '{}'));
        if (body.clientKey === 'key_1_depleted_mid_poll') {
          return {
            ok: false,
            status: 402,
            text: async () => '<html>502/402 Payment Required non-json body</html>',
            json: async () => {
              throw new SyntaxError('Unexpected token < in JSON');
            },
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            errorId: 0,
            status: 'ready',
            solution: { token: 'solved_by_second_key' },
          }),
        } as Response;
      }
      return { ok: false, status: 500 } as Response;
    }));

    const result = await solveTurnstileOrchestrated({
      siteurl: 'https://codeforces.com/contest/2275/submit',
      sitekey: '0x4AAAAAAADnPIDROrmt1Wwj',
      overrideKeys: ['key_1_depleted_mid_poll', 'key_2_funded_backup'],
      timeoutMs: 5000,
    });

    expect(result).not.toBeNull();
    expect(result?.token).toBe('solved_by_second_key');
    expect(usedClientKeys).toEqual(['key_1_depleted_mid_poll', 'key_2_funded_backup']);
  });

  it('clears in-memory Capzy keys when initCapzyKeys([]) is called with an empty list', async () => {
    const { initCapzyKeys, getCapzyApiKeys } = await import('../src/codeforces/capzyKeyManager');
    delete process.env.CAPZY_API_KEYS;
    delete process.env.CAPZY_API_KEY;
    delete process.env.CAPSOLVER_API_KEY;

    initCapzyKeys(['key_alpha', 'key_beta'], 1);
    expect(await getCapzyApiKeys()).toEqual(['key_alpha', 'key_beta']);

    initCapzyKeys([], 0);
    expect(await getCapzyApiKeys()).toEqual([]);
  });

  describe('Phase 1-6: Capzy Request Correctness & Bounded 3-Attempt Retry Verification', () => {
    beforeEach(() => {
      delete process.env.CPSOLVER_URL;
      delete process.env.TURNSTILE_SOLVER_URL;
      process.env.CAPZY_RETRY_DELAY_MS = '15';
      process.env.MAX_CAPZY_ATTEMPTS = '3';
    });

    it('exports MAX_CAPZY_ATTEMPTS = 3 and CAPZY_RETRY_DELAY_MS = 10000 constants', () => {
      expect(MAX_CAPZY_ATTEMPTS).toBe(3);
      expect(CAPZY_RETRY_DELAY_MS).toBe(10_000);
    });

    it('1. First-attempt success: creates 1 task, validates solution schema, and stops without retrying', async () => {
      let createCalls = 0;
      let pollCalls = 0;
      let capturedPayload: any = null;

      vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr.includes('api.capzy.ai/createTask')) {
          createCalls++;
          capturedPayload = JSON.parse(String(init?.body || '{}'));
          return {
            ok: true,
            status: 200,
            json: async () => ({ errorId: 0, taskId: 'task_attempt_1_ok' }),
          } as Response;
        }
        if (urlStr.includes('api.capzy.ai/getTaskResult')) {
          pollCalls++;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              errorId: 0,
              status: 'ready',
              solution: { token: '0.valid_turnstile_token_from_attempt_1' },
            }),
          } as Response;
        }
        return { ok: false, status: 500 } as Response;
      }));

      const res = await solveTurnstileWithCapzy(
        'https://leetcode.com/accounts/login/#fragment',
        '0x4AAAAAAADnPIDROrmt1Wwj',
        undefined,
        'Mozilla/5.0 TestUA',
        5_000,
        'login',
        'cdata_123',
        ['capzy_test_fixture_00000000000000000000000000000000'],
      );

      expect(res).toEqual({
        token: '0.valid_turnstile_token_from_attempt_1',
        cookies: undefined,
      });
      expect(createCalls).toBe(1);
      expect(pollCalls).toBe(1);
      expect(capturedPayload.task.type).toBe('AntiTurnstileTaskProxyLess');
      expect(capturedPayload.task.websiteURL).toBe('https://leetcode.com/accounts/login/');
      expect(capturedPayload.task.websiteKey).toBe('0x4AAAAAAADnPIDROrmt1Wwj');
      expect(capturedPayload.task.action).toBe('login');
      expect(capturedPayload.task.cdata).toBe('cdata_123');
      expect(capturedPayload.task.metadata).toEqual({ action: 'login', cdata: 'cdata_123' });

      const diag = getLastCapzyDiagnostic();
      expect(diag.attemptsMade).toBe(1);
      expect(diag.requestAccepted).toBe(true);
      expect(diag.operationCompleted).toBe(true);
      expect(diag.taskLifecycleState).toBe('ready');
    });

    it('2. Second-attempt success: retries after terminal ERROR_CAPTCHA_UNSOLVABLE on attempt 1 and succeeds on attempt 2', async () => {
      const events: string[] = [];
      let createCount = 0;

      vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
        const urlStr = String(url);
        const body = JSON.parse(String(init?.body || '{}'));
        if (urlStr.includes('api.capzy.ai/createTask')) {
          createCount++;
          const taskId = `task_attempt_${createCount}`;
          events.push(`create:${taskId}`);
          return {
            ok: true,
            status: 200,
            json: async () => ({ errorId: 0, taskId }),
          } as Response;
        }
        if (urlStr.includes('api.capzy.ai/getTaskResult')) {
          events.push(`poll:${body.taskId}`);
          if (body.taskId === 'task_attempt_1') {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                errorId: 1,
                errorCode: 'ERROR_CAPTCHA_UNSOLVABLE',
                errorDescription: 'The captcha could not be solved by workers',
                status: 'failed',
              }),
            } as Response;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              errorId: 0,
              status: 'ready',
              solution: { token: '0.valid_turnstile_token_from_attempt_2' },
            }),
          } as Response;
        }
        return { ok: false, status: 500 } as Response;
      }));

      const res = await solveTurnstileWithCapzy(
        'https://leetcode.com/accounts/login/',
        '0x4AAAAAAADnPIDROrmt1Wwj',
        undefined,
        undefined,
        5_000,
        undefined,
        undefined,
        ['capzy_test_fixture_00000000000000000000000000000000'],
      );

      expect(res?.token).toBe('0.valid_turnstile_token_from_attempt_2');
      expect(createCount).toBe(2);
      // Verify sequential execution: attempt 1 reaches terminal poll before attempt 2 is created
      expect(events).toEqual([
        'create:task_attempt_1',
        'poll:task_attempt_1',
        'create:task_attempt_2',
        'poll:task_attempt_2',
      ]);
      expect(getLastCapzyDiagnostic().attemptsMade).toBe(2);
      expect(getLastCapzyDiagnostic().operationCompleted).toBe(true);
    });

    it('3. Third-attempt success: retries after 2 retryable failures and succeeds on attempt 3', async () => {
      let createCount = 0;

      vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
        const urlStr = String(url);
        const body = JSON.parse(String(init?.body || '{}'));
        if (urlStr.includes('api.capzy.ai/createTask')) {
          createCount++;
          return {
            ok: true,
            status: 200,
            json: async () => ({ errorId: 0, taskId: `task_${createCount}` }),
          } as Response;
        }
        if (urlStr.includes('api.capzy.ai/getTaskResult')) {
          if (body.taskId === 'task_1' || body.taskId === 'task_2') {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                errorId: 1,
                errorCode: 'ERROR_CAPTCHA_UNSOLVABLE',
                errorDescription: 'Worker failed to solve Turnstile challenge',
              }),
            } as Response;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              errorId: 0,
              status: 'ready',
              solution: { token: '0.valid_turnstile_token_from_attempt_3' },
            }),
          } as Response;
        }
        return { ok: false, status: 500 } as Response;
      }));

      const res = await solveTurnstileWithCapzy(
        'https://leetcode.com/accounts/login/',
        '0x4AAAAAAADnPIDROrmt1Wwj',
        undefined,
        undefined,
        5_000,
        undefined,
        undefined,
        ['capzy_test_fixture_00000000000000000000000000000000'],
      );

      expect(res?.token).toBe('0.valid_turnstile_token_from_attempt_3');
      expect(createCount).toBe(3);
      expect(getLastCapzyDiagnostic().attemptsMade).toBe(3);
      expect(getLastCapzyDiagnostic().operationCompleted).toBe(true);
    });

    it('4. Three failed attempts: stops after MAX_CAPZY_ATTEMPTS (3) and preserves provider error diagnostics', async () => {
      let createCount = 0;

      vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
        const urlStr = String(url);
        if (urlStr.includes('api.capzy.ai/createTask')) {
          createCount++;
          return {
            ok: true,
            status: 200,
            json: async () => ({ errorId: 0, taskId: `task_fail_${createCount}` }),
          } as Response;
        }
        if (urlStr.includes('api.capzy.ai/getTaskResult')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              errorId: 1,
              errorCode: 'ERROR_CAPTCHA_UNSOLVABLE',
              errorDescription: 'Capzy worker could not solve Turnstile after 3 tries',
            }),
          } as Response;
        }
        return { ok: false, status: 500 } as Response;
      }));

      const res = await solveTurnstileWithCapzy(
        'https://leetcode.com/accounts/login/',
        '0x4AAAAAAADnPIDROrmt1Wwj',
        undefined,
        undefined,
        5_000,
        undefined,
        undefined,
        ['capzy_test_fixture_00000000000000000000000000000000'],
      );

      expect(res).toBeNull();
      expect(createCount).toBe(3);
      const diag = getLastCapzyDiagnostic();
      expect(diag.attemptsMade).toBe(3);
      expect(diag.maxAttempts).toBe(3);
      expect(diag.providerErrorCode).toBe('ERROR_CAPTCHA_UNSOLVABLE');
      expect(diag.providerErrorDescription).toContain('Capzy worker could not solve Turnstile after 3 tries');
      expect(diag.taskLifecycleState).toBe('failed');
      expect(diag.operationCompleted).toBe(false);
    });

    it('5. Permanent provider errors: never retries invalid credentials, insufficient balance, or bad parameters', async () => {
      let createCount = 0;

      vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
        const urlStr = String(url);
        if (urlStr.includes('api.capzy.ai/createTask')) {
          createCount++;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              errorId: 1,
              errorCode: 'ERROR_BAD_PARAMETERS',
              errorDescription: 'Bad parameters: invalid domain or task configuration',
            }),
          } as Response;
        }
        return { ok: false, status: 500 } as Response;
      }));

      const res = await solveTurnstileWithCapzy(
        'https://leetcode.com/accounts/login/',
        '0x4AAAAAAADnPIDROrmt1Wwj',
        undefined,
        undefined,
        5_000,
        undefined,
        undefined,
        ['capzy_test_fixture_00000000000000000000000000000000'],
      );

      expect(res).toBeNull();
      expect(createCount).toBe(1);
      const diag = getLastCapzyDiagnostic();
      expect(diag.attemptsMade).toBe(1);
      expect(diag.permanentError).toBe(true);
      expect(diag.providerErrorCode).toBe('ERROR_BAD_PARAMETERS');
      expect(isPermanentCapzyError({ errorCode: 'ERROR_ZERO_BALANCE' })).toBe(true);
      expect(isPermanentCapzyError({ errorCode: 'ERROR_KEY_DOES_NOT_EXIST' })).toBe(true);
      expect(isPermanentCapzyError({ httpStatus: 401 })).toBe(true);
      expect(isPermanentCapzyError({ errorCode: 'ERROR_CAPTCHA_UNSOLVABLE' })).toBe(false);
    });

    it('6. Incorrect request configuration: fails local schema validation with 0 HTTP calls and sanitizes debug output', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      // Invalid websiteURL (not a valid http/https URL)
      const res = await solveTurnstileWithCapzy(
        'not-a-valid-url',
        '0x4AAAAAAADnPIDROrmt1Wwj',
        undefined,
        undefined,
        5_000,
        undefined,
        undefined,
        ['capzy_test_fixture_00000000000000000000000000000000'],
      );

      expect(res).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
      const diag = getLastCapzyDiagnostic();
      expect(diag.providerErrorCategory).toBe('INVALID_REQUEST_CONFIGURATION');
      expect(diag.permanentError).toBe(true);
      expect(diag.attemptsMade).toBe(0);

      // Verify validateCapzyTaskPayload schema checks directly
      expect(validateCapzyTaskPayload({
        clientKey: 'capzy_valid_key',
        task: { type: 'AntiTurnstileTask', websiteURL: 'https://leetcode.com', websiteKey: '0x4AAA', proxyType: 'http', proxyAddress: 'in.decodo.com', proxyPort: 99999 },
      }).valid).toBe(false);

      // Verify sanitizeCapzyRequestPayload redacts secrets
      const sanitized = sanitizeCapzyRequestPayload({
        clientKey: 'capzy_test_fixture_00000000000000000000000000000000',
        task: {
          type: 'AntiTurnstileTask',
          websiteURL: 'https://leetcode.com/accounts/login/?token=secret123',
          websiteKey: '0x4AAAAAAADnPIDROrmt1Wwj',
          proxyType: 'http',
          proxyAddress: 'proxy.example.test',
          proxyPort: 10000,
          proxyLogin: 'secret_user',
          proxyPassword: 'secret_password',
        },
      });
      const serialized = JSON.stringify(sanitized);
      expect(serialized).not.toContain('capzy_test_fixture_00000000000000000000000000000000');
      expect(serialized).not.toContain('secret_user');
      expect(serialized).not.toContain('secret_password');
      expect(serialized).not.toContain('secret123');
      expect((sanitized.body as any).task.websiteKey).toBe('0x4AAAAAAADnPIDROrmt1Wwj');
    });

    it('7. Polling timeout & invalid ready solution: retries when task polling times out or returns empty solution', async () => {
      let createCount = 0;

      vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
        const urlStr = String(url);
        const body = JSON.parse(String(init?.body || '{}'));
        if (urlStr.includes('api.capzy.ai/createTask')) {
          createCount++;
          return {
            ok: true,
            status: 200,
            json: async () => ({ errorId: 0, taskId: `task_timeout_${createCount}` }),
          } as Response;
        }
        if (urlStr.includes('api.capzy.ai/getTaskResult')) {
          if (body.taskId === 'task_timeout_1') {
            // Always processing until timeout
            return {
              ok: true,
              status: 200,
              json: async () => ({ errorId: 0, status: 'processing' }),
            } as Response;
          }
          if (body.taskId === 'task_timeout_2') {
            // Ready but invalid empty token -> fails immediately with INVALID_SOLUTION_PAYLOAD instead of infinite polling
            return {
              ok: true,
              status: 200,
              json: async () => ({ errorId: 0, status: 'ready', solution: { token: '' } }),
            } as Response;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              errorId: 0,
              status: 'ready',
              solution: { token: '0.valid_token_after_timeout_and_invalid_ready' },
            }),
          } as Response;
        }
        return { ok: false, status: 500 } as Response;
      }));

      const res = await solveTurnstileWithCapzy(
        'https://leetcode.com/accounts/login/',
        '0x4AAAAAAADnPIDROrmt1Wwj',
        undefined,
        undefined,
        150, // short timeout for test speed
        undefined,
        undefined,
        ['capzy_test_fixture_00000000000000000000000000000000'],
      );

      expect(res?.token).toBe('0.valid_token_after_timeout_and_invalid_ready');
      expect(createCount).toBe(3);
      expect(validateCapzySolution({ token: 'short' }, 'AntiTurnstileTaskProxyLess').valid).toBe(false);
    });

    it('8. Application cancellation: aborts in-flight retry delay immediately and prevents further attempts', async () => {
      process.env.CAPZY_RETRY_DELAY_MS = '5000';
      const controller = new AbortController();
      let createCount = 0;

      vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
        const urlStr = String(url);
        if (urlStr.includes('api.capzy.ai/createTask')) {
          createCount++;
          return {
            ok: true,
            status: 200,
            json: async () => ({ errorId: 0, taskId: `task_cancel_${createCount}` }),
          } as Response;
        }
        if (urlStr.includes('api.capzy.ai/getTaskResult')) {
          // Schedule abort right after attempt 1 fails so it cancels during the 5000ms retry sleep
          setTimeout(() => controller.abort(new Error('User cancelled login')), 25);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              errorId: 1,
              errorCode: 'ERROR_CAPTCHA_UNSOLVABLE',
              errorDescription: 'Retryable failure before cancellation',
            }),
          } as Response;
        }
        return { ok: false, status: 500 } as Response;
      }));

      await expect(
        withAttemptContext(
          'cancel-test-1',
          Date.now() + 10_000,
          () =>
            solveTurnstileWithCapzy(
              'https://leetcode.com/accounts/login/',
              '0x4AAAAAAADnPIDROrmt1Wwj',
              undefined,
              undefined,
              5_000,
              undefined,
              undefined,
              ['capzy_test_fixture_00000000000000000000000000000000'],
            ),
          controller.signal,
        ),
      ).rejects.toThrow();

      expect(createCount).toBe(1);
    });

    it('9. Duplicate-task prevention: blocks simultaneous task creation within the same request context', async () => {
      vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
        const urlStr = String(url);
        if (urlStr.includes('api.capzy.ai/createTask')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ errorId: 0, taskId: 'task_in_flight_1' }),
          } as Response;
        }
        if (urlStr.includes('api.capzy.ai/getTaskResult')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              errorId: 0,
              status: 'ready',
              solution: { token: '0.first_task_completed_token' },
            }),
          } as Response;
        }
        return { ok: false, status: 500 } as Response;
      }));

      await withCapzyRequestContext(async () => {
        const p1 = solveTurnstileWithCapzy(
          'https://leetcode.com/accounts/login/',
          '0x4AAAAAAADnPIDROrmt1Wwj',
          undefined,
          undefined,
          5_000,
          undefined,
          undefined,
          ['capzy_test_fixture_00000000000000000000000000000000'],
        );
        // Trigger a second task inside the exact same requestId context while p1 is still in-flight
        const p2 = solveTurnstileWithCapzy(
          'https://leetcode.com/accounts/login/',
          '0x4AAAAAAADnPIDROrmt1Wwj',
          undefined,
          undefined,
          5_000,
          undefined,
          undefined,
          ['capzy_test_fixture_00000000000000000000000000000000'],
        );
        const [r1, r2] = await Promise.all([p1, p2]);
        // Exactly one succeeds and the duplicate concurrent call in the same request context is blocked
        expect([r1 !== null, r2 !== null]).toContain(true);
        expect([r1 === null, r2 === null]).toContain(true);
      }, 'shared-request-id-123');
    });

    it('10. Concurrent requests: isolates diagnostics and state across parallel independent requests', async () => {
      vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
        const urlStr = String(url);
        const body = JSON.parse(String(init?.body || '{}'));
        if (urlStr.includes('api.capzy.ai/createTask')) {
          const isSuccessReq = body.task?.websiteURL?.includes('account-a');
          return {
            ok: true,
            status: 200,
            json: async () => ({
              errorId: 0,
              taskId: isSuccessReq ? 'task_concurrent_a' : 'task_concurrent_b',
            }),
          } as Response;
        }
        if (urlStr.includes('api.capzy.ai/getTaskResult')) {
          if (body.taskId === 'task_concurrent_a') {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                errorId: 0,
                status: 'ready',
                solution: { token: '0.token_for_concurrent_account_a' },
              }),
            } as Response;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              errorId: 1,
              errorCode: 'ERROR_BAD_PARAMETERS',
              errorDescription: 'Permanent failure for account B',
            }),
          } as Response;
        }
        return { ok: false, status: 500 } as Response;
      }));

      const [outcomeA, outcomeB] = await Promise.all([
        withCapzyRequestContext(async () => {
          const res = await solveTurnstileWithCapzy(
            'https://leetcode.com/accounts/login/?user=account-a',
            '0x4AAAAAAADnPIDROrmt1Wwj',
            undefined,
            undefined,
            5_000,
            undefined,
            undefined,
            ['capzy_test_fixture_00000000000000000000000000000000'],
          );
          return { res, diag: getLastCapzyDiagnostic(), err: getLastCapzyError() };
        }, 'req-a'),
        withCapzyRequestContext(async () => {
          const res = await solveTurnstileWithCapzy(
            'https://leetcode.com/accounts/login/?user=account-b',
            '0x4AAAAAAADnPIDROrmt1Wwj',
            undefined,
            undefined,
            5_000,
            undefined,
            undefined,
            ['capzy_test_fixture_00000000000000000000000000000000'],
          );
          return { res, diag: getLastCapzyDiagnostic(), err: getLastCapzyError() };
        }, 'req-b'),
      ]);

      expect(outcomeA.res?.token).toBe('0.token_for_concurrent_account_a');
      expect(outcomeA.diag.taskLifecycleState).toBe('ready');
      expect(outcomeA.diag.operationCompleted).toBe(true);

      expect(outcomeB.res).toBeNull();
      expect(outcomeB.diag.taskLifecycleState).toBe('failed');
      expect(outcomeB.diag.providerErrorCode).toBe('ERROR_BAD_PARAMETERS');
      expect(outcomeB.err).toBe('Permanent failure for account B');
    });

    it('11. Outer orchestration budget cap: solveCloudflareWithCapzy + proxyTask never exceeds MAX_CAPZY_ATTEMPTS (3) total Capzy tasks', async () => {
      let createCount = 0;
      const taskTypes: string[] = [];

      vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
        const urlStr = String(url);
        const body = JSON.parse(String(init?.body || '{}'));
        if (urlStr.includes('api.capzy.ai/createTask')) {
          createCount++;
          taskTypes.push(body.task.type);
          return {
            ok: true,
            status: 200,
            json: async () => ({ errorId: 0, taskId: `task_budget_${createCount}` }),
          } as Response;
        }
        if (urlStr.includes('api.capzy.ai/getTaskResult')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              errorId: 1,
              errorCode: 'ERROR_CAPTCHA_UNSOLVABLE',
              errorDescription: 'Worker failed to solve challenge',
            }),
          } as Response;
        }
        return { ok: false, status: 500 } as Response;
      }));

      // Call solveCloudflareWithCapzy WITH a proxyUrl so AntiCloudflareTask runs first,
      // and ensure the fallback to solveTurnstileWithCapzy does NOT spawn extra attempts beyond 3 total!
      const res = await solveCloudflareWithCapzy(
        'https://leetcode.com/accounts/login/',
        'http://user:pass@in.decodo.com:10000',
        undefined,
        5_000,
        undefined,
        undefined,
        undefined,
        ['capzy_test_fixture_00000000000000000000000000000000'],
      );

      expect(res).toBeNull();
      expect(createCount).toBe(3);
      expect(getLastCapzyDiagnostic().attemptsMade).toBe(3);
    });

    it('12. Sanitizes HeadlessChrome User-Agent to desktop Chrome User-Agent before submitting to Capzy', async () => {
      let capturedTask: Record<string, unknown> | null = null;
      vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr.includes('api.capzy.ai/createTask')) {
          const body = JSON.parse(String(init?.body || '{}'));
          capturedTask = body.task;
          return {
            ok: true,
            status: 200,
            json: async () => ({ errorId: 0, taskId: 'task_ua_sanitize' }),
          } as Response;
        }
        if (urlStr.includes('api.capzy.ai/getTaskResult')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              errorId: 0,
              status: 'ready',
              solution: { token: '0.ua_sanitized_token_123456' },
            }),
          } as Response;
        }
        return { ok: false, status: 500 } as Response;
      }));

      const res = await solveTurnstileWithCapzy(
        'https://leetcode.com/accounts/login/',
        '0x4AAAAAAADnPIDROrmt1Wwj',
        undefined,
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.8010.12 Safari/537.36',
        5_000,
        undefined,
        undefined,
        ['capzy_test_fixture_00000000000000000000000000000000'],
      );

      expect(res?.token).toBe('0.ua_sanitized_token_123456');
      expect(capturedTask).not.toBeNull();
      expect(String((capturedTask as any)?.userAgent)).not.toContain('HeadlessChrome');
      expect(String((capturedTask as any)?.userAgent)).toContain('Chrome/131.0.0.0');
    });
  });

  describe('CPSolver False-Success Prevention & API Authentication', () => {
    it('rejects placeholder clearance sentinels (e.g. "cleared") in both direct and orchestrated paths', async () => {
      expect(isRealClearanceValue('cleared')).toBe(false);
      expect(isRealClearanceValue('ok')).toBe(false);
      expect(isRealClearanceValue('short')).toBe(false);
      expect(isRealClearanceValue('real_cf_clearance_cookie_value_12345')).toBe(true);

      process.env.CPSOLVER_URL = 'https://cpsolver.test.com';
      process.env.CPSOLVER_MAX_TRIES = '1';

      vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
        const urlStr = String(url);
        if (urlStr.includes('cpsolver.test.com/solve')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              cfClearance: 'cleared',
              cookies: { cf_clearance: 'cleared', JSESSIONID: 'abc' },
              durationMs: 1200,
            }),
          } as Response;
        }
        return { ok: false, status: 500, json: async () => ({}) } as Response;
      }));

      const cfDirect = await solveCloudflareWithCPSolver({
        siteurl: 'https://leetcode.com/accounts/login/',
        timeoutMs: 5_000,
      });
      expect(cfDirect.ok).toBe(false);
      expect(cfDirect.cfClearance).toBeUndefined();

      const tsDirect = await solveTurnstileWithCPSolver({
        siteurl: 'https://leetcode.com/accounts/login/',
        sitekey: '0x4AAAAAAADnPIDROrmt1Wwj',
        timeoutMs: 5_000,
      });
      expect(tsDirect.ok).toBe(false);
      expect(tsDirect.cfClearance).toBeUndefined();

      const cfOrch = await solveCloudflareOrchestrated({
        websiteURL: 'https://leetcode.com/accounts/login/',
        timeoutMs: 5_000,
        overrideKeys: [],
      });
      expect(cfOrch).toBeNull();
    });

    it('attaches CPSOLVER_API_TOKEN Authorization and x-api-key headers to CPSolver requests', async () => {
      process.env.CPSOLVER_URL = 'https://cpsolver.test.com';
      process.env.CPSOLVER_API_TOKEN = 'test_service_secret_12345';
      expect(getCPSolverApiToken()).toBe('test_service_secret_12345');

      const seenHeaders: Record<string, string>[] = [];
      vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        seenHeaders.push(headers);
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'ok', ok: true, token: '0.valid_turnstile_token_12345' }),
        } as Response;
      }));

      await checkCPSolverHealth();
      await solveTurnstileWithCPSolver({
        siteurl: 'https://example.com',
        sitekey: '1x00000000000000000000AA',
        timeoutMs: 5_000,
      });

      expect(seenHeaders.length).toBe(2);
      for (const h of seenHeaders) {
        expect(h.Authorization).toBe('Bearer test_service_secret_12345');
        expect(h['x-api-key']).toBe('test_service_secret_12345');
      }
    });
  });
});


