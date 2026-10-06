import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ProxyState {
  lastWorkingHash?: string;
  deadProxyHashes: string[];
  updatedAt: string;
}

function cleanProxyUrl(u: URL): string {
  const auth = u.username ? `${u.username}${u.password ? `:${u.password}` : ''}@` : '';
  const port = u.port ? `:${u.port}` : '';
  const path = (u.pathname === '/' || !u.pathname) ? '' : u.pathname;
  const search = u.search || '';
  return `${u.protocol}//${auth}${u.hostname}${port}${path}${search}`;
}

/**
 * Normalizes a single proxy string into a standard valid URL (http://, https://, socks5://).
 * Supports:
 * - standard URLs: http://user:pass@host:port
 * - no-scheme credentials: user:pass@host:port
 * - standard provider format: host:port:user:pass
 * - IP:port whitelist: host:port
 */
export function normalizeSingleProxy(raw: string): string | null {
  let s = raw.trim();
  if (!s || s.startsWith('#')) return null;

  // Remove surrounding quotes, brackets, angle brackets
  s = s.replace(/^["'`<(\[]+|["'`>)\]]+$/g, '').trim();

  // If already has supported protocol
  if (/^(https?|socks[45]h?):\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (['http:', 'https:', 'socks4:', 'socks5:', 'socks5h:'].includes(u.protocol) && u.hostname) {
        return cleanProxyUrl(u);
      }
    } catch {
      // Might have special characters in credentials; attempt reconstruction
      const match = s.match(/^((?:https?|socks[45]h?):\/\/)([^:]+):([^@]+)@([^:/]+)(?::(\d+))?(\/.*)?$/i);
      if (match && match[1] && match[2] && match[3] && match[4]) {
        const proto = match[1];
        const user = match[2];
        const pass = match[3];
        const host = match[4];
        const portPart = match[5] ? `:${match[5]}` : '';
        const pathPart = match[6] || '';
        return `${proto.toLowerCase()}${encodeURIComponent(decodeURIComponent(user))}:${encodeURIComponent(decodeURIComponent(pass))}@${host}${portPart}${pathPart}`;
      }
    }
  }

  // Check host:port:user:pass (e.g. gateway.brightdata.com:33335:user:pass)
  const hpupMatch = s.match(/^([a-zA-Z0-9_.-]+):(\d+):([^:@\s]+):([^@\s]+)$/);
  if (hpupMatch && hpupMatch[1] && hpupMatch[2] && hpupMatch[3] && hpupMatch[4]) {
    const [, host, port, user, pass] = hpupMatch;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }

  // Check user:pass@host:port (e.g. user:pass@gateway.brightdata.com:33335)
  const uphMatch = s.match(/^([^:@\s]+):([^@\s]+)@([a-zA-Z0-9_.-]+):(\d+)$/);
  if (uphMatch && uphMatch[1] && uphMatch[2] && uphMatch[3] && uphMatch[4]) {
    const [, user, pass, host, port] = uphMatch;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }

  // Check host:port without scheme (e.g. 1.2.3.4:8080)
  const hpMatch = s.match(/^([a-zA-Z0-9_.-]+):(\d+)$/);
  if (hpMatch && hpMatch[1] && hpMatch[2]) {
    const [, host, port] = hpMatch;
    return `http://${host}:${port}`;
  }

  return null;
}

/**
 * Parses raw proxy configuration string supporting:
 * - comma separated: proxy1, proxy2
 * - newline separated: proxy1\nproxy2
 * - space separated: proxy1 proxy2
 * - combined comma and newline: proxy1,\nproxy2
 * - semicolon separated: proxy1; proxy2
 * Ignores comments (lines starting with #) and invalid URLs.
 */
export function parseProxyList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const lines = raw.split(/[\r\n,;]+/);
  const tokens: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/).filter(Boolean);
    tokens.push(...parts);
  }

  const results: string[] = [];
  for (const token of tokens) {
    const normalized = normalizeSingleProxy(token);
    if (normalized && !results.includes(normalized)) {
      results.push(normalized);
    }
  }
  return results;
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

export interface ProxyTestResult {
  ok: boolean;
  latencyMs: number;
  ip?: string;
  error?: string;
}

/**
 * Native Node.js TCP HTTP CONNECT test.
 * Zero dependency on curl binary — runs anywhere Node runs with minimal data (~150 bytes).
 */
