import crypto from 'node:crypto';
import { getSystemState, setSystemState, deleteSystemState } from '../database/models';
import { logger } from '../logger';

export interface StoredCredential {
  username: string;
  password: string;
  email?: string;
  label?: string;
  updatedAt?: string;
}

/**
 * Derives a consistent 256-bit encryption key from environment configuration.
 */
function getEncryptionKey(): Buffer {
  const secret =
    process.env.CREDENTIALS_SECRET ||
    process.env.ENCRYPTION_KEY ||
    process.env.DATABASE_URL ||
    process.env.TELEGRAM_BOT_TOKEN ||
    'leetcode-cf-agent-credential-key-salt-2026';
  const salt = 'antigravity-credential-salt-v1';
  return crypto.scryptSync(secret, salt, 32);
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
    if (!ivHex || !authTagHex || !encryptedHex) return null;

    const key = getEncryptionKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
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

async function updateStoredIndex(site: 'leetcode' | 'codeforces', label: string, action: 'add' | 'remove'): Promise<void> {
  const norm = label.trim().toLowerCase();
  const current = await getStoredIndex(site);
  let next: string[];
  if (action === 'add') {
    next = Array.from(new Set([...current, norm]));
  } else {
    next = current.filter((item) => item !== norm);
  }
  await setSystemState(indexKey(site), JSON.stringify(next));
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

  // 3. Scan index for match
  const allLabels = await listCredentialLabels(site);
  for (const l of allLabels) {
    const cred = await getEncryptedCredentials(site, l);
    if (!cred) continue;
    if (
      cred.label?.toLowerCase() === account.label.toLowerCase() ||
      cred.username.toLowerCase() === account.label.toLowerCase() ||
      (account.username && cred.username.toLowerCase() === account.username.toLowerCase()) ||
      (account.username && cred.email && cred.email.toLowerCase() === account.username.toLowerCase())
    ) {
      return cred;
    }
  }

  return null;
}
