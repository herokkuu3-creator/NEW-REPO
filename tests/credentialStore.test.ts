import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  encryptText,
  decryptText,
  saveEncryptedCredentials,
  getEncryptedCredentials,
  deleteEncryptedCredentials,
  listCredentialLabels,
  findCredentialsForAccount,
} from '../src/security/credentialStore';

// Mock system state in-memory database
const inMemorySystemState = new Map<string, string>();

vi.mock('../src/database/models', () => ({
  getSystemState: vi.fn(async (key: string) => inMemorySystemState.get(key) ?? null),
  setSystemState: vi.fn(async (key: string, value: string) => {
    inMemorySystemState.set(key, value);
  }),
  deleteSystemState: vi.fn(async (key: string) => {
    inMemorySystemState.delete(key);
  }),
}));

describe('AES-256-GCM Credential Encryption & Decryption', () => {
  it('encrypts and decrypts text accurately', () => {
    const secret = 'super-secret-password-123!@#';
    const encrypted = encryptText(secret);

    expect(encrypted).not.toBe(secret);
    expect(encrypted.split(':')).toHaveLength(3); // iv:authTag:ciphertext

    const decrypted = decryptText(encrypted);
    expect(decrypted).toBe(secret);
  });

  it('generates unique ciphertexts and IVs for the same plaintext', () => {
    const text = 'test_password_unique';
    const enc1 = encryptText(text);
    const enc2 = encryptText(text);

    expect(enc1).not.toBe(enc2);
    expect(decryptText(enc1)).toBe(text);
    expect(decryptText(enc2)).toBe(text);
  });

  it('returns null on corrupted or tampered ciphertext without throwing', () => {
    expect(decryptText('invalid-format')).toBeNull();
    expect(decryptText('bad:format:data')).toBeNull();

    const valid = encryptText('valid_data');
    const [iv, authTag, data] = valid.split(':');
    // Tamper with data
    const corrupted = `${iv}:${authTag}:ff${data.slice(2)}`;
    expect(decryptText(corrupted)).toBeNull();
  });
});

describe('Credential Storage & Retrieval in Database', () => {
  beforeEach(() => {
    inMemorySystemState.clear();
  });

  it('saves and retrieves encrypted credentials for LeetCode and Codeforces', async () => {
    await saveEncryptedCredentials('leetcode', 'main_acc', {
      username: 'leet_user_1',
      password: 'password_lc_123',
      label: 'main_acc',
    });

    const retrieved = await getEncryptedCredentials('leetcode', 'main_acc');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.username).toBe('leet_user_1');
    expect(retrieved?.password).toBe('password_lc_123');
    expect(retrieved?.label).toBe('main_acc');

    // Verify stored format in DB is encrypted
    const rawDbVal = inMemorySystemState.get('creds:leetcode:main_acc');
    expect(rawDbVal).toBeDefined();
    expect(rawDbVal).not.toContain('password_lc_123');
  });

  it('maintains the credential index and supports listing labels', async () => {
    await saveEncryptedCredentials('codeforces', 'acc1', { username: 'cf_user_1', password: 'p1' });
    await saveEncryptedCredentials('codeforces', 'acc2', { username: 'cf_user_2', password: 'p2' });

    const labels = await listCredentialLabels('codeforces');
    expect(labels).toContain('acc1');
    expect(labels).toContain('acc2');
  });

  it('deletes stored credentials and updates the index', async () => {
    await saveEncryptedCredentials('leetcode', 'temp_acc', { username: 'temp', password: 'p' });
    expect(await getEncryptedCredentials('leetcode', 'temp_acc')).not.toBeNull();

    await deleteEncryptedCredentials('leetcode', 'temp_acc');
    expect(await getEncryptedCredentials('leetcode', 'temp_acc')).toBeNull();

    const labels = await listCredentialLabels('leetcode');
    expect(labels).not.toContain('temp_acc');
  });

  it('finds credentials for an account by matching label or username', async () => {
    await saveEncryptedCredentials('codeforces', 'contest_master', {
      username: 'tourist_clone',
      password: 'secret_codeforces_pass',
      label: 'contest_master',
    });

    // 1. By exact label match
    const byLabel = await findCredentialsForAccount('codeforces', { label: 'contest_master' });
    expect(byLabel?.username).toBe('tourist_clone');

    // 2. By username match
    const byUsername = await findCredentialsForAccount('codeforces', { label: 'different_label', username: 'tourist_clone' });
    expect(byUsername?.password).toBe('secret_codeforces_pass');

    // 3. Not found
    const notFound = await findCredentialsForAccount('codeforces', { label: 'unknown', username: 'nonexistent' });
    expect(notFound).toBeNull();
  });
});
