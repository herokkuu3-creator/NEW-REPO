import { createHash, randomBytes } from 'node:crypto';
import { AccountStatus } from '@prisma/client';
import { logger } from '../logger';
import type { StorageStateShape } from '../browser/cookiePayload';
import { driveLeetCodeLogin, type DriverPhase } from './loginDriver';
import type { RemoteBrowser, RemoteInput } from './remoteBrowser';
import {
  IN_SESSION_STATUSES,
  RecoveryCommitError,
  RecoveryRecord,
  RecoveryStatus,
  RecoveryStore,
} from './types';

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** 256 bits of CSPRNG output, URL-safe (43 chars). */
export function generateRecoveryToken(): string {
  return randomBytes(32).toString('base64url');
}
/** Only this hash is ever persisted. */
export function hashRecoveryToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const isWellFormedToken = (t: string): boolean => TOKEN_RE.test(t);

// ---------------------------------------------------------------------------
// Configuration & dependencies
// ---------------------------------------------------------------------------

export interface RecoveryLimits {
  reminderIntervalMs: number;
  tokenTtlMs: number;
  sessionTimeoutMs: number;
  maxConcurrency: number;
  pollMs: number;
  finalStatusRetentionMs: number;
}

export function loadRecoveryLimits(env: NodeJS.ProcessEnv = process.env): RecoveryLimits {
  const num = (key: string, fallback: number, min: number): number => {
    const parsed = Number(env[key]);
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
  };
  return {
    reminderIntervalMs: num('RECOVERY_REMINDER_INTERVAL_MS', 60 * 60_000, 1000),
    tokenTtlMs: num('RECOVERY_TOKEN_TTL_MS', 45 * 60_000, 1000),
    sessionTimeoutMs: num('RECOVERY_SESSION_TIMEOUT_MS', 10 * 60_000, 1000),
    // Render's free instance has 512 MB: one live Chromium at a time by default.
    maxConcurrency: Math.floor(num('RECOVERY_MAX_CONCURRENCY', 1, 1)),
    pollMs: num('RECOVERY_POLL_MS', 400, 10),
    finalStatusRetentionMs: num('RECOVERY_FINAL_RETENTION_MS', 2 * 60_000, 0),
  };
}

export interface RecoveryAccount {
  id: string;
  label: string;
  username: string | null;
  status: AccountStatus;
  storageState: string;
}

export interface RecoveryCredentials {
  username: string;
  password: string;
}

export interface LiveVerification {
  authenticated: boolean;
  username?: string | null;
  cause?: 'valid' | 'signed-out' | 'query-failed' | 'invalid-storage-state' | 'token-expired';
  error?: string;
}

export interface TelegramMarkup {
  inline_keyboard: { text: string; url: string }[][];
}

export interface RecoveryDeps {
  store: RecoveryStore;
  now(): Date;
  chatId(): string;
  /** Public HTTPS origin of this service, no trailing slash. */
  baseUrl(): string;
  listAccounts(): Promise<RecoveryAccount[]>;
  getAccount(id: string): Promise<RecoveryAccount | null>;
  markAccount(id: string, status: AccountStatus, lastError: string | null): Promise<void>;
  /** Live GraphQL userStatus check of the STORED session (never opens a login page). */
  verifyStoredSession(account: RecoveryAccount): Promise<LiveVerification>;
  /** Live GraphQL userStatus check of a freshly captured storageState (server API transport). */
  verifyCapturedSession(state: StorageStateShape): Promise<{ authenticated: boolean; username?: string | null }>;
  getCredentials(account: RecoveryAccount): Promise<RecoveryCredentials | null>;
  openBrowser(): Promise<RemoteBrowser>;
  sendTelegram(text: string, markup?: TelegramMarkup): Promise<boolean>;
  onRecovered?(account: RecoveryAccount): Promise<void> | void;
  limits: RecoveryLimits;
}

// ---------------------------------------------------------------------------
// Presentation helpers (never include secrets)
// ---------------------------------------------------------------------------

