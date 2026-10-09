import { deleteSystemState, getSystemState, setSystemState, SystemKeys } from '../database/models';
import { logger } from '../logger';
import {
  parseProxyList,
  normalizeSingleProxy,
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
  isPreferred?: boolean;
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

export const DEFAULT_JOY_PROXY = 'http://customer-jp-lmc6hb64r-cc-in-iptype-residential-sessid-ylvk7rom-sesstime-1-backup-1:kdKWYXp9PFrh@gate.joyproxy.com:9001';

export async function getAllConfiguredProxies(envSource?: string): Promise<ManagedProxy[]> {
  const rawEnv = envSource ?? (
    process.env.FALLBACK_CODEFORCES_PROXY ||
    process.env.CODEFORCES_RESIDENTIAL_PROXY ||
    process.env.CODEFORCES_PROXY ||
    DEFAULT_JOY_PROXY
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
  const preferred = await getPreferredProxy();

  return allUrls.map((url, i) => {
    const hash = proxyHash(url);
    const isPreferred = preferred ? (url === preferred || hash === preferred) : false;
    return {
      index: i + 1,
      url,
      masked: maskProxyUrl(url),
      hash,
      isRemoved: removedHashes.has(hash),
      isCustom: customSet.has(url),
      isPreferred,
    };
  });
}

export function extractProxyDetails(proxyUrl: string): { host: string; username: string } {
  try {
    const normalized = normalizeSingleProxy(proxyUrl) ?? proxyUrl.trim();
    const u = new URL(normalized);
    const host = u.host || u.hostname || 'unknown';
    const username = u.username ? decodeURIComponent(u.username) : 'none';
    return { host, username };
  } catch {
    return { host: 'unknown', username: 'none' };
  }
}

export async function getPreferredProxy(): Promise<string | null> {
  try {
    const raw = await getSystemState(SystemKeys.codeforcesPreferredProxy);
    return raw?.trim() || null;
  } catch {
    return null;
  }
}

export async function setPreferredProxy(
  proxyUrlOrHash: string,
  envSource?: string,
): Promise<ManagedProxy | null> {
  const all = await getAllConfiguredProxies(envSource);
  const norm = normalizeSingleProxy(proxyUrlOrHash);
  const target = all.find(
    (p) =>
      p.url === proxyUrlOrHash ||
      (norm !== null && p.url === norm) ||
      p.hash === proxyUrlOrHash.toLowerCase() ||
      (norm !== null && p.hash === proxyHash(norm)) ||
      String(p.index) === proxyUrlOrHash.trim() ||
      p.masked === proxyUrlOrHash,
  );
  if (!target) return null;
  await setSystemState(SystemKeys.codeforcesPreferredProxy, target.url);
  return { ...target, isPreferred: true };
}

export async function setPreferredProxyByIndex(
  index: number,
  envSource?: string,
): Promise<{ ok: boolean; proxy?: ManagedProxy; error?: string }> {
  const all = await getAllConfiguredProxies(envSource);
  const target = all.find((p) => p.index === index);
  if (!target) {
    return { ok: false, error: `Proxy #${index} not found. Available indices: 1 to ${all.length}.` };
  }
  await setSystemState(SystemKeys.codeforcesPreferredProxy, target.url);
  return { ok: true, proxy: { ...target, isPreferred: true } };
}

export async function clearPreferredProxy(): Promise<void> {
  await deleteSystemState(SystemKeys.codeforcesPreferredProxy).catch(async () => {
    await setSystemState(SystemKeys.codeforcesPreferredProxy, '');
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
  timeoutSeconds = 5,
): Promise<ProxyCheckStatus[]> {
  const list = await getAllConfiguredProxies(envSource);
  const results: ProxyCheckStatus[] = list.map((p) => ({
    proxy: p,
    result: { ok: false, latencyMs: 0, error: 'Check timeout' },
  }));

  let completed = 0;
  const runner = Promise.all(
    list.map(async (p, i) => {
      try {
        const timeoutPromise = new Promise<ProxyTestResult>((resolve) => {
          setTimeout(() => {
            resolve({ ok: false, latencyMs: timeoutSeconds * 1000, error: `Timed out after ${timeoutSeconds}s` });
          }, (timeoutSeconds + 1) * 1000);
        });
        const result = await Promise.race([testProxyDetailed(p.url, timeoutSeconds), timeoutPromise]);
        const status: ProxyCheckStatus = { proxy: p, result };
        results[i] = status;
        completed++;
        if (onProgress) {
          await onProgress(status, completed, list.length);
        }
      } catch (err) {
        const status: ProxyCheckStatus = {
          proxy: p,
          result: {
            ok: false,
            latencyMs: 0,
            error: err instanceof Error ? err.message : String(err),
          },
        };
        results[i] = status;
        completed++;
        if (onProgress) {
          await onProgress(status, completed, list.length);
        }
      }
    }),
  );

  const overallTimeout = new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(10_000, (timeoutSeconds + 3) * 1000));
  });

  await Promise.race([runner, overallTimeout]);
  return results;
}

export interface ActiveProxyResult {
  proxy: ManagedProxy;
  url: string;
  host: string;
  username: string;
  fromPreferred: boolean;
  fallbackOccurred: boolean;
}

export async function resolveActiveProxy(
  options: {
    envSource?: string;
    tester?: (proxyUrl: string) => Promise<boolean | ProxyTestResult>;
    log?: (msg: string) => void;
  } = {},
): Promise<ActiveProxyResult | null> {
  const log = options.log ?? ((msg: string) => logger.info({ msg }, 'codeforces proxy resolver'));
  const runTest = async (url: string): Promise<ProxyTestResult> => {
    if (options.tester) {
      try {
        const res = await options.tester(url);
        if (typeof res === 'boolean') return { ok: res, latencyMs: 0, error: res ? undefined : 'tester returned false' };
        return res;
      } catch (err) {
        return { ok: false, latencyMs: 0, error: err instanceof Error ? err.message : String(err) };
      }
    }
    return testProxyDetailed(url, 12).catch((err) => ({ ok: false, latencyMs: 0, error: err instanceof Error ? err.message : String(err) }));
  };

  const all = await getAllConfiguredProxies(options.envSource);
  const available = all.filter((p) => !p.isRemoved);
  if (available.length === 0) {
    log('No available (non-blacklisted) proxies found.');
    return null;
  }

  const preferredUrlOrHash = await getPreferredProxy();
  let fallbackOccurred = false;

  if (preferredUrlOrHash) {
    const preferredCandidate = available.find(
      (p) => p.url === preferredUrlOrHash || p.hash === preferredUrlOrHash || p.masked === preferredUrlOrHash,
    );
    if (preferredCandidate) {
      log(`Testing preferred proxy #${preferredCandidate.index} (${preferredCandidate.masked})...`);
      const testRes = await runTest(preferredCandidate.url);
      if (testRes.ok) {
        log(`Preferred proxy #${preferredCandidate.index} (${preferredCandidate.masked}) is live! Selected.`);
        const details = extractProxyDetails(preferredCandidate.url);
        return {
          proxy: preferredCandidate,
          url: preferredCandidate.url,
          host: details.host,
          username: details.username,
          fromPreferred: true,
          fallbackOccurred: false,
        };
      }
      logger.warn(
        { proxy: preferredCandidate.masked, index: preferredCandidate.index, error: testRes.error },
        'Preferred Codeforces proxy failed health check. Falling back to pool rotation from beginning.',
      );
      fallbackOccurred = true;
    } else {
      logger.warn(
        { preferred: preferredUrlOrHash },
        'Preferred Codeforces proxy is blacklisted or missing from pool. Falling back to pool rotation.',
      );
      fallbackOccurred = true;
    }
  }

  // Fallback / default: Walk available proxies in pool order starting from index 0
  for (const candidate of available) {
    if (fallbackOccurred && preferredUrlOrHash && (candidate.url === preferredUrlOrHash || candidate.hash === preferredUrlOrHash || candidate.masked === preferredUrlOrHash)) {
      log(`Proxy [${candidate.index}/${all.length}] ${candidate.masked} already failed preferred proxy check. Skipping.`);
      continue;
    }
    log(`Testing proxy [${candidate.index}/${all.length}] ${candidate.masked}...`);
    const testRes = await runTest(candidate.url);
    if (testRes.ok) {
      log(`Proxy [${candidate.index}/${all.length}] ${candidate.masked} is live! Selected.`);
      const details = extractProxyDetails(candidate.url);
      return {
        proxy: candidate,
        url: candidate.url,
        host: details.host,
        username: details.username,
        fromPreferred: false,
        fallbackOccurred,
      };
    }
    logger.warn({ proxy: candidate.masked, index: candidate.index, error: testRes.error }, 'Proxy failed health check, testing next.');
  }

  return null;
}
