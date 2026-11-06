import fs from 'node:fs';
import path from 'node:path';
import { runRemoteBrowserPoc } from '../src/recovery/poc';

/**
 * Proof of concept for the remote interactive recovery browser.
 *   npx tsx scripts/recovery-poc.ts
 * Opens the real https://leetcode.com/accounts/login/ in the plain remote
 * browser, reports how LeetCode/Cloudflare respond from THIS machine's network,
 * and saves the frame a remote user would see. Nothing is clicked or solved.
 * (To test from Render's network use POST /admin/recovery/poc on the service.)
 */
(async () => {
  const result = await runRemoteBrowserPoc({ settleMs: 12_000 });
  const { screenshot, ...summary } = result;
  console.log(JSON.stringify(summary, null, 2));
  if (screenshot) {
    const out = path.resolve('scratch', 'recovery-poc.jpg');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, screenshot);
    console.log(`frame saved: ${out}`);
  }
})().catch((err) => {
  console.error('poc failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
