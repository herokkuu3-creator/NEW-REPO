import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AccountStatus } from '@prisma/client';
import { ingestCookiePayload, type IngestResult, type Validator } from '../accounts/ingest';
import { checkSession } from '../browser/sessionCheck';
import { listAccounts } from '../database/accounts';
import { logger } from '../logger';
import { sendTelegramMessage } from '../notifications/telegram';
import { hasRecoveryService, getRecoveryService } from '../recovery/runtime';
import { saveEncryptedCredentials } from '../security/credentialStore';
import { clearLeetCodeLoginCooldown, openLightweightLeetCodeSession } from './sessionManager';

export const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ACTIVE_PAIRING_SESSIONS = 32;

export type LeetCodePairingStatus = 'pending' | 'completing' | 'completed' | 'expired' | 'cancelled';

export interface LeetCodePairingSession {
  token: string;
  label?: string;
  identifier?: string;
  password?: string;
  createdAt: number;
  expiresAt: number;
  status: LeetCodePairingStatus;
  completedAt?: number;
  verifiedUsername?: string | null;
  localVerifiedUsername?: string | null;
  accountStatus?: AccountStatus;
}

export interface CreateLeetCodePairingOptions {
  label?: string;
  identifier?: string;
  password?: string;
  ttlMs?: number;
  baseUrl?: string;
}

export interface CreatedLeetCodePairingSession extends LeetCodePairingSession {
  pairingUrl: string;
  companionCommand: string;
  expiresInMinutes: number;
}

export interface CompleteLeetCodePairingPayload {
  storageState?: unknown;
  cookies?: unknown;
  localVerifiedUsername?: string | null;
}

export interface CompleteLeetCodePairingDeps {
  validator?: Validator;
  notifyTelegram?: (html: string) => Promise<boolean | void>;
  onVerifiedSuccess?: (info: { label: string; username: string | null }) => void | Promise<void>;
}

export type CompleteLeetCodePairingResult =
  | {
      ok: true;
      httpStatus: 200;
      label: string;
      username: string | null;
      localVerifiedUsername: string | null;
      accountStatus: AccountStatus;
      serverVerified: boolean;
      localVsServerMismatch: boolean;
      cookieCount: number;
      detail: string;
      telegramMessage: string;
    }
  | {
      ok: false;
      httpStatus: 400 | 404 | 409 | 410 | 422;
      code:
        | 'INVALID_TOKEN'
        | 'TOKEN_EXPIRED'
        | 'TOKEN_ALREADY_USED'
        | 'TOKEN_CANCELLED'
        | 'INVALID_PAYLOAD'
        | 'SERVER_VERIFICATION_FAILED';
      error: string;
      label?: string;
      username?: string | null;
      localVerifiedUsername?: string | null;
      accountStatus?: AccountStatus;
      serverVerified?: boolean;
      localVsServerMismatch?: boolean;
      telegramMessage?: string;
    };

const pairingSessions = new Map<string, LeetCodePairingSession>();

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function resolvePublicBaseUrl(override?: string): string {
  const raw =
    override ||
    process.env.PUBLIC_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    'https://leetcode-daily-agent-ascq.onrender.com';
  return raw.trim().replace(/\/+$/, '');
}

function pruneStaleSessions(now = Date.now()): void {
  for (const [token, session] of pairingSessions.entries()) {
    if (session.status === 'pending' && now >= session.expiresAt) {
      session.status = 'expired';
    }
    if (now - session.createdAt > 60 * 60 * 1000) {
      pairingSessions.delete(token);
    }
  }
  while (pairingSessions.size > MAX_ACTIVE_PAIRING_SESSIONS) {
    const oldestKey = pairingSessions.keys().next().value;
    if (!oldestKey) break;
    pairingSessions.delete(oldestKey);
  }
}

function findSessionConstantTime(candidateToken: string): LeetCodePairingSession | null {
  const trimmed = candidateToken.trim();
  if (!trimmed || trimmed.length < 16 || trimmed.length > 128) return null;
  const candidateBuf = Buffer.from(trimmed, 'utf8');
  let matched: LeetCodePairingSession | null = null;
  for (const [storedToken, session] of pairingSessions.entries()) {
    const storedBuf = Buffer.from(storedToken, 'utf8');
    if (storedBuf.length === candidateBuf.length && timingSafeEqual(storedBuf, candidateBuf)) {
      matched = session;
    }
  }
  return matched;
}

