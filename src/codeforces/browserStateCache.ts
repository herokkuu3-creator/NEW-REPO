import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Only encrypted session state leaves the ephemeral runner. Renewed cookies,
 * changed routes and browser upgrades start a fresh isolated session. */
export class BrowserStateCache<T> {
  private readonly key: Buffer;
  private readonly file: string;

  constructor(directory: string, secret: string, identity: unknown) {
    this.key = createHash('sha256').update(secret).digest();
    const id = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    this.file = path.join(directory, `${id}.enc`);
  }

  async load(): Promise<T | null> {
    try {
      const data = await readFile(this.file);
      const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      const decoded = JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'));
      if (Date.now() - decoded.savedAt > 7 * 24 * 60 * 60_000) return null;
      return decoded.state as T;
    } catch { return null; }
  }

  async save(state: T): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ savedAt: Date.now(), state })), cipher.final()]);
    const temporary = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporary, Buffer.concat([iv, cipher.getAuthTag(), ciphertext]), { mode: 0o600 });
    await rename(temporary, this.file);
  }
}
