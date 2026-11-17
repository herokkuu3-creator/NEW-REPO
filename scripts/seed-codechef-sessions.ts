import { chromium, request as playwrightRequest } from 'playwright';
import { CodeChefAccountStatus, PrismaClient } from '@prisma/client';
import { loginOnCodeChefPage } from '../src/codechef/auth';
import { ensureCodeChefAccountsSeeded } from '../src/codechef/storage';

const prisma = new PrismaClient();

async function main() {
  await ensureCodeChefAccountsSeeded();
  const accounts = await prisma.codeChefAccount.findMany({ where: { status: { not: 'DISABLED' } } });
  console.log(`Found ${accounts.length} active CodeChef accounts in DB`);

  for (const acc of accounts) {
    let creds: { username?: string; password?: string } = {};
    try {
      creds = JSON.parse(acc.storageState || '{}') as { username?: string; password?: string };
    } catch {
      console.warn(`Skipping ${acc.label}: invalid stored storageState JSON`);
      process.exitCode = 1;
      continue;
    }
    const username = creds.username || acc.username || acc.label;
    const password = creds.password;

    if (!username || !password) {
      console.warn(`Skipping ${acc.label}: missing username or password`);
      continue;
    }

    console.log(`\nLogging in ${username}...`);
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });
      const page = await context.newPage();
      const state = await loginOnCodeChefPage(page, username, password);
      console.log(`  ✓ Login succeeded! Received ${state.cookies.length} cookies.`);

      // Verify session via API
      const apiContext = await playwrightRequest.newContext({
        storageState: { cookies: state.cookies, origins: [] },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });
      let csrf: string | undefined;
      let hasUser = false;
      try {
        const verifyRes = await apiContext.get('https://www.codechef.com/problems/FLOW001', { timeout: 20000 });
        const html = await verifyRes.text();
        csrf = /window\.csrfToken\s*=\s*["']([^"']+)["']/.exec(html)?.[1];
        hasUser = html.includes(username) || /"isLoggedIn"\s*:\s*true/i.test(html) || /"username"\s*:\s*"[^"]+"/i.test(html);
      } finally {
        await apiContext.dispose().catch(() => undefined);
      }
      console.log(`  ✓ Verification: CSRF found = ${Boolean(csrf)}, isLoggedIn = ${hasUser}`);
      if (!hasUser) {
        throw new Error(`Verification did not confirm signed-in session for ${acc.label}`);
      }

      // Save to database
      const updatedStorageState = JSON.stringify({
        username,
        password,
        cookies: state.cookies,
        origins: state.origins || [],
      });

      await prisma.codeChefAccount.update({
        where: { id: acc.id },
        data: {
          status: CodeChefAccountStatus.ACTIVE,
          storageState: updatedStorageState,
          lastError: null,
          lastCheckedAt: new Date(),
        },
      });
      console.log(`  ✓ Saved session cookies to database for ${acc.label}!`);
    } catch (err: any) {
      console.error(`  ✗ Failed for ${acc.label}:`, err?.message || err);
      process.exitCode = 1;
    } finally {
      await browser.close().catch(() => undefined);
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
