import { CodeforcesAccount, CodeforcesAccountStatus, CodeforcesProgress } from '@prisma/client';
import { prisma } from '../database/prisma';

export type CodeforcesAccountRecord = CodeforcesAccount;

export type StoredCodeforcesState = {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None';
  }>;
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
};

export function parseStoredCodeforcesState(json: string): { ok: true; state: StoredCodeforcesState } | { ok: false; error: string } {
  try {
    const value = JSON.parse(json) as StoredCodeforcesState;
    if (!value || !Array.isArray(value.cookies) || value.cookies.length === 0) {
      return { ok: false, error: 'stored Codeforces session has no cookies' };
    }
    if (!Array.isArray(value.origins)) value.origins = [];
    return { ok: true, state: value };
  } catch {
    return { ok: false, error: 'stored Codeforces session is not valid JSON — re-upload it' };
  }
}

export async function listCodeforcesAccounts(includeDisabled = true): Promise<CodeforcesAccountRecord[]> {
  return prisma.codeforcesAccount.findMany({
    ...(includeDisabled ? {} : { where: { status: { not: CodeforcesAccountStatus.DISABLED } } }),
    orderBy: { label: 'asc' },
  });
}

export async function getCodeforcesAccountById(id: string): Promise<CodeforcesAccountRecord | null> {
  return prisma.codeforcesAccount.findUnique({ where: { id } });
}

export interface CodeforcesUsernameProgress {
  username: string;
  lastCompletedKey: string | null;
  nextKey: string | null;
  lastCompletedAt: string | null;
  lastSubmissionId?: string | null;
  lastVerdict?: string | null;
  updatedAt: string;
}

export function getCodeforcesUsernameProgressKey(username: string): string {
  return `cf_user_progress:${username.trim().toLowerCase()}`;
}

export async function getUsernameProgress(username: string): Promise<CodeforcesUsernameProgress | null> {
  const clean = username.trim();
  if (!clean) return null;
  const key = getCodeforcesUsernameProgressKey(clean);
  const raw = await prisma.systemState.findUnique({ where: { key } }).then((r) => r?.value ?? null);
  if (!raw) {
    if (clean.toLowerCase() === 'pts003') {
      return {
        username: 'pts003',
        lastCompletedKey: null,
        nextKey: '628B',
        lastCompletedAt: null,
        lastSubmissionId: null,
        lastVerdict: null,
        updatedAt: new Date().toISOString(),
      };
    }
    return null;
  }
  try {
    return JSON.parse(raw) as CodeforcesUsernameProgress;
  } catch {
    return null;
  }
}

export async function saveUsernameProgress(
  username: string,
  data: {
    lastCompletedKey?: string | null;
    nextKey?: string | null;
    lastCompletedAt?: string | null;
    lastSubmissionId?: string | null;
    lastVerdict?: string | null;
  },
): Promise<CodeforcesUsernameProgress | null> {
  const clean = username.trim();
  if (!clean) return null;
  const existing = await getUsernameProgress(clean);
  const now = new Date().toISOString();
  const updated: CodeforcesUsernameProgress = {
    username: existing?.username ?? clean,
    lastCompletedKey: data.lastCompletedKey !== undefined ? data.lastCompletedKey : (existing?.lastCompletedKey ?? null),
    nextKey: data.nextKey !== undefined ? data.nextKey : (existing?.nextKey ?? null),
    lastCompletedAt: data.lastCompletedAt !== undefined ? data.lastCompletedAt : (existing?.lastCompletedAt ?? null),
    lastSubmissionId: data.lastSubmissionId !== undefined ? data.lastSubmissionId : (existing?.lastSubmissionId ?? null),
    lastVerdict: data.lastVerdict !== undefined ? data.lastVerdict : (existing?.lastVerdict ?? null),
    updatedAt: now,
  };
  const key = getCodeforcesUsernameProgressKey(clean);
  await prisma.systemState.upsert({
    where: { key },
    create: { key, value: JSON.stringify(updated) },
    update: { value: JSON.stringify(updated) },
  });
  return updated;
}

