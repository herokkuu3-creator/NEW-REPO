const CAPZY_API_KEYS_KEY = 'capzyApiKeys';
const CAPZY_ACTIVE_KEY_INDEX_KEY = 'capzyActiveKeyIndex';

async function safeGetSystemState(key: string): Promise<string | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    const { getSystemState } = await import('../database/models');
    return await getSystemState(key);
  } catch {
    return null;
  }
}

async function safeSetSystemState(key: string, value: string): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    const { setSystemState } = await import('../database/models');
    await setSystemState(key, value);
  } catch {}
}

function logInfo(fields: Record<string, unknown>, msg: string): void {
  const entry = { level: 30, time: new Date().toISOString(), service: 'capzy-key-manager', ...fields, msg };
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

function logWarn(fields: Record<string, unknown>, msg: string): void {
  const entry = { level: 40, time: new Date().toISOString(), service: 'capzy-key-manager', ...fields, msg };
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

export interface KeyBalanceResult {
  key: string;
  masked: string;
  ok: boolean;
  balance: number;
  errorId: number;
  error?: string;
}

let inMemoryKeys: string[] = [];
let inMemoryActiveIndex = 0;

export function maskApiKey(key: string): string {
  const trimmed = (key || '').trim();
  if (!trimmed) return '(empty)';
  if (trimmed.length <= 12) return trimmed.slice(0, 4) + '...' + trimmed.slice(-2);
  return trimmed.slice(0, 8) + '...' + trimmed.slice(-4);
}

export function parseCapzyApiKeys(raw: string | string[]): string[] {
  const parts = Array.isArray(raw)
    ? raw
    : String(raw ?? '')
        .split(/[,\n\r\t]+/)
        .map((s) => s.trim());

  const cleaned: string[] = [];
  const seen = new Set<string>();

  for (let part of parts) {
    part = part.trim().replace(/^["'`<([\])>]+|["'`<([\])>]+$/g, '');
    if (!part) continue;
    // Discard placeholder values
    if (/^(none|null|undefined|test|fixture)$/i.test(part)) continue;
    if (!seen.has(part)) {
      seen.add(part);
      cleaned.push(part);
    }
  }

  return cleaned;
}

export function isLikelyCapzyKey(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith('/') || trimmed.startsWith('{') || trimmed.startsWith('[')) return false;
  return /capzy_[a-f0-9]{30,}/i.test(trimmed) || /^(capzy_[a-f0-9]+[,\s]*)+$/i.test(trimmed);
}

export function isCapzyKeyError(
  errorId?: number,
  errorCode?: string | null,
  errorDescription?: string | null,
): boolean {
  if (errorId === 0 && !errorCode && !errorDescription) return false;
  const code = (errorCode || '').toUpperCase();
  const desc = (errorDescription || '').toLowerCase();
  return (
    code.includes('KEY_DOES_NOT_EXIST') ||
    code.includes('WRONG_USER_KEY') ||
    code.includes('ZERO_BALANCE') ||
    code.includes('CREDIT') ||
    code.includes('BALANCE') ||
    code.includes('PAYMENT') ||
    code.includes('UNAUTHORIZED') ||
    code.includes('FORBIDDEN') ||
    desc.includes('invalid api key') ||
    desc.includes('balance') ||
    desc.includes('credit') ||
    desc.includes('expired') ||
    desc.includes('funds') ||
    desc.includes('insufficient') ||
    desc.includes('unauthorized') ||
    desc.includes('does not exist') ||
    desc.includes('no credit')
  );
}

export async function checkCapzyKeyBalance(clientKey: string): Promise<KeyBalanceResult> {
  const masked = maskApiKey(clientKey);
  try {
    const res = await fetch('https://api.capzy.ai/getBalance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey }),
      signal: AbortSignal.timeout(6_000),
    });

    if (!res.ok) {
      return {
        key: clientKey,
        masked,
        ok: false,
        balance: 0,
        errorId: res.status,
        error: `HTTP ${res.status}`,
      };
    }

    const data = (await res.json()) as { errorId?: number; balance?: number; errorDescription?: string };
    const errorId = data.errorId ?? 0;
    const balance = typeof data.balance === 'number' ? data.balance : 0;

    if (errorId !== 0) {
      return {
        key: clientKey,
        masked,
        ok: false,
        balance,
        errorId,
        error: data.errorDescription || `Error ${errorId}`,
      };
    }

    if (balance <= 0) {
      return {
        key: clientKey,
        masked,
        ok: false,
        balance,
        errorId: 0,
        error: 'Zero balance (no credits)',
      };
    }

    return {
      key: clientKey,
      masked,
      ok: true,
      balance,
      errorId: 0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      key: clientKey,
      masked,
      ok: false,
      balance: 0,
      errorId: -1,
      error: msg,
    };
  }
}

export async function getCapzyApiKeys(): Promise<string[]> {
  if (inMemoryKeys.length > 0) return inMemoryKeys;

  if (!process.env.VITEST && process.env.NODE_ENV !== 'test') {
    try {
      const rawDb = await safeGetSystemState(CAPZY_API_KEYS_KEY);
      if (rawDb) {
        try {
          const parsed = JSON.parse(rawDb);
          if (Array.isArray(parsed) && parsed.length > 0) {
            inMemoryKeys = parseCapzyApiKeys(parsed);
            return inMemoryKeys;
          }
        } catch {
          const fromDelim = parseCapzyApiKeys(rawDb);
          if (fromDelim.length > 0) {
            inMemoryKeys = fromDelim;
            return inMemoryKeys;
          }
        }
      }
    } catch {
      // DB not available in isolated context
    }
  }

  const envRaw =
    process.env.CAPZY_API_KEYS ||
    process.env.CAPZY_API_KEY ||
    process.env.CAPSOLVER_API_KEYS ||
    process.env.CAPSOLVER_API_KEY ||
    '';

  const envKeys = parseCapzyApiKeys(envRaw);
  if (envKeys.length > 0) {
    inMemoryKeys = envKeys;
    return inMemoryKeys;
  }

  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    return ['test-capzy-key'];
  }

  return [];
}

export function initCapzyKeys(keys: string[], activeIndex = 0): void {
  const parsed = parseCapzyApiKeys(keys);
  if (parsed.length > 0) {
    inMemoryKeys = parsed;
    inMemoryActiveIndex = Math.max(0, Math.min(activeIndex, parsed.length - 1));
  }
}

export async function setActiveCapzyKeyIndex(index: number): Promise<void> {
  inMemoryActiveIndex = Math.max(0, index);
  if (!process.env.VITEST && process.env.NODE_ENV !== 'test') {
    try {
      await safeSetSystemState(CAPZY_ACTIVE_KEY_INDEX_KEY, String(inMemoryActiveIndex));
    } catch {}
  }
}

export async function getActiveCapzyKeyIndex(): Promise<number> {
  if (!process.env.VITEST && process.env.NODE_ENV !== 'test') {
    try {
      const raw = await safeGetSystemState(CAPZY_ACTIVE_KEY_INDEX_KEY);
      if (raw !== null && raw !== undefined) {
        const idx = parseInt(raw, 10);
        if (!isNaN(idx) && idx >= 0) {
          inMemoryActiveIndex = idx;
          return idx;
        }
      }
    } catch {}
  }
  return inMemoryActiveIndex;
}

export async function saveCapzyApiKeys(
  rawInput: string | string[],
): Promise<{ ok: boolean; keys: string[]; balances: KeyBalanceResult[]; error?: string }> {
  const keys = parseCapzyApiKeys(rawInput);
  if (keys.length === 0) {
    return { ok: false, keys: [], balances: [], error: 'No valid Capzy / CapSolver API keys detected in input.' };
  }

  const balances: KeyBalanceResult[] = [];
  for (const k of keys) {
    balances.push(await checkCapzyKeyBalance(k));
  }

  // Set the first funded key as the active index, or 0 if none funded
  const firstFundedIdx = balances.findIndex((b) => b.ok && b.balance > 0);
  const activeIdx = firstFundedIdx >= 0 ? firstFundedIdx : 0;

  inMemoryKeys = keys;
  inMemoryActiveIndex = activeIdx;

  if (!process.env.VITEST && process.env.NODE_ENV !== 'test') {
    try {
      await safeSetSystemState(CAPZY_API_KEYS_KEY, JSON.stringify(keys));
      await safeSetSystemState(CAPZY_ACTIVE_KEY_INDEX_KEY, String(activeIdx));
    } catch (err) {
      logWarn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to persist Capzy keys to database');
    }
  }

  logInfo(
    { count: keys.length, activeIdx, activeKey: maskApiKey(keys[activeIdx] ?? '') },
    'Saved Capzy API keys and updated active index',
  );

  return { ok: true, keys, balances };
}

export async function addCapzyApiKeys(
  rawInput: string | string[],
): Promise<{
  ok: boolean;
  totalKeys: string[];
  addedKeys: string[];
  alreadyPresentKeys: string[];
  balances: KeyBalanceResult[];
  error?: string;
}> {
  const newKeys = parseCapzyApiKeys(rawInput);
  if (newKeys.length === 0) {
    return {
      ok: false,
      totalKeys: [],
      addedKeys: [],
      alreadyPresentKeys: [],
      balances: [],
      error: 'No valid Capzy / CapSolver API keys detected in input.',
    };
  }

  const existingKeys = await getCapzyApiKeys();
  const existingSet = new Set(existingKeys);

  const addedKeys: string[] = [];
  const alreadyPresentKeys: string[] = [];

  for (const k of newKeys) {
    if (existingSet.has(k)) {
      alreadyPresentKeys.push(k);
    } else {
      addedKeys.push(k);
      existingSet.add(k); // avoid internal duplicates in input
    }
  }

  if (addedKeys.length === 0) {
    const balances: KeyBalanceResult[] = [];
    for (const k of existingKeys) {
      balances.push(await checkCapzyKeyBalance(k));
    }
    return {
      ok: true,
      totalKeys: existingKeys,
      addedKeys: [],
      alreadyPresentKeys,
      balances,
    };
  }

  const mergedKeys = [...existingKeys, ...addedKeys];
  const balances: KeyBalanceResult[] = [];
  for (const k of mergedKeys) {
    balances.push(await checkCapzyKeyBalance(k));
  }

  // Preserve active key index if current active key is valid; otherwise choose the first funded key
  const currentActiveIdx = await getActiveCapzyKeyIndex();
  let targetActiveIdx = currentActiveIdx;
  if (
    currentActiveIdx < 0 ||
    currentActiveIdx >= mergedKeys.length ||
    !balances[currentActiveIdx]?.ok ||
    (balances[currentActiveIdx]?.balance ?? 0) <= 0
  ) {
    const firstFundedIdx = balances.findIndex((b) => b.ok && b.balance > 0);
    targetActiveIdx = firstFundedIdx >= 0 ? firstFundedIdx : 0;
  }

  inMemoryKeys = mergedKeys;
  inMemoryActiveIndex = targetActiveIdx;

  if (!process.env.VITEST && process.env.NODE_ENV !== 'test') {
    try {
      await safeSetSystemState(CAPZY_API_KEYS_KEY, JSON.stringify(mergedKeys));
      await safeSetSystemState(CAPZY_ACTIVE_KEY_INDEX_KEY, String(targetActiveIdx));
    } catch (err) {
      logWarn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to persist appended Capzy keys to database');
    }
  }

  logInfo(
    {
      total: mergedKeys.length,
      added: addedKeys.length,
      alreadyPresent: alreadyPresentKeys.length,
      activeIdx: targetActiveIdx,
    },
    'Appended new Capzy API keys to database pool',
  );

  return {
    ok: true,
    totalKeys: mergedKeys,
    addedKeys,
    alreadyPresentKeys,
    balances,
  };
}

export async function rotateToNextCapzyKey(
  failedKey?: string,
  reason?: string,
  availableKeys?: string[],
): Promise<{ newKey: string | null; newIndex: number; total: number }> {
  const keys = availableKeys && availableKeys.length > 0 ? availableKeys : await getCapzyApiKeys();
  const currentIndex = await getActiveCapzyKeyIndex();

  let nextIndex = currentIndex + 1;
  if (failedKey) {
    const failedIdx = keys.indexOf(failedKey);
    if (failedIdx >= 0 && failedIdx >= currentIndex) {
      nextIndex = failedIdx + 1;
    }
  }

  inMemoryActiveIndex = nextIndex;
  if (!process.env.VITEST && process.env.NODE_ENV !== 'test') {
    try {
      await safeSetSystemState(CAPZY_ACTIVE_KEY_INDEX_KEY, String(nextIndex));
    } catch {}
  }

  const newKey = nextIndex < keys.length ? keys[nextIndex] : null;

  logWarn(
    {
      failedKey: failedKey ? maskApiKey(failedKey) : undefined,
      reason,
      oldIndex: currentIndex,
      newIndex: nextIndex,
      newKey: newKey ? maskApiKey(newKey) : null,
      total: keys.length,
    },
    newKey
      ? `Rotated Capzy API key to next candidate (${nextIndex + 1} of ${keys.length})`
      : 'All configured Capzy API keys have been exhausted',
  );

  return { newKey: newKey ?? null, newIndex: nextIndex, total: keys.length };
}

export async function getCandidateCapzyKeys(overrideKeys?: string[]): Promise<string[]> {
  const keys = overrideKeys && overrideKeys.length > 0 ? overrideKeys : await getCapzyApiKeys();
  if (keys.length === 0) return [];
  const activeIdx = await getActiveCapzyKeyIndex();
  // Return keys starting from activeIdx, followed by preceding keys as fallback if needed
  const primary = keys.slice(activeIdx);
  return primary.length > 0 ? primary : keys;
}
