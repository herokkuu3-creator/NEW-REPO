import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config';
import { getSystemState, setSystemState } from '../database/models';

const STATE_KEY = 'solution-post-api-key-pool:v1';
const VERSION = 'v1';
const MAX_KEYS = 100;

export interface SolutionKeyPool {
  keys: string[];
  activeIndex: number;
  /** Calendar month in which this active position was chosen (Asia/Kolkata by default). */
  activePeriod?: string;
  stored: boolean;
}

export interface SolutionKeyPoolStatus {
  total: number;
  active: number | null;
  keys: Array<{ position: number; masked: string; active: boolean }>;
  source: 'database' | 'environment' | 'empty';
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

export function parseSolutionApiKeys(input: string | string[]): string[] {
  const pieces = (Array.isArray(input) ? input : input.split(/[,\n\r\t]+/)).map(value => value.trim()
    .replace(/^["'`<[(\{]+|["'`>\])}\s]+$/g, ''));
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const value of pieces) {
    if (!value || /^(?:none|null|undefined|test|fixture)$/i.test(value)) continue;
    if (value.length < 8 || value.length > 512 || /\s/.test(value)) throw new Error('Each API key must be 8–512 non-whitespace characters');
    if (!seen.has(value)) { seen.add(value); keys.push(value); }
  }
  if (keys.length > MAX_KEYS) throw new Error(`At most ${MAX_KEYS} API keys may be stored`);
  return keys;
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
    stored,
  };
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
  if (saved) {
    try {
      const pool = normalise(JSON.parse(open(saved)), true);
      const period = solutionKeyPeriod(now);
      // A previous month's exhausted quota must not permanently strand the
      // earlier keys. Reset only at a calendar-month boundary, never during
      // ordinary retries or short-lived rate limits.
      if (pool.activePeriod !== period) {
        return persist({ ...pool, activeIndex: 0, activePeriod: period, stored: true });
      }
      return pool;
    } catch {
      // Do not silently fall back to a possibly different environment pool if saved secrets cannot be decrypted.
      throw new Error('SOLUTION_KEY_POOL_UNREADABLE');
    }
  }
  return normalise({ keys: config.solutionPosts.apiKeys, activeIndex: 0 }, false);
}

async function persist(pool: SolutionKeyPool): Promise<SolutionKeyPool> {
  const valid = normalise(pool, true);
  const activePeriod = valid.activePeriod ?? solutionKeyPeriod();
  await setSystemState(STATE_KEY, seal(JSON.stringify({ keys: valid.keys, activeIndex: valid.activeIndex, activePeriod })));
  valid.activePeriod = activePeriod;
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
  const pool = await persist({ keys: merged, activeIndex: existing.activeIndex, activePeriod: existing.activePeriod, stored: true });
  return { pool, added: newKeys.length, duplicates: additions.length - newKeys.length };
}

/** Explicit operator action: discard stale/exhausted slots and start a fresh pool at key one. */
export async function replaceSolutionApiKeys(raw: string | string[]): Promise<SolutionKeyPool> {
  const keys = parseSolutionApiKeys(raw);
  if (!keys.length) throw new Error('NO_API_KEYS');
  return persist({ keys, activeIndex: 0, activePeriod: solutionKeyPeriod(), stored: true });
}

/** Advance only after an explicit key quota/credential failure. No round-robin on ordinary rate limits. */
export async function rotateSolutionApiKey(failedKey: string): Promise<SolutionKeyPool> {
  const current = await loadSolutionKeyPool();
  const position = current.keys.indexOf(failedKey);
  if (position < 0) return current;
  return persist({ keys: current.keys, activeIndex: Math.max(current.activeIndex, position + 1), activePeriod: current.activePeriod, stored: true });
}

export async function solutionKeyPoolStatus(): Promise<SolutionKeyPoolStatus> {
  const pool = await loadSolutionKeyPool();
  return {
    total: pool.keys.length,
    active: pool.activeIndex < pool.keys.length ? pool.activeIndex + 1 : null,
    keys: pool.keys.map((key, index) => ({ position: index + 1, masked: maskSolutionApiKey(key), active: index === pool.activeIndex })),
    source: pool.keys.length ? (pool.stored ? 'database' : 'environment') : 'empty',
  };
}
