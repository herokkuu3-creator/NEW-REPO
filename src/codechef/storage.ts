import { CodeChefAccount, CodeChefAccountStatus, CodeChefProgress } from '@prisma/client';
import { prisma } from '../database/prisma';
import { resetCodeChefRetryPollGate } from './retryGate';

export type CodeChefAccountSummary = Pick<
  CodeChefAccount,
  'id' | 'label' | 'username' | 'status' | 'lastSubmissionDate'
>;

export async function listCodeChefAccounts(onlyActive = true): Promise<CodeChefAccount[]> {
  const where = onlyActive ? { status: CodeChefAccountStatus.ACTIVE } : {};
  return prisma.codeChefAccount.findMany({
    where,
    orderBy: { createdAt: 'asc' },
  });
}

export async function listCodeChefAccountSummaries(onlyActive = true): Promise<CodeChefAccountSummary[]> {
  const where = onlyActive ? { status: CodeChefAccountStatus.ACTIVE } : {};
  return prisma.codeChefAccount.findMany({
    where,
    select: {
      id: true,
      label: true,
      username: true,
      status: true,
      lastSubmissionDate: true,
    },
    orderBy: { createdAt: 'asc' },
  });
}

export async function getCodeChefAccountStorageState(id: string): Promise<string | null> {
  const row = await prisma.codeChefAccount.findUnique({
    where: { id },
    select: { storageState: true },
  });
  return row?.storageState ?? null;
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
  return prisma.codeChefProgress.upsert({ where: { accountId }, create: { accountId }, update: {} });
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

export function isTerminalCodeChefVerdict(verdict: string | null | undefined): boolean {
  if (!verdict) return false;
  const v = verdict.toLowerCase();
  return /accepted|wrong answer|time limit|runtime|compilation|partially|internal error/i.test(v);
}

export async function claimDailyAttempt(accountId: string, today: string, key: string, force = false): Promise<boolean> {
  if (typeof prisma.codeChefProgress?.upsert === 'function') {
    await getCodeChefProgress(accountId);
  }
  if (force) {
    await prisma.codeChefProgress.updateMany({
      where: { accountId },
      data: {
        lastAttemptDate: today,
        lastAttemptKey: key,
      },
    });
    return true;
  }
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
    select: { accountId: true },
  });
}

export async function ensureCodeChefAccountsSeeded(): Promise<void> {
  const envKeys = Object.keys(process.env).filter((k) => /^(?:CODECHEF|CC)_\d+$/.test(k));
  
  for (const key of envKeys) {
    const value = process.env[key];
    if (!value) continue;
    const separator = value.indexOf('::');
    if (separator < 1 || separator === value.length - 2) continue;
    const username = value.slice(0, separator).trim();
    const password = value.slice(separator + 2);
    if (!username) continue;
    // Note: We use username as label
    const existing = await prisma.codeChefAccount.findUnique({
      where: { label: username },
      select: { id: true, storageState: true, status: true },
    });
    if (!existing) {
      await prisma.codeChefAccount.create({
        data: {
          label: username,
          username,
          storageState: JSON.stringify({
            username,
            password,
            cookies: []
          }),
          status: CodeChefAccountStatus.ACTIVE,
        },
        select: { id: true },
      });
      resetCodeChefRetryPollGate();
    } else {
      let storedPassword: string | undefined;
      try {
        storedPassword = (JSON.parse(existing.storageState) as { password?: string }).password;
      } catch {
        storedPassword = undefined;
      }
      if (storedPassword !== password) {
        await patchCodeChefAccount(existing.id, {
          storageState: JSON.stringify({ username, password, cookies: [], origins: [] }),
          ...(existing.status !== CodeChefAccountStatus.DISABLED
            ? { status: CodeChefAccountStatus.ACTIVE, lastError: null }
            : {}),
        });
        resetCodeChefRetryPollGate();
      }
    }
  }
}