export function createLeetCodePairingSession(
  opts: CreateLeetCodePairingOptions = {},
): CreatedLeetCodePairingSession {
  const now = Date.now();
  pruneStaleSessions(now);

  // Cancel any older pending session for the same target label so only the newest link is active.
  if (opts.label) {
    for (const existing of pairingSessions.values()) {
      if (existing.status === 'pending' && existing.label === opts.label) {
        existing.status = 'cancelled';
        existing.password = undefined;
      }
    }
  }

  const token = randomBytes(32).toString('base64url');
  const ttlMs = Math.max(60_000, opts.ttlMs ?? DEFAULT_PAIRING_TTL_MS);
  const session: LeetCodePairingSession = {
    token,
    label: opts.label,
    identifier: opts.identifier,
    password: opts.password,
    createdAt: now,
    expiresAt: now + ttlMs,
    status: 'pending',
  };

  pairingSessions.set(token, session);

  const baseUrl = resolvePublicBaseUrl(opts.baseUrl);
  const pairingUrl = `${baseUrl}/auth/leetcode/${token}`;
  const companionCommand = `npm run auth:login -- "${pairingUrl}"`;

  return {
    ...session,
    pairingUrl,
    companionCommand,
    expiresInMinutes: Math.max(1, Math.round(ttlMs / 60_000)),
  };
}

export function getLeetCodePairingSession(token: string, now = Date.now()): LeetCodePairingSession | null {
  pruneStaleSessions(now);
  const session = findSessionConstantTime(token);
  if (!session) return null;
  if (session.status === 'pending' && now >= session.expiresAt) {
    session.status = 'expired';
    session.password = undefined;
  }
  return session;
}

export function getLatestPendingLeetCodePairingSession(now = Date.now()): CreatedLeetCodePairingSession | null {
  pruneStaleSessions(now);
  let latest: LeetCodePairingSession | null = null;
  for (const session of pairingSessions.values()) {
    if (session.status === 'pending' && now < session.expiresAt) {
      if (!latest || session.createdAt >= latest.createdAt) {
        latest = session;
      }
    }
  }
  if (!latest) return null;
  const baseUrl = resolvePublicBaseUrl();
  const pairingUrl = `${baseUrl}/auth/leetcode/${latest.token}`;
  return {
    ...latest,
    pairingUrl,
    companionCommand: `npm run auth:login -- "${pairingUrl}"`,
    expiresInMinutes: Math.max(1, Math.ceil((latest.expiresAt - now) / 60_000)),
  };
}

export function cancelAllLeetCodePairingSessions(): number {
  let cancelled = 0;
  for (const session of pairingSessions.values()) {
    if (session.status === 'pending') {
      session.status = 'cancelled';
      session.password = undefined;
      cancelled += 1;
    }
  }
  return cancelled;
}

export function clearLeetCodePairingSessionsForTests(): void {
  pairingSessions.clear();
}

export function formatTelegramPairingPrompt(
  session: CreatedLeetCodePairingSession,
  opts: { reason?: 'command' | 'verification_required'; diagnosticError?: string } = {},
): string {
  const labelDisplay = session.label || session.identifier || 'auto-detect from LeetCode';
  const lines: string[] = [];

  if (opts.reason === 'verification_required') {
    lines.push('🔐 <b>Connect your LeetCode account (Browser Verification Required)</b>');
    if (opts.diagnosticError) {
      lines.push(`<i>${escapeHtml(opts.diagnosticError)}</i>`);
    }
    lines.push('');
    lines.push(
      'Cloudflare blocked headless server login from Render. Complete the sign-in in your browser using the secure single-use pairing link below — <b>no manual cookie copying into Telegram is required</b>:',
    );
  } else {
    lines.push('🔐 <b>Connect your LeetCode account</b>');
    lines.push('');
  }

  lines.push(`• Target account label: <code>${escapeHtml(labelDisplay)}</code>`);
  lines.push(`• Link expires in: <b>${session.expiresInMinutes} minutes</b> (single-use)`);
  lines.push('');
  lines.push(`🌐 <b>1. Open Secure Connection Portal:</b>`);
  lines.push(`<a href="${escapeHtml(session.pairingUrl)}">${escapeHtml(session.pairingUrl)}</a>`);
  lines.push('');
  lines.push(`💻 <b>2. Or run the Automated Local Browser Companion (Zero Cookie Copy):</b>`);
  lines.push(`<code>${escapeHtml(session.companionCommand)}</code>`);
  lines.push(
    '<i>Opens a real Chromium window on your machine, lets you sign in and pass Cloudflare normally, verifies your LeetCode identity, and automatically pushes the authenticated session to this bot.</i>',
  );

  if (opts.reason !== 'verification_required') {
    lines.push('');
    lines.push(
      '🔑 <b>Direct Server Login Fallback:</b> You can also reply here with your LeetCode <b>username or email address</b> (or send <code>/cancel</code> to abort).',
    );
  } else {
    lines.push('');
    lines.push('<i>Send <code>/cancel</code> anytime to revoke this pairing link.</i>');
  }

  return lines.join('\n');
}

