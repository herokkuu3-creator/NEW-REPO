import { chromium, request as playwrightRequest } from 'playwright';
import { PrismaClient } from '@prisma/client';
import { loginOnCodeChefPage } from '../src/codechef/auth';

const prisma = new PrismaClient();

async function main() {
  const accounts = await prisma.codeChefAccount.findMany({ where: { status: 'ACTIVE' } });
  console.log(`Found ${accounts.length} active CodeChef accounts in DB`);

  for (const acc of accounts) {
    const creds = JSON.parse(acc.storageState || '{}');
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
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      });
      const page = await context.newPage();
      const state = await loginOnCodeChefPage(page, username, password);
      console.log(`  ✓ Login succeeded! Received ${state.cookies.length} cookies.`);

      // Verify session via API
      const apiContext = await playwrightRequest.newContext({
        storageState: { cookies: state.cookies, origins: [] },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      });
      const verifyRes = await apiContext.get('https://www.codechef.com/problems/FLOW001', { timeout: 20000 });
      const html = await verifyRes.text();
      const csrf = /window\.csrfToken\s*=\s*["']([^"']+)["']/.exec(html)?.[1];
      const hasUser = html.includes(username) || /"isLoggedIn"\s*:\s*true/i.test(html) || /"username"\s*:\s*"[^"]+"/i.test(html);
      console.log(`  ✓ Verification: CSRF found = ${Boolean(csrf)}, isLoggedIn = ${hasUser}`);
      await apiContext.dispose();

      // Save to database
      const updatedStorageState = JSON.stringify({
        username,
        password,
        cookies: state.cookies,
        origins: state.origins || []
      });

      await prisma.codeChefAccount.update({
        where: { id: acc.id },
        data: {
          storageState: updatedStorageState,
          lastError: null,
          lastCheckedAt: new Date()
        }
      });
      console.log(`  ✓ Saved session cookies to database for ${acc.label}!`);
    } catch (err: any) {
      console.error(`  ✗ Failed for ${acc.label}:`, err.message || err);
    } finally {
      await browser.close();
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
