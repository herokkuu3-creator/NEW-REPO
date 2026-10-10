import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory tables to simulate Prisma Postgres store
const systemStateTable = new Map<string, string>();
const accountTable = new Map<string, any>();
const progressTable = new Map<string, any>();

vi.mock('../src/database/prisma', () => ({
  prisma: {
    systemState: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => {
        const val = systemStateTable.get(where.key);
        return val ? { key: where.key, value: val, updatedAt: new Date() } : null;
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const val = create?.value ?? update?.value;
        systemStateTable.set(where.key, val);
        return { key: where.key, value: val, updatedAt: new Date() };
      }),
      findMany: vi.fn(async (params?: any) => {
        const prefix = params?.where?.key?.startsWith;
        const results: Array<{ key: string; value: string; updatedAt: Date }> = [];
        for (const [k, v] of systemStateTable.entries()) {
          if (!prefix || k.startsWith(prefix)) {
            results.push({ key: k, value: v, updatedAt: new Date() });
          }
        }
        return results;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        if (where?.key) {
          const existed = systemStateTable.has(where.key);
          systemStateTable.delete(where.key);
          return { count: existed ? 1 : 0 };
        }
        const count = systemStateTable.size;
        systemStateTable.clear();
        return { count };
      }),
    },
    codeforcesAccount: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where?.id) return accountTable.get(where.id) ?? null;
        if (where?.label) {
          for (const acc of accountTable.values()) {
            if (acc.label === where.label) return acc;
          }
        }
        return null;
      }),
      findMany: vi.fn(async () => Array.from(accountTable.values())),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        let acc: any = null;
        for (const existing of accountTable.values()) {
          if (existing.label === where.label) {
            acc = existing;
            break;
          }
        }
        if (acc) {
          Object.assign(acc, update, { updatedAt: new Date() });
        } else {
          acc = {
            id: `acc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            label: create.label,
            storageState: create.storageState,
            username: create.username ?? null,
            status: create.status ?? 'UNKNOWN',
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          accountTable.set(acc.id, acc);
        }
        return acc;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        if (where?.id) {
          const existed = accountTable.has(where.id);
          accountTable.delete(where.id);
          // Simulate CASCADE DELETE on CodeforcesProgress
          progressTable.delete(where.id);
          return { count: existed ? 1 : 0 };
        }
        const count = accountTable.size;
        accountTable.clear();
        progressTable.clear();
        return { count };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const acc = accountTable.get(where.id);
        if (acc) Object.assign(acc, data, { updatedAt: new Date() });
        return acc;
      }),
    },
    codeforcesProgress: {
      upsert: vi.fn(async ({ where, create, update }: any) => {
        let prog = progressTable.get(where.accountId);
        if (prog) {
          Object.assign(prog, update, { updatedAt: new Date() });
        } else {
          prog = {
            accountId: where.accountId,
            nextKey: create.nextKey ?? null,
            lastCompletedKey: create.lastCompletedKey ?? null,
            lastCompletedAt: create.lastCompletedAt ?? null,
            lastSubmissionId: create.lastSubmissionId ?? null,
            lastVerdict: create.lastVerdict ?? null,
            updatedAt: new Date(),
          };
          progressTable.set(where.accountId, prog);
        }
        return prog;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        let prog = progressTable.get(where.accountId);
        if (!prog) {
          prog = { accountId: where.accountId };
          progressTable.set(where.accountId, prog);
        }
        Object.assign(prog, data, { updatedAt: new Date() });
        return prog;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const prog = progressTable.get(where.accountId);
        if (prog) {
          Object.assign(prog, data, { updatedAt: new Date() });
          return { count: 1 };
        }
        return { count: 0 };
      }),
    },
  },
}));

import {
  saveUsernameProgress,
  getUsernameProgress,
  listAllUsernameProgress,
  deleteUsernameProgress,
  saveCodeforcesAccount,
  deleteCodeforcesAccountById,
  deleteAllCodeforcesAccounts,
  completeCurrentProblem,
  recordAttempt,
  getCodeforcesProgress,
} from '../src/codeforces/storage';
import { resolveCurrentEntry, matchQueueEntry } from '../src/codeforces/worker';
import { SourceIndexEntry } from '../src/codeforces/sourceRepo';

beforeEach(() => {
  systemStateTable.clear();
  accountTable.clear();
  progressTable.clear();
});

describe('Permanent Codeforces Username Progress Tracking', () => {
  it('saves and retrieves permanent username progress from PostgreSQL systemState', async () => {
    const saved = await saveUsernameProgress('pts003', {
      lastCompletedKey: '628A - Tennis Tournament.cpp',
      nextKey: '628B',
      lastVerdict: 'OK',
      lastSubmissionId: '12345678',
    });

    expect(saved).toMatchObject({
      username: 'pts003',
      lastCompletedKey: '628A - Tennis Tournament.cpp',
      nextKey: '628B',
      lastVerdict: 'OK',
      lastSubmissionId: '12345678',
    });

    const retrieved = await getUsernameProgress('pts003');
    expect(retrieved).toMatchObject({
      username: 'pts003',
      lastCompletedKey: '628A - Tennis Tournament.cpp',
      nextKey: '628B',
      lastVerdict: 'OK',
      lastSubmissionId: '12345678',
    });
  });

  it('provides a resilient baseline for pts003 resuming at 628B if not yet initialized in DB', async () => {
    const progress = await getUsernameProgress('pts003');
    expect(progress).not.toBeNull();
    expect(progress?.nextKey).toBe('628B');
  });

  it('automatically updates permanent username progress when completeCurrentProblem is called', async () => {
    const account = await saveCodeforcesAccount('worker-pts', '{}', { username: 'pts003' });
    await completeCurrentProblem(account.id, {
      completedKey: '628B - New Skateboard.cpp',
      nextKey: '629A',
      submissionId: '99887766',
      verdict: 'OK',
    });

    const userProg = await getUsernameProgress('pts003');
    expect(userProg?.lastCompletedKey).toBe('628B - New Skateboard.cpp');
    expect(userProg?.nextKey).toBe('629A');
    expect(userProg?.lastVerdict).toBe('OK');
    expect(userProg?.lastSubmissionId).toBe('99887766');
  });

  it('automatically updates username attempt verdict on recordAttempt', async () => {
    const account = await saveCodeforcesAccount('worker-alice', '{}', { username: 'alice_cf' });
    await recordAttempt(account.id, {
      submissionId: '112233',
      verdict: 'WRONG_ANSWER',
    });

    const userProg = await getUsernameProgress('alice_cf');
    expect(userProg?.lastSubmissionId).toBe('112233');
    expect(userProg?.lastVerdict).toBe('WRONG_ANSWER');
  });

  it('preserves permanent username progress when account session is deleted or cleared', async () => {
    const account = await saveCodeforcesAccount('my-session', '{}', { username: 'pts003' });
    await completeCurrentProblem(account.id, {
      completedKey: '628B - New Skateboard.cpp',
      nextKey: '629A',
      submissionId: '123',
      verdict: 'OK',
    });

    // User removes cookies (simulates /cf_clear_cookies or cfrm:all)
    await deleteCodeforcesAccountById(account.id);
    expect(accountTable.size).toBe(0);
    expect(progressTable.size).toBe(0);

    // Permanent username progress remains intact in PostgreSQL!
    const userProg = await getUsernameProgress('pts003');
    expect(userProg).not.toBeNull();
    expect(userProg?.nextKey).toBe('629A');
    expect(userProg?.lastCompletedKey).toBe('628B - New Skateboard.cpp');
  });

  it('automatically hydrates CodeforcesProgress when user re-adds cookies for the same username', async () => {
    // 1. User solved up to question 100
    await saveUsernameProgress('coder123', {
      lastCompletedKey: '100A',
      nextKey: '100B',
      lastVerdict: 'OK',
    });

    // 2. User uploads fresh cookies for coder123
    const newAccount = await saveCodeforcesAccount('coder-main', '{"cookies":[{"name":"cf","value":"1"}]}', {
      username: 'coder123',
    });

    // 3. New account's CodeforcesProgress immediately has restored nextKey!
    const prog = await getCodeforcesProgress(newAccount.id);
    expect(prog.nextKey).toBe('100B');
    expect(prog.lastCompletedKey).toBe('100A');
    expect(prog.lastVerdict).toBe('OK');
  });

  it('getCodeforcesProgress falls back to username progress if account progress was blank', async () => {
    await saveUsernameProgress('user_bob', {
      lastCompletedKey: '50A',
      nextKey: '50B',
      lastVerdict: 'OK',
    });

    // Create an account without initial progress
    const acc = await saveCodeforcesAccount('bob-acc', '{}', { username: 'user_bob' });
    // Manually blank the progress record to simulate old blank state
    progressTable.set(acc.id, { accountId: acc.id, nextKey: null, lastCompletedKey: null });

    const restored = await getCodeforcesProgress(acc.id);
    expect(restored.nextKey).toBe('50B');
    expect(restored.lastCompletedKey).toBe('50A');
  });

  it('listAllUsernameProgress returns all tracked accounts and deleteUsernameProgress removes correctly', async () => {
    await saveUsernameProgress('user_a', { nextKey: '10A' });
    await saveUsernameProgress('user_b', { nextKey: '20B' });

    const list = await listAllUsernameProgress();
    expect(list.some((u) => u.username === 'user_a' && u.nextKey === '10A')).toBe(true);
    expect(list.some((u) => u.username === 'user_b' && u.nextKey === '20B')).toBe(true);

    const deleted = await deleteUsernameProgress('user_a');
    expect(deleted).toBe(true);
    const afterDelete = await getUsernameProgress('user_a');
    expect(afterDelete).toBeNull();
  });
});

describe('resolveCurrentEntry with shorthand contest/index matching', () => {
  const queue: SourceIndexEntry[] = [
    {
      key: '9A - Help Far Away Kingdom.cpp',
      path: '9A - Help Far Away Kingdom.cpp',
      fileName: '9A - Help Far Away Kingdom.cpp',
      contestId: 9,
      problemIndex: 'A',
      problemName: 'Help Far Away Kingdom',
      language: 'cpp',
      kind: 'CODEFORCES',
      rawUrl: '',
      interactive: false,
      gym: false,
      reason: '',
    },
    {
      key: '628A - Tennis Tournament.cpp',
      path: '628A - Tennis Tournament.cpp',
      fileName: '628A - Tennis Tournament.cpp',
      contestId: 628,
      problemIndex: 'A',
      problemName: 'Tennis Tournament',
      language: 'cpp',
      kind: 'CODEFORCES',
      rawUrl: '',
      interactive: false,
      gym: false,
      reason: '',
    },
    {
      key: '628B - New Skateboard.cpp',
      path: '628B - New Skateboard.cpp',
      fileName: '628B - New Skateboard.cpp',
      contestId: 628,
      problemIndex: 'B',
      problemName: 'New Skateboard',
      language: 'cpp',
      kind: 'CODEFORCES',
      rawUrl: '',
      interactive: false,
      gym: false,
      reason: '',
    },
    {
      key: '629A - Far Relative Birthday Cake.cpp',
      path: '629A - Far Relative Birthday Cake.cpp',
      fileName: '629A - Far Relative Birthday Cake.cpp',
      contestId: 629,
      problemIndex: 'A',
      problemName: 'Far Relative Birthday Cake',
      language: 'cpp',
      kind: 'CODEFORCES',
      rawUrl: '',
      interactive: false,
      gym: false,
      reason: '',
    },
  ];

  it('matches exact full filename key', () => {
    const entry = resolveCurrentEntry(queue, '628B - New Skateboard.cpp', null);
    expect(entry?.contestId).toBe(628);
    expect(entry?.problemIndex).toBe('B');
  });

  it('matches shorthand contest/index key like 628B', () => {
    const entry = resolveCurrentEntry(queue, '628B', null);
    expect(entry?.contestId).toBe(628);
    expect(entry?.problemIndex).toBe('B');
    expect(entry?.problemName).toBe('New Skateboard');
  });

  it('matches slash shorthand like 628/B', () => {
    const entry = resolveCurrentEntry(queue, '628/B', null);
    expect(entry?.contestId).toBe(628);
    expect(entry?.problemIndex).toBe('B');
  });

  it('advances past lastCompletedKey when nextKey is null', () => {
    const entry = resolveCurrentEntry(queue, null, '628A');
    expect(entry?.contestId).toBe(628);
    expect(entry?.problemIndex).toBe('B');
  });

  it('falls back to queue[0] when both keys are null', () => {
    const entry = resolveCurrentEntry(queue, null, null);
    expect(entry?.contestId).toBe(9);
    expect(entry?.problemIndex).toBe('A');
  });

  it('matchQueueEntry works with various key representations', () => {
    const target = queue[2]!; // 628B
    expect(matchQueueEntry(target, '628B - New Skateboard.cpp')).toBe(true);
    expect(matchQueueEntry(target, '628B')).toBe(true);
    expect(matchQueueEntry(target, '628b')).toBe(true);
    expect(matchQueueEntry(target, '628/B')).toBe(true);
    expect(matchQueueEntry(target, '628A')).toBe(false);
  });
});