function extractRawCookiePayload(payload: CompleteLeetCodePairingPayload | string | unknown): string | null {
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!payload || typeof payload !== 'object') return null;

  const obj = payload as Record<string, unknown>;
  if (obj.storageState !== undefined) {
    return typeof obj.storageState === 'string'
      ? obj.storageState.trim()
      : JSON.stringify(obj.storageState);
  }
  if (obj.cookies !== undefined && !Array.isArray(obj.origins)) {
    return typeof obj.cookies === 'string'
      ? obj.cookies.trim()
      : JSON.stringify(obj.cookies);
  }
  if (Array.isArray(obj.cookies)) {
    return JSON.stringify(obj);
  }
  return null;
}

export async function completeLeetCodePairingSession(
  token: string,
  payload: CompleteLeetCodePairingPayload | string | unknown,
  deps: CompleteLeetCodePairingDeps = {},
): Promise<CompleteLeetCodePairingResult> {
  const now = Date.now();
  const session = getLeetCodePairingSession(token, now);

  if (!session) {
    return {
      ok: false,
      httpStatus: 404,
      code: 'INVALID_TOKEN',
      error: 'Invalid or unknown authentication link. Run /lclogin in Telegram to generate a new link.',
    };
  }

  if (session.status === 'completed' || session.status === 'completing') {
    return {
      ok: false,
      httpStatus: 409,
      code: 'TOKEN_ALREADY_USED',
      error: 'This authentication link has already been used. Run /lclogin in Telegram for a fresh single-use link.',
    };
  }

  if (session.status === 'cancelled') {
    return {
      ok: false,
      httpStatus: 410,
      code: 'TOKEN_CANCELLED',
      error: 'This authentication link was cancelled. Run /lclogin in Telegram to start again.',
    };
  }

  if (session.status === 'expired' || now >= session.expiresAt) {
    session.status = 'expired';
    session.password = undefined;
    return {
      ok: false,
      httpStatus: 410,
      code: 'TOKEN_EXPIRED',
      error: 'This authentication link has expired. Run /lclogin in Telegram to generate a new link.',
    };
  }

  const rawCookiePayload = extractRawCookiePayload(payload);
  if (!rawCookiePayload) {
    return {
      ok: false,
      httpStatus: 400,
      code: 'INVALID_PAYLOAD',
      error: 'Missing session payload. Provide a Playwright storageState JSON or LeetCode cookie export.',
    };
  }

  const localVerifiedUsername =
    payload && typeof payload === 'object' && typeof (payload as CompleteLeetCodePairingPayload).localVerifiedUsername === 'string'
      ? (payload as CompleteLeetCodePairingPayload).localVerifiedUsername!.trim() || null
      : null;

  // Lock token against concurrent replay while server-side GraphQL verification runs.
  session.status = 'completing';

  const defaultLightweightValidator: Validator = async (state) => {
    const s = await openLightweightLeetCodeSession(state);
    try {
      const check = await checkSession(s.api);
      if (check.authenticated && check.username) {
        return { ok: true, username: check.username };
      }
      if (check.cause === 'query-failed') {
        return {
          ok: false,
          reason: 'blocked',
          error: 'the LeetCode check request failed (network or bot protection)',
        };
      }
      return {
        ok: false,
        reason: 'signed-out',
        error: 'LeetCode reported userStatus.isSignedIn = false',
      };
    } finally {
      await s.close().catch(() => undefined);
    }
  };

  let ingestResult: IngestResult;
  try {
    ingestResult = await ingestCookiePayload(rawCookiePayload, {
      label: session.label,
      validate: true,
      validator: deps.validator ?? defaultLightweightValidator,
    });
  } catch (err) {
    session.status = 'pending';
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, label: session.label }, 'Error during pairing session ingestion');
    return {
      ok: false,
      httpStatus: 422,
      code: 'SERVER_VERIFICATION_FAILED',
      error: `Session verification failed on server: ${msg}`,
    };
  }

  if (!ingestResult.ok) {
    // Allow user to retry submitting a valid export on the same link if they pasted malformed text.
    session.status = 'pending';
    return {
      ok: false,
      httpStatus: 400,
      code: 'INVALID_PAYLOAD',
      error: ingestResult.error,
    };
  }

  // Consume the single-use token now that a syntactically valid session was processed.
  session.status = 'completed';
  session.completedAt = Date.now();
  session.verifiedUsername = ingestResult.username;
  session.localVerifiedUsername = localVerifiedUsername;
  session.accountStatus = ingestResult.status;

  const pendingPassword = session.password;
  const pendingIdentifier = session.identifier;
  session.password = undefined;

  const notify =
    deps.notifyTelegram ??
    ((html: string) => sendTelegramMessage(html, { parseMode: 'HTML', disableWebPagePreview: true }));

  const totalAccounts = (await listAccounts().catch(() => [])).length;

  if (ingestResult.status === AccountStatus.ACTIVE) {
    const verifiedUsername = ingestResult.username || localVerifiedUsername || pendingIdentifier || ingestResult.label;
    await clearLeetCodeLoginCooldown(ingestResult.label).catch(() => undefined);
    if (hasRecoveryService()) {
      await getRecoveryService().cancelByLabel(ingestResult.label).catch(() => undefined);
    }
    let savedCreds = false;
    if (pendingPassword) {
      await saveEncryptedCredentials('leetcode', ingestResult.label, {
        username: verifiedUsername,
        password: pendingPassword,
        label: ingestResult.label,
      });
      savedCreds = true;
    }

    const telegramMessage = [
      '✅ <b>LeetCode login successful!</b>',
      '<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>',
      `• Authenticated username: <code>${escapeHtml(verifiedUsername)}</code>`,
      `• Account label: <code>${escapeHtml(ingestResult.label)}</code>`,
      `• Account status: <b>ACTIVE</b> (verified live on Render via LeetCode GraphQL <code>userStatus</code>)`,
      ...(localVerifiedUsername
        ? [`• Local companion check: <code>${escapeHtml(localVerifiedUsername)}</code> (matched server)`]
        : []),
      ...(savedCreds
        ? ['• Encrypted credentials saved (AES-256-GCM) for automated session refresh.']
        : []),
      `• Total LeetCode accounts stored: <b>${totalAccounts}</b>`,
      '',
      '<b>Available commands:</b>',
      '├ <code>/triggersubmission</code> — Submit today’s daily challenge now',
      '├ <code>/accounts</code> — View connected accounts &amp; status',
      '├ <code>/checksessions</code> — Run live health check on all sessions',
      '└ <code>/status</code> — View agent pulse &amp; latest run report',
    ].join('\n');

    await notify(telegramMessage).catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to send pairing success Telegram notification');
    });

    if (deps.onVerifiedSuccess) {
      await Promise.resolve(
        deps.onVerifiedSuccess({ label: ingestResult.label, username: verifiedUsername }),
      ).catch(() => undefined);
    }

    return {
      ok: true,
      httpStatus: 200,
      label: ingestResult.label,
      username: verifiedUsername,
      localVerifiedUsername,
      accountStatus: AccountStatus.ACTIVE,
      serverVerified: true,
      localVsServerMismatch: false,
      cookieCount: ingestResult.cookieCount,
      detail: ingestResult.detail,
      telegramMessage,
    };
  }

  // Session did NOT validate as ACTIVE on the server.
  // Explicitly detect if the session was verified locally in the companion browser but rejected/blocked on Render.
  const localVsServerMismatch = Boolean(localVerifiedUsername);
  const statusLabel =
    ingestResult.status === AccountStatus.REJECTED
      ? 'REJECTED (Server Session Rejected)'
      : ingestResult.status === AccountStatus.EXPIRED
        ? 'EXPIRED'
        : 'UNKNOWN (Unverified on Server)';

  const telegramLines = [
    localVsServerMismatch
      ? '⚠️ <b>LeetCode Session Verified Locally, Rejected on Server</b>'
      : '❌ <b>LeetCode Server Verification Failed</b>',
    '<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>',
    `• Account label: <code>${escapeHtml(ingestResult.label)}</code>`,
    ...(localVerifiedUsername
      ? [`• Local browser verification: ✅ <b>Signed in as <code>${escapeHtml(localVerifiedUsername)}</code></b>`]
      : []),
    `• Server verification (Render): ❌ <b>${escapeHtml(statusLabel)}</b>`,
    `• Reason: <i>${escapeHtml(ingestResult.detail)}</i>`,
    '',
    localVsServerMismatch
      ? '<b>Why this happened:</b> Your session is valid locally (<code>./local-auth/storage-state.json</code>), but LeetCode/Cloudflare rejected or blocked the transferred session when replayed from the Render server IP. The server account was <b>not</b> marked ACTIVE.'
      : 'The uploaded session could not be verified as signed-in on the server and was <b>not</b> marked ACTIVE.',
    '',
    '<b>Next steps:</b>',
    '├ Run locally with your verified local session: <code>npm run run:now</code>',
    '└ Or generate a fresh connection link in Telegram: <code>/lclogin</code>',
  ];
  const telegramMessage = telegramLines.join('\n');

  await notify(telegramMessage).catch((err) => {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to send pairing failure Telegram notification');
  });

  return {
    ok: false,
    httpStatus: 422,
    code: 'SERVER_VERIFICATION_FAILED',
    error: localVsServerMismatch
      ? `Session verified locally as "${localVerifiedUsername}", but server-side verification on Render returned ${ingestResult.status}: ${ingestResult.detail}`
      : `Server-side LeetCode verification returned ${ingestResult.status}: ${ingestResult.detail}`,
    label: ingestResult.label,
    username: ingestResult.username ?? localVerifiedUsername,
    localVerifiedUsername,
    accountStatus: ingestResult.status,
    serverVerified: false,
    localVsServerMismatch,
    telegramMessage,
  };
}

