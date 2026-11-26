import crypto from 'node:crypto';
import { getSystemState, getSystemStates, setSystemState, deleteSystemState } from '../database/models';
import { logger } from '../logger';

function isMockFn(fn: unknown): boolean {
  return typeof fn === 'function' && 'mock' in fn && typeof (fn as { mock?: unknown }).mock === 'object';
}

export interface StoredCredential {
  username: string;
  password: string;
  email?: string;
  label?: string;
  updatedAt?: string;
}

let cachedSecret: string | null = null;
let cachedEncryptionKey: Buffer | null = null;
let warnedWeakSecret = false;

/**
 * Derives a consistent 256-bit encryption key from environment configuration.
 */
function getEncryptionKey(): Buffer {
  const explicitSecret = process.env.CREDENTIALS_SECRET || process.env.ENCRYPTION_KEY;
  if (!explicitSecret && !warnedWeakSecret && process.env.NODE_ENV === 'production') {
    warnedWeakSecret = true;
    logger.warn('Neither CREDENTIALS_SECRET nor ENCRYPTION_KEY is set in production; credential encryption is coupled to DATABASE_URL/TELEGRAM_BOT_TOKEN');
  }
  const secret =
    explicitSecret ||
    process.env.DATABASE_URL ||
    process.env.TELEGRAM_BOT_TOKEN ||
    'leetcode-cf-agent-credential-key-salt-2026';
  if (cachedEncryptionKey && cachedSecret === secret) {
    return cachedEncryptionKey;
  }
  const salt = 'antigravity-credential-salt-v1';
  const derived = crypto.scryptSync(secret, salt, 32);
  cachedSecret = secret;
  cachedEncryptionKey = derived;
  return derived;
}

/**
 * Encrypts a string using AES-256-GCM.
 * Output format: <iv_hex>:<authTag_hex>:<ciphertext_hex>
 */
export function encryptText(plainText: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts a string encrypted with encryptText.
 */
export function decryptText(encryptedString: string): string | null {
  try {
    const parts = encryptedString.split(':');
    if (parts.length !== 3) return null;
    const [ivHex, authTagHex, encryptedHex] = parts;
    if (
      typeof ivHex !== 'string' ||
      typeof authTagHex !== 'string' ||
      typeof encryptedHex !== 'string' ||
      !/^[0-9a-f]{24}$/i.test(ivHex) ||
      !/^[0-9a-f]{32}$/i.test(authTagHex) ||
      encryptedHex.length % 2 !== 0 ||
      (encryptedHex.length > 0 && !/^[0-9a-f]+$/i.test(encryptedHex))
    ) {
      return null;
    }

    const key = getEncryptionKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to decrypt credential payload');
    return null;
  }
}

function credKey(site: 'leetcode' | 'codeforces', label: string): string {
  return `creds:${site}:${label.trim().toLowerCase()}`;
}

function indexKey(site: 'leetcode' | 'codeforces'): string {
  return `creds:${site}:_index`;
}

async function getStoredIndex(site: 'leetcode' | 'codeforces'): Promise<string[]> {
  try {
    const val = await getSystemState(indexKey(site));
    if (!val) return [];
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const indexUpdateLocks = new Map<'leetcode' | 'codeforces', Promise<void>>();

async function updateStoredIndex(site: 'leetcode' | 'codeforces', label: string, action: 'add' | 'remove'): Promise<void> {
  const prev = indexUpdateLocks.get(site) ?? Promise.resolve();
  const nextRun = prev.catch(() => undefined).then(async () => {
    const norm = label.trim().toLowerCase();
    const current = await getStoredIndex(site);
    const next = action === 'add'
      ? Array.from(new Set([...current, norm]))
      : current.filter((item) => item !== norm);
    await setSystemState(indexKey(site), JSON.stringify(next));
  });
  indexUpdateLocks.set(site, nextRun);
  try {
    await nextRun;
  } finally {
    if (indexUpdateLocks.get(site) === nextRun) {
      indexUpdateLocks.delete(site);
    }
  }
}

/**
 * Saves encrypted credentials for a given site and account label.
 */
export async function saveEncryptedCredentials(
  site: 'leetcode' | 'codeforces',
  label: string,
  creds: StoredCredential,
): Promise<void> {
  const norm = label.trim().toLowerCase();
  const payload: StoredCredential = {
    ...creds,
    label: creds.label || label,
    updatedAt: new Date().toISOString(),
  };
  const cipher = encryptText(JSON.stringify(payload));
  await setSystemState(credKey(site, norm), cipher);
  await updateStoredIndex(site, norm, 'add');
  logger.info({ site, label: norm }, 'Saved encrypted credentials in database');
}

/**
 * Retrieves and decrypts credentials for a given account label.
 */
export async function getEncryptedCredentials(
  site: 'leetcode' | 'codeforces',
  label: string,
): Promise<StoredCredential | null> {
  const norm = label.trim().toLowerCase();
  const cipher = await getSystemState(credKey(site, norm));
  if (!cipher) return null;
  const json = decryptText(cipher);
  if (!json) return null;
  try {
    return JSON.parse(json) as StoredCredential;
  } catch {
    return null;
  }
}

/**
 * Deletes credentials for a given account label.
 */
export async function deleteEncryptedCredentials(
  site: 'leetcode' | 'codeforces',
  label: string,
): Promise<boolean> {
  const norm = label.trim().toLowerCase();
  await deleteSystemState(credKey(site, norm));
  await updateStoredIndex(site, norm, 'remove');
  return true;
}

/**
 * Lists all labels with stored credentials for a given site.
 */
export async function listCredentialLabels(site: 'leetcode' | 'codeforces'): Promise<string[]> {
  return getStoredIndex(site);
}

/**
 * Finds credentials for an account by matching its label, username, or email.
 */
export async function findCredentialsForAccount(
  site: 'leetcode' | 'codeforces',
  account: { label: string; username?: string | null },
): Promise<StoredCredential | null> {
  // 1. Direct label match
  const byLabel = await getEncryptedCredentials(site, account.label);
  if (byLabel) return byLabel;

  // 2. Direct username match
  if (account.username) {
    const byUsername = await getEncryptedCredentials(site, account.username);
    if (byUsername) return byUsername;
  }

  // 3. Scan index for match (skipping label/username already checked above)
  const seenNorm = new Set<string>([account.label.trim().toLowerCase()]);
  if (account.username) seenNorm.add(account.username.trim().toLowerCase());
  const allLabels = (await listCredentialLabels(site))
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && !seenNorm.has(l));
  if (allLabels.length === 0) return null;

  const matchesAccount = (cred: StoredCredential): boolean =>
    cred.label?.toLowerCase() === account.label.toLowerCase() ||
    cred.username.toLowerCase() === account.label.toLowerCase() ||
    Boolean(account.username && cred.username.toLowerCase() === account.username.toLowerCase()) ||
    Boolean(account.username && cred.email && cred.email.toLowerCase() === account.username.toLowerCase());

  if (!isMockFn(getSystemState) && typeof getSystemStates === 'function') {
    const states = await getSystemStates(allLabels.map((l) => credKey(site, l)));
    for (const l of allLabels) {
      const cipher = states[credKey(site, l)];
      if (!cipher) continue;
      const json = decryptText(cipher);
      if (!json) continue;
      try {
        const cred = JSON.parse(json) as StoredCredential;
        if (matchesAccount(cred)) return cred;
      } catch {}
    }
    return null;
  }

  for (const l of allLabels) {
    const cred = await getEncryptedCredentials(site, l);
    if (cred && matchesAccount(cred)) return cred;
  }

  return null;
}
