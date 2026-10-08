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
  getPreferredProxy,
  setPreferredProxy,
  setPreferredProxyByIndex,
  clearPreferredProxy,
  extractProxyDetails,
  resolveActiveProxy,
} from '../src/codeforces/proxyManager';
import { selectWorkingProxy, proxyHash, toPlaywrightProxy } from '../src/codeforces/proxyRotator';
import {
  handleTestProxyCommand,
  handleUseProxyCommand,
  handleRemoveProxyCommand,
  handleAddProxyCommand,
  handleRestoreProxiesCommand,
  handleProxyButton,
  extractTelegramCommand,
  isLikelyProxyPayload,
  type ProxyUiDeps,
} from '../src/notifications/telegramBot';
import { notifyProxyInUse } from '../src/codeforces/remoteSubmitter';
import { sendTelegramMessage } from '../src/notifications/telegram';

vi.mock('../src/notifications/telegram', () => ({
  sendTelegramMessage: vi.fn(async () => true),
}));

// Mock DB state storage
const dbMock: Record<string, string> = {};

vi.mock('../src/database/models', () => ({
  SystemKeys: {
    codeforcesRemovedProxies: 'codeforcesRemovedProxies',
    codeforcesCustomProxies: 'codeforcesCustomProxies',
    codeforcesPreferredProxy: 'codeforcesPreferredProxy',
  },
  getSystemState: vi.fn(async (key: string) => dbMock[key] ?? null),
  setSystemState: vi.fn(async (key: string, val: string) => {
    dbMock[key] = val;
  }),
  deleteSystemState: vi.fn(async (key: string) => {
    delete dbMock[key];
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

  it('extractProxyDetails extracts host and username correctly', () => {
    const p1 = extractProxyDetails('http://user123:pass456@gate.brightdata.com:33335');
    expect(p1.host).toBe('gate.brightdata.com:33335');
    expect(p1.username).toBe('user123');

    const p2 = extractProxyDetails('http://1.2.3.4:8080');
    expect(p2.host).toBe('1.2.3.4:8080');
    expect(p2.username).toBe('none');

    const p3 = extractProxyDetails('gate.brightdata.com:33335:user789:pass999');
    expect(p3.host).toBe('gate.brightdata.com:33335');
    expect(p3.username).toBe('user789');

    const p4 = extractProxyDetails('userabc:passdef@gate.brightdata.com:33335');
    expect(p4.host).toBe('gate.brightdata.com:33335');
    expect(p4.username).toBe('userabc');
  });

  it('toPlaywrightProxy converts proxy string to Playwright proxy format', () => {
    const res = toPlaywrightProxy('http://myuser:mypass@myhost.com:8080');
    expect(res).toEqual({
      server: 'http://myhost.com:8080',
      username: 'myuser',
      password: 'mypass',
    });

    const direct = toPlaywrightProxy('http://myhost.com:8080');
    expect(direct).toEqual({
      server: 'http://myhost.com:8080',
    });

    expect(toPlaywrightProxy('')).toBeUndefined();
  });

  it('gets, sets, and clears preferred proxy', async () => {
    const env = 'http://u1:p1@p1.com:8080, http://u2:p2@p2.com:8080';
    expect(await getPreferredProxy()).toBeNull();

    const setRes = await setPreferredProxyByIndex(2, env);
    expect(setRes.ok).toBe(true);
    expect(setRes.proxy?.url).toBe('http://u2:p2@p2.com:8080');
    expect(setRes.proxy?.isPreferred).toBe(true);
    expect(await getPreferredProxy()).toBe('http://u2:p2@p2.com:8080');

    const all = await getAllConfiguredProxies(env);
    expect(all[1]?.isPreferred).toBe(true);
    expect(all[0]?.isPreferred).toBe(false);

    await clearPreferredProxy();
    expect(await getPreferredProxy()).toBeNull();
  });

  it('resolveActiveProxy uses preferred proxy when it is live', async () => {
    const env = 'http://u1:p1@first.com:8080, http://u2:p2@second.com:8080';
    await setPreferredProxyByIndex(2, env);

    const active = await resolveActiveProxy({
      envSource: env,
      tester: async () => true,
    });

    expect(active).not.toBeNull();
    expect(active?.url).toBe('http://u2:p2@second.com:8080');
    expect(active?.host).toBe('second.com:8080');
    expect(active?.username).toBe('u2');
    expect(active?.fromPreferred).toBe(true);
    expect(active?.fallbackOccurred).toBe(false);
  });

  it('resolveActiveProxy falls back to testing from the start when preferred proxy is dead', async () => {
    const env = 'http://u1:p1@first-live.com:8080, http://u2:p2@second-dead.com:8080, http://u3:p3@third-live.com:8080';
    await setPreferredProxyByIndex(2, env);

    const tested: string[] = [];
    const active = await resolveActiveProxy({
      envSource: env,
      tester: async (url) => {
        tested.push(url);
        return !url.includes('dead');
      },
    });

    expect(active).not.toBeNull();
    // Preferred proxy #2 was tested first, failed, then it fell back to proxy #1 from start!
    expect(active?.url).toBe('http://u1:p1@first-live.com:8080');
    expect(active?.host).toBe('first-live.com:8080');
    expect(active?.username).toBe('u1');
    expect(active?.fromPreferred).toBe(false);
    expect(active?.fallbackOccurred).toBe(true);
    expect(tested[0]).toBe('http://u2:p2@second-dead.com:8080');
    expect(tested[1]).toBe('http://u1:p1@first-live.com:8080');
  });

  it('resolveActiveProxy starts from index 0 when no preferred proxy is configured', async () => {
    const env = 'http://u1:p1@dead1.com:8080, http://u2:p2@live2.com:8080';
    const tested: string[] = [];
    const active = await resolveActiveProxy({
      envSource: env,
      tester: async (url) => {
        tested.push(url);
        return url.includes('live2');
      },
    });

    expect(active).not.toBeNull();
    expect(active?.url).toBe('http://u2:p2@live2.com:8080');
    expect(active?.fromPreferred).toBe(false);
    expect(active?.fallbackOccurred).toBe(false);
    expect(tested).toEqual(['http://u1:p1@dead1.com:8080', 'http://u2:p2@live2.com:8080']);
  });

  it('resolveActiveProxy skips redundant testing of dead preferred proxy during fallback', async () => {
    const env = 'http://u1:p1@first-dead.com:8080, http://u2:p2@second-preferred-dead.com:8080, http://u3:p3@third-live.com:8080';
    await setPreferredProxyByIndex(2, env);

    const tested: string[] = [];
    const active = await resolveActiveProxy({
      envSource: env,
      tester: async (url) => {
        tested.push(url);
        return url.includes('third-live');
      },
    });

    expect(active).not.toBeNull();
    expect(active?.url).toBe('http://u3:p3@third-live.com:8080');
    expect(active?.fromPreferred).toBe(false);
    expect(active?.fallbackOccurred).toBe(true);

    // Tested sequence: preferred proxy (#2) first -> then pool from start (#1) -> then #3 (skipping #2!)
    expect(tested).toEqual([
      'http://u2:p2@second-preferred-dead.com:8080',
      'http://u1:p1@first-dead.com:8080',
      'http://u3:p3@third-live.com:8080',
    ]);
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

  it('handles /useproxy without args: tests proxies and sends interactive buttons', async () => {
    process.env.CODEFORCES_RESIDENTIAL_PROXY = 'http://u1:p1@good.com:8080, http://u2:p2@dead.com:8080';
    const sent: { text: string; buttons?: any[] }[] = [];
    const deps: ProxyUiDeps = {
      send: vi.fn(async (text, buttons) => {
        sent.push({ text, buttons });
      }),
      edit: vi.fn(),
      answer: vi.fn(),
    };

    await handleUseProxyCommand('', deps);
    expect(sent.length).toBe(2); // testing notice + interactive selection menu
    expect(sent[1]?.text).toContain('CODEFORCES PROXY SELECTION');
    expect(sent[1]?.text).toContain('Live');
    expect(sent[1]?.text).toContain('Failed');
    // Live proxy button + dead proxy button + auto fallback + done
    expect(sent[1]?.buttons).toBeDefined();
    expect(sent[1]?.buttons?.some((row) => row[0]?.callback_data === 'pxuse:1')).toBe(true);
    expect(sent[1]?.buttons?.some((row) => row[0]?.callback_data === 'pxuse:auto')).toBe(true);
  });

  it('handles /useproxy <number> to set preferred proxy', async () => {
    process.env.CODEFORCES_RESIDENTIAL_PROXY = 'http://u1:p1@p1.com:8080, http://u2:p2@p2.com:8080';
    const sent: string[] = [];
    const deps: ProxyUiDeps = {
      send: vi.fn(async (text) => {
        sent.push(text);
      }),
      edit: vi.fn(),
      answer: vi.fn(),
    };

    await handleUseProxyCommand('2', deps);
    expect(sent[0]).toContain('Preferred Proxy Selected: #2');
    expect(sent[0]).toContain('Host:');
    expect(sent[0]).toContain('p2.com:8080');
    expect(sent[0]).toContain('User:');
    expect(sent[0]).toContain('u2');
    expect(await getPreferredProxy()).toBe('http://u2:p2@p2.com:8080');
  });

  it('handles /useproxy auto to reset preferred proxy', async () => {
    process.env.CODEFORCES_RESIDENTIAL_PROXY = 'http://u1:p1@p1.com:8080, http://u2:p2@p2.com:8080';
    await setPreferredProxyByIndex(2);
    expect(await getPreferredProxy()).toBe('http://u2:p2@p2.com:8080');

    const sent: string[] = [];
    const deps: ProxyUiDeps = {
      send: vi.fn(async (text) => {
        sent.push(text);
      }),
      edit: vi.fn(),
      answer: vi.fn(),
    };

    await handleUseProxyCommand('auto', deps);
    expect(sent[0]).toContain('Reset to Automatic Proxy Rotation');
    expect(await getPreferredProxy()).toBeNull();
  });

  it('handles proxy button clicks for pxuse:<index> and pxuse:auto', async () => {
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

    await handleProxyButton(123, 456, 'q1', 'pxuse:2', deps);
    expect(answered[0]).toContain('Preferred proxy #2 selected');
    expect(edited[0]).toContain('Preferred Proxy Selected: #2');
    expect(edited[0]).toContain('p2.com:8080');
    expect(await getPreferredProxy()).toBe('http://u2:p2@p2.com:8080');

    await handleProxyButton(123, 456, 'q2', 'pxuse:auto', deps);
    expect(answered[1]).toContain('Reset to auto');
    expect(edited[1]).toContain('Reset to Automatic Proxy Rotation');
    expect(await getPreferredProxy()).toBeNull();
  });

  it('notifyProxyInUse drops a message in the bot with proxy host and username', async () => {
    process.env.CODEFORCES_RESIDENTIAL_PROXY = 'http://user_cf:pass_cf@myhost.org:1080';
    vi.mocked(sendTelegramMessage).mockClear();

    const result = await notifyProxyInUse('proxy');
    expect(result).not.toBeNull();
    expect(result?.host).toBe('myhost.org:1080');
    expect(result?.username).toBe('user_cf');

    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(sendTelegramMessage).mock.calls[0];
    expect(callArgs?.[0]).toContain('Proxy in use:');
    expect(callArgs?.[0]).toContain('myhost.org:1080');
    expect(callArgs?.[0]).toContain('user_cf');
  });

  it('notifyProxyInUse skips Telegram notification when networkMode is tailscale', async () => {
    vi.mocked(sendTelegramMessage).mockClear();

    const result = await notifyProxyInUse('tailscale');
    expect(result).toBeNull();
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it('handles /useproxy with invalid string without running proxy checks', async () => {
    const sent: string[] = [];
    const deps: ProxyUiDeps = {
      send: vi.fn(async (text) => {
        sent.push(text);
      }),
      edit: vi.fn(),
      answer: vi.fn(),
    };

    await handleUseProxyCommand('not_a_valid_proxy', deps);
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain('not found');
  });

  it('handles /useproxy <url> to set preferred proxy directly by url', async () => {
    process.env.CODEFORCES_RESIDENTIAL_PROXY = 'http://u1:p1@p1.com:8080, http://u2:p2@p2.com:8080';
    const sent: string[] = [];
    const deps: ProxyUiDeps = {
      send: vi.fn(async (text) => {
        sent.push(text);
      }),
      edit: vi.fn(),
      answer: vi.fn(),
    };

    await handleUseProxyCommand('http://u2:p2@p2.com:8080', deps);
    expect(sent[0]).toContain('Preferred Proxy Selected: #2');
    expect(await getPreferredProxy()).toBe('http://u2:p2@p2.com:8080');
  });

  it('handleUseProxyCommand edits pending message in place when message_id is returned', async () => {
    process.env.CODEFORCES_RESIDENTIAL_PROXY = 'http://u1:p1@good.com:8080';
    const sent: string[] = [];
    const edited: { chatId: any; messageId: number; text: string; buttons?: any[] }[] = [];
    const deps: ProxyUiDeps = {
      send: vi.fn(async (text) => {
        sent.push(text);
        return { message_id: 12345 };
      }),
      edit: vi.fn(async (chatId, messageId, text, buttons) => {
        edited.push({ chatId, messageId, text, buttons });
      }),
      answer: vi.fn(),
    };

    await handleUseProxyCommand('', deps);
    expect(sent.length).toBe(1); // Only initial "Please wait..." sent
    expect(sent[0]).toContain('Please wait');
    expect(edited.length).toBe(1); // Initial message edited into selection menu!
    expect(edited[0]?.messageId).toBe(12345);
    expect(edited[0]?.text).toContain('CODEFORCES PROXY SELECTION');
    expect(edited[0]?.buttons?.length).toBeGreaterThan(0);
  });

  it('handleTestProxyCommand edits pending message in place when message_id is returned', async () => {
    process.env.CODEFORCES_RESIDENTIAL_PROXY = 'http://u1:p1@good.com:8080';
    const sent: string[] = [];
    const edited: { chatId: any; messageId: number; text: string; buttons?: any[] }[] = [];
    const deps: ProxyUiDeps = {
      send: vi.fn(async (text) => {
        sent.push(text);
        return { message_id: 67890 };
      }),
      edit: vi.fn(async (chatId, messageId, text, buttons) => {
        edited.push({ chatId, messageId, text, buttons });
      }),
      answer: vi.fn(),
    };

    await handleTestProxyCommand(deps);
    expect(sent.length).toBe(1); // Initial notice
    expect(edited.length).toBe(1); // Edited with results
    expect(edited[0]?.messageId).toBe(67890);
    expect(edited[0]?.text).toContain('CODEFORCES PROXY HEALTH CHECK');
  });

  it('notifyProxyInUse includes fallback notice when preferred proxy was down', async () => {
    process.env.CODEFORCES_RESIDENTIAL_PROXY = 'http://u1:p1@live.com:8080, http://u2:p2@dead.com:8080';
    await setPreferredProxyByIndex(2); // Set dead proxy #2 as preferred
    vi.mocked(sendTelegramMessage).mockClear();

    const result = await notifyProxyInUse('proxy');
    expect(result).not.toBeNull();
    expect(result?.fallbackOccurred).toBe(true);
    expect(result?.host).toBe('live.com:8080');

    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(sendTelegramMessage).mock.calls[0]?.[0];
    expect(msg).toContain('Proxy in use:');
    expect(msg).toContain('live.com:8080');
    expect(msg).toContain('Preferred proxy was unreachable; fell back to pool rotation');
  });

  describe('extractTelegramCommand', () => {
    it('preserves @ in proxy passwords without stripping', () => {
      const text = '/setproxies http://bi_sticky:FYkZGhF73hJzSids@gateway-residential.brightdata.com:33335';
      const parsed = extractTelegramCommand(text);
      expect(parsed.command).toBe('/setproxies');
      expect(parsed.arg).toBe('http://bi_sticky:FYkZGhF73hJzSids@gateway-residential.brightdata.com:33335');
    });

    it('strips @botname mention while preserving credentials', () => {
      const text = '/setproxies@LEETCODE_BOT http://user:pass@host:8080';
      const parsed = extractTelegramCommand(text);
      expect(parsed.command).toBe('/setproxies');
      expect(parsed.arg).toBe('http://user:pass@host:8080');
    });

    it('preserves multiline proxy strings', () => {
      const text = '/setproxies\nhttp://u1:p1@h1:8080\nhttp://u2:p2@h2:8080';
      const parsed = extractTelegramCommand(text);
      expect(parsed.command).toBe('/setproxies');
      expect(parsed.arg).toBe('http://u1:p1@h1:8080\nhttp://u2:p2@h2:8080');
    });

    it('parses commands with integer arguments', () => {
      expect(extractTelegramCommand('/cfrange 10')).toEqual({ command: '/cfrange', arg: '10' });
      expect(extractTelegramCommand('/removeproxy 3')).toEqual({ command: '/removeproxy', arg: '3' });
    });

    it('returns empty command for non-command text', () => {
      expect(extractTelegramCommand('hello bot')).toEqual({ command: '', arg: '' });
      expect(extractTelegramCommand('')).toEqual({ command: '', arg: '' });
    });
  });

  describe('isLikelyProxyPayload', () => {
    it('returns true for proxy lists', () => {
      expect(isLikelyProxyPayload('http://user:pass@gateway.com:8080')).toBe(true);
      expect(isLikelyProxyPayload('gateway.com:8080:user:pass')).toBe(true);
      expect(isLikelyProxyPayload('user:pass@gateway.com:8080')).toBe(true);
      expect(isLikelyProxyPayload('http://u:p@h1:8080\nhttp://u:p@h2:8080')).toBe(true);
    });

    it('returns false for JSON cookies or plain text', () => {
      expect(isLikelyProxyPayload('[{"name":"cf_clearance","value":"123"}]')).toBe(false);
      expect(isLikelyProxyPayload('{"key":"value"}')).toBe(false);
      expect(isLikelyProxyPayload('hello how are you')).toBe(false);
    });
  });
});
