import fs from 'node:fs';
import { testProxyDetailed, normalizeSingleProxy, maskProxyUrl, type ProxyTestResult } from '../src/codeforces/proxyRotator';

const RAW_PROXIES = (process.env.PROXY_LIST || process.env.CODEFORCES_RESIDENTIAL_PROXY || '')
  .trim()
  .split(/[\r\n,;]+/)
  .map(s => s.trim())
  .filter(Boolean);

interface ProxyScore {
  raw: string;
  normalized: string;
  cfOk: boolean;
  cfLatency: number;
  cfIp?: string;
  cfCountry?: string;
  lcOk: boolean;
  lcLatency: number;
  error?: string;
  score: number;
}

async function testSingleProxy(raw: string): Promise<ProxyScore> {
  const normalized = normalizeSingleProxy(raw) ?? `http://${raw}`;

  // Test Codeforces
  const cfRes = await testProxyDetailed(normalized, 6);

  // Test LeetCode
  let lcRes: ProxyTestResult;
  try {
    lcRes = await testProxyDetailed(normalized, 6);
  } catch (e: any) {
    lcRes = { ok: false, latencyMs: 9999, error: e?.message };
  }

  // Calculate score: lower is better. Failed tests get large penalty.
  let score = 0;
  if (cfRes.ok && lcRes.ok) {
    score = (cfRes.latencyMs + lcRes.latencyMs) / 2;
  } else if (cfRes.ok) {
    score = cfRes.latencyMs + 5000;
  } else if (lcRes.ok) {
    score = lcRes.latencyMs + 5000;
  } else {
    score = 99999;
  }

  return {
    raw: maskProxyUrl(normalized),
    normalized: maskProxyUrl(normalized),
    cfOk: cfRes.ok,
    cfLatency: cfRes.latencyMs,
    cfIp: cfRes.ip,
    cfCountry: cfRes.country,
    lcOk: lcRes.ok,
    lcLatency: lcRes.latencyMs,
    error: cfRes.error || lcRes.error,
    score,
  };
}

async function runPool<T, R>(items: T[], concurrency: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      const item = items[idx]!;
      results[idx] = await fn(item, idx);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function main() {
  if (RAW_PROXIES.length === 0) {
    throw new Error('Set PROXY_LIST or CODEFORCES_RESIDENTIAL_PROXY before running this diagnostic script');
  }
  console.log(`Starting test for ${RAW_PROXIES.length} proxies with concurrency 12...`);
  const startTime = Date.now();

  let completed = 0;
  const scored = await runPool(RAW_PROXIES, 12, async (raw) => {
    const res = await testSingleProxy(raw);
    completed++;
    const status = (res.cfOk && res.lcOk) ? `✅ CF: ${res.cfLatency}ms | LC: ${res.lcLatency}ms (${res.cfCountry || '??'})` : (res.cfOk ? `🟡 CF ONLY (${res.cfLatency}ms)` : `❌ FAILED: ${res.error?.slice(0, 40)}`);
    console.log(`[${completed}/${RAW_PROXIES.length}] ${res.normalized} -> ${status}`);
    return res;
  });

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nCompleted testing ${RAW_PROXIES.length} proxies in ${totalTime}s!\n`);

  // Filter and sort
  const workingBoth = scored.filter(s => s.cfOk && s.lcOk).sort((a, b) => a.score - b.score);
  const workingAny = scored.filter(s => s.cfOk || s.lcOk).sort((a, b) => a.score - b.score);

  console.log(`Working on both Codeforces & LeetCode: ${workingBoth.length}/${RAW_PROXIES.length}`);
  console.log(`Working on at least one: ${workingAny.length}/${RAW_PROXIES.length}`);

  const best10 = (workingBoth.length >= 10 ? workingBoth : workingAny).slice(0, 10);

  console.log('\n========================================');
  console.log('🏆 TOP 10 BEST PROXIES (MASKED):');
  console.log('========================================');
  best10.forEach((p, idx) => {
    console.log(`${idx + 1}. ${p.normalized}`);
    console.log(`   CF: ${p.cfLatency}ms (IP: ${p.cfIp || 'N/A'}, Loc: ${p.cfCountry || 'N/A'}) | LC: ${p.lcLatency}ms | Avg: ${Math.round(p.score)}ms`);
  });

  // Save masked results to json
  fs.writeFileSync('tested-proxies.json', JSON.stringify({ best10, workingBoth, workingAny, all: scored }, null, 2));
  console.log('\nSaved masked results to tested-proxies.json');
}

main().catch(console.error);