export async function listAllUsernameProgress(): Promise<CodeforcesUsernameProgress[]> {
  const rows = await prisma.systemState.findMany({
    where: { key: { startsWith: 'cf_user_progress:' } },
  });
  const list: CodeforcesUsernameProgress[] = [];
  for (const row of rows) {
    try {
      list.push(JSON.parse(row.value) as CodeforcesUsernameProgress);
    } catch {
      // ignore malformed
    }
  }
  if (!list.some((p) => p.username.toLowerCase() === 'pts003')) {
    list.push({
      username: 'pts003',
      lastCompletedKey: null,
      nextKey: '628B',
      lastCompletedAt: null,
      lastSubmissionId: null,
      lastVerdict: null,
      updatedAt: new Date().toISOString(),
    });
  }
  return list.sort((a, b) => a.username.localeCompare(b.username));
}

export async function deleteUsernameProgress(username: string): Promise<boolean> {
  const key = getCodeforcesUsernameProgressKey(username);
  const res = await prisma.systemState.deleteMany({ where: { key } });
  return res.count > 0;
}

export async function saveCodeforcesAccount(
  label: string,
  storageState: string,
  meta: { username?: string | null; status?: CodeforcesAccountStatus } = {},
): Promise<CodeforcesAccountRecord> {
  const account = await prisma.codeforcesAccount.upsert({
    where: { label },
    create: {
      label,
      storageState,
      username: meta.username ?? null,
      status: meta.status ?? CodeforcesAccountStatus.UNKNOWN,
    },
    update: {
      storageState,
      username: meta.username ?? null,
      status: meta.status ?? CodeforcesAccountStatus.UNKNOWN,
      lastError: null,
    },
  });

  // Restore permanent username progress if available
  if (account.username) {
    const userProgress = await getUsernameProgress(account.username);
    if (userProgress && (userProgress.nextKey || userProgress.lastCompletedKey)) {
      await prisma.codeforcesProgress.upsert({
        where: { accountId: account.id },
        create: {
          accountId: account.id,
          nextKey: userProgress.nextKey,
          lastCompletedKey: userProgress.lastCompletedKey,
          lastCompletedAt: userProgress.lastCompletedAt ? new Date(userProgress.lastCompletedAt) : null,
          lastSubmissionId: userProgress.lastSubmissionId ?? null,
          lastVerdict: userProgress.lastVerdict ?? null,
        },
        update: {
          nextKey: userProgress.nextKey,
          lastCompletedKey: userProgress.lastCompletedKey,
          lastCompletedAt: userProgress.lastCompletedAt ? new Date(userProgress.lastCompletedAt) : null,
          lastSubmissionId: userProgress.lastSubmissionId ?? null,
          lastVerdict: userProgress.lastVerdict ?? null,
        },
      });
    }
  }

  return account;
}

export async function patchCodeforcesAccount(
  id: string,
  patch: {
    username?: string | null;
    status?: CodeforcesAccountStatus;
    lastError?: string | null;
    checked?: boolean;
    lastSubmissionDate?: string | null;
    lastSubmissionId?: string | null;
    lastVerdict?: string | null;
    state?: StoredCodeforcesState;
  },
): Promise<void> {
  await prisma.codeforcesAccount.update({
    where: { id },
    data: {
      username: patch.username,
      status: patch.status,
      lastError: patch.lastError,
      ...(patch.checked ? { lastCheckedAt: new Date() } : {}),
      ...(patch.lastSubmissionDate !== undefined ? { lastSubmissionDate: patch.lastSubmissionDate } : {}),
      ...(patch.lastSubmissionId !== undefined ? { lastSubmissionId: patch.lastSubmissionId } : {}),
      ...(patch.lastVerdict !== undefined ? { lastVerdict: patch.lastVerdict } : {}),
      ...(patch.state !== undefined ? { storageState: JSON.stringify(patch.state) } : {}),
    },
  });
}

