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

export async function saveCodeforcesAccount(
  label: string,
  storageState: string,
  meta: { username?: string | null; status?: CodeforcesAccountStatus } = {},
): Promise<CodeforcesAccountRecord> {
  return prisma.codeforcesAccount.upsert({
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
    },
  });
}

export async function getCodeforcesProgress(accountId: string): Promise<CodeforcesProgress> {
  return prisma.codeforcesProgress.upsert({
    where: { accountId },
    create: { accountId },
    update: {},
  });
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
  await prisma.codeforcesProgress.update({
    where: { accountId },
    data: {
      lastCompletedKey: data.completedKey,
      lastCompletedAt: new Date(),
      nextKey: data.nextKey,
      lastSubmissionId: data.submissionId,
      lastVerdict: data.verdict,
    },
  });
}