async function testHttpProxyNative(
  proxyUrl: string,
  timeoutSeconds = 8,
): Promise<ProxyTestResult> {
  const start = Date.now();
  const u = new URL(proxyUrl);
  const isHttpsProxy = u.protocol === 'https:';
  const proxyHost = u.hostname;
  const proxyPort = Number(u.port) || (isHttpsProxy ? 443 : 80);
  const timeoutMs = timeoutSeconds * 1000;

  return new Promise((resolve) => {
    let finished = false;
    const finish = (res: ProxyTestResult) => {
      if (!finished) {
        finished = true;
        resolve(res);
      }
    };

    const targetHost = 'challenges.cloudflare.com';
    const targetPort = 443;

    let authHeader = '';
    if (u.username || u.password) {
      const user = decodeURIComponent(u.username);
      const pass = decodeURIComponent(u.password);
      const creds = Buffer.from(`${user}:${pass}`).toString('base64');
      authHeader = `Proxy-Authorization: Basic ${creds}\r\n`;
    }

    let socket: net.Socket;
    try {
      if (isHttpsProxy) {
        socket = tls.connect({
          host: proxyHost,
          port: proxyPort,
          servername: proxyHost,
          rejectUnauthorized: false,
        });
      } else {
        socket = net.createConnection({
          host: proxyHost,
          port: proxyPort,
        });
      }
    } catch (err) {
      return finish({
        ok: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const timer = setTimeout(() => {
      try { socket.destroy(); } catch {}
      finish({ ok: false, latencyMs: Date.now() - start, error: `Connection timed out after ${timeoutSeconds}s` });
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      try { socket.destroy(); } catch {}
    };

    socket.on('error', (err) => {
      cleanup();
      finish({ ok: false, latencyMs: Date.now() - start, error: err.message });
    });

    const onConnected = () => {
      const connectReq =
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n` +
        `User-Agent: curl/8.4.0\r\n` +
        authHeader +
        `\r\n`;
      socket.write(connectReq);
    };

    if (isHttpsProxy) {
      socket.on('secureConnect', onConnected);
    } else {
      socket.on('connect', onConnected);
    }

    let responseBuffer = '';
    socket.on('data', (chunk) => {
      responseBuffer += chunk.toString('latin1');
      if (responseBuffer.includes('\r\n\r\n') || responseBuffer.includes('\n\n')) {
        const firstLine = (responseBuffer.split(/\r?\n/)[0] ?? '').trim();
        const statusMatch = firstLine.match(/HTTP\/\d(?:\.\d)?\s+(\d+)/i);
        const statusCode = statusMatch ? Number(statusMatch[1]) : 0;

        if (statusCode === 200) {
          const latencyMs = Date.now() - start;
          socket.removeAllListeners('data');
          socket.removeAllListeners('error');

          // Tunnel is established! Try quick TLS query to get outbound IP
          try {
            const tlsTunnel = tls.connect({
              socket,
              servername: targetHost,
              rejectUnauthorized: false,
            }, () => {
              tlsTunnel.write(`GET /cdn-cgi/trace HTTP/1.1\r\nHost: ${targetHost}\r\nUser-Agent: curl/8.4.0\r\nConnection: close\r\n\r\n`);
            });

            let traceBody = '';
            tlsTunnel.on('data', (data) => {
              traceBody += data.toString('utf8');
              if (traceBody.includes('ip=')) {
                cleanup();
                try { tlsTunnel.destroy(); } catch {}
                const ipMatch = traceBody.match(/^ip=([^\r\n]+)/m);
                finish({
                  ok: true,
                  latencyMs: Date.now() - start,
                  ip: ipMatch ? ipMatch[1]?.trim() : undefined,
                });
              }
            });

            tlsTunnel.on('error', () => {
              cleanup();
              finish({ ok: true, latencyMs });
            });

            tlsTunnel.on('end', () => {
              cleanup();
              const ipMatch = traceBody.match(/^ip=([^\r\n]+)/m);
              finish({
                ok: true,
                latencyMs: Date.now() - start,
                ip: ipMatch ? ipMatch[1]?.trim() : undefined,
              });
            });
          } catch {
            cleanup();
            finish({ ok: true, latencyMs });
          }
        } else if (statusCode === 407) {
          cleanup();
          finish({ ok: false, latencyMs: Date.now() - start, error: 'Proxy 407 (Invalid credentials / authentication failed)' });
        } else if (statusCode === 403 || statusCode === 402) {
          cleanup();
          finish({ ok: false, latencyMs: Date.now() - start, error: `Proxy ${statusCode} (Quota expired / access forbidden)` });
        } else if (statusCode >= 500) {
          cleanup();
          finish({ ok: false, latencyMs: Date.now() - start, error: `Proxy ${statusCode} (Upstream gateway error)` });
        } else {
          cleanup();
          finish({ ok: false, latencyMs: Date.now() - start, error: `Proxy returned HTTP ${statusCode}: ${firstLine}` });
        }
      }
    });
  });
}

async function testProxyWithCurlFallback(
  proxyUrl: string,
  timeoutSeconds = 8,
): Promise<ProxyTestResult> {
  const start = Date.now();
  const testEndpoints = [
    'https://challenges.cloudflare.com/cdn-cgi/trace',
    'https://www.cloudflare.com/cdn-cgi/trace',
  ];

  let lastError = 'Failed to connect';
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
      const latencyMs = Date.now() - start;
      if (stdout && stdout.includes('ip=')) {
        const ipMatch = stdout.match(/^ip=(.+)$/m);
        return {
          ok: true,
          latencyMs,
          ip: ipMatch ? ipMatch[1]?.trim() : undefined,
        };
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return {
    ok: false,
    latencyMs: Date.now() - start,
    error: lastError,
  };
}

/**
 * Tests proxy health with minimal data (~150 bytes) using Cloudflare's trace endpoint.
 * First tries native Node.js HTTP CONNECT (zero external dependencies),
 * then falls back to curl if needed (e.g. for socks proxies).
 */
export async function testProxyDetailed(
  proxyUrl: string,
  timeoutSeconds = 8,
): Promise<ProxyTestResult> {
  let u: URL;
  try {
    u = new URL(proxyUrl);
  } catch {
    return { ok: false, latencyMs: 0, error: 'Invalid proxy URL format' };
  }

  if (u.protocol === 'http:' || u.protocol === 'https:') {
    try {
      const nativeRes = await testHttpProxyNative(proxyUrl, timeoutSeconds);
      if (nativeRes.ok) return nativeRes;
      if (nativeRes.error && /Proxy (?:407|403|402|50\d)/i.test(nativeRes.error)) {
        return nativeRes;
      }
    } catch {
      // Fall through to curl fallback
    }
  }

  return testProxyWithCurlFallback(proxyUrl, timeoutSeconds);
}

/**
 * Tests proxy health with minimal data (~150 bytes) using Cloudflare's trace endpoint.
 * Returns true if the proxy connects successfully and returns a 200 trace with `ip=`.
 */
export async function testProxyWithCurl(
  proxyUrl: string,
  timeoutSeconds = 8,
): Promise<boolean> {
  const res = await testProxyDetailed(proxyUrl, timeoutSeconds);
  return res.ok;
}

export interface SelectProxyOptions {
  stateDir?: string;
  tester?: (proxyUrl: string) => Promise<boolean>;
  log?: (msg: string) => void;
  removedHashes?: string[] | Set<string>;
}

/**
 * Selects the first verified working proxy from a list.
 * Automatically filters out any blacklisted/removed proxies recorded in DB,
 * skips previously dead/expired proxies recorded in stateDir,
 * tests each candidate with minimal data, updates state on failure/success,
 * and falls back to testing any dead proxies if all proxies appear dead.
 */
export async function selectWorkingProxy(
  rawProxies: string,
  options: SelectProxyOptions = {},
): Promise<{ selectedProxy: string; masked: string; index: number; total: number }> {
  const allProxies = parseProxyList(rawProxies);
  if (allProxies.length === 0) {
    throw new Error('No valid proxies configured in proxy list');
  }

  const log = options.log ?? ((msg: string) => process.stdout.write(`${msg}\n`));
  const tester = options.tester ?? ((p: string) => testProxyWithCurl(p));
  const stateDir = options.stateDir ?? path.resolve('.proxy_state');
  const stateFile = path.join(stateDir, 'proxy_state.json');

  const removedSet = new Set<string>();
  if (options.removedHashes) {
    for (const h of options.removedHashes) {
      if (h) removedSet.add(h.trim().toLowerCase());
    }
  }

  // Filter out any proxies that have been removed/blacklisted in DB
  const proxies: string[] = [];
  for (const p of allProxies) {
    const h = proxyHash(p);
    if (removedSet.has(h)) {
      log(`Proxy ${maskProxyUrl(p)} was removed in database. Skipping completely.`);
    } else {
      proxies.push(p);
    }
  }

  if (proxies.length === 0) {
    throw new Error(`All ${allProxies.length} configured proxies are blacklisted/removed in DB.`);
  }


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

  let removedHashes: string[] = [];
  if (process.env.REMOVED_PROXIES) {
    try {
      const parsed = JSON.parse(process.env.REMOVED_PROXIES);
      if (Array.isArray(parsed)) removedHashes = parsed.map(String);
    } catch {
      removedHashes = process.env.REMOVED_PROXIES.split(/[\s,;]+/).filter(Boolean);
    }
  }

  try {
    const result = await selectWorkingProxy(raw, { removedHashes });
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
