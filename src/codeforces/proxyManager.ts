import { getSystemState, setSystemState, SystemKeys } from '../database/models';
import {
  parseProxyList,
  maskProxyUrl,
  proxyHash,
  testProxyDetailed,
  type ProxyTestResult,
} from './proxyRotator';

export interface ManagedProxy {
  index: number;
  url: string;
  masked: string;
  hash: string;
  isRemoved: boolean;
  isCustom: boolean;
}

export interface ProxyCheckStatus {
  proxy: ManagedProxy;
  result: ProxyTestResult;
}

export async function getRemovedProxyHashes(): Promise<string[]> {
  try {
    const raw = await getSystemState(SystemKeys.codeforcesRemovedProxies);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export async function saveRemovedProxyHashes(hashes: string[]): Promise<void> {
  const unique = Array.from(new Set(hashes.filter(Boolean)));
  await setSystemState(SystemKeys.codeforcesRemovedProxies, JSON.stringify(unique));
}

export async function addRemovedProxy(proxyUrlOrHash: string): Promise<{ hash: string; totalRemoved: number }> {
  const hash = proxyUrlOrHash.length === 16 && /^[a-f0-9]{16}$/i.test(proxyUrlOrHash)
    ? proxyUrlOrHash.toLowerCase()
    : proxyHash(proxyUrlOrHash);

  const existing = await getRemovedProxyHashes();
  if (!existing.includes(hash)) {
    existing.push(hash);
    await saveRemovedProxyHashes(existing);
  }
  return { hash, totalRemoved: existing.length };
}

export async function restoreAllProxies(): Promise<number> {
  const existing = await getRemovedProxyHashes();
  await saveRemovedProxyHashes([]);
  return existing.length;
}

export async function getCustomProxies(): Promise<string[]> {
  try {
    const raw = await getSystemState(SystemKeys.codeforcesCustomProxies);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parseProxyList(parsed.join('\n')) : [];
  } catch {
    return [];
  }
}

export async function addCustomProxy(proxyUrl: string): Promise<{ ok: boolean; error?: string; proxy?: string; masked?: string }> {
  const parsed = parseProxyList(proxyUrl);
  if (parsed.length === 0) {
    return { ok: false, error: 'Invalid proxy URL. Supported protocols: http://, https://, socks5://' };
  }
  const validated = parsed[0]!;
  const current = await getCustomProxies();
  if (!current.includes(validated)) {
    current.push(validated);
    await setSystemState(SystemKeys.codeforcesCustomProxies, JSON.stringify(current));
  }

  // If this proxy was previously marked removed, unmark it
  const hash = proxyHash(validated);
  const removed = await getRemovedProxyHashes();
  if (removed.includes(hash)) {
    await saveRemovedProxyHashes(removed.filter((h) => h !== hash));
  }

  return { ok: true, proxy: validated, masked: maskProxyUrl(validated) };
}

export async function getAllConfiguredProxies(envSource?: string): Promise<ManagedProxy[]> {
  const rawEnv = envSource ?? (
    process.env.FALLBACK_CODEFORCES_PROXY ||
    process.env.CODEFORCES_RESIDENTIAL_PROXY ||
    process.env.CODEFORCES_PROXY ||
    ''
  );

  const envProxies = parseProxyList(rawEnv);
  const customProxies = await getCustomProxies();

  const allUrls: string[] = [];
  const customSet = new Set(customProxies);

  for (const p of envProxies) {
    if (!allUrls.includes(p)) allUrls.push(p);
  }
  for (const p of customProxies) {
    if (!allUrls.includes(p)) allUrls.push(p);
  }

  const removedHashes = new Set(await getRemovedProxyHashes());

  return allUrls.map((url, i) => {
    const hash = proxyHash(url);
    return {
      index: i + 1,
      url,
      masked: maskProxyUrl(url),
      hash,
      isRemoved: removedHashes.has(hash),
      isCustom: customSet.has(url),
    };
  });
}

export async function removeProxyByIndex(index: number, envSource?: string): Promise<{ ok: boolean; proxy?: ManagedProxy; error?: string }> {
  const list = await getAllConfiguredProxies(envSource);
  const target = list.find((p) => p.index === index);
  if (!target) {
    return { ok: false, error: `Proxy #${index} not found. Available indices: 1 to ${list.length}.` };
  }

  await addRemovedProxy(target.hash);
  return { ok: true, proxy: target };
}

export async function testAllProxiesOneByOne(
  onProgress?: (progress: ProxyCheckStatus, index: number, total: number) => Promise<void> | void,
  envSource?: string,
): Promise<ProxyCheckStatus[]> {
  const list = await getAllConfiguredProxies(envSource);
  const results: ProxyCheckStatus[] = [];

  for (let i = 0; i < list.length; i++) {
    const p = list[i]!;
    // Even if removed, we test it so the user can see if it's currently working or dead
    const result = await testProxyDetailed(p.url, 8);
    const status: ProxyCheckStatus = { proxy: p, result };
    results.push(status);
    if (onProgress) {
      await onProgress(status, i + 1, list.length);
    }
  }

  return results;
}
