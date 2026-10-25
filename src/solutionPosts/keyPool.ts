import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config';
import { getSystemState, setSystemState } from '../database/models';
import { DEFAULT_SOLUTION_POST_BASE_URL, DEFAULT_SOLUTION_POST_MODEL, isBazaarLinkProvider,
  solutionPostProviderHeaders } from '../config/solutionPostProvider';
import { validateSolutionPostModels } from '../config/solutionPostModels';
import { parseSolutionApiKeys, ArticleKeyInput } from '../config/solutionPostKeys';
export { parseSolutionApiKeys } from '../config/solutionPostKeys';

const STATE_KEY = 'solution-post-api-key-pool:v1';
const VERSION = 'v1';
const MAX_KEYS = 100;

export interface SolutionKeyPool {
  keys: string[];
  activeIndex: number;
  /** Calendar month in which this active position was chosen (Asia/Kolkata by default). */
  activePeriod?: string;
  lastFailure?: string;
  environmentFingerprint?: string;
  /** Prevents credentials for one provider being reused after the configured endpoint changes. */
  providerFingerprint?: string;
  stored: boolean;
}

export interface SolutionKeyPoolStatus {
  total: number;
  active: number | null;
  keys: Array<{ position: number; masked: string; active: boolean }>;
  source: 'database' | 'environment' | 'empty';
  lastFailure?: string;
}

const keyMaterial = (): Buffer => createHash('sha256')
  .update(`solution-post-key-pool:${VERSION}\0${config.api.setupToken}`)
  .digest();