export async function getCodeforcesProgress(accountId: string): Promise<CodeforcesProgress> {
  const progress = await prisma.codeforcesProgress.upsert({
    where: { accountId },
    create: { accountId },
    update: {},
  });

  // If this account has no progress keys yet, check if the username has permanent progress in DB
  if (!progress.nextKey && !progress.lastCompletedKey) {
    const account = await prisma.codeforcesAccount.findUnique({
      where: { id: accountId },
      select: { username: true },
    });
    if (account?.username) {
      const userProgress = await getUsernameProgress(account.username);
      if (userProgress && (userProgress.nextKey || userProgress.lastCompletedKey)) {
        return prisma.codeforcesProgress.update({
          where: { accountId },
          data: {
            nextKey: userProgress.nextKey,
            lastCompletedKey: userProgress.lastCompletedKey,
            lastCompletedAt: userProgress.lastCompletedAt ? new Date(userProgress.lastCompletedAt) : null,
            lastSubmissionId: userProgress.lastSubmissionId ?? null,
            lastVerdict: userProgress.lastVerdict ?? null,
          },
        });
      }
    }
  }

  return progress;
}

/** Atomically reserves the one daily attempt for an account. */
export async function claimDailyAttempt(accountId: string, date: string, key: string): Promise<boolean> {
  const result = await prisma.codeforcesProgress.updateMany({
    where: {
      accountId,
      OR: [{ lastAttemptDate: null }, { lastAttemptDate: { not: date } }],
    },
    data: {
      lastAttemptDate: date,
      lastAttemptKey: key,
      lastSubmissionId: null,
      lastVerdict: null,
    },
  });
  return result.count === 1;
}

export async function releaseDailyAttempt(accountId: string, date: string): Promise<void> {
  await prisma.codeforcesProgress.updateMany({
    where: { accountId, lastAttemptDate: date },
    data: { lastAttemptDate: null },
  });
}

export async function recordAttempt(
  accountId: string,
  data: { submissionId?: string | null; verdict: string },
): Promise<void> {
  await prisma.codeforcesProgress.update({
    where: { accountId },
    data: {
      lastSubmissionId: data.submissionId ?? null,
      lastVerdict: data.verdict,
    },
  });

  const account = await prisma.codeforcesAccount.findUnique({
    where: { id: accountId },
    select: { username: true },
  });
  if (account?.username) {
    await saveUsernameProgress(account.username, {
      lastSubmissionId: data.submissionId ?? null,
      lastVerdict: data.verdict,
    });
  }
}

export async function completeCurrentProblem(
  accountId: string,
  data: {
    completedKey: string;
    nextKey: string | null;
    submissionId: string | null;
    verdict: string;
  },
): Promise<void> {
  const now = new Date();
  await prisma.codeforcesProgress.update({
    where: { accountId },
    data: {
      lastCompletedKey: data.completedKey,
      lastCompletedAt: now,
      nextKey: data.nextKey,
      lastSubmissionId: data.submissionId,
      lastVerdict: data.verdict,
    },
  });

  const account = await prisma.codeforcesAccount.findUnique({
    where: { id: accountId },
    select: { username: true },
  });
  if (account?.username) {
    await saveUsernameProgress(account.username, {
      lastCompletedKey: data.completedKey,
      nextKey: data.nextKey,
      lastCompletedAt: now.toISOString(),
      lastSubmissionId: data.submissionId,
      lastVerdict: data.verdict,
    });
  }
}

export async function deleteCodeforcesAccountById(id: string): Promise<boolean> {
  const res = await prisma.codeforcesAccount.deleteMany({ where: { id } });
  return res.count > 0;
}

export async function deleteAllCodeforcesAccounts(): Promise<number> {
  const res = await prisma.codeforcesAccount.deleteMany({});
  return res.count;
}
