import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseProxyList,
  maskProxyUrl,
  proxyHash,
  selectWorkingProxy,
} from '../src/codeforces/proxyRotator';

describe('proxyRotator', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('parseProxyList', () => {
    it('returns empty array on empty input', () => {
      expect(parseProxyList('')).toEqual([]);
      expect(parseProxyList(undefined)).toEqual([]);
      expect(parseProxyList('   ')).toEqual([]);
    });

    it('parses single proxy url', () => {
      expect(parseProxyList('http://user:pass@proxy1.example.com:8080')).toEqual([
        'http://user:pass@proxy1.example.com:8080',
      ]);
    });

    it('parses comma-separated proxy list', () => {
      const raw = 'http://u:p@p1.example.com:8080, http://u:p@p2.example.com:8080,socks5://u:p@p3.example.com:1080';
      expect(parseProxyList(raw)).toEqual([
        'http://u:p@p1.example.com:8080',
        'http://u:p@p2.example.com:8080',
        'socks5://u:p@p3.example.com:1080',
      ]);
    });

    it('parses newline-separated and mixed comma/newline proxy list', () => {
      const raw = `
        http://u:p@p1.example.com:8080,
        http://u:p@p2.example.com:8080
        # this is a comment
        socks5://u:p@p3.example.com:1080;
        https://u:p@p4.example.com:8443
      `;
      expect(parseProxyList(raw)).toEqual([
        'http://u:p@p1.example.com:8080',
        'http://u:p@p2.example.com:8080',
        'socks5://u:p@p3.example.com:1080',
        'https://u:p@p4.example.com:8443',
      ]);
    });

    it('ignores invalid URLs', () => {
      expect(parseProxyList('not-a-url, http://u:p@p1.example.com:8080, ftp://invalid')).toEqual([
        'http://u:p@p1.example.com:8080',
      ]);
    });
  });

  describe('maskProxyUrl', () => {
    it('masks password and keeps username and host', () => {
      expect(maskProxyUrl('http://myuser:mypassword@res-proxy.net:9000')).toBe(
        'http://myuser:****@res-proxy.net:9000',
      );
    });

    it('keeps proxy url without credentials intact', () => {
      expect(maskProxyUrl('http://res-proxy.net:9000')).toBe('http://res-proxy.net:9000');
    });
  });

  describe('selectWorkingProxy', () => {
    const p1 = 'http://u:p@proxy1.example.com:8080';
    const p2 = 'http://u:p@proxy2.example.com:8080';
    const p3 = 'http://u:p@proxy3.example.com:8080';
    const rawList = `${p1}, ${p2}\n${p3}`;

    it('selects first working proxy when candidate 0 is alive', async () => {
      const tester = vi.fn().mockImplementation(async (url: string) => url === p1);
      const logs: string[] = [];
      const result = await selectWorkingProxy(rawList, {
        stateDir: tmpDir,
        tester,
        log: (m) => logs.push(m),
      });

      expect(result.selectedProxy).toBe(p1);
      expect(result.index).toBe(0);
      expect(result.total).toBe(3);
      expect(tester).toHaveBeenCalledTimes(1);

      // Verify state was saved
      const state = JSON.parse(fs.readFileSync(path.join(tmpDir, 'proxy_state.json'), 'utf8'));
      expect(state.lastWorkingHash).toBe(proxyHash(p1));
      expect(state.deadProxyHashes).toEqual([]);
    });

    it('rotates to second proxy when first proxy fails health check and remembers dead proxy', async () => {
      const tester = vi.fn().mockImplementation(async (url: string) => url === p2);
      const logs: string[] = [];
      const result = await selectWorkingProxy(rawList, {
        stateDir: tmpDir,
        tester,
        log: (m) => logs.push(m),
      });

      expect(result.selectedProxy).toBe(p2);
      expect(result.index).toBe(1);
      expect(tester).toHaveBeenCalledTimes(2);

      // Verify state recorded p1 as dead
      const state = JSON.parse(fs.readFileSync(path.join(tmpDir, 'proxy_state.json'), 'utf8'));
      expect(state.deadProxyHashes).toContain(proxyHash(p1));
      expect(state.lastWorkingHash).toBe(proxyHash(p2));
    });

    it('skips dead proxies on subsequent run and directly tests next candidate', async () => {
      // Seed state file with p1 marked as dead
      fs.writeFileSync(
        path.join(tmpDir, 'proxy_state.json'),
        JSON.stringify({
          lastWorkingHash: proxyHash(p2),
          deadProxyHashes: [proxyHash(p1)],
          updatedAt: new Date().toISOString(),
        }),
      );

      const tester = vi.fn().mockImplementation(async (url: string) => url === p2);
      const logs: string[] = [];
      const result = await selectWorkingProxy(rawList, {
        stateDir: tmpDir,
        tester,
        log: (m) => logs.push(m),
      });

      expect(result.selectedProxy).toBe(p2);
      expect(result.index).toBe(1);
      // p1 was skipped completely! Only p2 was tested!
      expect(tester).toHaveBeenCalledTimes(1);
      expect(tester).toHaveBeenCalledWith(p2);
      expect(logs.some((l) => l.includes('previously marked expired/dead'))).toBe(true);
    });

    it('advances from p2 to p3 when p2 also expires', async () => {
      // Seed state file with p1 already marked dead
      fs.writeFileSync(
        path.join(tmpDir, 'proxy_state.json'),
        JSON.stringify({
          lastWorkingHash: proxyHash(p2),
          deadProxyHashes: [proxyHash(p1)],
          updatedAt: new Date().toISOString(),
        }),
      );

      // p2 now fails too, only p3 works
      const tester = vi.fn().mockImplementation(async (url: string) => url === p3);
      const result = await selectWorkingProxy(rawList, {
        stateDir: tmpDir,
        tester,
      });

      expect(result.selectedProxy).toBe(p3);
      expect(result.index).toBe(2);
      // p1 was skipped, p2 was tested (failed), p3 was tested (succeeded)
      expect(tester).toHaveBeenCalledTimes(2);

      const state = JSON.parse(fs.readFileSync(path.join(tmpDir, 'proxy_state.json'), 'utf8'));
      expect(state.deadProxyHashes).toContain(proxyHash(p1));
      expect(state.deadProxyHashes).toContain(proxyHash(p2));
      expect(state.lastWorkingHash).toBe(proxyHash(p3));
    });

    it('resets dead proxy cache if all configured proxies are dead', async () => {
      // Seed state file with all 3 marked as dead
      fs.writeFileSync(
        path.join(tmpDir, 'proxy_state.json'),
        JSON.stringify({
          lastWorkingHash: proxyHash(p3),
          deadProxyHashes: [proxyHash(p1), proxyHash(p2), proxyHash(p3)],
          updatedAt: new Date().toISOString(),
        }),
      );

      // Suppose p1 was recharged and works again!
      const tester = vi.fn().mockImplementation(async (url: string) => url === p1);
      const logs: string[] = [];
      const result = await selectWorkingProxy(rawList, {
        stateDir: tmpDir,
        tester,
        log: (m) => logs.push(m),
      });

      expect(result.selectedProxy).toBe(p1);
      expect(result.index).toBe(0);
      expect(logs.some((l) => l.includes('Resetting dead proxy cache'))).toBe(true);
    });

    it('throws when all proxies fail', async () => {
      const tester = vi.fn().mockResolvedValue(false);
      await expect(
        selectWorkingProxy(rawList, {
          stateDir: tmpDir,
          tester,
        }),
      ).rejects.toThrow('All 3 configured proxies failed health check');
    });
  });
});
