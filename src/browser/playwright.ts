import { chromium, firefox, BrowserContext, Page } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config';
import { logger } from '../logger';
import { loadStorageStateFromDb, saveStorageStateToDb } from '../database/models';
import { StorageStateShape } from './cookiePayload';

/**
 * Browser lifecycle management.
 *
 * Two legitimate authentication modes, in priority order:
 *   1. Persistent Chromium profile (launchPersistentContext) — the profile
 *      directory was created ONCE by a human logging in (`npm run auth:setup`)
 *      and uploaded to the Render persistent disk.
 *   2. Playwright storageState JSON fallback — cookies/localStorage snapshot
 *      saved at the same time, used to build a fresh context.
 *
 * This module never types credentials, never reads passwords, and never
 * logs cookies, tokens, or headers.
 */

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  /** 'profile' when the persistent profile authenticated, 'storage-state' otherwise */
  mode: 'profile' | 'storage-state';
  /** Console + page-error lines captured for diagnostics (bounded ring buffer) */
  browserLogs: string[];
  close: () => Promise<void>;
}

const MAX_LOG_LINES = 500;

function attachLogCapture(page: Page, sink: string[]): void {
  page.on('console', (msg) => {
    if (sink.length < MAX_LOG_LINES) {
      sink.push(`[console:${msg.type()}] ${msg.text()}`.slice(0, 1000));
    }
  });
  page.on('pageerror', (err) => {
    if (sink.length < MAX_LOG_LINES) {
      sink.push(`[pageerror] ${String(err).slice(0, 1000)}`);
    }
  });
}

/**
 * Chromium flags tuned for Render's Free web service (512 MB RAM, small
 * /dev/shm, no sandbox). `--single-process` is available as an escape hatch
 * via CHROMIUM_SINGLE_PROCESS=true but is off by default (stability first).
 */
export function buildLaunchArgs(): string[] {
  const args = [
    '--disable-dev-shm-usage', // small /dev/shm in containers
    '--no-sandbox', // required in most container environments
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--no-first-run',
    '--js-flags=--max-old-space-size=256', // cap V8 heap for 512MB instances
  ];
  if (config.browser.chromiumSingleProcess) args.push('--single-process');
  return args;
}

async function openPageWithCapture(context: BrowserContext, logs: string[]): Promise<Page> {
  const page = context.pages()[0] ?? (await context.newPage());
  attachLogCapture(page, logs);
  return page;
}

/** Mode 1: reuse the persistent profile directory created during auth:setup. */
export async function launchWithPersistentProfile(): Promise<BrowserSession | null> {
  const profilePath = config.browser.profilePath;
  if (!fs.existsSync(profilePath)) {
    logger.warn({ profilePath }, 'persistent browser profile not found');
    return null;
  }
  try {
    const context = await chromium.launchPersistentContext(profilePath, {
      headless: config.browser.headless,
      args: buildLaunchArgs(),
      viewport: { width: 1366, height: 900 },
      locale: 'en-US',
    });
    const browserLogs: string[] = [];
    const page = await openPageWithCapture(context, browserLogs);
    logger.info({ profilePath }, 'launched persistent Chromium profile');
    return {
      context,
      page,
      mode: 'profile',
      browserLogs,
      close: () => context.close(),
    };
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'failed to launch persistent profile — will try storageState fallback',
    );
    return null;
  }
}

/**
 * Mode 2: build a fresh context from the saved storageState snapshot.
 *
 * Free-tier aware: if the snapshot file is missing (ephemeral filesystem),
 * it is hydrated from PostgreSQL, where every successful run re-saves it.
 */
export async function launchWithStorageState(): Promise<BrowserSession | null> {
  const statePath = await resolveStorageStatePath();
  if (!statePath) {
    logger.warn('no storageState available (neither file nor database copy)');
    return null;
  }
  try {
    const browser = await chromium.launch({
      headless: config.browser.headless,
      args: buildLaunchArgs(),
    });
    const context = await browser.newContext({
      storageState: statePath,
      viewport: { width: 1366, height: 900 },
      locale: 'en-US',
    });
    const browserLogs: string[] = [];
    const page = await openPageWithCapture(context, browserLogs);
    logger.info({ statePath }, 'launched context from storageState');
    return {
      context,
      page,
      mode: 'storage-state',
      browserLogs,
      close: async () => {
        await context.close();
        await browser.close();
      },
    };
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'failed to launch from storageState',
    );
    return null;
  }
}

/**
 * Mode 3 (multi-account): build a fresh context from an IN-MEMORY
 * storageState object — the per-account credential coming straight from an
 * Account row in Postgres. Nothing touches the shared profile or the legacy
 * snapshot paths, so accounts are fully isolated from each other.
 */
