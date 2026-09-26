import { describe, expect, it } from 'vitest';
import {
  extractSessionIdentity,
  labelFromFileName,
  labelFromUsername,
  resolveAccountLabel,
} from '../src/browser/sessionIdentity';
import { parseCookiePayload, StorageStateShape } from '../src/browser/cookiePayload';
import { captureExport, fakeSession } from './fixtures';

/**
 * Offline session identity + account-label resolution. Pure — fake tokens
 * built in the same shape as a real LEETCODE_SESSION (header.payload.sig).
 */

function stateOf(json: string): StorageStateShape {
  const p = parseCookiePayload(json);
  if (!p.ok) throw new Error(p.error);
  return p.storageState;
}

const NOW = 1_790_500_000;

describe('extractSessionIdentity', () => {
  it('reads the username and computes expiry from refreshed_at + _session_expiry', () => {
    const s = stateOf(captureExport(fakeSession({ username: 'chris_grif', refreshed_at: NOW - 1000, _session_expiry: 1_209_600 })));
    const id = extractSessionIdentity(s, NOW);
    expect(id.username).toBe('chris_grif');
    expect(id.expiresAt).toBe(NOW - 1000 + 1_209_600);
    expect(id.expired).toBe(false);
  });

  it('flags an expired token (payload lifetime passed)', () => {
    const s = stateOf(captureExport(fakeSession({ username: 'old', refreshed_at: NOW - 2_000_000, _session_expiry: 1_209_600 })));
    expect(extractSessionIdentity(s, NOW).expired).toBe(true);
  });

  it('flags an expired cookie (cookie expires in the past)', () => {
    const s = stateOf(captureExport(fakeSession({ username: 'u' }), NOW - 10));
    expect(extractSessionIdentity(s, NOW).expired).toBe(true);
  });

  it('survives a non-JWT session value (no username, not expired)', () => {
    const s = stateOf('LEETCODE_SESSION=opaque-session-value-123; csrftoken=abc');
    const id = extractSessionIdentity(s, NOW);
    expect(id.username).toBeUndefined();
    expect(id.expired).toBe(false);
  });
});

describe('resolveAccountLabel', () => {
  const id = (username?: string) => ({ username, expired: false });

  it('adds a new account named after the username', () => {
    expect(resolveAccountLabel([], id('chris_grif'))).toEqual({ label: 'chris_grif', isNew: true });
  });

  it('overrides the existing account with the same username (case-insensitive), whatever its label', () => {
    const existing = [{ label: 'default', username: 'Chris_Grif' }];
    expect(resolveAccountLabel(existing, id('chris_grif'))).toEqual({ label: 'default', isNew: false });
  });

  it('keeps different users as different accounts', () => {
    const existing = [{ label: 'alice', username: 'alice' }];
    expect(resolveAccountLabel(existing, id('bob'))).toEqual({ label: 'bob', isNew: true });
  });

  it('an explicit label always wins', () => {
    const existing = [{ label: 'alice', username: 'alice' }];
    expect(resolveAccountLabel(existing, id('alice'), 'main')).toEqual({ label: 'main', isNew: true });
    expect(resolveAccountLabel(existing, id('bob'), 'alice')).toEqual({ label: 'alice', isNew: false });
  });

  it('falls back to the file name when no username is readable', () => {
    expect(resolveAccountLabel([], id(), undefined, 'lc_26Sept_4179')).toEqual({ label: 'lc_26Sept_4179', isNew: true });
    expect(resolveAccountLabel([], id())).toEqual({ label: 'account', isNew: true });
  });
});

describe('label helpers', () => {
  it('sanitizes usernames and file names into valid labels', () => {
    expect(labelFromUsername('john doe!')).toBe('john-doe-');
    expect(labelFromFileName('lc_26Sept_4179.json')).toBe('lc_26Sept_4179');
    expect(labelFromFileName('leetcode session (1).json')).toBe('leetcode-session--1-');
    expect(labelFromFileName(undefined)).toBeUndefined();
  });
});