const esc = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Failures a fresh link cannot fix: the stored credentials/identity need attention. */
export const NON_RETRYABLE_CATEGORIES = new Set([
  'NO_CREDENTIALS',
  'LOGIN_REJECTED',
  'USERNAME_MISMATCH',
  'WRONG_ACCOUNT',
  'NO_EXPECTED_USERNAME',
]);

const CATEGORY_TEXT: Record<string, string> = {
  VERIFICATION_TIMEOUT: 'Verification was not completed in time',
  VERIFICATION_REJECTED: 'LeetCode asked for verification again after sign-in',
  LOGIN_REJECTED: 'LeetCode rejected the stored credentials',
  USERNAME_MISMATCH: 'The signed-in username did not match this account',
  WRONG_ACCOUNT: 'The stored credentials belong to a different stored account',
  NO_EXPECTED_USERNAME: 'This account has no known username to verify against',
  NO_CREDENTIALS: 'No encrypted credentials are stored for this account',
  SERVER_VERIFICATION_FAILED: 'The new session failed server-side verification',
  DATABASE_ERROR: 'The new session could not be saved (database error); the old session was left untouched',
  BROWSER_CRASHED: 'The recovery browser crashed',
  BROWSER_LAUNCH_FAILED: 'The recovery browser could not be started on the server',
  BROWSER_CLOSED: 'The recovery browser closed unexpectedly',
  NAVIGATION_FAILED: 'The server could not open the LeetCode login page',
  FORM_FILL_FAILED: 'The login form could not be filled',
  SUBMIT_FAILED: 'The login button could not be clicked',
  RATE_LIMITED: 'LeetCode rate limited the sign-in',
  SERVICE_ERROR: 'LeetCode sign-in returned a server error',
  SESSION_LOST: 'The server restarted during recovery',
  SERVER_RESTART: 'The server restarted during recovery',
  INTERNAL_ERROR: 'Unexpected internal error',
};
export const describeCategory = (c: string): string => CATEGORY_TEXT[c] ?? c;

export type PortalPhase =
  | 'starting'
  | 'awaiting_verification'
  | 'filling'
  | 'submitting'
  | 'verifying'
  | 'success'
  | 'failed'
  | 'cancelled';

const PHASE_TEXT: Record<PortalPhase, string> = {
  starting: 'Starting a secure browser…',
  awaiting_verification: 'Complete the verification shown below. Sign-in continues automatically afterwards.',
  filling: 'Verification passed — the server is entering your saved credentials…',
  submitting: 'Signing in…',
  verifying: 'Verifying your LeetCode identity…',
  success: 'Session restored. You can close this page.',
  failed: 'Recovery did not complete. A summary was sent to Telegram.',
  cancelled: 'Recovery cancelled.',
};

interface PortalSession {
  recoveryId: string;
  accountId: string;
  label: string;
  secretHash: string;
  phase: PortalPhase;
  message: string;
  username?: string;
  browser: RemoteBrowser | null;
  abort: AbortController;
  stopReason: 'cancelled' | 'crash' | null;
  finished: boolean;
  done: Promise<void>;
}

export type OpenResult =
  | { ok: true; secret: string; label: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'used' | 'cancelled' | 'busy' | 'unavailable'; message?: string };

export interface MonitorSummary {
  checked: number;
  active: string[];
  transient: string[];
  opened: string[];
  alreadyOpen: string[];
  resolved: string[];
  errors: string[];
}

const secretHash = (s: string): string => createHash('sha256').update(`portal:${s}`).digest('hex');
const lower = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

