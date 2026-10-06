import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getRemovedProxyHashes,
  addRemovedProxy,
  restoreAllProxies,
  getCustomProxies,
  addCustomProxy,
  getAllConfiguredProxies,
  removeProxyByIndex,
  testAllProxiesOneByOne,
} from '../src/codeforces/proxyManager';
import { selectWorkingProxy, proxyHash } from '../src/codeforces/proxyRotator';
import {
  handleTestProxyCommand,
  handleRemoveProxyCommand,
  handleAddProxyCommand,
  handleRestoreProxiesCommand,
  handleProxyButton,
  type ProxyUiDeps,
} from '../src/notifications/telegramBot';

// Mock DB state storage
const dbMock: Record<string, string> = {};

vi.mock('../src/database/models', () => ({
  SystemKeys: {
    codeforcesRemovedProxies: 'codeforcesRemovedProxies',
    codeforcesCustomProxies: 'codeforcesCustomProxies',
  },
  getSystemState: vi.fn(async (key: string) => dbMock[key] ?? null),
  setSystemState: vi.fn(async (key: string, val: string) => {
    dbMock[key] = val;
  }),
}));

// Mock curl tests
vi.mock('../src/codeforces/proxyRotator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/codeforces/proxyRotator')>();
  return {
    ...actual,
    testProxyDetailed: vi.fn(async (url: string) => {
      if (url.includes('dead') || url.includes('fail')) {
        return { ok: false, latencyMs: 500, error: 'Connection refused' };
      }
      return { ok: true, latencyMs: 120, ip: '1.2.3.4' };
    }),
  };
});

describe('proxyManager', () => {
  beforeEach(() => {
    for (const k of Object.keys(dbMock)) delete dbMock[k];
  });

  it('adds and gets removed proxies', async () => {
    expect(await getRemovedProxyHashes()).toEqual([]);
    const proxy1 = 'http://user1:pass1@proxy1.com:8080';
    const res = await addRemovedProxy(proxy1);
    expect(res.hash).toBe(proxyHash(proxy1));
    expect(res.totalRemoved).toBe(1);

    const hashes = await getRemovedProxyHashes();
    expect(hashes).toContain(res.hash);

    // Idempotent
    await addRemovedProxy(proxy1);
    expect((await getRemovedProxyHashes()).length).toBe(1);
  });

  it('restores all proxies by clearing blacklist', async () => {
    await addRemovedProxy('http://user1:pass1@proxy1.com:8080');
    await addRemovedProxy('http://user2:pass2@proxy2.com:8080');
    expect((await getRemovedProxyHashes()).length).toBe(2);

    const cleared = await restoreAllProxies();
    expect(cleared).toBe(2);
    expect(await getRemovedProxyHashes()).toEqual([]);
  });

  it('adds custom proxies and parses them', async () => {
    expect(await getCustomProxies()).toEqual([]);
    const res = await addCustomProxy('http://myuser:mypass@customproxy.com:9000');
    expect(res.ok).toBe(true);
    expect(res.proxy).toBe('http://myuser:mypass@customproxy.com:9000');
    expect(res.masked).toBe('http://myuser:****@customproxy.com:9000');

    const custom = await getCustomProxies();
    expect(custom).toContain('http://myuser:mypass@customproxy.com:9000');
  });

  it('rejects invalid custom proxy URLs', async () => {
    const res = await addCustomProxy('not a proxy');
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
  });

  it('merges environment and custom proxies and tags removed status', async () => {
    const env = 'http://u1:p1@p1.com:8080, http://u2:p2@p2.com:8080';
    await addCustomProxy('http://u3:p3@p3.com:8080');

    // Remove proxy 2
    const hash2 = proxyHash('http://u2:p2@p2.com:8080');
    await addRemovedProxy(hash2);

    const all = await getAllConfiguredProxies(env);
    expect(all.length).toBe(3);

    expect(all[0]?.masked).toBe('http://u1:****@p1.com:8080');
    expect(all[0]?.isRemoved).toBe(false);

    expect(all[1]?.masked).toBe('http://u2:****@p2.com:8080');
    expect(all[1]?.isRemoved).toBe(true);

    expect(all[2]?.masked).toBe('http://u3:****@p3.com:8080');
    expect(all[2]?.isCustom).toBe(true);
    expect(all[2]?.isRemoved).toBe(false);
  });

  it('removes proxy by 1-based index', async () => {
    const env = 'http://u1:p1@p1.com:8080, http://u2:p2@p2.com:8080';
    const res = await removeProxyByIndex(2, env);
    expect(res.ok).toBe(true);
    expect(res.proxy?.index).toBe(2);
    expect(res.proxy?.masked).toBe('http://u2:****@p2.com:8080');

    const removedHashes = await getRemovedProxyHashes();
    expect(removedHashes).toContain(proxyHash('http://u2:p2@p2.com:8080'));
  });

  it('tests all proxies one by one', async () => {
    const env = 'http://u1:p1@good.com:8080, http://u2:p2@dead.com:8080';
    const progressCalls: number[] = [];
    const results = await testAllProxiesOneByOne((_, idx) => {
      progressCalls.push(idx);
    }, env);

    expect(results.length).toBe(2);
    expect(results[0]?.result.ok).toBe(true);
    expect(results[1]?.result.ok).toBe(false);
    expect(progressCalls).toEqual([1, 2]);
  });

  it('selectWorkingProxy skips removedHashes even if present in raw string', async () => {
    const raw = 'http://u1:p1@dead1.com:8080, http://u2:p2@good2.com:8080, http://u3:p3@good3.com:8080';
    const hash2 = proxyHash('http://u2:p2@good2.com:8080');

    const logged: string[] = [];
    const selected = await selectWorkingProxy(raw, {
      removedHashes: [hash2],
      tester: async (url) => !url.includes('dead'),
      log: (msg) => logged.push(msg),
    });

    // proxy 2 was removed, so proxy 3 should be selected!
    expect(selected.selectedProxy).toBe('http://u3:p3@good3.com:8080');
    expect(logged.some((l) => l.includes('was removed in database'))).toBe(true);
  });
});

