import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AccountStatus, RunState } from '@prisma/client';

const h = vi.hoisted(() => ({
  accountFindMany: vi.fn(),
  accountFindUnique: vi.fn(),
  accountDelete: vi.fn(),
  dailyRunFindFirst: vi.fn(),
  systemStateFindMany: vi.fn(),
  systemStateFindUnique: vi.fn(),
  systemStateUpsert: vi.fn(),
  queryRaw: vi.fn(),
  ingestCookiePayload: vi.fn(),
  isRunInProgress: false,
}));

vi.mock('../src/config', async (orig) => {
  const real = (await orig()) as { config: Record<string, unknown> };
  return { config: { ...real.config, api: { ...(real.config.api as object), port: 0 } } };
});

vi.mock('../src/database/prisma', () => ({
  prisma: {
    account: {
      findMany: h.accountFindMany,
      findUnique: h.accountFindUnique,
      delete: h.accountDelete,
    },
    dailyRun: {
      findFirst: h.dailyRunFindFirst,
    },
    systemState: {
      findMany: h.systemStateFindMany,
      findUnique: h.systemStateFindUnique,
      upsert: h.systemStateUpsert,
    },
    $queryRaw: h.queryRaw,
  },
}));

vi.mock('../src/accounts/ingest', async (orig) => ({
  ...((await orig()) as object),
  ingestCookiePayload: h.ingestCookiePayload,
}));

import {
  getAccountIdentityById,
  listAccountIdentities,
  listAccountIdentitiesByIds,
  listAccountSummaries,
} from '../src/database/accounts';
import { getSystemStates, latestRunSummary, SystemKeys } from '../src/database/models';