export function expectedUsername(account: RecoveryAccount, creds: RecoveryCredentials): string | null {
  if (account.username) return account.username;
  if (creds.username && !creds.username.includes('@')) return creds.username;
  return null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class RecoveryService {
  private readonly sessions = new Map<string, PortalSession>(); // by secretHash
  private readonly byRecovery = new Map<string, PortalSession>();
  private readonly lockedAccounts = new Set<string>();
  private tickRunning = false;

  constructor(private readonly deps: RecoveryDeps) {}

  get activeSessionCount(): number {
    return [...this.byRecovery.values()].filter((s) => !s.finished).length;
  }

  // -- creating recoveries ---------------------------------------------------

  /** Opens (or returns) the single recovery for an account. The next tick sends the notice. */
  async openRecovery(
    account: RecoveryAccount,
    reason: 'EXPIRED' | 'REJECTED',
  ): Promise<{ recovery: RecoveryRecord; created: boolean }> {
    const now = this.deps.now();
    return this.deps.store.create({
      accountId: account.id,
      reason,
      telegramChatId: this.deps.chatId(),
      now,
      nextReminderAt: now,
    });
  }

  // -- daily monitoring -------------------------------------------------------

  /**
   * Verifies every stored account through GraphQL userStatus. Only a definitive
   * signed-out / expired answer opens a recovery; network or Cloudflare errors
   * (`query-failed`) are transient and never change an account.
   */
  async monitorAccounts(): Promise<MonitorSummary> {
    const summary: MonitorSummary = { checked: 0, active: [], transient: [], opened: [], alreadyOpen: [], resolved: [], errors: [] };
    const accounts = await this.deps.listAccounts();
    for (const account of accounts) {
      if (account.status === AccountStatus.DISABLED) continue;
      summary.checked += 1;
      try {
        const open = await this.deps.store.findOpenByAccount(account.id);
        if (open && IN_SESSION_STATUSES.includes(open.status)) {
          summary.alreadyOpen.push(account.label);
          continue; // a human is recovering this account right now
        }
        const live = await this.deps.verifyStoredSession(account);
        if (live.authenticated) {
          summary.active.push(account.label);
          if (open) {
            await this.deps.store.cancel(open.id, 'EXTERNALLY_RESOLVED');
            summary.resolved.push(account.label);
          }
          continue;
        }
        if (live.cause === 'query-failed' || !live.cause) {
          summary.transient.push(account.label);
          continue;
        }
        const reason = live.cause === 'signed-out' ? 'REJECTED' : 'EXPIRED';
        await this.deps.markAccount(
          account.id,
          reason === 'EXPIRED' ? AccountStatus.EXPIRED : AccountStatus.REJECTED,
          live.error ?? 'session expired',
        );
        const { created } = await this.openRecovery(account, reason);
        (created ? summary.opened : summary.alreadyOpen).push(account.label);
      } catch (err) {
        // One account's failure must never stop the others.
        summary.errors.push(account.label);
        logger.warn({ label: account.label, err: err instanceof Error ? err.message : String(err) }, 'recovery monitor: account check failed');
      }
    }
    if (summary.opened.length > 0) await this.tick();
    logger.info(
      { checked: summary.checked, active: summary.active.length, transient: summary.transient.length, opened: summary.opened.length },
      'recovery monitor finished',
    );
    return summary;
  }

  // -- reminders ---------------------------------------------------------------

  /** Called every minute. Idempotent and restart-safe: claims advance nextReminderAt first. */
  async tick(): Promise<{ notified: number }> {
    if (this.tickRunning) return { notified: 0 };
    this.tickRunning = true;
    try {
      await this.reapOrphans();
      const due = await this.deps.store.claimDueReminders(this.deps.now(), this.deps.limits.reminderIntervalMs, 25);
      if (due.length === 0) return { notified: 0 };
      return { notified: await this.notify(due) };
    } finally {
      this.tickRunning = false;
    }
  }

  /** Recoveries stuck "in session" without a live browser (restart/crash) become retryable failures. */
  private async reapOrphans(): Promise<void> {
    const open = await this.deps.store.listOpen();
    for (const r of open) {
      if (IN_SESSION_STATUSES.includes(r.status) && !this.byRecovery.has(r.id)) {
        await this.deps.store.markFailed(r.id, 'SESSION_LOST', describeCategory('SESSION_LOST'), this.deps.now());
      }
    }
  }

  private linkFor(token: string): string {
    return `${this.deps.baseUrl().replace(/\/+$/, '')}/auth/recover/${token}`;
  }

  /** One consolidated Telegram message; one fresh one-time link per account. */
  private async notify(recoveries: RecoveryRecord[]): Promise<number> {
    const entries: { recovery: RecoveryRecord; account: RecoveryAccount; link: string | null }[] = [];
    for (const recovery of recoveries) {
      const account = await this.deps.getAccount(recovery.accountId);
      if (!account || account.status === AccountStatus.DISABLED) {
        await this.deps.store.cancel(recovery.id, 'ACCOUNT_UNAVAILABLE');
        continue;
      }
      if (account.status === AccountStatus.ACTIVE) {
        await this.deps.store.cancel(recovery.id, 'EXTERNALLY_RESOLVED');
        continue;
      }
      if (recovery.lastErrorCategory && NON_RETRYABLE_CATEGORIES.has(recovery.lastErrorCategory)) {
        entries.push({ recovery, account, link: null });
        continue;
      }
      const token = generateRecoveryToken();
      const issued = await this.deps.store.issueToken(
        recovery.id,
        hashRecoveryToken(token),
        new Date(this.deps.now().getTime() + this.deps.limits.tokenTtlMs),
      );
      if (!issued) continue; // became in-session/finished in the meantime
      entries.push({ recovery: issued, account, link: this.linkFor(token) });
    }
    if (entries.length === 0) return 0;

    const ttlMin = Math.round(this.deps.limits.tokenTtlMs / 60_000);
    const lines: string[] = [];
    const buttons: { text: string; url: string }[][] = [];
    if (entries.length === 1) {
      const { account, recovery, link } = entries[0]!;
      lines.push('🔴 <b>LeetCode Session Expired</b>', '', `Account: <code>${esc(account.label)}</code>`, 'Status: Verification required');
      if (recovery.lastErrorCategory) lines.push(`Last attempt: ${esc(describeCategory(recovery.lastErrorCategory))}`);
      lines.push('');
      if (link) {
        lines.push('Your account credentials are already securely saved.', '', 'Open the recovery link to complete verification and restore your session.');
        buttons.push([{ text: '🔗 Reconnect Account', url: link }]);
      } else {
        lines.push(`Action needed: ${esc(describeCategory(recovery.lastErrorCategory ?? ''))}. Re-save the account with <code>/lclogin ${esc(account.label)}</code>.`);
      }
    } else {
      lines.push(`🔴 <b>${entries.length} LeetCode Sessions Expired</b>`, '');
      for (const { account, recovery, link } of entries) {
        lines.push(`• <code>${esc(account.label)}</code> — ${link ? 'verification required' : esc(describeCategory(recovery.lastErrorCategory ?? 'attention needed'))}`);
        if (link) buttons.push([{ text: `🔗 Reconnect ${account.label}`.slice(0, 60), url: link }]);
      }
      lines.push('', 'Credentials are already securely saved. Open each link to complete verification for that account only.');
    }
    if (buttons.length > 0) lines.push('', `<i>Links are single-use and expire in ${ttlMin} minutes. A new one is sent hourly until recovered.</i>`);

    const https = this.deps.baseUrl().startsWith('https://');
    let sent = await this.deps.sendTelegram(lines.join('\n'), https && buttons.length > 0 ? { inline_keyboard: buttons } : undefined);
    if (!sent && https && buttons.length > 0) {
      // Fall back to plain-text links if Telegram rejected the inline keyboard.
      const plain = entries.filter((e) => e.link).map((e) => `${esc(e.account.label)}: ${e.link}`);
      sent = await this.deps.sendTelegram([...lines, '', ...plain].join('\n'));
    }
    if (!sent) {
      const retryAt = new Date(this.deps.now().getTime() + 5 * 60_000);
      for (const e of entries) await this.deps.store.rescheduleReminder(e.recovery.id, retryAt);
      return 0;
    }
    return entries.length;
  }

  // -- portal -----------------------------------------------------------------

  /** Read-only look at a link (never consumes it) so link-preview bots cannot burn tokens. */
  async inspectToken(token: string): Promise<{ state: 'valid' | 'invalid' | 'expired' | 'used' | 'cancelled'; label?: string }> {
    if (!isWellFormedToken(token)) return { state: 'invalid' };
    const row = await this.deps.store.findByTokenHash(hashRecoveryToken(token));
    if (!row) return { state: 'invalid' };
    if (row.status === RecoveryStatus.CANCELLED) return { state: 'cancelled' };
    if (row.tokenUsedAt) return { state: 'used' };
    if (!row.tokenExpiresAt || row.tokenExpiresAt <= this.deps.now()) return { state: 'expired' };
    const account = await this.deps.getAccount(row.accountId);
    return { state: 'valid', label: account?.label };
  }

  /** Consumes the one-time token and starts the isolated recovery browser session. */
  async openPortalSession(token: string): Promise<OpenResult> {
    if (!isWellFormedToken(token)) return { ok: false, reason: 'invalid' };
    if (this.activeSessionCount >= this.deps.limits.maxConcurrency) return { ok: false, reason: 'busy' };

    const consumed = await this.deps.store.consumeToken(hashRecoveryToken(token), this.deps.now());
    if (!consumed.ok) {
      const reason = consumed.reason === 'wrong_state' ? 'used' : consumed.reason;
      return { ok: false, reason };
    }
    const recovery = consumed.recovery;

    const abortEarly = async (category: string, message: string, reason: 'unavailable' | 'cancelled' = 'unavailable'): Promise<OpenResult> => {
      await this.failRecovery(recovery, null, category, message, { notify: true });
      return { ok: false, reason, message };
    };

    if (recovery.telegramChatId !== this.deps.chatId()) {
      await this.deps.store.cancel(recovery.id, 'CHAT_MISMATCH');
      return { ok: false, reason: 'invalid' };
    }
    const account = await this.deps.getAccount(recovery.accountId);
    if (!account || account.status === AccountStatus.DISABLED) {
      await this.deps.store.cancel(recovery.id, 'ACCOUNT_UNAVAILABLE');
      return { ok: false, reason: 'unavailable', message: 'This account is no longer available.' };
    }
    if (this.lockedAccounts.has(account.id)) {
      await this.deps.store.markFailed(recovery.id, 'SESSION_LOST', 'another recovery for this account is running', this.deps.now());
      return { ok: false, reason: 'busy' };
    }
    const creds = await this.deps.getCredentials(account);
    if (!creds) return abortEarly('NO_CREDENTIALS', describeCategory('NO_CREDENTIALS'));
    if (!expectedUsername(account, creds)) return abortEarly('NO_EXPECTED_USERNAME', describeCategory('NO_EXPECTED_USERNAME'));

    const secret = randomBytes(32).toString('base64url');
    const session: PortalSession = {
      recoveryId: recovery.id,
      accountId: account.id,
      label: account.label,
      secretHash: secretHash(secret),
      phase: 'starting',
      message: PHASE_TEXT.starting,
      browser: null,
      abort: new AbortController(),
      stopReason: null,
      finished: false,
      done: Promise.resolve(),
    };
    this.lockedAccounts.add(account.id);
    this.sessions.set(session.secretHash, session);
    this.byRecovery.set(recovery.id, session);
    session.done = this.runSession(session, recovery, account, creds).catch((err) => {
      logger.error({ label: account.label, err: err instanceof Error ? err.message : String(err) }, 'recovery session crashed');
    });
    return { ok: true, secret, label: account.label };
  }

  private setPhase(s: PortalSession, phase: PortalPhase, message?: string): void {
    s.phase = phase;
    s.message = message ?? PHASE_TEXT[phase];
  }

  private async runSession(
    s: PortalSession,
    recovery: RecoveryRecord,
    account: RecoveryAccount,
    creds: RecoveryCredentials,
  ): Promise<void> {
    const limits = this.deps.limits;
    const deadline = this.deps.now().getTime() + limits.sessionTimeoutMs;
    const hardStop = setTimeout(() => s.abort.abort(), limits.sessionTimeoutMs + 5000);
    try {
      try {
        s.browser = await this.deps.openBrowser();
      } catch {
        return void (await this.failRecovery(recovery, s, 'BROWSER_LAUNCH_FAILED', describeCategory('BROWSER_LAUNCH_FAILED'), { notify: true }));
      }
      s.browser.onDisconnected(() => {
        if (!s.finished) {
          s.stopReason = s.stopReason ?? 'crash';
          s.abort.abort();
        }
      });

      const result = await driveLeetCodeLogin(
        s.browser.page,
        { identifier: creds.username, password: creds.password },
        {
          deadline,
          signal: s.abort.signal,
          pollMs: limits.pollMs,
          onPhase: async (p: DriverPhase) => {
            this.setPhase(s, p);
            if (p === 'submitting') {
              await this.deps.store.setStatus(recovery.id, [RecoveryStatus.AWAITING_VERIFICATION], RecoveryStatus.VERIFYING);
            }
          },
        },
      );

      if (s.stopReason === 'cancelled') return void (await this.finishCancelled(s, recovery, account));
      if (!result.ok) {
        const category = s.stopReason === 'crash' ? 'BROWSER_CRASHED' : result.category;
        return void (await this.failRecovery(recovery, s, category, describeCategory(category), { notify: true }));
      }

      // ---- identity checks BEFORE anything is written --------------------------------
      const expected = expectedUsername(account, creds)!;
      if (lower(result.username) !== lower(expected)) {
        return void (await this.failRecovery(recovery, s, 'USERNAME_MISMATCH', describeCategory('USERNAME_MISMATCH'), { notify: true }));
      }
      const others = (await this.deps.listAccounts()).filter((a) => a.id !== account.id);
      if (others.some((a) => lower(a.username) === lower(result.username))) {
        return void (await this.failRecovery(recovery, s, 'WRONG_ACCOUNT', describeCategory('WRONG_ACCOUNT'), { notify: true }));
      }

      let state: StorageStateShape;
      try {
        state = await s.browser.captureStorageState();
      } catch {
        return void (await this.failRecovery(recovery, s, 'BROWSER_CRASHED', describeCategory('BROWSER_CRASHED'), { notify: true }));
      }
      const check = await this.deps.verifyCapturedSession(state).catch(() => ({ authenticated: false as const, username: null }));
      if (!check.authenticated || lower(check.username) !== lower(expected)) {
        return void (await this.failRecovery(recovery, s, 'SERVER_VERIFICATION_FAILED', describeCategory('SERVER_VERIFICATION_FAILED'), { notify: true }));
      }

      // ---- atomic replacement ---------------------------------------------------------
      try {
        await this.deps.store.commitRecovered({
          recoveryId: recovery.id,
          accountId: account.id,
          storageState: JSON.stringify(state),
          username: check.username!,
          now: this.deps.now(),
        });
      } catch (err) {
        if (err instanceof RecoveryCommitError && err.code === 'recovery_not_verifying') {
          return void (await this.finishCancelled(s, recovery, account)); // cancelled while verifying
        }
        const category = err instanceof RecoveryCommitError ? 'INTERNAL_ERROR' : 'DATABASE_ERROR';
        return void (await this.failRecovery(recovery, s, category, describeCategory(category), { notify: true }));
      }

      s.username = check.username!;
      this.setPhase(s, 'success');
      await this.deps.sendTelegram(
        [
          '✅ <b>LeetCode Session Restored</b>',
          '',
          `Account: <code>${esc(account.label)}</code>`,
          'Verification: Successful',
          'Session: ACTIVE',
          `Username: <code>${esc(check.username!)}</code>`,
          '',
          'Your automated LeetCode tasks can resume.',
        ].join('\n'),
      );
      logger.info({ label: account.label }, 'LeetCode session recovered');
      try {
        await this.deps.onRecovered?.(account);
      } catch {
        /* resuming automation is best-effort */
      }
    } catch (err) {
      logger.error({ label: account.label, err: err instanceof Error ? err.message : String(err) }, 'recovery session failed unexpectedly');
      await this.failRecovery(recovery, s, 'INTERNAL_ERROR', describeCategory('INTERNAL_ERROR'), { notify: true }).catch(() => undefined);
    } finally {
      clearTimeout(hardStop);
      s.finished = true;
      // Close the context — never click Logout (that would invalidate the stored session).
      await s.browser?.close().catch(() => undefined);
      s.browser = null;
      this.lockedAccounts.delete(s.accountId);
      const retention = this.deps.limits.finalStatusRetentionMs;
      setTimeout(() => {
        this.sessions.delete(s.secretHash);
        if (this.byRecovery.get(s.recoveryId) === s) this.byRecovery.delete(s.recoveryId);
      }, retention).unref?.();
    }
  }

  private async finishCancelled(s: PortalSession, recovery: RecoveryRecord, account: RecoveryAccount): Promise<void> {
    await this.deps.store.cancel(recovery.id, 'CANCELLED_BY_USER');
    this.setPhase(s, 'cancelled');
    await this.deps.sendTelegram(`🛑 <b>LeetCode Recovery Cancelled</b>\n\nAccount: <code>${esc(account.label)}</code>`);
  }

  /** Records the failure, tells the user the specific reason, and (when fixable) sends a retry link. */
  private async failRecovery(
    recovery: RecoveryRecord,
    s: PortalSession | null,
    category: string,
    message: string,
    opts: { notify: boolean },
  ): Promise<void> {
    const now = this.deps.now();
    const next = new Date(now.getTime() + this.deps.limits.reminderIntervalMs);
    await this.deps.store.markFailed(recovery.id, category, message, next).catch(() => undefined);
    if (s) this.setPhase(s, 'failed', `${PHASE_TEXT.failed} (${describeCategory(category)})`);
    logger.warn({ recoveryId: recovery.id, category }, 'LeetCode recovery failed');
    if (!opts.notify) return;

    const account = await this.deps.getAccount(recovery.accountId).catch(() => null);
    const label = account?.label ?? 'account';
    const lines = [
      '❌ <b>LeetCode Recovery Failed</b>',
      '',
      `Account: <code>${esc(label)}</code>`,
      `Error: <b>${esc(describeCategory(category))}</b> (<code>${esc(category)}</code>)`,
      'Your other accounts and their sessions were not touched.',
    ];
    let markup: TelegramMarkup | undefined;
    if (NON_RETRYABLE_CATEGORIES.has(category)) {
      lines.push('', `A new link would fail the same way. Re-save credentials with <code>/lclogin ${esc(label)}</code>.`);
    } else {
      const token = generateRecoveryToken();
      const issued = await this.deps.store
        .issueToken(recovery.id, hashRecoveryToken(token), new Date(now.getTime() + this.deps.limits.tokenTtlMs))
        .catch(() => null);
      if (issued) {
        lines.push('', 'You can retry with a fresh single-use link:');
        const url = this.linkFor(token);
        if (this.deps.baseUrl().startsWith('https://')) markup = { inline_keyboard: [[{ text: '🔁 Retry Recovery', url }]] };
        else lines.push(url);
      }
    }
    const sent = await this.deps.sendTelegram(lines.join('\n'), markup);
    if (!sent && markup) await this.deps.sendTelegram(lines.join('\n'));
  }

  // -- portal session accessors (cookie secret authenticates every call) ----------

  private sessionFor(secret: string | undefined): PortalSession | null {
    if (!secret || secret.length < 20) return null;
    return this.sessions.get(secretHash(secret)) ?? null;
  }

  portalStatus(secret: string | undefined) {
    const s = this.sessionFor(secret);
    if (!s) return null;
    return {
      phase: s.phase,
      message: s.message,
      label: s.label,
      username: s.phase === 'success' ? s.username : undefined,
      final: s.phase === 'success' || s.phase === 'failed' || s.phase === 'cancelled',
      viewport: s.browser?.viewport ?? { width: 1024, height: 720 },
    };
  }

  async portalFrame(secret: string | undefined): Promise<Buffer | null> {
    const s = this.sessionFor(secret);
    return s && !s.finished && s.browser ? s.browser.snapshot() : null;
  }

  async portalInput(secret: string | undefined, ev: RemoteInput): Promise<boolean> {
    const s = this.sessionFor(secret);
    if (!s || s.finished || !s.browser) return false;
    await s.browser.input(ev).catch(() => undefined);
    return true;
  }

  async portalCancel(secret: string | undefined): Promise<boolean> {
    const s = this.sessionFor(secret);
    if (!s || s.finished) return false;
    return this.cancelRecovery(s.recoveryId);
  }

  // -- explicit cancellation / operator commands ----------------------------------

  async cancelRecovery(recoveryId: string): Promise<boolean> {
    const live = this.byRecovery.get(recoveryId);
    if (live && !live.finished) {
      live.stopReason = 'cancelled';
      await this.deps.store.cancel(recoveryId, 'CANCELLED_BY_USER');
      live.abort.abort();
      await live.done;
      return true;
    }
    return (await this.deps.store.cancel(recoveryId, 'CANCELLED_BY_USER')) !== null;
  }

  async cancelByLabel(label: string): Promise<'cancelled' | 'none' | 'unknown_account'> {
    const accounts = await this.deps.listAccounts();
    const account = accounts.find((a) => lower(a.label) === lower(label) || lower(a.username) === lower(label));
    if (!account) return 'unknown_account';
    const open = await this.deps.store.findOpenByAccount(account.id);
    if (!open) return 'none';
    return (await this.cancelRecovery(open.id)) ? 'cancelled' : 'none';
  }

  /** Operator-forced recovery for one account: opens it and sends the link right away. */
  async requestRecovery(label: string): Promise<'sent' | 'unknown_account' | 'active' | 'in_progress'> {
    const accounts = await this.deps.listAccounts();
    const account = accounts.find((a) => lower(a.label) === lower(label) || lower(a.username) === lower(label));
    if (!account) return 'unknown_account';
    const { recovery } = await this.openRecovery(account, 'EXPIRED');
    if (IN_SESSION_STATUSES.includes(recovery.status)) return 'in_progress';
    await this.deps.store.rescheduleReminder(recovery.id, this.deps.now());
    await this.tick();
    return 'sent';
  }

  async describeOpen(): Promise<string[]> {
    const open = await this.deps.store.listOpen();
    const accounts = new Map((await this.deps.listAccounts()).map((a) => [a.id, a]));
    return open.map((r) => {
      const label = accounts.get(r.accountId)?.label ?? r.accountId;
      const next = r.nextReminderAt ? ` · next reminder ${r.nextReminderAt.toISOString()}` : '';
      const err = r.lastErrorCategory ? ` · last error ${r.lastErrorCategory}` : '';
      return `${label}: ${r.status} · attempts ${r.attemptCount}${err}${next}`;
    });
  }

  /** Test/shutdown helper: waits for every live session to finish cleanup. */
  async drain(): Promise<void> {
    await Promise.all([...this.byRecovery.values()].map((s) => s.done));
  }

  async shutdown(): Promise<void> {
    for (const s of this.byRecovery.values()) {
      if (!s.finished) {
        s.stopReason = s.stopReason ?? 'crash';
        s.abort.abort();
      }
    }
    await this.drain();
  }
}