function seal(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyMaterial(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join(':');
}

function open(value: string): string {
  const [version, iv, tag, encrypted, ...extra] = value.split(':');
  if (version !== VERSION || !iv || !tag || !encrypted || extra.length) throw new Error('Invalid encrypted API key pool');
  const decipher = createDecipheriv('aes-256-gcm', keyMaterial(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
}

export function maskSolutionApiKey(key: string): string {
  return key.length <= 12 ? `${key.slice(0, 3)}…${key.slice(-2)}` : `${key.slice(0, 7)}…${key.slice(-4)}`;
}

function normalise(pool: Partial<SolutionKeyPool>, stored: boolean): SolutionKeyPool {
  const keys = parseSolutionApiKeys(pool.keys ?? []);
  return {
    keys,
    activeIndex: Math.min(Math.max(0, Number.isInteger(pool.activeIndex) ? pool.activeIndex! : 0), keys.length),
    activePeriod: /^\d{4}-\d{2}$/.test(pool.activePeriod ?? '') ? pool.activePeriod : undefined,
    lastFailure: pool.lastFailure && /^(?:HTTP_\d+(?:_BILLING_REQUIRED)?|KEY_EXHAUSTED)$/.test(pool.lastFailure) ? pool.lastFailure : undefined,
    environmentFingerprint: pool.environmentFingerprint,
    providerFingerprint: /^[a-f0-9]{64}$/.test(pool.providerFingerprint ?? '') ? pool.providerFingerprint : undefined,
    stored,
  };
}

function providerFingerprint(): string {
  return createHash('sha256').update(config.solutionPosts.baseUrl.replace(/\/+$/, '').toLowerCase()).digest('hex');
}

function isDefaultCodeCraftProvider(): boolean {
  return config.solutionPosts.baseUrl.replace(/\/+$/, '').toLowerCase() === 'https://codecraftapi.com/v1';
}

function environmentArticleKeys(): string[] {
  return parseSolutionApiKeys(config.solutionPosts.apiKeys);
}

/** A spent monthly allowance remains skipped until this period changes. */
export function solutionKeyPeriod(now = new Date()): string {
  const timezone = config.schedule?.timezone || 'Asia/Kolkata';
  const fields = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit' })
    .formatToParts(now);
  const value = (name: string) => fields.find(field => field.type === name)?.value;
  return `${value('year')}-${value('month')}`;
}

export async function loadSolutionKeyPool(now = new Date()): Promise<SolutionKeyPool> {
  const saved = await getSystemState(STATE_KEY);
  const bazaarLink = isBazaarLinkProvider(config.solutionPosts.baseUrl);
  const environmentKeys = environmentArticleKeys();
  const environmentFingerprint = createHash('sha256').update(JSON.stringify(environmentKeys)).digest('hex');
  const configuredProvider = providerFingerprint();
  if (saved) {
    try {
      let pool = normalise(JSON.parse(open(saved)), true);
      // A key valid for CodeCraft must never be sent to a newly selected provider.
      // Legacy entries predate providerFingerprint and are treated as CodeCraft only.
      const providerChanged = pool.providerFingerprint
        ? pool.providerFingerprint !== configuredProvider
        : !isDefaultCodeCraftProvider();
      if (providerChanged) {
        // Older installations could save a BazaarLink key while CodeCraft was
        // still the default. Carry only recognizable BazaarLink credentials.
        const keys = [...new Set([...environmentKeys, ...(bazaarLink ? pool.keys.filter(key => key.startsWith('sk-bl-')) : [])])];
        return persist({ keys, activeIndex: 0, activePeriod: solutionKeyPeriod(now),
          environmentFingerprint, providerFingerprint: configuredProvider, stored: true });
      }
      // Newly configured bootstrap keys must not be hidden by an older DB pool.
      // Preserve every existing slot and its exhaustion pointer.
      if (pool.environmentFingerprint !== environmentFingerprint) {
        const additions = environmentKeys.filter(key => !pool.keys.includes(key));
        pool = await persist({ ...pool, keys: [...pool.keys, ...additions], environmentFingerprint,
          providerFingerprint: configuredProvider });
      }
      // Older versions retired a valid BazaarLink key on free-tier 429 and
      // skipped it until next month. Restore the most recently retired slot
      // once, preserving earlier authentication/billing retirements.
      if (bazaarLink && ['KEY_EXHAUSTED', 'HTTP_429'].includes(pool.lastFailure ?? '') && pool.activeIndex > 0) {
        pool = await persist({ ...pool, activeIndex: pool.activeIndex - 1, lastFailure: undefined });
      }
      const period = solutionKeyPeriod(now);
      // A previous month's exhausted quota must not permanently strand the
      // earlier keys. Reset only at a calendar-month boundary, never during
      // ordinary retries or short-lived rate limits.
      if (pool.activePeriod !== period) {
        return persist({ ...pool, activeIndex: 0, activePeriod: period, lastFailure: undefined, stored: true });
      }
      return pool;
    } catch {
      // Do not silently fall back to a possibly different environment pool if saved secrets cannot be decrypted.
      throw new Error('SOLUTION_KEY_POOL_UNREADABLE');
    }
  }
  return normalise({ keys: environmentKeys, activeIndex: 0, environmentFingerprint, providerFingerprint: configuredProvider }, false);
}

async function persist(pool: SolutionKeyPool): Promise<SolutionKeyPool> {
  const valid = normalise(pool, true);
  const activePeriod = valid.activePeriod ?? solutionKeyPeriod();
  const environmentFingerprint = valid.environmentFingerprint ?? createHash('sha256')
    .update(JSON.stringify(environmentArticleKeys())).digest('hex');
  const currentProviderFingerprint = valid.providerFingerprint ?? providerFingerprint();
  await setSystemState(STATE_KEY, seal(JSON.stringify({ keys: valid.keys, activeIndex: valid.activeIndex, activePeriod,
    lastFailure: valid.lastFailure, environmentFingerprint, providerFingerprint: currentProviderFingerprint })));
  valid.activePeriod = activePeriod;
  valid.environmentFingerprint = environmentFingerprint;
  valid.providerFingerprint = currentProviderFingerprint;
  return valid;
}

export async function appendSolutionApiKeys(raw: string | string[]): Promise<{
  pool: SolutionKeyPool; added: number; duplicates: number;
}> {
  const additions = parseSolutionApiKeys(raw);
  if (!additions.length) throw new Error('NO_API_KEYS');
  const existing = await loadSolutionKeyPool();
  const set = new Set(existing.keys);
  const newKeys = additions.filter(key => !set.has(key));
  const merged = [...existing.keys, ...newKeys];
  if (merged.length > MAX_KEYS) throw new Error(`At most ${MAX_KEYS} API keys may be stored`);
  const pool = await persist({ ...existing, keys: merged, stored: true });
  return { pool, added: newKeys.length, duplicates: additions.length - newKeys.length };
}

/** Explicit operator action: discard stale/exhausted slots and start a fresh pool at key one. */
export async function replaceSolutionApiKeys(raw: string | string[]): Promise<SolutionKeyPool> {
  const keys = parseSolutionApiKeys(raw);
  if (!keys.length) throw new Error('NO_API_KEYS');
  return persist({ keys, activeIndex: 0, activePeriod: solutionKeyPeriod(), stored: true });
}

/** Explicit operator action: reset active index to 0 on the existing pool. */
export async function resetSolutionApiKeyPool(): Promise<SolutionKeyPool> {
  const current = await loadSolutionKeyPool();
  if (!current.keys.length) throw new Error('NO_API_KEYS');
  return persist({ keys: current.keys, activeIndex: 0, activePeriod: solutionKeyPeriod(), stored: true });
}

/** Advance only after an explicit key quota/credential failure. No round-robin on ordinary rate limits. */
export async function rotateSolutionApiKey(failedKey: string, reason = 'KEY_EXHAUSTED'): Promise<SolutionKeyPool> {
  const current = await loadSolutionKeyPool();
  const position = current.keys.indexOf(failedKey);
  if (position < 0) return current;
  return persist({ keys: current.keys, activeIndex: Math.max(current.activeIndex, position + 1), activePeriod: current.activePeriod, lastFailure: reason, stored: true });
}

export async function solutionKeyPoolStatus(): Promise<SolutionKeyPoolStatus> {
  const pool = await loadSolutionKeyPool();
  return {
    total: pool.keys.length,
    active: pool.activeIndex < pool.keys.length ? pool.activeIndex + 1 : null,
    keys: pool.keys.map((key, index) => ({ position: index + 1, masked: maskSolutionApiKey(key), active: index === pool.activeIndex })),
    source: pool.keys.length ? (pool.stored ? 'database' : 'environment') : 'empty',
    lastFailure: pool.lastFailure,
  };
}

export interface KeyTestResult {
  ok: boolean;
  keyMasked: string;
  modelsStatus: number;
  modelsCount: number;
  chatStatus?: number;
  chatError?: string;
  chatType?: string;
  chatCode?: string;
  chatModel?: string;
  error?: string;
  executionHost?: string;
  failureCategory?: string;
  providerRequestId?: string;
  keySource?: string;
  keyEnvironment?: ArticleKeyInput[];
}

export async function testSolutionApiKey(candidateKey?: string, model?: string): Promise<KeyTestResult> {
  let key: string | undefined;
  try {
    const candidates = candidateKey ? parseSolutionApiKeys(candidateKey) : [];
    if (candidates.length > 1) throw new Error('ONE_KEY_REQUIRED');
    key = candidates[0];
  } catch { return { ok: false, keyMasked: 'none', modelsStatus: 0, modelsCount: 0, error: 'AI_KEY_INPUT_INVALID' }; }
  if (!key) {
    const pool = await loadSolutionKeyPool();
    const active = pool.keys.slice(Math.max(0, pool.activeIndex));
    key = active[0] ?? pool.keys.at(-1);
  }
  if (!key) {
    return { ok: false, keyMasked: 'none', modelsStatus: 0, modelsCount: 0,
      error: config.solutionPosts.keyError ?? 'NO_KEY_CONFIGURED',
      keySource: config.solutionPosts.keySource, keyEnvironment: config.solutionPosts.keyEnvironment };
  }
  const masked = maskSolutionApiKey(key);
  const testModel = model ?? config.solutionPosts.models?.[0] ?? DEFAULT_SOLUTION_POST_MODEL;
  const executionHost = process.env.RENDER_INSTANCE_ID ? 'render' : 'local';
  let allowed = false;
  try { allowed = validateSolutionPostModels(testModel).length === 1; } catch { /* invalid model */ }
  if (!allowed) {
    return { ok: false, keyMasked: masked, modelsStatus: 0, modelsCount: 0, error: 'MODEL_NOT_ALLOWED', executionHost };
  }
  const redact = (value: string) => value.split(key!).join('[REDACTED]')
    .replace(/(?:(?:cc|gsk)_|sk-bl-)[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 300);
  try {
    const baseUrl = config.solutionPosts.baseUrl || DEFAULT_SOLUTION_POST_BASE_URL;
    const modelsUrl = new URL('models', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    const modelsRes = await fetch(modelsUrl.href, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', ...solutionPostProviderHeaders(baseUrl) },
      signal: AbortSignal.timeout(20000),
    });
    // Discovery and inference have separate scopes. Even a 403 here does not
    // prove the key cannot generate a completion.
    const modelsData = await modelsRes.json().catch(() => ({})) as { data?: Array<{ id: string }> };
    const modelsCount = Array.isArray(modelsData.data) ? modelsData.data.length : 0;

    const chatUrl = new URL('chat/completions', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    const chatRes = await fetch(chatUrl.href, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', ...solutionPostProviderHeaders(baseUrl) },
      body: JSON.stringify({
        model: testModel,
        messages: [{ role: 'user', content: 'Reply with only OK.' }],
        max_tokens: 64,
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!chatRes.ok) {
      const chatBody = await chatRes.text().catch(() => '');
      let parsedMsg = chatBody;
      let parsedType: string | undefined;
      let parsedCode: string | undefined;
      try {
        const p = JSON.parse(chatBody) as { error?: { message?: string; type?: string; code?: string } };
        if (p.error?.message) parsedMsg = p.error.message;
        if (p.error?.type) parsedType = p.error.type;
        if (p.error?.code) parsedCode = p.error.code;
      } catch {}
      return {
        ok: false,
        keyMasked: masked,
        modelsStatus: modelsRes.status,
        modelsCount,
        chatStatus: chatRes.status,
        chatError: chatRes.status === 403 && chatRes.headers.get('content-type')?.includes('text/html') ?
          'The AI provider returned an HTML access challenge to this server; authenticated API access must be allowed by the provider.' : redact(parsedMsg),
        chatType: parsedType ? redact(parsedType) : undefined,
        chatCode: parsedCode ? redact(parsedCode) : undefined,
        chatModel: testModel,
        executionHost,
        providerRequestId: chatRes.headers.get('cf-ray') ?? undefined,
        failureCategory: chatRes.status === 402 ? 'PROVIDER_BILLING_REQUIRED' : chatRes.status === 401 ? 'INVALID_API_KEY' :
          chatRes.status === 403 ? (chatRes.headers.get('content-type')?.includes('text/html') ? 'PROVIDER_ACCESS_BLOCKED' : 'PROVIDER_PERMISSION_DENIED') :
          chatRes.status === 429 ? 'PROVIDER_RATE_OR_QUOTA_LIMIT' : 'PROVIDER_ERROR',
      };
    }
    const completion = await chatRes.json() as { choices?: Array<{ message?: { content?: string } }> };
    const valid = !!completion.choices?.[0]?.message?.content?.trim();
    return {
      ok: valid,
      keyMasked: masked,
      modelsStatus: modelsRes.status,
      modelsCount,
      chatStatus: chatRes.status,
      chatModel: testModel,
      executionHost,
      ...(valid ? {} : { failureCategory: 'INVALID_COMPLETION', chatError: 'Provider returned no text' }),
    };
  } catch (err) {
    return { ok: false, keyMasked: masked, modelsStatus: 0, modelsCount: 0, executionHost,
      failureCategory: err instanceof Error && /Timeout|Abort/.test(err.name) ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK_ERROR',
      error: 'Provider request did not complete' };
  }
}

