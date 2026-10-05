import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserStateCache } from '../src/codeforces/browserStateCache';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function directory(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'cf-state-test-'));
  directories.push(value);
  return value;
}

describe('encrypted runner session cache', () => {
  it('expires state after seven days', async () => {
    const root = await directory();
    const now = Date.now();
    const cache = new BrowserStateCache(root, 'key', 'account');
    await cache.save({ cookies: [] });
    vi.spyOn(Date, 'now').mockReturnValue(now + 8 * 24 * 60 * 60_000);
    expect(await cache.load()).toBeNull();
  });
  it('restores session data without storing plaintext credentials', async () => {
    const root = await directory();
    const cache = new BrowserStateCache(root, 'test-secret', { account: 'a', route: 'static' });
    const state = { cookies: [{ value: 'private-cookie-value' }], origins: [] };
    await cache.save(state);
    expect(await cache.load()).toEqual(state);
    const bytes = await readFile(path.join(root, (await readdir(root))[0]!));
    expect(bytes.includes(Buffer.from('private-cookie-value'))).toBe(false);
  });
  it('isolates accounts, cookie renewals and network routes', async () => {
    const root = await directory();
    await new BrowserStateCache(root, 'key', { account: 'a', cookie: 'old', route: 'static' }).save({ cookies: [] });
    for (const identity of [
      { account: 'b', cookie: 'old', route: 'static' },
      { account: 'a', cookie: 'new', route: 'static' },
      { account: 'a', cookie: 'old', route: 'phone' },
    ]) expect(await new BrowserStateCache(root, 'key', identity).load()).toBeNull();
  });
  it('falls back to uploaded cookies on a changed key or corrupted cache', async () => {
    const root = await directory();
    const cache = new BrowserStateCache(root, 'key', 'account');
    await cache.save({ cookies: [] });
    expect(await new BrowserStateCache(root, 'changed-key', 'account').load()).toBeNull();
    const file = path.join(root, (await readdir(root))[0]!);
    await writeFile(file, Buffer.from('broken'));
    expect(await cache.load()).toBeNull();
  });
});
