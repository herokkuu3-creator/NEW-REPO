import fs from 'node:fs';
import path from 'node:path';
import { Page } from 'playwright';
import { config } from '../config';
import { logger } from '../logger';
import { fileStampLocal, isoLocal } from '../time';

/**
 * Failure forensics. When the worker hits Cloudflare verification or any
 * unrecoverable browser state, it writes a timestamped bundle to the
 * diagnostics directory (the Render persistent disk in production) so the
 * operator can see exactly what the browser saw.
 *
 * The bundle contains: timestamp, URL, HTML title, a full-page screenshot,
 * and captured browser console/page-error logs. It never contains cookies,
 * tokens, or request headers.
 */

export interface DiagnosticsBundle {
  dir: string;
  screenshotPath: string | null;
  metaPath: string;
  logsPath: string;
}

export async function captureDiagnostics(
  page: Page | null,
  reason: string,
  browserLogs: string[],
): Promise<DiagnosticsBundle | null> {
  try {
    const stamp = fileStampLocal();
    const dir = path.join(config.browser.diagnosticsDir, `${stamp}-${reason}`);
    fs.mkdirSync(dir, { recursive: true });

    const meta = {
      timestamp: isoLocal(),
      reason,
      url: page ? safeUrl(page) : null,
      title: page ? await page.title().catch(() => null) : null,
    };
    const metaPath = path.join(dir, 'meta.json');
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    const logsPath = path.join(dir, 'browser-logs.txt');
    fs.writeFileSync(logsPath, browserLogs.join('\n'));

    let screenshotPath: string | null = null;
    if (page) {
      try {
        screenshotPath = path.join(dir, 'screenshot.png');
        await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 15_000 });
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'diagnostic screenshot failed',
        );
        screenshotPath = null;
      }
    }

    logger.warn({ dir, reason }, 'diagnostics bundle captured');
    return { dir, screenshotPath, metaPath, logsPath };
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'failed to capture diagnostics',
    );
    return null;
  }
}

function safeUrl(page: Page): string | null {
  try {
    return page.url();
  } catch {
    return null;
  }
}

/** Keep the diagnostics directory bounded — retain the newest N bundles. */
export function pruneDiagnostics(keep = 30): void {
  try {
    const root = config.browser.diagnosticsDir;
    if (!fs.existsSync(root)) return;
    const entries = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    const excess = entries.length - keep;
    for (let i = 0; i < excess; i++) {
      fs.rmSync(path.join(root, entries[i]!), { recursive: true, force: true });
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'diagnostics prune failed');
  }
}
