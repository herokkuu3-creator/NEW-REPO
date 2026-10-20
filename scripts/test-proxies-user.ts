import fs from 'node:fs';
import { testProxyDetailed, normalizeSingleProxy, type ProxyTestResult } from '../src/codeforces/proxyRotator';

const RAW_PROXIES = `
lxwhp9qwnfzu:lu0xh7yyx30fzwl@209.50.179.249:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@104.207.54.75:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@45.3.44.255:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@216.26.240.38:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@65.111.1.24:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@193.56.28.80:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@45.3.44.238:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@45.3.34.131:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@104.207.42.197:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@216.26.239.122:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@104.207.37.84:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@65.111.13.16:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@209.50.176.51:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@216.26.232.103:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@65.111.26.28:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@216.26.239.235:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@104.207.60.134:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@209.50.163.93:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@45.3.49.47:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@209.50.190.152:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@209.50.169.146:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@216.26.225.119:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@209.50.175.193:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@216.26.245.71:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@104.207.38.176:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@209.50.190.85:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@104.207.43.147:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@216.26.248.129:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@216.26.244.76:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@65.111.22.35:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@209.50.186.187:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@45.3.37.26:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@104.207.36.132:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@216.26.230.53:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@216.26.247.215:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@45.3.38.251:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@216.26.236.32:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@104.207.51.4:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@45.3.49.126:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@45.3.35.149:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@209.50.173.46:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@151.123.176.240:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@45.3.53.14:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@65.111.8.244:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@216.26.253.59:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@104.207.35.72:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@216.26.247.32:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@65.111.5.104:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@209.50.188.170:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@216.26.249.26:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@104.207.45.188:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@45.3.49.165:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@209.50.165.114:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@104.207.39.226:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@216.26.233.169:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@45.3.49.63:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@104.207.56.199:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@104.207.56.101:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@104.207.48.185:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@45.3.43.212:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@104.207.47.209:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@45.3.46.9:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@104.207.36.53:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@216.26.230.69:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@216.26.246.199:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@104.207.62.16:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@104.207.43.68:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@216.26.241.94:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@209.50.176.109:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@216.26.224.156:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@45.3.51.84:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@104.207.38.74:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@104.207.47.194:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@216.26.227.13:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@209.50.189.116:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@216.26.233.123:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@104.207.34.111:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@216.26.233.216:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@195.63.31.43:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@216.26.232.64:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@216.26.226.45:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@216.26.253.46:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@209.50.170.75:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@45.3.36.216:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@65.111.6.102:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@104.207.42.77:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@45.3.32.49:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@209.50.167.11:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@216.26.237.115:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@45.3.47.45:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@104.167.19.238:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@104.207.47.54:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@104.207.33.92:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@65.111.10.47:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@45.3.32.155:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@45.3.33.104:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@216.26.234.196:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@104.207.43.109:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@216.26.242.230:3129
lxwhp9qwnfzu:lu0xh7yyx30fzwl@216.26.249.242:3129
`.trim().split('\n').map(s => s.trim()).filter(Boolean);

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
    raw,
    normalized,
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
  console.log(`Starting test for ${RAW_PROXIES.length} proxies with concurrency 12...`);
  const startTime = Date.now();

  let completed = 0;
  const scored = await runPool(RAW_PROXIES, 12, async (raw, i) => {
    const res = await testSingleProxy(raw);
    completed++;
    const status = (res.cfOk && res.lcOk) ? `✅ CF: ${res.cfLatency}ms | LC: ${res.lcLatency}ms (${res.cfCountry || '??'})` : (res.cfOk ? `🟡 CF ONLY (${res.cfLatency}ms)` : `❌ FAILED: ${res.error?.slice(0, 40)}`);
    console.log(`[${completed}/${RAW_PROXIES.length}] ${raw.split('@')[1]} -> ${status}`);
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
  console.log('🏆 TOP 10 BEST PROXIES:');
  console.log('========================================');
  best10.forEach((p, idx) => {
    console.log(`${idx + 1}. ${p.raw}`);
    console.log(`   CF: ${p.cfLatency}ms (IP: ${p.cfIp || 'N/A'}, Loc: ${p.cfCountry || 'N/A'}) | LC: ${p.lcLatency}ms | Avg: ${Math.round(p.score)}ms`);
  });

  // Save results to json
  fs.writeFileSync('tested-proxies.json', JSON.stringify({ best10, workingBoth, workingAny, all: scored }, null, 2));
  console.log('\nSaved full results to tested-proxies.json');
}

main().catch(console.error);
