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

const PROFILE_DIR = path.resolve(process.cwd(), 'local-auth/browser-profile');
const STORAGE_STATE = path.resolve(process.cwd(), 'local-auth/storage-state.json');
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
    if (/^https?:\/\/\S+\/auth\/leetcode\/[A-Za-z0-9_-]+/i.test(arg)) {
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

async function main(): Promise<void> {
  const { pairingUrl } = parseCompanionCliArgs(process.argv.slice(2));
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  console.log('─'.repeat(70));
  console.log(pairingUrl ? 'LeetCode Telegram Pairing Companion' : 'LeetCode auth setup');
  console.log(`Profile dir:      ${PROFILE_DIR}`);
  console.log(`Storage state:    ${STORAGE_STATE}`);
  if (pairingUrl) {
    console.log(`Pairing endpoint: ${pairingUrl}`);
  }
  console.log('─'.repeat(70));
  console.log('A Chromium window will open. Log into LeetCode and complete any');
  console.log('Cloudflare verification check if prompted.');
  console.log(`You have ${MAX_WAIT_MINUTES} minutes. The window closes itself once`);
  console.log('authentication is detected.');
  console.log('─'.repeat(70));

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('https://leetcode.com/accounts/login/', {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });

  const deadline = Date.now() + MAX_WAIT_MINUTES * 60_000;
  let username: string | null = null;

  while (Date.now() < deadline) {
    await page.waitForTimeout(3_000);
    username = await detectSignedInUser(page).catch(() => null);
    if (username) break;
  }

  if (!username) {
    console.error(`\n✗ No signed-in session detected within ${MAX_WAIT_MINUTES} minutes.`);
    console.error('  The profile directory was kept — run the command again');
    console.error('  and finish logging in; the window resumes where you left off.');
    await context.close();
    process.exit(1);
  }

  await context.storageState({ path: STORAGE_STATE });
  await context.close();

  console.log('─'.repeat(70));
  console.log(`✓ Local browser verified as: ${username}`);
  console.log(`✓ Browser profile saved:     ${PROFILE_DIR}`);
  console.log(`✓ Storage state saved:       ${STORAGE_STATE}`);
  console.log('─'.repeat(70));

  if (pairingUrl) {
    console.log('Uploading authenticated session to your Telegram bot server...');
    const rawState = fs.readFileSync(STORAGE_STATE, 'utf8');
    const { httpStatus, body } = await pushSessionToPairingEndpoint(pairingUrl, rawState, username);

    if (httpStatus === 200 && body.ok) {
      console.log(`✓ Server verified LeetCode account "${body.username ?? username}" (status: ${body.accountStatus ?? 'ACTIVE'})!`);
      console.log('✓ Check your Telegram chat for the "✅ LeetCode login successful!" confirmation.');
      console.log('─'.repeat(70));
      return;
    }

    if (body.localVsServerMismatch) {
      console.warn(`⚠ Local vs. Server mismatch detected (HTTP ${httpStatus}):`);
      console.warn(`  • Local browser session:  ACTIVE (verified as "${username}")`);
      console.warn(`  • Server check (Render):  ${body.accountStatus ?? 'REJECTED'}`);
      console.warn(`  • Detail:                 ${body.error ?? 'Transferred session rejected by LeetCode on server.'}`);
      console.warn('  • Your local session at ./local-auth/storage-state.json is ready for local runs (`npm run run:now`).');
      console.log('─'.repeat(70));
      process.exit(2);
    }

    console.error(`✗ Pairing upload failed (HTTP ${httpStatus}): ${body.error ?? 'Unknown error'}`);
    console.log('─'.repeat(70));
    process.exit(1);
  }

  console.log('Next steps:');
  console.log('  • Run `/lclogin` in Telegram and pass the pairing URL to `npm run auth:login -- <url>`');
  console.log('  • Or run locally immediately with `npm run run:now`');
  console.log('─'.repeat(70));
}

/**
 * Same-origin GraphQL userStatus check from inside the page — the script
 * learns only the username, never any credential.
 */
async function detectSignedInUser(page: import('playwright').Page): Promise<string | null> {
  const url = page.url();
  if (!url.startsWith('https://leetcode.com') || url.includes('/accounts/')) {
    await page
      .goto('https://leetcode.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 })
      .catch(() => undefined);
  }
  const result = await page.evaluate(async () => {
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
  return result;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('auth setup failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
