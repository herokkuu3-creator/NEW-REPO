import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  initCPSolverConfig,
  solveTurnstileOrchestrated,
  solveCloudflareOrchestrated,
  getCPSolverUrl,
  checkCPSolverHealth,
} from '../src/codeforces/captchaSolver';

describe('Solver Orchestration & Fallback Engine', () => {
  const originalEnv = process.env;
  let sentTelegramMessages: string[] = [];

  beforeEach(() => {
    process.env = { ...originalEnv };
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

      // CPSolver returns ok: true with cfClearance and cookies
      if (urlStr.includes('cpsolver.test.com/solve')) {
        cpsolverAttempts++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            cfClearance: 'cleared',
            cookies: { JSESSIONID: 'abc', '39ce7': 'xyz' },
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
    expect(result?.cfClearance).toBe('cleared');
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
});