describe('Database egress helpers & /health projections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.isRunInProgress = false;
  });

  it('listAccountSummaries computes cookieCount via $queryRaw without transferring storageState and falls back to Prisma select on error', async () => {
    const createdAt = new Date('2026-11-01T00:00:00Z');
    h.queryRaw.mockResolvedValueOnce([
      {
        id: 'acc-1',
        label: 'main',
        username: 'alice',
        status: 'ACTIVE',
        lastCheckedAt: null,
        lastRunAt: null,
        lastResult: 'SUCCESS',
        lastError: null,
        createdAt,
        updatedAt: createdAt,
        cookieCount: 14,
      },
    ]);

    const rawResult = await listAccountSummaries();
    expect(rawResult).toHaveLength(1);
    expect(rawResult[0]?.cookieCount).toBe(14);
    expect((rawResult[0] as unknown as Record<string, unknown>).storageState).toBeUndefined();
    expect(h.accountFindMany).not.toHaveBeenCalled();

    // Fallback when $queryRaw fails (e.g. malformed non-JSON storageState row)
    h.queryRaw.mockRejectedValueOnce(new Error('invalid input syntax for type json'));
    h.accountFindMany.mockResolvedValueOnce([
      {
        id: 'acc-2',
        label: 'backup',
        username: 'bob',
        status: AccountStatus.EXPIRED,
        lastCheckedAt: null,
        lastRunAt: null,
        lastResult: null,
        lastError: 'expired',
        createdAt,
        updatedAt: createdAt,
      },
    ]);

    const fallbackResult = await listAccountSummaries();
    expect(fallbackResult).toHaveLength(1);
    expect(fallbackResult[0]?.label).toBe('backup');
    expect(h.accountFindMany).toHaveBeenCalledWith({
      orderBy: { label: 'asc' },
      select: {
        id: true,
        label: true,
        username: true,
        status: true,
        lastCheckedAt: true,
        lastRunAt: true,
        lastResult: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  });

  it('listAccountIdentities, getAccountIdentityById, and listAccountIdentitiesByIds omit storageState', async () => {
    h.accountFindMany.mockResolvedValue([]);
    h.accountFindUnique.mockResolvedValue(null);

    await listAccountIdentities();
    expect(h.accountFindMany).toHaveBeenCalledWith({
      orderBy: { label: 'asc' },
      select: { id: true, label: true, username: true, status: true },
    });

    await getAccountIdentityById('acc-1');
    expect(h.accountFindUnique).toHaveBeenCalledWith({
      where: { id: 'acc-1' },
      select: { id: true, label: true, username: true, status: true },
    });

    expect(await listAccountIdentitiesByIds([])).toEqual([]);
    await listAccountIdentitiesByIds(['acc-1', 'acc-2']);
    expect(h.accountFindMany).toHaveBeenLastCalledWith({
      where: { id: { in: ['acc-1', 'acc-2'] } },
      select: { id: true, label: true, username: true, status: true },
    });
  });

  it('getSystemStates queries only requested keys and latestRunSummary omits solution/error blobs', async () => {
    expect(await getSystemStates([])).toEqual({});
    expect(h.systemStateFindMany).not.toHaveBeenCalled();

    h.systemStateFindMany.mockResolvedValueOnce([
      { key: SystemKeys.authStatus, value: 'ok' },
      { key: SystemKeys.lastError, value: 'none' },
    ]);
    const states = await getSystemStates([SystemKeys.authStatus, SystemKeys.lastError]);
    expect(states).toEqual({ authStatus: 'ok', lastError: 'none' });
    expect(h.systemStateFindMany).toHaveBeenCalledWith({
      where: { key: { in: [SystemKeys.authStatus, SystemKeys.lastError] } },
      select: { key: true, value: true },
    });

    h.dailyRunFindFirst.mockResolvedValueOnce(null);
    await latestRunSummary();
    expect(h.dailyRunFindFirst).toHaveBeenCalledWith({
      orderBy: { createdAt: 'desc' },
      select: {
        date: true,
        problemSlug: true,
        title: true,
        state: true,
        submissionStatus: true,
        runtime: true,
        memory: true,
        createdAt: true,
      },
    });
  });
});

describe('/health and /admin/accounts HTTP projection & short-lived cache', () => {
  let app: FastifyInstance;
  const AUTH = { authorization: 'Bearer test-token-for-vitest' };

  beforeAll(async () => {
    const { startHealthServer } = await import('../src/api/health');
    app = await startHealthServer(
      {
        triggerRun: async () => ({ started: false, message: 'nope' }),
        isRunInProgress: () => h.isRunInProgress,
        runSubmission: async () => null,
      },
      { pinCode: '4821', healthCacheTtlMs: 5_000 },
    );
  }, 30_000);

  afterAll(async () => app?.close());

  beforeEach(() => {
    vi.clearAllMocks();
    h.isRunInProgress = false;
    // Clear cache between tests via a mutation endpoint
    return app.inject({
      method: 'POST',
      url: '/admin/storage-state',
      headers: AUTH,
      payload: { cookies: [], origins: [] },
    }).then(() => {
      vi.clearAllMocks();
    });
  });

  it('serves exact /health JSON via selective SystemState, latestRunSummary, and listAccountSummaries, and caches within TTL', async () => {
    const createdAt = new Date('2026-11-17T02:00:00Z');
    const lastRunAt = new Date('2026-11-17T03:00:00Z');
    h.systemStateFindMany.mockResolvedValue([
      { key: SystemKeys.authStatus, value: 'ok' },
      { key: SystemKeys.authUsername, value: 'alice' },
      { key: SystemKeys.lastReport, value: JSON.stringify({ date: '2026-11-17', summary: '1 account(s): 1 solved' }) },
      { key: SystemKeys.lastError, value: 'minor warning' },
    ]);
    h.dailyRunFindFirst.mockResolvedValue({
      date: '2026-11-17',
      problemSlug: 'two-sum',
      title: 'Two Sum',
      state: RunState.SUCCESS,
      submissionStatus: 'Accepted',
      runtime: '0 ms',
      memory: '8.5 MB',
      createdAt,
    });
    h.queryRaw.mockResolvedValue([
      {
        id: 'acc-1',
        label: 'main',
        username: 'alice',
        status: 'ACTIVE',
        lastCheckedAt: null,
        lastRunAt,
        lastResult: 'SUCCESS',
        lastError: null,
        createdAt,
        updatedAt: createdAt,
        cookieCount: 11,
      },
    ]);

    const res1 = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-pin-code': '4821' },
    });
    expect(res1.statusCode).toBe(200);
    const body1 = res1.json();
    expect(body1).toMatchObject({
      status: 'ok',
      service: 'leetcode-daily-agent',
      runInProgress: false,
      authentication: { status: 'ok', username: 'alice' },
      accounts: {
        total: 1,
        active: 1,
        expired: 0,
        items: [
          {
            label: 'main',
            username: 'alice',
            status: 'ACTIVE',
            cookieCount: 11,
            lastCheckedAt: null,
            lastResult: 'SUCCESS',
            lastError: null,
          },
        ],
      },
      lastReport: { date: '2026-11-17', summary: '1 account(s): 1 solved' },
      lastRun: {
        date: '2026-11-17',
        problemSlug: 'two-sum',
        title: 'Two Sum',
        state: 'SUCCESS',
        submissionStatus: 'Accepted',
        runtime: '0 ms',
        memory: '8.5 MB',
      },
      lastError: 'minor warning',
    });
    expect(h.systemStateFindMany).toHaveBeenCalledTimes(1);
    expect(h.dailyRunFindFirst).toHaveBeenCalledTimes(1);
    expect(h.queryRaw).toHaveBeenCalledTimes(1);

    // Second request within TTL reuses cached DB snapshot while refreshing live fields
    h.isRunInProgress = true;
    const res2 = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-pin-code': '4821' },
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().runInProgress).toBe(true);
    expect(h.systemStateFindMany).toHaveBeenCalledTimes(1);
    expect(h.dailyRunFindFirst).toHaveBeenCalledTimes(1);
    expect(h.queryRaw).toHaveBeenCalledTimes(1);

    // DELETE /admin/accounts/:label invalidates the health cache
    h.accountFindUnique.mockResolvedValueOnce({ id: 'acc-1', label: 'main' });
    h.accountDelete.mockResolvedValueOnce({ id: 'acc-1' });
    const del = await app.inject({ method: 'DELETE', url: '/admin/accounts/main', headers: AUTH });
    expect(del.statusCode).toBe(200);

    await app.inject({ method: 'GET', url: '/health', headers: { 'x-pin-code': '4821' } });
    expect(h.systemStateFindMany).toHaveBeenCalledTimes(2);
    expect(h.dailyRunFindFirst).toHaveBeenCalledTimes(2);
    expect(h.queryRaw).toHaveBeenCalledTimes(2);
  });

  it('GET /admin/accounts uses listAccountSummaries without transferring storageState', async () => {
    const createdAt = new Date('2026-11-17T02:00:00Z');
    h.queryRaw.mockResolvedValueOnce([
      {
        id: 'acc-1',
        label: 'main',
        username: 'alice',
        status: 'ACTIVE',
        lastCheckedAt: null,
        lastRunAt: null,
        lastResult: 'SUCCESS',
        lastError: null,
        createdAt,
        updatedAt: createdAt,
        cookieCount: 9,
      },
    ]);

    const res = await app.inject({ method: 'GET', url: '/admin/accounts', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      total: 1,
      accounts: [{ label: 'main', username: 'alice', status: 'ACTIVE', cookieCount: 9 }],
    });
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
    expect(h.accountFindMany).not.toHaveBeenCalled();
  });
});
