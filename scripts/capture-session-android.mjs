#!/usr/bin/env node

/**
 * Android-only LeetCode session capture.
 *
 * Runs in Termux on the SAME Android phone as Chrome.
 * It connects to Android Chrome's DevTools socket through ADB, reads the
 * authenticated LeetCode cookies with Chrome DevTools Protocol, writes a
 * Playwright-compatible storageState file to Downloads, and optionally opens
 * the Android share sheet so the user can send it to the Telegram bot.
 *
 * No cookies are printed or uploaded by this script.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const CDP_BASE_PORT = 9222;
const CAPTURE_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 2_000;
const LOGIN_URL = 'https://leetcode.com/accounts/login/';
const CHROME_PACKAGE = 'com.android.chrome';
const CHROME_ACTIVITY = 'com.google.android.apps.chrome.Main';
const CONFIG_DIR = path.join(os.homedir(), '.config', 'leetcode-daily-agent');
const CONFIG_FILE = path.join(CONFIG_DIR, 'android-adb-connection-port');

const USER_STATUS_QUERY = `
  query userStatus {
    userStatus {
      isSignedIn
      username
    }
  }
`;

function log(message) {
  console.log(`[leetcode-capture] ${message}`);
}

function fail(message) {
  console.error(`\nâŒ ${message}\n`);
  process.exitCode = 1;
}

function run(cmd, args, options = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', options.showStderr ? 'inherit' : 'pipe'],
      timeout: options.timeout ?? 20_000,
    }).trim();
  } catch (err) {
    const stdout = err?.stdout ? String(err.stdout).trim() : '';
    const stderr = err?.stderr ? String(err.stderr).trim() : '';
    const detail = [stdout, stderr].filter(Boolean).join(' | ');
    const e = new Error(`${cmd} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
    e.cause = err;
    throw e;
  }
}

function commandExists(name) {
  try {
    run('sh', ['-c', `command -v ${name}`], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function adb(args, options = {}) {
  return run('adb', args, options);
}

function getDevices() {
  const out = adb(['devices']);
  return out
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[1] === 'device')
    .map((parts) => parts[0]);
}

async function prompt(text) {
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(text)).trim();
  } finally {
    rl.close();
  }
}

function savedConnectionPort() {
  try {
    const value = fs.readFileSync(CONFIG_FILE, 'utf8').trim();
    return /^\d+$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function saveConnectionPort(port) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, String(port), 'utf8');
  } catch {
    // Non-fatal; Wireless debugging port can be entered again next time.
  }
}

async function ensureAdbDevice() {
  if (!commandExists('adb')) {
    fail('adb is not installed. In Termux run: pkg update -y && pkg install -y android-tools');
    return null;
  }

  try {
    adb(['start-server'], { timeout: 10_000 });
  } catch (err) {
    fail(err.message);
    return null;
  }

  let devices = getDevices();
  if (devices.length > 0) return devices[0];

  const savedPort = savedConnectionPort();
  if (savedPort) {
    try {
      adb(['connect', `127.0.0.1:${savedPort}`], { timeout: 15_000 });
      devices = getDevices();
      if (devices.length > 0) return devices[0];
    } catch {
      // The Wireless debugging port may have changed after reboot.
    }
  }

  console.log('');
  console.log('Android Chrome connection is not active yet.');
  console.log('Open Android Settings â†’ Developer options â†’ Wireless debugging.');
  console.log('If the phone was already paired, enter only the current connection port.');
  console.log('If it is not paired yet, choose â€œPair device with pairing codeâ€ first.');
  console.log('');

  const pairPort = await prompt('Pairing port (press Enter if already paired): ');
  if (pairPort) {
    const pairingCode = await prompt('Pairing code: ');
    if (!pairingCode) {
      fail('Pairing code was not provided.');
      return null;
    }
    try {
      adb(['pair', `127.0.0.1:${pairPort}`, pairingCode], { timeout: 30_000 });
      log('ADB pairing succeeded.');
    } catch (err) {
      // ADB 35.x has a known Termux pairing quirk; retrying once is harmless.
      log('ADB pairing reported an error; retrying once.');
      try {
        adb(['pair', `127.0.0.1:${pairPort}`, pairingCode], { timeout: 30_000 });
        log('ADB pairing succeeded on retry.');
      } catch (retryErr) {
        fail(retryErr.message);
        return null;
      }
    }
  }

  const connectionPort = await prompt('Wireless-debugging connection port (IP address & Port): ');
  if (!connectionPort) {
    fail('Connection port was not provided.');
    return null;
  }

  try {
    adb(['connect', `127.0.0.1:${connectionPort}`], { timeout: 20_000 });
  } catch (err) {
    fail(err.message);
    return null;
  }

  devices = getDevices();
  if (devices.length === 0) {
    fail('ADB still does not see the phone. Make sure Wireless debugging is ON and retry.');
    return null;
  }
  saveConnectionPort(connectionPort);
  return devices[0];
}

function chooseForwardPort() {
  return new Promise((resolve) => {
    let port = CDP_BASE_PORT;
    const tryPort = () => {
      const server = net.createServer();
      server.once('error', () => {
        port += 1;
        tryPort();
      });
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(port));
      });
    };
    tryPort();
  });
}

async function forwardChromeDevTools() {
  const requested = Number(process.env.LEETCODE_CDP_PORT ?? 0);
  const port = requested >= 1024 && requested <= 65535 ? requested : await chooseForwardPort();
  try {
    adb(['forward', `tcp:${port}`, 'localabstract:chrome_devtools_remote'], { timeout: 20_000 });
  } catch (err) {
    return { port, ok: false, error: err.message };
  }
  return { port, ok: true };
}

async function httpJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function chromeDebugInfo(port) {
  return httpJson(`http://127.0.0.1:${port}/json/version`);
}

async function chromeTargets(port) {
  return httpJson(`http://127.0.0.1:${port}/json/list`);
}

function launchChrome(url) {
  try {
    adb([
      'shell',
      'am',
      'start',
      '-n',
      `${CHROME_PACKAGE}/${CHROME_ACTIVITY}`,
      '-d',
      url,
    ], { timeout: 20_000 });
    return true;
  } catch {
    try {
      adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url], { timeout: 20_000 });
      return true;
    } catch {
      return false;
    }
  }
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    if (typeof WebSocket !== 'function') {
      throw new Error('This Termux Node.js build does not expose the WebSocket API; install Node.js 22+ with pkg.');
    }

    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (!message.id) return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${message.error.message ?? 'CDP error'} (${message.error.code ?? ''})`));
        else pending.resolve(message.result ?? {});
      } catch {
        // Ignore malformed/unrelated frames.
      }
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to Chrome DevTools')), 10_000);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Chrome DevTools WebSocket connection failed'));
      }, { once: true });
    });
  }

  call(method, params = {}) {
    if (!this.ws) return Promise.reject(new Error('CDP client is not connected'));
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        reject(new Error(`CDP call timed out: ${method}`));
      }, 15_000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
    });
  }

  close() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }
    this.ws = null;
    for (const pending of this.pending.values()) pending.reject(new Error('CDP connection closed'));
    this.pending.clear();
  }
}

async function evaluate(client, expression) {
  const result = await client.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error('LeetCode page evaluation failed');
  }
  return result.result?.value;
}

async function getUserStatus(client) {
  const value = await evaluate(client, `
    (async () => {
      const r = await fetch('/graphql', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: ${JSON.stringify(USER_STATUS_QUERY)},
          variables: {}
        })
      });
      return { status: r.status, body: await r.json() };
    })()
  `);

  const st = value?.body?.data?.userStatus;
  return {
    authenticated: Boolean(st?.isSignedIn && st?.username),
    username: typeof st?.username === 'string' ? st.username : null,
  };
}

function normalizeSameSite(value) {
  const s = String(value ?? '').toLowerCase();
  if (s === 'strict') return 'Strict';
  if (s === 'none' || s === 'no_restriction') return 'None';
  return 'Lax';
}

function toStorageState(cookies) {
  const leetcodeCookies = cookies
    .filter((c) => typeof c.domain === 'string' && c.domain.includes('leetcode.com'))
    .filter((c) => typeof c.name === 'string' && typeof c.value === 'string')
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      expires: c.session ? -1 : (typeof c.expires === 'number' ? c.expires : -1),
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
      sameSite: normalizeSameSite(c.sameSite),
    }));

  const deduped = [...new Map(leetcodeCookies.map((c) => [`${c.name}@${c.domain}@${c.path}`, c])).values()];
  const session = deduped.find((c) => c.name === 'LEETCODE_SESSION' && c.value.length > 10);
  const csrf = deduped.find((c) => c.name === 'csrftoken' && c.value.length > 0);
  if (!session) throw new Error('Chrome did not expose a usable LEETCODE_SESSION cookie. Is Chrome remote debugging enabled?');
  if (!csrf) throw new Error('Chrome did not expose a csrftoken cookie.');
  return { cookies: deduped, origins: [] };
}

function downloadPath() {
  const candidates = [
    path.join(os.homedir(), 'storage', 'downloads'),
    path.join(os.homedir(), 'storage', 'shared', 'Download'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

function ensureDownloadsDir() {
  const existing = downloadPath();
  if (existing) return existing;

  if (commandExists('termux-setup-storage')) {
    log('Requesting Android shared-storage permissionâ€¦');
    try { run('termux-setup-storage', [], { timeout: 20_000 }); } catch {}
  }

  const after = downloadPath();
  if (after) return after;
  return path.join(process.cwd(), 'android-capture');
}

function tryShare(filePath) {
  if (!commandExists('termux-share')) return false;
  try {
    run('termux-share', [
      '-a', 'send',
      '-c', 'application/json',
      '-t', 'LeetCode session',
      filePath,
    ], { timeout: 120_000 });
    return true;
  } catch (err) {
    log(`Could not open the Android share sheet: ${err.message}`);
    return false;
  }
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    fail(`Node.js 22+ is required. Detected ${process.version}.`);
    return;
  }

  log('Android-only local Chrome capture starting.');
  log('Your password and cookie values are never printed.');

  const serial = await ensureAdbDevice();
  if (!serial) return;
  log(`ADB device connected: ${serial}`);

  const forward = await forwardChromeDevTools();
  if (!forward.ok) {
    log('Chrome DevTools is not available yet.');
    launchChrome('chrome://flags/#enable-command-line-on-non-rooted-devices');
    fail(
      'Enable â€œEnable command line on non-rooted devicesâ€ in Chrome flags, relaunch Chrome, then run `npm run capture` again.',
    );
    return;
  }

  const port = forward.port;
  let debugReady = false;
  try {
    await chromeDebugInfo(port);
    debugReady = true;
  } catch {
    // The forward can exist before Chrome exposes the DevTools socket.
  }

  if (!debugReady) {
    launchChrome('chrome://flags/#enable-command-line-on-non-rooted-devices');
    try { adb(['forward', `tcp:${port}`, 'localabstract:chrome_devtools_remote'], { timeout: 20_000 }); } catch {}
    fail(
      'Chrome DevTools is not exposed. In Chrome, enable â€œEnable command line on non-rooted devicesâ€, relaunch Chrome, then run `npm run capture` again.',
    );
    return;
  }

  launchChrome(LOGIN_URL);
  log('LeetCode login page opened in Chrome on this phone.');
  log('Sign in normally. If LeetCode shows a human verification, complete it yourself.');

  const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
  let client = null;
  let lastTargetId = null;

  try {
    while (Date.now() < deadline) {
      const targets = await chromeTargets(port).catch(() => []);
      const target = targets.find(
        (t) => t.type === 'page' && typeof t.url === 'string' && /(^https?:\/\/)([^/]*\.)?leetcode\.com\//i.test(t.url),
      );

      if (!target?.webSocketDebuggerUrl) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        continue;
      }

      if (target.id !== lastTargetId || !client) {
        client?.close();
        client = new CdpClient(target.webSocketDebuggerUrl);
        await client.connect();
        lastTargetId = target.id;
      }

      const status = await getUserStatus(client).catch(() => ({ authenticated: false, username: null }));
      if (!status.authenticated) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        continue;
      }

      const cookieResult = await client.call('Network.getAllCookies');
      const storageState = toStorageState(cookieResult.cookies ?? []);
      const dir = ensureDownloadsDir();
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, 'leetcode-session.json');
      fs.writeFileSync(filePath, JSON.stringify(storageState, null, 2), { encoding: 'utf8', mode: 0o600 });

      console.log('');
      log(`âœ… Signed in as ${status.username}.`);
      log('âœ… Authenticated Chrome cookies captured into a Playwright storageState file.');
      log(`ðŸ“„ File: ${filePath}`);
      console.log('');

      if (tryShare(filePath)) {
        log('ðŸ“¤ Android share sheet opened. Choose Telegram, then your LeetCode bot, and send the file.');
      } else {
        log('Install Termux:API if you want the script to open the share sheet automatically.');
        log('Otherwise attach the file above manually in Telegram.');
      }

      log('The Telegram bot validates the file against LeetCode before saving it.');
      return;
    }

    fail('Timed out waiting for the LeetCode login. Run `npm run capture` again and sign in within 10 minutes.');
  } finally {
    client?.close();
    try { adb(['forward', '--remove', `tcp:${port}`], { timeout: 10_000 }); } catch {}
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
