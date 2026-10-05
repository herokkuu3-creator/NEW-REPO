import { CodeChefAccount, CodeChefAccountStatus, CodeChefProgress } from '@prisma/client';
import { prisma } from '../database/prisma';

export async function listCodeChefAccounts(onlyActive = true): Promise<CodeChefAccount[]> {
  const where = onlyActive ? { status: CodeChefAccountStatus.ACTIVE } : {};
  return prisma.codeChefAccount.findMany({
    where,
    orderBy: { createdAt: 'asc' },
  });
}

export async function patchCodeChefAccount(
  id: string,
  data: Partial<Pick<CodeChefAccount, 'username' | 'status' | 'lastError' | 'lastSubmissionDate' | 'lastSubmissionId' | 'lastVerdict' | 'storageState'>> & { checked?: boolean },
): Promise<CodeChefAccount> {
  return prisma.codeChefAccount.update({
    where: { id },
    data: {
      username: data.username,
      status: data.status,
      storageState: data.storageState,
      lastError: data.lastError,
      lastSubmissionDate: data.lastSubmissionDate,
      lastSubmissionId: data.lastSubmissionId,
      lastVerdict: data.lastVerdict,
      lastCheckedAt: data.checked ? new Date() : undefined,
    },
  });
}

export async function getCodeChefProgress(accountId: string): Promise<CodeChefProgress> {
  const progress = await prisma.codeChefProgress.findUnique({
    where: { accountId },
  });
  if (progress) return progress;
  return prisma.codeChefProgress.create({
    data: { accountId },
  });
}

export async function completeCurrentProblem(
  accountId: string,
  data: {
    completedKey: string;
    nextKey: string | null;
    submissionId: string | null;
    verdict: string | null;
  },
): Promise<CodeChefProgress> {
  return prisma.codeChefProgress.update({
    where: { accountId },
    data: {
      lastCompletedKey: data.completedKey,
      nextKey: data.nextKey,
      lastCompletedAt: new Date(),
      lastAttemptKey: data.completedKey,
      lastSubmissionId: data.submissionId,
      lastVerdict: data.verdict,
    },
  });
}

export async function claimDailyAttempt(accountId: string, today: string, key: string): Promise<boolean> {
  try {
    const updated = await prisma.codeChefProgress.updateMany({
      where: {
        accountId,
        OR: [
          { lastAttemptDate: null },
          { lastAttemptDate: { not: today } },
        ],
      },
      data: {
        lastAttemptDate: today,
        lastAttemptKey: key,
      },
    });
    return updated.count > 0;
  } catch {
    return false;
  }
}

export async function releaseDailyAttempt(accountId: string, today: string): Promise<void> {
  await prisma.codeChefProgress.updateMany({
    where: { accountId, lastAttemptDate: today },
    data: { lastAttemptDate: null },
  });
}

export async function recordAttempt(
  accountId: string,
  data: { submissionId: string | null; verdict: string | null },
): Promise<void> {
  await prisma.codeChefProgress.update({
    where: { accountId },
    data: {
      lastSubmissionId: data.submissionId,
      lastVerdict: data.verdict,
    },
  });
}

export async function ensureCodeChefAccountsSeeded(): Promise<void> {
  const envKeys = Object.keys(process.env).filter((k) => k.startsWith('CODECHEF_') || k.startsWith('CC_'));
  
  for (const key of envKeys) {
    const value = process.env[key];
    if (!value) continue;
    const parts = value.split('::');
    if (parts.length !== 2) continue;
    const username = parts[0]!;
    // Note: We use username as label
    const existing = await prisma.codeChefAccount.findUnique({ where: { label: username } });
    if (!existing) {
      await prisma.codeChefAccount.create({
        data: {
          label: username,
          username,
          storageState: JSON.stringify({
            username: parts[0],
            password: parts[1],
            cookies: []
          }),
          status: CodeChefAccountStatus.ACTIVE,
        },
      });
    }
  }
}