export async function launchWithStorageStateObject(
  state: StorageStateShape,
  label: string,
): Promise<BrowserSession | null> {
  try {
    const browser = await chromium.launch({
      headless: config.browser.headless,
      args: buildLaunchArgs(),
    });
    const context = await browser.newContext({
      storageState: {
        cookies: state.cookies,
        origins: state.origins,
      },
      viewport: { width: 1366, height: 900 },
      locale: 'en-US',
    });
    const browserLogs: string[] = [];
    const page = await openPageWithCapture(context, browserLogs);
    logger.info({ label }, 'launched context from account storageState');
    return {
      context,
      page,
      mode: 'storage-state',
      browserLogs,
      close: async () => {
        await context.close();
        await browser.close();
      },
    };
  } catch (err) {
    logger.error(
      { label, err: err instanceof Error ? err.message : String(err) },
      'failed to launch context from account storageState',
    );
    return null;
  }
}

/**
 * Firefox flavour of launchWithStorageStateObject, used by the Codeforces
 * submit path.
 *
 * Codeforces sits behind Cloudflare, which sorts clients by TLS fingerprint:
 * headless Chromium is handed "Just a moment..." there, while Firefox is served
 * normally — including the submit POST, which Cloudflare answers with 302 → "/"
 * for every other kind of client. Firefox also runs the page's own JavaScript,
 * so `_tta`, `ftaa`, `bfaa` and the form action are filled in by Codeforces'
 * own code instead of being guessed. LeetCode stays on Chromium.
 */
export async function launchFirefoxWithStorageStateObject(
  state: StorageStateShape,
  label: string,
): Promise<BrowserSession | null> {
  try {
    const browser = await firefox.launch({
      headless: config.browser.headless,
      firefoxUserPrefs: {
        // A submit form needs no images, and the free instance has 512MB total:
        // keep one content process and no caches, or the service is OOM-killed
        // mid-submission.
        'permissions.default.image': 2,
        'browser.cache.memory.capacity': 0,
        'browser.sessionhistory.max_entries': 2,
        'network.prefetch-next': false,
        'browser.newtabpage.enabled': false,
        'toolkit.telemetry.enabled': false,
        'datareporting.policy.dataSubmissionEnabled': false,
      },
    });
    const context = await browser.newContext({
      storageState: {
        cookies: state.cookies,
        origins: state.origins,
      },
      viewport: { width: 1366, height: 900 },
      locale: 'en-US',
    });
    const browserLogs: string[] = [];
    const page = await openPageWithCapture(context, browserLogs);
    logger.info({ label }, 'launched Firefox context from account storageState');
    return {
      context,
      page,
      mode: 'storage-state',
      browserLogs,
      close: async () => {
        await context.close();
        await browser.close();
      },
    };
  } catch (err) {
    logger.error(
      { label, err: err instanceof Error ? err.message : String(err) },
      'failed to launch Firefox context from account storageState',
    );
    return null;
  }
}

/**
 * Locates a usable storageState file:
 *   1. the configured path, if it exists (paid tier: persistent disk)
 *   2. otherwise hydrate from Postgres into a temp file (free tier)
 */
async function resolveStorageStatePath(): Promise<string | null> {
  const configured = config.browser.storageStatePath;
  if (fs.existsSync(configured)) return configured;

  try {
    const fromDb = await loadStorageStateFromDb();
    if (!fromDb) return null;
    const tmp = path.join(os.tmpdir(), 'storage-state.json');
    fs.writeFileSync(tmp, fromDb);
    logger.info('storageState hydrated from database (ephemeral filesystem)');
    return tmp;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'failed to hydrate storageState from database',
    );
    return null;
  }
}

/**
 * Persist a fresh storageState snapshot from an authenticated persistent
 * session. Keeps the JSON fallback in sync with the live profile so a
 * profile corruption does not strand the worker.
 */
export async function backupStorageState(context: BrowserContext): Promise<void> {
  try {
    // In-memory snapshot first — always works, even on a read-only or
    // ephemeral filesystem. The DB copy is the durable artifact on Render's
    // free tier; the file copy additionally lands on the persistent disk
    // when one exists (paid tier / docker-compose).
    const state = await context.storageState();
    const json = JSON.stringify(state);

    try {
      const target = config.browser.storageStatePath;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, json);
      logger.info({ target }, 'storageState file backup refreshed');
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'storageState file backup failed (ephemeral filesystem?) — database copy still saved',
      );
    }

    await saveStorageStateToDb(json);
    logger.info('storageState backup persisted to database');
  } catch (err) {
    // Non-fatal: the profile itself remains the primary credential store.
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'storageState backup failed');
  }
}