describe('telegram proxy commands', () => {
  beforeEach(() => {
    for (const k of Object.keys(dbMock)) delete dbMock[k];
  });

  it('handles /testproxy with results', async () => {
    process.env.CODEFORCES_RESIDENTIAL_PROXY = 'http://u1:p1@good.com:8080, http://u2:p2@dead.com:8080';
    const sent: string[] = [];
    const deps: ProxyUiDeps = {
      send: vi.fn(async (text) => {
        sent.push(text);
      }),
      edit: vi.fn(),
      answer: vi.fn(),
    };

    await handleTestProxyCommand(deps);
    expect(sent.length).toBe(2); // initial + final
    expect(sent[1]).toContain('CODEFORCES PROXY HEALTH CHECK');
    expect(sent[1]).toContain('Working');
    expect(sent[1]).toContain('Failed');
  });

  it('handles /removeproxy with number and blacklists in DB', async () => {
    process.env.CODEFORCES_RESIDENTIAL_PROXY = 'http://u1:p1@p1.com:8080, http://u2:p2@p2.com:8080';
    const sent: string[] = [];
    const deps: ProxyUiDeps = {
      send: vi.fn(async (text) => {
        sent.push(text);
      }),
      edit: vi.fn(),
      answer: vi.fn(),
    };

    await handleRemoveProxyCommand('2', deps);
    expect(sent[0]).toContain('Proxy #2 Removed &amp; Blacklisted');
    expect(sent[0]).toContain('Saved to database blacklist');

    const removed = await getRemovedProxyHashes();
    expect(removed).toContain(proxyHash('http://u2:p2@p2.com:8080'));
  });

  it('handles /addproxy and tests connectivity', async () => {
    const sent: string[] = [];
    const deps: ProxyUiDeps = {
      send: vi.fn(async (text) => {
        sent.push(text);
      }),
      edit: vi.fn(),
      answer: vi.fn(),
    };

    await handleAddProxyCommand('http://u:p@added.com:8080', deps);
    expect(sent.length).toBe(3);
    expect(sent[0]).toContain('Added 1 proxy(ies)');
    expect(sent[2]).toContain('CODEFORCES PROXY HEALTH CHECK');

    const custom = await getCustomProxies();
    expect(custom).toContain('http://u:p@added.com:8080');
  });

  it('handles /restoreproxies to clear blacklist', async () => {
    await addRemovedProxy('http://u:p@any.com:8080');
    const sent: string[] = [];
    const deps: ProxyUiDeps = {
      send: vi.fn(async (text) => {
        sent.push(text);
      }),
      edit: vi.fn(),
      answer: vi.fn(),
    };

    await handleRestoreProxiesCommand(deps);
    expect(sent[0]).toContain('Proxy Blacklist Cleared');
    expect(sent[0]).toContain('Restored 1');
    expect(await getRemovedProxyHashes()).toEqual([]);
  });

  it('handles proxy button clicks for pxrm and pxdone', async () => {
    process.env.CODEFORCES_RESIDENTIAL_PROXY = 'http://u1:p1@p1.com:8080, http://u2:p2@p2.com:8080';
    const edited: string[] = [];
    const answered: string[] = [];
    const deps: ProxyUiDeps = {
      send: vi.fn(),
      edit: vi.fn(async (_chat, _msg, text) => {
        edited.push(text);
      }),
      answer: vi.fn(async (_id, text) => {
        if (text) answered.push(text);
      }),
    };

    await handleProxyButton(123, 456, 'q1', 'pxrm:1', deps);
    expect(answered[0]).toContain('Proxy #1 blacklisted');
    expect(edited[0]).toContain('Proxy #1');
    expect((await getRemovedProxyHashes()).length).toBe(1);

    await handleProxyButton(123, 456, 'q2', 'pxdone', deps);
    expect(edited[1]).toBe('✅ Done.');
  });

  it('handles /setproxies with multiple proxies', async () => {
    const sent: string[] = [];
    const deps: ProxyUiDeps = {
      send: vi.fn(async (text) => {
        sent.push(text);
      }),
      edit: vi.fn(),
      answer: vi.fn(),
    };

    await handleAddProxyCommand('http://u1:p1@a.com:8080, http://u2:p2@b.com:8080', deps);
    expect(sent.length).toBe(3); // confirmation + testing notice + results
    expect(sent[0]).toContain('Added 2 proxy(ies)');
    const custom = await getCustomProxies();
    expect(custom.length).toBe(2);
  });
});
