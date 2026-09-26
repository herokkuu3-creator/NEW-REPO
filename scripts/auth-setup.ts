/* eslint-disable no-console */
/**
 * ONE-TIME local authentication setup.
 *
 *   npm run auth:setup
 *
 * What it does:
 *   1. Opens a HEADED Chromium window with a persistent local profile
 *      (./local-auth/browser-profile).
 *   2. You log into LeetCode manually in that window (password, Google
 *      OAuth, passkey — whatever you normally use; the script never sees it).
 *   3. The script polls until LeetCode reports you as signed in.
 *   4. It saves ./local-auth/storage-state.json alongside the profile.
 *
 * What it NEVER does: read/print/store your password, cookies, or tokens
 * outside the two artifact locations above.
 *
 * Afterwards, upload BOTH artifacts to the Render persistent disk:
 *   local-auth/browser-profile   →  /var/data/browser-profile
 *   local-auth/storage-state.json →  /var/data/storage-state.json
 * (See README §5 for exact instructions.)
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const PROFILE_DIR = path.resolve(process.cwd(), 'local-auth/browser-profile');
const STORAGE_STATE = path.resolve(process.cwd(), 'local-auth/storage-state.json');
const MAX_WAIT_MINUTES = 10;

async function main(): Promise<void> {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  console.log('─'.repeat(70));
  console.log('LeetCode auth setup');
  console.log(`Profile dir:      ${PROFILE_DIR}`);
  console.log(`Storage state:    ${STORAGE_STATE}`);
  console.log('─'.repeat(70));
  console.log('A Chromium window will open. Log into LeetCode manually.');
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
    console.error('  The profile directory was kept — just run `npm run auth:setup` again');
    console.error('  and finish logging in; the window resumes where you left off.');
    await context.close();
    process.exit(1);
  }

  await context.storageState({ path: STORAGE_STATE });
  await context.close();

  console.log('─'.repeat(70));
  console.log(`✓ Authenticated as: ${username}`);
  console.log(`✓ Browser profile saved:  ${PROFILE_DIR}`);
  console.log(`✓ Storage state saved:    ${STORAGE_STATE}`);
  console.log('─'.repeat(70));
  console.log('Next steps (README §5):');
  console.log('  1. Create the Render Background Worker with a persistent disk at /var/data');
  console.log('  2. Upload browser-profile/ → /var/data/browser-profile');
  console.log('  3. Upload storage-state.json → /var/data/storage-state.json');
  console.log('─'.repeat(70));
}

/**
 * Same-origin GraphQL userStatus check from inside the page — the script
 * learns only the username, never any credential.
 */
async function detectSignedInUser(page: import('playwright').Page): Promise<string | null> {
  // If we're still on the login page, navigate home first so the fetch has
  // the leetcode.com origin in every state of the login flow.
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

main().catch((err) => {
  console.error('auth setup failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
