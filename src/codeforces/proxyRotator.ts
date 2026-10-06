import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ProxyState {
  lastWorkingHash?: string;
  deadProxyHashes: string[];
  updatedAt: string;
}

/**
 * Parses raw proxy configuration string supporting:
 * - comma separated: proxy1, proxy2
 * - newline separated: proxy1\nproxy2
 * - combined comma and newline: proxy1,\nproxy2
 * - semicolon separated: proxy1; proxy2
 * Ignores comments (lines starting with #) and invalid URLs.
 */
export function parseProxyList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[\r\n,;]+/)
    .map((s) => s.trim())
    .filter((s) => {
      if (!s || s.startsWith('#')) return false;
      try {
        const u = new URL(s);
        return ['http:', 'https:', 'socks4:', 'socks5:', 'socks5h:'].includes(u.protocol) && !!u.hostname;
      } catch {
        return false;
      }
    });
}

/**
 * Masks credentials for safe logging without exposing passwords in logs.
 */
export function maskProxyUrl(proxyUrl: string): string {
  try {
    const u = new URL(proxyUrl);
    if (u.username || u.password) {
      return `${u.protocol}//${u.username ? u.username : ''}:****@${u.host}`;
    }
    return proxyUrl;
  } catch {
    return '(invalid proxy url)';
  }
}

export function proxyHash(proxyUrl: string): string {
  return crypto.createHash('sha256').update(proxyUrl.trim()).digest('hex').slice(0, 16);
}

/**
 * Tests proxy health with minimal data (~150 bytes) using Cloudflare's trace endpoint.
 * Returns true if the proxy connects successfully and returns a 200 trace with `ip=`.
 */
export async function testProxyWithCurl(
  proxyUrl: string,
  timeoutSeconds = 8,
): Promise<boolean> {
  const testEndpoints = [
    'https://challenges.cloudflare.com/cdn-cgi/trace',
    'https://www.cloudflare.com/cdn-cgi/trace',
  ];

  for (const endpoint of testEndpoints) {
    try {
      const { stdout } = await execFileAsync('curl', [
        '-s',
        '-S',
        '--fail',
        '--max-time',
        String(timeoutSeconds),
        '-x',
        proxyUrl,
        endpoint,
      ]);
      if (stdout && stdout.includes('ip=')) {
        return true;
      }
    } catch {
      // try next endpoint if any
    }
  }
  return false;
}

export interface SelectProxyOptions {
  stateDir?: string;
  tester?: (proxyUrl: string) => Promise<boolean>;
  log?: (msg: string) => void;
}

/**
 * Selects the first verified working proxy from a list.
 * Automatically skips previously dead/expired proxies recorded in stateDir,
 * tests each candidate with minimal data, updates state on failure/success,
 * and falls back to testing any dead proxies if all proxies appear dead.
 */
export async function selectWorkingProxy(
  rawProxies: string,
  options: SelectProxyOptions = {},
): Promise<{ selectedProxy: string; masked: string; index: number; total: number }> {
  const proxies = parseProxyList(rawProxies);
  if (proxies.length === 0) {
    throw new Error('No valid proxies configured in proxy list');
  }

  const log = options.log ?? ((msg: string) => process.stdout.write(`${msg}\n`));
  const tester = options.tester ?? ((p: string) => testProxyWithCurl(p));
  const stateDir = options.stateDir ?? path.resolve('.proxy_state');
  const stateFile = path.join(stateDir, 'proxy_state.json');

  let state: ProxyState = { deadProxyHashes: [], updatedAt: new Date().toISOString() };
  try {
    if (fs.existsSync(stateFile)) {
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Partial<ProxyState>;
      state = {
        lastWorkingHash: typeof data.lastWorkingHash === 'string' ? data.lastWorkingHash : undefined,
        deadProxyHashes: Array.isArray(data.deadProxyHashes) ? data.deadProxyHashes : [],
        updatedAt: new Date().toISOString(),
      };
    }
  } catch {
    // Ignore corrupt state file
  }

  const deadSet = new Set(state.deadProxyHashes);

  // If all proxies are currently in deadSet, reset deadSet (in case proxies were refreshed/recharged)
  const allDead = proxies.every((p) => deadSet.has(proxyHash(p)));
  if (allDead && proxies.length > 0) {
    log('All configured proxies were previously marked dead. Resetting dead proxy cache to re-test.');
    deadSet.clear();
  }

  let selected: { proxy: string; index: number } | null = null;

  // 1. Test proxies that are not in deadSet
  for (let i = 0; i < proxies.length; i++) {
    const candidate = proxies[i]!;
    const hash = proxyHash(candidate);
    const masked = maskProxyUrl(candidate);

    if (deadSet.has(hash)) {
      log(`Proxy [${i + 1}/${proxies.length}] ${masked} was previously marked expired/dead. Skipping.`);
      continue;
    }

    log(`Testing proxy [${i + 1}/${proxies.length}] ${masked} (~150B trace check)...`);
    const ok = await tester(candidate);
    if (ok) {
      log(`Proxy [${i + 1}/${proxies.length}] ${masked} is alive and verified!`);
      selected = { proxy: candidate, index: i };
      break;
    } else {
      log(`Proxy [${i + 1}/${proxies.length}] ${masked} failed health check (expired or unreachable). Marking dead.`);
      deadSet.add(hash);
    }
  }

  // 2. If all non-dead proxies failed, retry dead ones as a last resort
  if (!selected) {
    for (let i = 0; i < proxies.length; i++) {
      const candidate = proxies[i]!;
      const hash = proxyHash(candidate);
      const masked = maskProxyUrl(candidate);
      log(`Retrying dead proxy [${i + 1}/${proxies.length}] ${masked} as last resort...`);
      const ok = await tester(candidate);
      if (ok) {
        log(`Proxy [${i + 1}/${proxies.length}] ${masked} recovered and verified!`);
        deadSet.delete(hash);
        selected = { proxy: candidate, index: i };
        break;
      }
    }
  }

  if (!selected) {
    throw new Error(`All ${proxies.length} configured proxies failed health check. Please verify proxy credentials or replenish data.`);
  }

  // Save updated state
  state.lastWorkingHash = proxyHash(selected.proxy);
  state.deadProxyHashes = Array.from(deadSet);
  state.updatedAt = new Date().toISOString();

  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    log(`Warning: Failed to persist proxy state: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    selectedProxy: selected.proxy,
    masked: maskProxyUrl(selected.proxy),
    index: selected.index,
    total: proxies.length,
  };
}

// CLI runner for GitHub Actions workflow
export async function runCli(): Promise<void> {
  const raw = process.env.FALLBACK_CODEFORCES_PROXY || process.env.CODEFORCES_RESIDENTIAL_PROXY || process.env.CODEFORCES_PROXY || '';
  if (!raw.trim()) {
    process.stderr.write('Residential proxy mode was selected but CODEFORCES_RESIDENTIAL_PROXY is empty.\n');
    process.exit(1);
  }

  try {
    const result = await selectWorkingProxy(raw);
    process.stdout.write(`Selected working proxy: ${result.masked} (index ${result.index + 1} of ${result.total})\n`);

    const envFile = process.env.GITHUB_ENV;
    if (envFile) {
      fs.appendFileSync(envFile, `CODEFORCES_PROXY=${result.selectedProxy}\n`);
      process.stdout.write('Exported CODEFORCES_PROXY to GITHUB_ENV\n');
    }
  } catch (err) {
    process.stderr.write(`Proxy rotation failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && /proxyRotator\.[jt]s$/i.test(process.argv[1])) {
  void runCli();
}
