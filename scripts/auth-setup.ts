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

export interface RecoveryBootstrapInfo {
  ok: boolean;
  label?: string;
  expectedUsername?: string | null;
  credentials?: { identifier: string; password: string } | null;
  reason?: string;
  message?: string;
}

export async function fetchRecoveryBootstrap(
  pairingUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RecoveryBootstrapInfo | null> {
  if (!/\/auth\/recover\/[A-Za-z0-9_-]+/i.test(pairingUrl)) {
    return null;
  }
  const bootstrapUrl = `${pairingUrl.replace(/\/+$/, '')}/bootstrap`;
  try {
    const res = await fetchImpl(bootstrapUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => null)) as RecoveryBootstrapInfo | null;
    if ((res.status === 200 || Boolean(res.ok)) && body && body.ok === true) {
      return {
        ok: true,
        label: body.label,
        expectedUsername: body.expectedUsername ?? null,
        credentials: body.credentials ?? null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function pushSessionToPairingEndpoint(
  pairingUrl: string,
  storageStateJson: string,
  localVerifiedUsername: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ httpStatus: number; body: PairingUploadResponse }> {
  const parsedState = JSON.parse(storageStateJson) as {
    transport?: { userAgent?: unknown };
    [key: string]: unknown;
  } | null;
  const userAgent =
    typeof parsedState?.transport?.userAgent === 'string' && parsedState.transport.userAgent.trim()
      ? parsedState.transport.userAgent.trim()
      : undefined;
  const res = await fetchImpl(pairingUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      storageState: parsedState,
      localVerifiedUsername,
      ...(userAgent ? { userAgent } : {}),
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const body = (await res.json().catch(() => ({
    ok: false,
    error: `Unexpected non-JSON response (HTTP ${res.status})`,
  }))) as PairingUploadResponse;
  return { httpStatus: res.status, body };
}

export function copyToWindowsClipboard(text: string): boolean {
  if (process.platform !== 'win32' || !text) return false;
  try {
    const proc = spawn('clip');
    proc.on('error', () => {});
    proc.stdin.on('error', () => {});
    proc.stdin.write(text);
    proc.stdin.end();
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const { pairingUrl } = parseCompanionCliArgs(process.argv.slice(2));
  const bootstrap = pairingUrl ? await fetchRecoveryBootstrap(pairingUrl) : null;
  const activeProfileDir = bootstrap?.label
    ? path.resolve(process.cwd(), 'local-auth/profiles', bootstrap.label.replace(/[^a-zA-Z0-9_-]/g, '_'))
    : PROFILE_DIR;

  fs.mkdirSync(activeProfileDir, { recursive: true });
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
  console.log(`• Profile dir:    ${activeProfileDir}`);
  if (bootstrap?.label) {
    console.log(`• Account:        ${bootstrap.label}`);
  }
  console.log(`• Network:        Your local residential IP (bypasses Cloudflare datacenter blocks)`);
  if (pairingUrl) {
    console.log(`• Server sync:    ${pairingUrl}`);
  }
  console.log('═'.repeat(70));
  console.log('Opening browser window on your screen now...');
  console.log('Log into LeetCode (any Turnstile checkbox will pass cleanly on your network).');
  console.log('The window will automatically close and save your cookies once you are logged in.');
  console.log('═'.repeat(70));

  const context = await chromium.launchPersistentContext(activeProfileDir, {
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

  if (bootstrap?.expectedUsername) {
    const initialUser = await detectSignedInUser(page).catch(() => null);
    if (initialUser && initialUser.toLowerCase() !== bootstrap.expectedUsername.toLowerCase()) {
      console.log(
        `Profile is currently signed in as "${initialUser}", clearing cookies for "${bootstrap.expectedUsername}"...`,
      );
      await context.clearCookies();
      await page.goto('https://leetcode.com/accounts/login/', {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      }).catch(() => undefined);
    }
  }

  const deadline = Date.now() + MAX_WAIT_MINUTES * 60_000;
  let username: string | null = null;
  let autoFilled = false;
  let autoSubmitted = false;

  while (Date.now() < deadline) {
    await page.waitForTimeout(2_500);
    const detected = await detectSignedInUser(page).catch(() => null);
    if (detected) {
      if (
        !bootstrap?.expectedUsername ||
        detected.toLowerCase() === bootstrap.expectedUsername.toLowerCase()
      ) {
        username = detected;
        break;
      }
      continue;
    }

    if (bootstrap?.credentials && !autoFilled) {
      try {
        const userInput = page
          .locator('input#id_login, input[name="login"], input[name="username"]')
          .first();
        const passInput = page
          .locator('input#id_password, input[name="password"], input[type="password"]')
          .first();
        const [userVisible, passVisible] = await Promise.all([
          userInput.isVisible().catch(() => false),
          passInput.isVisible().catch(() => false),
        ]);
        if (userVisible && passVisible) {
          await userInput.fill(bootstrap.credentials.identifier);
          await passInput.fill(bootstrap.credentials.password);
          autoFilled = true;
          console.log('✓ Filled saved LeetCode credentials.');
        }
      } catch {
        // Best-effort autofill; user can still fill manually.
      }
    }

    if (bootstrap?.credentials && autoFilled && !autoSubmitted) {
      try {
        const cfResponse = page.locator('input[name="cf-turnstile-response"]').first();
        const hasCf = (await cfResponse.count().catch(() => 0)) > 0;
        const cfSolved = hasCf
          ? (await cfResponse.inputValue().catch(() => '')).trim().length > 0
          : true;
        if (cfSolved) {
          const submitBtn = page
            .locator('button#signin_btn, button[type="submit"], button:has-text("Sign In")')
            .first();
          const [btnVisible, btnEnabled] = await Promise.all([
            submitBtn.isVisible().catch(() => false),
            submitBtn.isEnabled().catch(() => false),
          ]);
          if (btnVisible && btnEnabled) {
            await submitBtn.click().catch(() => undefined);
            autoSubmitted = true;
          }
        }
      } catch {
        // Best-effort submit; user can click Sign In manually.
      }
    }
  }

  if (!username) {
    console.error(`\n✗ No signed-in session detected within ${MAX_WAIT_MINUTES} minutes.`);
    console.error('  Run the command again whenever you want to log in.');
    await context.close().catch(() => undefined);
    process.exit(1);
  }

  let cookies = await context.cookies(['https://leetcode.com']);
  if (!cookies.some((c) => c.name === 'csrftoken' && c.value)) {
    await page
      .evaluate(() =>
        fetch('https://leetcode.com/api/problems/algorithms/', { credentials: 'include' }).catch(() => null),
      )
      .catch(() => null);
    await page.waitForTimeout(1_000);
    cookies = await context.cookies(['https://leetcode.com']);
  }

  const state = await context.storageState();
  const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => undefined);
  const enrichedState = {
    ...state,
    ...(typeof userAgent === 'string' && userAgent.trim()
      ? { transport: { userAgent: userAgent.trim() } }
      : {}),
  };
  fs.writeFileSync(STORAGE_STATE, JSON.stringify(enrichedState, null, 2), 'utf8');

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

  console.log('\n' + '═'.repeat(70));
  console.log(`✅ LOGIN DETECTED & VERIFIED AS: ${username}`);
  console.log('═'.repeat(70));
  console.log(`• Profile:        ${activeProfileDir}`);
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
      console.log('✓ Redirecting browser to confirmation page...');
      const completedUrl = `${pairingUrl.replace(/\/+$/, '')}?completed=1`;
      await page.goto(completedUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
      await page.waitForTimeout(2_000).catch(() => undefined);
      console.log('✓ Check Telegram for confirmation.');
      console.log('═'.repeat(70));
      await context.close().catch(() => undefined);
      return;
    }

    console.warn(`Note on server upload (HTTP ${httpStatus}): ${body.error ?? 'Uploaded locally; use /renew in bot'}`);
    console.log('═'.repeat(70));
  }

  await context.close().catch(() => undefined);
}

export async function detectSignedInUser(page: import('playwright').Page): Promise<string | null> {
  try {
    const cookies = await page.context().cookies(['https://leetcode.com']);
    const session = cookies.find((c) => c.name === 'LEETCODE_SESSION' && c.value && c.value.length > 20);
    if (!session) return null;

    // Check GraphQL userStatus inside page context (no redirects or reloads!)
    const status = await page.evaluate(async () => {
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
        if (!res.ok) return null;
        const json = (await res.json()) as {
          data?: { userStatus?: { isSignedIn?: boolean; username?: string | null } };
        };
        const u = json.data?.userStatus;
        if (!u || u.isSignedIn !== true) return null;
        return { isSignedIn: true as const, username: u.username?.trim() || null };
      } catch {
        return null;
      }
    });

    if (!status || status.isSignedIn !== true) return null;
    if (status.username) return status.username;

    // Only fill missing username from JWT payload after GraphQL confirms isSignedIn === true
    try {
      const parts = session.value.split('.');
      if (parts.length >= 2 && parts[1]) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (typeof payload?.username === 'string' && payload.username.trim()) {
          return payload.username.trim();
        }
      }
    } catch {
      // ignore
    }

    return 'unknown';
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
