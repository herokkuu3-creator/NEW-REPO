import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ value: null as string | null }));
vi.mock('../src/config', () => ({ config: { api: { setupToken: 'test-setup-token' },
  solutionPosts: { apiKeys: ['env_primary_0001', 'env_backup_0002'] } } }));
vi.mock('../src/database/models', () => ({
  getSystemState: vi.fn(async () => db.value),
  setSystemState: vi.fn(async (_key: string, value: string) => { db.value = value; }),
}));

import { appendSolutionApiKeys, loadSolutionKeyPool, maskSolutionApiKey, parseSolutionApiKeys,
  replaceSolutionApiKeys, rotateSolutionApiKey, solutionKeyPoolStatus, solutionKeyPeriod } from '../src/solutionPosts/keyPool';

describe('solution article API key pool', () => {
  beforeEach(() => { db.value = null; });

  it('accepts comma-separated additions, keeps insertion order, and never persists plaintext', async () => {
    expect(parseSolutionApiKeys(' key_one_0001, key_two_0002, key_one_0001 ')).toEqual(['key_one_0001', 'key_two_0002']);
    const result = await appendSolutionApiKeys('key_three_0003,key_four_0004,key_three_0003');
    expect(result.added).toBe(2); expect(result.duplicates).toBe(0);
    expect(db.value).toMatch(/^v1:/); expect(db.value).not.toContain('key_three_0003');
    const saved = await loadSolutionKeyPool();
    expect(saved.keys).toEqual(['env_primary_0001', 'env_backup_0002', 'key_three_0003', 'key_four_0004']);
    expect(maskSolutionApiKey(saved.keys[2]!)).not.toContain('three');
  });

  it('advances only to the next configured key and reports masked positions', async () => {
    await appendSolutionApiKeys('key_three_0003');
    const rotated = await rotateSolutionApiKey('env_primary_0001');
    expect(rotated.activeIndex).toBe(1);
    expect((await rotateSolutionApiKey('not-in-pool')).activeIndex).toBe(1);
    const status = await solutionKeyPoolStatus();
    expect(status).toMatchObject({ total: 3, active: 2, source: 'database' });
    expect(status.keys[1]).toMatchObject({ position: 2, active: true });
    expect(JSON.stringify(status)).not.toContain('env_backup_0002');
  });
  it('replaces a stale pool and explicitly restores key one as active', async () => {
    await appendSolutionApiKeys('key_three_0003');
    await rotateSolutionApiKey('env_primary_0001');
    const pool = await replaceSolutionApiKeys('fresh_key_0001,fresh_key_0002');
    expect(pool.keys).toEqual(['fresh_key_0001', 'fresh_key_0002']);
    expect(pool.activeIndex).toBe(0);
    expect((await solutionKeyPoolStatus()).active).toBe(1);
  });

  it('keeps an exhausted key skipped within its month and restores key one in the next month', async () => {
    await appendSolutionApiKeys('key_three_0003');
    expect((await rotateSolutionApiKey('env_primary_0001')).activeIndex).toBe(1);
    const thisMonth = solutionKeyPeriod(new Date('2026-10-16T00:00:00Z'));
    expect((await loadSolutionKeyPool(new Date('2026-10-16T00:00:00Z'))).activePeriod).toBe(thisMonth);
    const next = await loadSolutionKeyPool(new Date('2026-11-01T00:00:00Z'));
    expect(next.activeIndex).toBe(0);
    expect(next.activePeriod).toBe(solutionKeyPeriod(new Date('2026-11-01T00:00:00Z')));
  });
});
