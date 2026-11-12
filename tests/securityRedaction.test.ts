import { describe, it, expect, beforeEach, vi } from 'vitest';
import { redactSecrets } from '../src/security/redact';
import { logger, logRingBuffer } from '../src/logger';
import { diagnosticLog, logRingBuffer as diagRingBuffer } from '../src/codeforces/diagnosticLog';

describe('Security & Secret Redaction', () => {
  beforeEach(() => {
    logRingBuffer.length = 0;
    diagRingBuffer.length = 0;
  });

  it('redacts Capzy keys, proxy passwords, Telegram bot tokens, Bearer tokens, and LeetCode cookies', () => {
    const raw = [
      'key=capzy_abcdef0123456789abcdef0123456789abcdef0123456789',
      'proxy=http://proxy_user:SuperSecretPass99@proxy.example.test:10000',
      'tg=https://api.telegram.org/bot123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd/sendMessage',
      'auth=Bearer secret-bearer-token-value-12345',
      'cookie=LEETCODE_SESSION=jwt.part1.part2; csrftoken=csrfval123',
    ].join(' | ');

    const scrubbed = redactSecrets(raw);
    expect(scrubbed).not.toContain('capzy_abcdef0123456789');
    expect(scrubbed).toContain('capzy_[REDACTED]');
    expect(scrubbed).not.toContain('SuperSecretPass99');
    expect(scrubbed).toContain('http://proxy_user:****@proxy.example.test:10000');
    expect(scrubbed).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZabcd');
    expect(scrubbed).toContain('bot[REDACTED]');
    expect(scrubbed).not.toContain('secret-bearer-token-value-12345');
    expect(scrubbed).not.toContain('jwt.part1.part2');
    expect(scrubbed).not.toContain('csrfval123');
  });

  it('scrubs secrets written via structured logger and logRingBuffer', () => {
    logger.info(
      {
        proxyUrl: 'http://u1:MyProxyPass123@proxy.example.test:10000',
        clientKey: 'capzy_1234567890abcdef1234567890abcdef1234567890abcd',
        err: 'Failed connecting via http://u1:MyProxyPass123@proxy.example.test:10000 using capzy_1234567890abcdef1234567890abcdef1234567890abcd',
      },
      'Redaction verification event',
    );

    const serialized = JSON.stringify(logRingBuffer);
    expect(serialized).not.toContain('MyProxyPass123');
    expect(serialized).not.toContain('capzy_1234567890abcdef');
    expect(serialized).toContain('[REDACTED]');
  });

  it('scrubs secrets in diagnosticLog entries', () => {
    diagnosticLog(
      'test-service',
      40,
      {
        apiKey: 'capzy_1234567890abcdef1234567890abcdef1234567890abcd',
        detail: 'Proxy failed on http://u1:SecretProxyPw@proxy.example.test:10000 with capzy_1234567890abcdef1234567890abcdef1234567890abcd',
      },
      'Diag redaction check',
    );

    const serialized = JSON.stringify(diagRingBuffer);
    expect(serialized).not.toContain('SecretProxyPw');
    expect(serialized).not.toContain('capzy_1234567890abcdef');
  });

  it('does not load any hardcoded Capzy API key outside test placeholder when env and DB are empty', async () => {
    vi.resetModules();
    vi.doMock('../src/database/models', () => ({
      SystemKeys: {},
      getSystemState: vi.fn(async () => null),
      setSystemState: vi.fn(async () => undefined),
    }));
    const prevVitest = process.env.VITEST;
    const prevNodeEnv = process.env.NODE_ENV;
    const prevKeys = process.env.CAPZY_API_KEYS;
    const prevKey = process.env.CAPZY_API_KEY;
    const prevCsKeys = process.env.CAPSOLVER_API_KEYS;
    const prevCsKey = process.env.CAPSOLVER_API_KEY;
    try {
      delete process.env.VITEST;
      process.env.NODE_ENV = 'production';
      delete process.env.CAPZY_API_KEYS;
      delete process.env.CAPZY_API_KEY;
      delete process.env.CAPSOLVER_API_KEYS;
      delete process.env.CAPSOLVER_API_KEY;

      const { getCapzyApiKeys } = await import('../src/codeforces/capzyKeyManager');
      const keys = await getCapzyApiKeys();
      expect(keys).toEqual([]);
    } finally {
      vi.doUnmock('../src/database/models');
      vi.resetModules();
      if (prevVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = prevVitest;
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
      if (prevKeys === undefined) delete process.env.CAPZY_API_KEYS;
      else process.env.CAPZY_API_KEYS = prevKeys;
      if (prevKey === undefined) delete process.env.CAPZY_API_KEY;
      else process.env.CAPZY_API_KEY = prevKey;
      if (prevCsKeys === undefined) delete process.env.CAPSOLVER_API_KEYS;
      else process.env.CAPSOLVER_API_KEYS = prevCsKeys;
      if (prevCsKey === undefined) delete process.env.CAPSOLVER_API_KEY;
      else process.env.CAPSOLVER_API_KEY = prevCsKey;
    }
  });
});
