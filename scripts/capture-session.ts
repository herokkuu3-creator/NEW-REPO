import { chromium } from 'playwright';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

/**
 * Local-browser LeetCode session renewal.
 *
 * Desktop:
 *   - starts the REAL installed Google Chrome on this machine with a dedicated
 *     local capture profile
 *   - you sign in yourself in that visible Chrome window
 *   - the script captures that browser's storageState and uploads it
 *
 * Android:
 *   - `npm run capture:android` uses adb + Chrome's documented remote-debugging
 *     socket to control Chrome running on the phone
 *   - you sign in on the phone itself
 *   - the script captures the phone Chrome session and uploads it
 *
 * No password is read or printed. Cookie values are never logged.
 */

const execFileAsync = promisify(execFile);
const START_URL = 'https://leetcode.com/accounts/login/';
const DEFAULT_AGENT_URL = 'https://leetcode-daily-agent.onrender.com';
const DEFAULT_CDP_PORT = 9222;
const TIMEOUT_MS = parsePositiveInt(process.env.CAPTURE_TIMEOUT_MS, 10 * 60_000);
const isAndroid = process.argv.includes('--android');

const localEnv = readDotEnv();
const AGENT_URL = (process.env.AGENT_URL ?? localEnv.AGENT_URL ?? DEFAULT_AGENT_URL).replace(/\/$/, '');
const SETUP_TOKEN = process.env.SETUP_TOKEN ?? localEnv.SETUP_TOKEN ?? '';

const USER_STATUS_QUERY = `
  query userStatus {
    userStatus {
      isSignedIn
      username
    }
  }
`;

const userStatusSchema = z.object({
  userStatus: z.object({
    isSignedIn: z.boolean(),
    username: z.string().nullable().optional(),
  }),
});

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readDotEnv(): Record<string, string> {
  const file = path.join(process.cwd(), '.env');
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let value = t.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function fail(message: string): never {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chromeCandidates(): string[] {
  if (process.platform === 'win32') {
    return [
      path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.PROGRAMFILES ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    ];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
}

function findChrome(): string | null {
  const configured = process.env.CHROME_PATH?.trim();
  if (configured && fs.existsSync(configured)) return configured;
  return chromeCandidates().find((p) => p && fs.existsSync(p)) ?? null;
}

async function assertConfig(): Promise<void> {
  if (!AGENT_URL.startsWith('http')) fail(`AGENT_URL is invalid: ${AGENT_URL}`);
  if (SETUP_TOKEN.length < 8) {
    fail('SETUP_TOKEN is missing. Put it in your local .env (SETUP_TOKEN=...) or pass it as an environment variable.');
  }
}

async function waitForCdp(cdpUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
    } catch {
      // Chrome is still starting.
    }
    await sleep(500);
  }
  throw new Error(`Chrome did not expose the DevTools endpoint at ${cdpUrl}`);
}

async function checkSignedIn(context: any): Promise<string | null> {
  try {
    const res = await context.request.post('https://leetcode.com/graphql', {
      headers: { 'Content-Type': 'application/json' },
      data: { query: USER_STATUS_QUERY, variables: {} },
      timeout: 15_000,
    });
    if (res.status() !== 200) return null;
    const parsed = userStatusSchema.safeParse((await res.json()).data);
    return parsed.success && parsed.data.userStatus.isSignedIn && parsed.data.userStatus.username
      ? parsed.data.userStatus.username
      : null;
  } catch {
    return null;
  }
}

async function captureDesktop(): Promise<{ state: any; username: string }> {
  const chrome = findChrome();
  if (!chrome) {
    throw new Error('Google Chrome was not found. Set CHROME_PATH to your chrome.exe path and run npm run capture again.');
  }

  const profileDir = process.env.CHROME_CAPTURE_PROFILE?.trim() ||
    path.join(os.homedir(), '.leetcode-daily-agent', 'chrome-capture-profile');
  fs.mkdirSync(profileDir, { recursive: true });

  console.log(`Using local Google Chrome: ${chrome}`);
  console.log(`Capture profile: ${profileDir}`);
  console.log('A visible Chrome window will open. Sign in to LeetCode there.');
  console.log('Complete any human verification yourself if LeetCode shows one.\n');

  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chrome,
    headless: false,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    args: ['--no-first-run', '--no-default-browser-check'],
  });

  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
    const username = await waitForLogin(context);
    const state = await context.storageState();
    return { state, username };
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function waitForLogin(context: any): Promise<string> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const username = await checkSignedIn(context);
    if (username) return username;
    await sleep(3_000);
  }
  throw new Error('Timed out waiting for LeetCode sign-in (10 minutes by default).');
}

async function captureAndroid(): Promise<{ state: any; username: string }> {
  const port = parsePositiveInt(process.env.ANDROID_CDP_PORT, DEFAULT_CDP_PORT);
  try {
    const { stdout } = await execFileAsync('adb', ['devices']);
    const deviceLines = stdout.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('List of devices'));
    if (!deviceLines.some((line) => /\sdevice\s*$/.test(line))) {
      fail('No Android device is available to adb. Enable Developer Options + USB debugging, connect the phone, and accept the debugging prompt.');
    }

    await execFileAsync('adb', ['forward', `tcp:${port}`, 'localabstract:chrome_devtools_remote']);
    await execFileAsync('adb', ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', START_URL]);
    await waitForCdp(`http://127.0.0.1:${port}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/adb|not found|ENOENT/i.test(msg)) {
      fail('Android mode needs Android Platform Tools (adb). Install adb on this computer, connect the phone, then run npm run capture:android again.');
    }
    throw err;
  }

  console.log('Chrome on Android is now connected through USB/ADB.');
  console.log('Sign in on the phone in Chrome. Complete any human verification yourself.\n');

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  if (!context) throw new Error('Chrome Android exposed no browser context.');

  const username = await waitForLogin(context);
  const state = await context.storageState();
  // Do not call browser.close(): keep the user's phone Chrome session alive.
  return { state, username };
}

async function upload(state: any, username: string): Promise<void> {
  const cookies = Array.isArray(state?.cookies) ? state.cookies : [];
  if (!cookies.some((c: any) => c?.name === 'LEETCODE_SESSION')) {
    fail('The captured browser state has no LEETCODE_SESSION cookie. Sign-in did not complete successfully.');
  }

  console.log(`✅ Signed in as ${username}. Uploading session to ${AGENT_URL}…`);
  const res = await fetch(`${AGENT_URL}/admin/upload-session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SETUP_TOKEN}`,
    },
    body: JSON.stringify(state),
    signal: AbortSignal.timeout(60_000),
  });

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 401) fail('Upload rejected with 401: SETUP_TOKEN does not match the Render service.');
  if (res.status === 422) fail(`Render rejected the session after validation: ${body.error ?? 'validation failed'}`);
  if (!res.ok || body.ok !== true) fail(`Upload failed with HTTP ${res.status}: ${String(body.error ?? 'unknown error')}`);

  console.log('🎉 Session renewed on Render.');
  console.log(`Cookies stored: ${String(body.cookieCount ?? cookies.length)}.`);
  console.log("Today's challenge run has been triggered automatically. Check Telegram for the result.\n");
}

async function main(): Promise<void> {
  await assertConfig();
  const result = isAndroid ? await captureAndroid() : await captureDesktop();
  await upload(result.state, result.username);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
