/* eslint-disable no-console */
/**
 * Local Browser Authentication Companion & One-Time Setup.
 *
 *   npm run auth:login -- <pairing-url>
 *   npm run auth:setup
 *
 * What it does:
 *   1. Opens a HEADED Chromium window with a persistent local profile
 *      (./local-auth/browser-profile).
 *   2. You log into LeetCode manually in that window (password, Google
 *      OAuth, passkey, or Cloudflare verification — whatever you normally use;
 *      the script never reads your password).
 *   3. The script polls until LeetCode's GraphQL `userStatus` API confirms
 *      you are signed in and returns your verified username.
 *   4. It saves ./local-auth/storage-state.json alongside the profile.
 *   5. When invoked with a Telegram `/lclogin` pairing URL
 *      (`https://<host>/auth/leetcode/<token>`), it automatically uploads
 *      the authenticated storageState over HTTPS to the pairing endpoint,
 *      verifies whether the server can use the session against LeetCode's
 *      GraphQL API, and triggers the Telegram confirmation message — with
 *      ZERO manual cookie copying.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PROFILE_DIR = path.resolve(process.cwd(), 'local-auth/browser-profile');
const STORAGE_STATE = path.resolve(process.cwd(), 'local-auth/storage-state.json');
const COOKIES_TXT = path.resolve(process.cwd(), 'local-auth/cookies.txt');
const MAX_WAIT_MINUTES = 10;

export interface CompanionCliArgs {
  pairingUrl: string | null;
}

export function parseCompanionCliArgs(argv: string[]): CompanionCliArgs {
  let pairingUrl: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = (argv[i] ?? '').trim();
    if (!arg) continue;
    if ((arg === '--pair' || arg === '--url' || arg === '-u') && argv[i + 1]) {
      pairingUrl = argv[i + 1]!.trim();
      i += 1;
      continue;
    }
    if (arg.startsWith('--pair=') || arg.startsWith('--url=')) {
      pairingUrl = arg.slice(arg.indexOf('=') + 1).trim();
      continue;
    }
    if (/^https?:\/\/\S+\/auth\/(?:leetcode|recover)\/\S+/i.test(arg)) {
      pairingUrl = arg;
    }
  }
  return { pairingUrl };
}

export interface PairingUploadResponse {
  ok: boolean;
  code?: string;
  error?: string;
  label?: string | null;
  username?: string | null;
  localVerifiedUsername?: string | null;
  accountStatus?: string | null;
  serverVerified?: boolean;
  localVsServerMismatch?: boolean;
  cookieCount?: number;
  detail?: string;
}

export async function pushSessionToPairingEndpoint(
  pairingUrl: string,
  storageStateJson: string,
  localVerifiedUsername: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ httpStatus: number; body: PairingUploadResponse }> {
  const parsedState = JSON.parse(storageStateJson) as unknown;
  const res = await fetchImpl(pairingUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      storageState: parsedState,
      localVerifiedUsername,
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const body = (await res.json().catch(() => ({
    ok: false,
    error: `Unexpected non-JSON response (HTTP ${res.status})`,
  }))) as PairingUploadResponse;
  return { httpStatus: res.status, body };
}

function copyToWindowsClipboard(text: string): boolean {
  if (process.platform !== 'win32' || !text) return false;
  try {
    const proc = spawn('clip');
    proc.stdin.write(text);
    proc.stdin.end();
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const { pairingUrl } = parseCompanionCliArgs(process.argv.slice(2));
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(COOKIES_TXT), { recursive: true });

  const hasSystemChrome =
    process.platform === 'win32' &&
    (fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe') ||
      fs.existsSync('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe') ||
      fs.existsSync(path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')));

  console.log('═'.repeat(70));
  console.log('   LEETCODE LOCAL BROWSER AUTHENTICATION');
  console.log('═'.repeat(70));
  console.log(`• Browser:        ${hasSystemChrome ? 'Google Chrome (native system)' : 'Chromium'}`);
  console.log(`• Profile dir:    ${PROFILE_DIR}`);
  console.log(`• Network:        Your local residential IP (bypasses Cloudflare datacenter blocks)`);
  if (pairingUrl) {
    console.log(`• Server sync:    ${pairingUrl}`);
  }
  console.log('═'.repeat(70));
  console.log('Opening browser window on your screen now...');
  console.log('Log into LeetCode (any Turnstile checkbox will pass cleanly on your network).');
  console.log('The window will automatically close and save your cookies once you are logged in.');
  console.log('═'.repeat(70));

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: hasSystemChrome ? 'chrome' : undefined,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('https://leetcode.com/accounts/login/', {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  }).catch(() => undefined);

  const deadline = Date.now() + MAX_WAIT_MINUTES * 60_000;
  let username: string | null = null;

  while (Date.now() < deadline) {
    await page.waitForTimeout(2_500);
    username = await detectSignedInUser(page).catch(() => null);
    if (username) break;
  }

  if (!username) {
    console.error(`\n✗ No signed-in session detected within ${MAX_WAIT_MINUTES} minutes.`);
    console.error('  Run the command again whenever you want to log in.');
    await context.close().catch(() => undefined);
    process.exit(1);
  }

  await context.storageState({ path: STORAGE_STATE });

  const cookies = await context.cookies(['https://leetcode.com']);
  const sessionCookie = cookies.find((c) => c.name === 'LEETCODE_SESSION');
  const csrfCookie = cookies.find((c) => c.name === 'csrftoken');

  let cookieHeader = '';
  if (sessionCookie && csrfCookie) {
    cookieHeader = `LEETCODE_SESSION=${sessionCookie.value}; csrftoken=${csrfCookie.value}`;
  } else if (sessionCookie) {
    cookieHeader = `LEETCODE_SESSION=${sessionCookie.value}`;
  }

  fs.writeFileSync(COOKIES_TXT, cookieHeader, 'utf8');
  const copied = copyToWindowsClipboard(cookieHeader);

  await context.close().catch(() => undefined);

  console.log('\n' + '═'.repeat(70));
  console.log(`✅ LOGIN DETECTED & VERIFIED AS: ${username}`);
  console.log('═'.repeat(70));
  console.log(`• Profile:        ${PROFILE_DIR}`);
  console.log(`• Storage state:  ${STORAGE_STATE}`);
  console.log(`• Cookie file:    ${COOKIES_TXT}`);
  if (copied) {
    console.log(`• Clipboard:      📋 COPIED TO CLIPBOARD AUTOMATICALLY!`);
  }
  console.log('═'.repeat(70));
  console.log('👉 RESTORE YOUR TELEGRAM BOT INSTANTLY:');
  console.log('   In your Telegram chat with the bot, send:');
  console.log('');
  console.log(`   /renew ${cookieHeader}`);
  console.log('');
  if (copied) {
    console.log('   (Your cookies are already copied to your clipboard — just press Ctrl+V!)');
  }
  console.log('═'.repeat(70));

  if (pairingUrl) {
    console.log('Syncing authenticated session to your server...');
    const rawState = fs.readFileSync(STORAGE_STATE, 'utf8');
    const uploadOutcome = await pushSessionToPairingEndpoint(pairingUrl, rawState, username).catch((err) => ({
      httpStatus: 500,
      body: { ok: false, error: err instanceof Error ? err.message : String(err) } as PairingUploadResponse,
    }));
    const { httpStatus, body } = uploadOutcome;

    if (httpStatus === 200 && body.ok) {
      console.log(`✓ Server verified account "${body.username ?? username}" (status: ${body.accountStatus ?? 'ACTIVE'})!`);
      console.log('✓ Check Telegram for confirmation.');
      console.log('═'.repeat(70));
      return;
    }

    console.warn(`Note on server upload (HTTP ${httpStatus}): ${body.error ?? 'Uploaded locally; use /renew in bot'}`);
    console.log('═'.repeat(70));
  }
}

async function detectSignedInUser(page: import('playwright').Page): Promise<string | null> {
  try {
    const cookies = await page.context().cookies(['https://leetcode.com']);
    const session = cookies.find((c) => c.name === 'LEETCODE_SESSION' && c.value && c.value.length > 20);
    if (!session) return null;

    // Check GraphQL userStatus inside page context (no redirects or reloads!)
    const username = await page.evaluate(async () => {
      try {
        const res = await fetch('https://leetcode.com/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            query: 'query { userStatus { isSignedIn username } }',
            variables: {},
          }),
        });
        const json = (await res.json()) as {
          data?: { userStatus?: { isSignedIn?: boolean; username?: string | null } };
        };
        const u = json.data?.userStatus;
        return u?.isSignedIn ? (u.username ?? 'unknown') : null;
      } catch {
        return null;
      }
    });

    if (username) return username;

    // Fallback: parse JWT payload from session cookie
    try {
      const parts = session.value.split('.');
      if (parts.length >= 2 && parts[1]) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
        if (payload?.username) return String(payload.username);
      }
    } catch {
      // ignore
    }

    return null;
  } catch {
    return null;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('auth setup failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