export function renderLeetCodePairingPortalHtml(
  session: CreatedLeetCodePairingSession | null,
  stateReason?: 'invalid' | 'expired' | 'used' | 'cancelled',
): string {
  if (!session || stateReason) {
    const title =
      stateReason === 'used'
        ? 'Authentication Link Already Used'
        : stateReason === 'expired'
          ? 'Authentication Link Expired'
          : stateReason === 'cancelled'
            ? 'Authentication Link Cancelled'
            : 'Invalid Authentication Link';
    const desc =
      stateReason === 'used'
        ? 'This single-use LeetCode pairing link has already been consumed.'
        : stateReason === 'expired'
          ? 'This pairing link has expired (links are valid for 10 minutes).'
          : stateReason === 'cancelled'
            ? 'This pairing link was cancelled from Telegram.'
            : 'This pairing link was not found or is no longer active.';
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} — LeetCode Daily Agent</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 16px; }
    .card { max-width: 520px; width: 100%; background: #1e293b; border: 1px solid #334155; border-radius: 14px; padding: 28px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); }
    h1 { font-size: 1.35rem; margin: 0 0 12px; color: #f87171; }
    p { color: #cbd5e1; line-height: 1.55; margin: 0 0 16px; }
    code { background: #0f172a; padding: 3px 8px; border-radius: 6px; color: #38bdf8; }
  </style>
</head>
<body>
  <div class="card">
    <h1>⚠️ ${escapeHtml(title)}</h1>
    <p>${escapeHtml(desc)}</p>
    <p>Send <code>/lclogin</code> in your Telegram bot to generate a fresh connection link.</p>
  </div>
</body>
</html>`;
  }

  const labelText = session.label || session.identifier || 'Auto-detect from LeetCode';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connect Your LeetCode Account — LeetCode Daily Agent</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 24px 16px; display: flex; justify-content: center; }
    .container { max-width: 680px; width: 100%; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 14px; padding: 26px; margin-bottom: 20px; box-shadow: 0 15px 25px -5px rgba(0,0,0,0.45); }
    h1 { font-size: 1.45rem; margin: 0 0 8px; color: #38bdf8; }
    h2 { font-size: 1.08rem; margin: 0 0 10px; color: #e2e8f0; }
    p { color: #cbd5e1; line-height: 1.55; margin: 0 0 14px; font-size: 0.95rem; }
    .meta { display: flex; gap: 12px; flex-wrap: wrap; margin: 14px 0 6px; }
    .badge { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 6px 12px; font-size: 0.85rem; color: #94a3b8; }
    .badge strong { color: #f8fafc; }
    pre { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 12px 14px; overflow-x: auto; color: #4ade80; font-size: 0.88rem; margin: 8px 0 12px; }
    textarea { width: 100%; min-height: 130px; background: #0f172a; border: 1px solid #475569; border-radius: 8px; color: #f8fafc; padding: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; margin-bottom: 12px; }
    .btn { display: inline-block; background: #0284c7; color: #fff; font-weight: 600; border: none; border-radius: 8px; padding: 10px 18px; cursor: pointer; text-decoration: none; font-size: 0.92rem; }
    .btn:hover { background: #0369a1; }
    .btn-secondary { background: #334155; }
    .btn-secondary:hover { background: #475569; }
    .status-box { display: none; margin-top: 14px; padding: 14px; border-radius: 8px; font-size: 0.92rem; line-height: 1.5; }
    .status-ok { display: block; background: rgba(34, 197, 94, 0.15); border: 1px solid #22c55e; color: #bbf7d0; }
    .status-err { display: block; background: rgba(239, 68, 68, 0.15); border: 1px solid #ef4444; color: #fecaca; }
    input[type="file"] { margin-bottom: 12px; color: #cbd5e1; font-size: 0.88rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>🔐 Connect Your LeetCode Account</h1>
      <p>Complete your LeetCode sign-in and Cloudflare verification in your own browser. Your session will be verified live against LeetCode's GraphQL API and linked to your Telegram bot automatically.</p>
      <div class="meta">
        <div class="badge">Target Label: <strong>${escapeHtml(labelText)}</strong></div>
        <div class="badge">Valid For: <strong>${session.expiresInMinutes} min (Single-Use)</strong></div>
      </div>
    </div>

    <div class="card">
      <h2>Option 1 (Recommended — Zero Manual Cookie Copy): Local Browser Companion</h2>
      <p>Run this single command in your project terminal. It launches a real Chromium window, waits for you to sign in to <a href="https://leetcode.com/accounts/login/" target="_blank" rel="noopener" style="color:#38bdf8">leetcode.com/accounts/login/</a>, verifies your identity locally, and uploads the session to this link automatically:</p>
      <pre id="cmdText">${escapeHtml(session.companionCommand)}</pre>
      <button type="button" class="btn btn-secondary" onclick="navigator.clipboard.writeText(document.getElementById('cmdText').innerText)">📋 Copy Companion Command</button>
    </div>

    <div class="card">
      <h2>Option 2: Direct HTTPS Session Upload (No Telegram Chat Paste)</h2>
      <p>Already signed in to LeetCode in your browser? Upload your <code>storage-state.json</code> / Cookie-Editor JSON file or paste it directly over HTTPS below (never sent through Telegram chat history):</p>
      <form id="uploadForm">
        <input type="file" id="sessionFile" accept=".json,.txt" />
        <textarea id="sessionInput" placeholder="Paste Playwright storageState JSON, Cookie-Editor JSON array, or LEETCODE_SESSION=...; csrftoken=..."></textarea>
        <button type="submit" class="btn" id="submitBtn">🔗 Verify &amp; Connect Account</button>
      </form>
      <div id="statusBox" class="status-box"></div>
    </div>
  </div>

  <script>
    const fileInput = document.getElementById('sessionFile');
    const sessionInput = document.getElementById('sessionInput');
    const uploadForm = document.getElementById('uploadForm');
    const statusBox = document.getElementById('statusBox');
    const submitBtn = document.getElementById('submitBtn');

    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      sessionInput.value = await file.text();
    });

    uploadForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const raw = sessionInput.value.trim();
      if (!raw) {
        statusBox.className = 'status-box status-err';
        statusBox.textContent = 'Please select a session file or paste your session JSON first.';
        return;
      }
      submitBtn.disabled = true;
      submitBtn.textContent = 'Verifying with LeetCode...';
      statusBox.className = 'status-box';
      statusBox.style.display = 'none';

      try {
        const res = await fetch(window.location.pathname, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cookies: raw }),
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          statusBox.className = 'status-box status-ok';
          statusBox.textContent = '✅ Connected as ' + (data.username || data.label) + ' (Status: ' + data.accountStatus + '). Check Telegram for confirmation!';
        } else {
          statusBox.className = 'status-box status-err';
          statusBox.textContent = '❌ ' + (data.error || 'Verification failed.');
        }
      } catch (err) {
        statusBox.className = 'status-box status-err';
        statusBox.textContent = '❌ Network error while submitting session.';
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '🔗 Verify & Connect Account';
      }
    });
  </script>
</body>
</html>`;
}
