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

export async function addCustomProxies(rawText: string): Promise<{
  ok: boolean;
  added: string[];
  total: number;
  error?: string;
}> {
  const parsed = parseProxyList(rawText);
  if (parsed.length === 0) {
    return {
      ok: false,
      added: [],
      total: 0,
      error: 'No valid proxy URLs found. Supported protocols: http://, https://, socks5://',
    };
  }

  const current = await getCustomProxies();
  const newlyAdded: string[] = [];

  for (const p of parsed) {
    if (!current.includes(p)) {
      current.push(p);
      newlyAdded.push(p);
    }
  }

  if (newlyAdded.length > 0) {
    await setSystemState(SystemKeys.codeforcesCustomProxies, JSON.stringify(current));
  }

  // If any were in removed list, unmark them
  const removed = await getRemovedProxyHashes();
  const addedHashes = new Set(parsed.map(proxyHash));
  const remainingRemoved = removed.filter((h) => !addedHashes.has(h));
  if (remainingRemoved.length !== removed.length) {
    await saveRemovedProxyHashes(remainingRemoved);
  }

  return { ok: true, added: newlyAdded, total: current.length };
}

export async function addCustomProxy(proxyUrl: string): Promise<{ ok: boolean; error?: string; proxy?: string; masked?: string }> {
  const res = await addCustomProxies(proxyUrl);
  if (!res.ok) {
    return { ok: false, error: res.error };
  }
  const first = parseProxyList(proxyUrl)[0]!;
  return { ok: true, proxy: first, masked: maskProxyUrl(first) };
}

export async function fetchRemoteSyncedProxies(): Promise<string[]> {
  try {
    const rawUrl = process.env.CODEFORCES_SUBMITTER_URL?.trim();
    const token = process.env.CODEFORCES_SUBMITTER_TOKEN?.trim();
    if (!rawUrl || !token) return [];
    const url = rawUrl.replace(/\/+$/, '');
    const res = await fetch(`${url}/proxy/list`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { proxies?: string[] };
    return Array.isArray(data?.proxies) ? parseProxyList(data.proxies.join('\n')) : [];
  } catch {
    return [];
  }
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
  const remoteSynced = await fetchRemoteSyncedProxies();

  const allUrls: string[] = [];
  const customSet = new Set(customProxies);

  for (const p of envProxies) {
    if (!allUrls.includes(p)) allUrls.push(p);
  }
  for (const p of customProxies) {
    if (!allUrls.includes(p)) allUrls.push(p);
  }
  for (const p of remoteSynced) {
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
