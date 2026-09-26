import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { captureExport, fakeSession } from './fixtures';

/**
 * Integration test for the Telegram multi-file flow against a REAL
 * PostgreSQL (set TEST_DATABASE_URL to run it; skipped otherwise). The live
 * LeetCode check is replaced by an injected validator — no network.
 *
 * Scenario (the reported bug): several cookie .json files sent one after
 * another must each be stored as an account; a file for a user that already
 * exists must override that account's cookies — never be rejected/lost.
 */

const DB = process.env.TEST_DATABASE_URL;
const suite = DB ? describe : describe.skip;
if (DB) process.env.DATABASE_URL = DB;

const NOW = Math.floor(Date.now() / 1000);
const fresh = (username: string, marker: string) =>
  captureExport(fakeSession({ username, refreshed_at: NOW - 60, _session_expiry: 1_209_600, marker }));

suite('Telegram cookie files -> accounts (real DB)', async () => {
  const { prisma } = await import('../src/database/prisma');
  const { processCookieMessage } = await import('../src/notifications/telegramBot');
  const { listAccounts } = await import('../src/database/accounts');

  // What LeetCode would say: from THIS server the session reads signed out.
  const signedOut = async () => ({ ok: false as const, reason: 'signed-out' as const, error: 'signed out' });
  const signedIn = (username: string) => async () => ({ ok: true as const, username });
  const blocked = async () => ({ ok: false as const, reason: 'blocked' as const, error: 'HTTP 403' });

  beforeEach(async () => {
    await prisma.dailyRun.deleteMany();
    await prisma.account.deleteMany();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('keeps adding one account per file, for different users', async () => {
    const r1 = await processCookieMessage(fresh('alice', 'a1'), { fileName: 'lc_26Sept_4179.json', validator: signedIn('alice') });
    const r2 = await processCookieMessage(fresh('bob', 'b1'), { fileName: 'lc_26Sept_3700.json', validator: signedIn('bob') });
    const r3 = await processCookieMessage(fresh('carol', 'c1'), { fileName: 'lc_26Sept_5075.json', validator: blocked });
    expect([r1.stored, r2.stored, r3.stored]).toEqual([true, true, true]);
    expect(r1.text).toContain('Added new account: alice');
    expect(r3.text).toContain('NOT VERIFIED YET');

    const accounts = await listAccounts();
    expect(accounts.map((a) => [a.label, a.username, a.status])).toEqual([
      ['alice', 'alice', 'ACTIVE'],
      ['bob', 'bob', 'ACTIVE'],
      ['carol', 'carol', 'UNKNOWN'],
    ]);
    expect(r3.text).toContain('Accounts stored: 3');
  });

  it('overrides the cookies when the same user sends a new file', async () => {
    await processCookieMessage(fresh('alice', 'OLD'), { validator: signedIn('alice') });
    const r = await processCookieMessage(fresh('alice', 'NEW'), { validator: signedIn('alice') });
    expect(r.text).toContain('Updated account (old cookies overridden): alice');

    const accounts = await listAccounts();
    expect(accounts).toHaveLength(1);
    const session = JSON.parse(accounts[0]!.storageState).cookies.find(
      (c: { name: string }) => c.name === 'LEETCODE_SESSION',
    ).value as string;
    const payload = JSON.parse(Buffer.from(session.split('.')[1]!, 'base64url').toString());
    expect(payload.marker).toBe('NEW');
  });

  it('overrides a legacy "default" account that belongs to the same user', async () => {
    const { saveAccount } = await import('../src/database/accounts');
    await saveAccount('default', fresh('alice', 'OLD'), { username: 'alice' });
    await processCookieMessage(fresh('alice', 'NEW'), { validator: signedIn('alice') });
    const accounts = await listAccounts();
    expect(accounts.map((a) => a.label)).toEqual(['default']);
  });

  it('STORES the file even when LeetCode says signed out — marked EXPIRED, not rejected', async () => {
    const r = await processCookieMessage(fresh('chris_grif', 'x'), { fileName: 'lc_26Sept_4179.json', validator: signedOut });
    expect(r.stored).toBe(true);
    expect(r.text).toContain('Status: EXPIRED');
    const [a] = await listAccounts();
    expect(a?.label).toBe('chris_grif');
    expect(a?.status).toBe('EXPIRED');
  });

  it('marks an already-expired token EXPIRED without calling LeetCode', async () => {
    let called = false;
    const expiredJson = captureExport(fakeSession({ username: 'old', refreshed_at: NOW - 3_000_000, _session_expiry: 1_209_600 }));
    const r = await processCookieMessage(expiredJson, {
      validator: async () => {
        called = true;
        return { ok: true, username: 'old' };
      },
    });
    expect(called).toBe(false);
    expect(r.text).toContain('past its expiry');
    expect((await listAccounts())[0]?.status).toBe('EXPIRED');
  });

  it('an explicit /renew <label> stores under that label', async () => {
    await processCookieMessage(fresh('alice', 'x'), { label: 'main', validator: signedIn('alice') });
    expect((await listAccounts()).map((a) => a.label)).toEqual(['main']);
  });

  it('rejects junk without storing anything', async () => {
    const r = await processCookieMessage('hello there', { validator: signedIn('x') });
    expect(r.stored).toBe(false);
    const r2 = await processCookieMessage('{"cookies":[]}', { validator: signedIn('x') });
    expect(r2.stored).toBe(false);
    expect(await listAccounts()).toHaveLength(0);
  });
});
