import cron from 'node-cron';
import { CodeChefAccountStatus } from '@prisma/client';
import { logger } from '../logger';
import { config } from '../config';
import { 
  listCodeChefAccounts, 
  ensureCodeChefAccountsSeeded, 
  patchCodeChefAccount, 
  getCodeChefProgress, 
  completeCurrentProblem, 
  claimDailyAttempt 
} from './storage';
import { loadCodeChefSourceIndex, fetchSourceCode } from './sourceRepo';
import { loginToCodeChef } from './auth';
import { submitToCodeChef } from './api';

let runInProgress = false;

function todayInTimezone(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.schedule.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export async function runCodeChefNow(): Promise<void> {
  if (runInProgress) return;
  runInProgress = true;
  
  try {
    await ensureCodeChefAccountsSeeded();
    const accounts = await listCodeChefAccounts(true);
    const sourceIndex = await loadCodeChefSourceIndex();
    const today = todayInTimezone();

    if (accounts.length === 0) {
      logger.info('No active CodeChef accounts found.');
      return;
    }

    for (const account of accounts) {
      try {
        const progress = await getCodeChefProgress(account.id);
        
        let currentIndex = progress.nextKey 
          ? sourceIndex.findIndex(e => e.problemCode === progress.nextKey) 
          : (progress.lastCompletedKey 
              ? sourceIndex.findIndex(e => e.problemCode === progress.lastCompletedKey) + 1 
              : 0);
        
        if (currentIndex < 0 || currentIndex >= sourceIndex.length) {
          logger.info({ accountId: account.id }, 'CodeChef source queue exhausted');
          continue;
        }

        const entry = sourceIndex[currentIndex]!;
        
        // Check if we already claimed today
        const claimed = await claimDailyAttempt(account.id, today, entry.problemCode!);
        if (!claimed && progress.lastAttemptDate === today) {
          logger.info({ accountId: account.id }, 'CodeChef daily attempt already made today');
          continue;
        }

        // Validate session or login
        let stateData = JSON.parse(account.storageState);
        let storageState = stateData.cookies && stateData.cookies.length > 0 ? stateData : null;

        if (!storageState) {
          logger.info({ username: stateData.username }, 'Logging in to CodeChef to get cookies');
          storageState = await loginToCodeChef(stateData.username, stateData.password);
          await patchCodeChefAccount(account.id, {
            storageState: JSON.stringify({ ...stateData, cookies: storageState.cookies, origins: storageState.origins }),
            checked: true
          } as any);
        }

        const sourceCode = await fetchSourceCode(entry);
        
        logger.info({ problemCode: entry.problemCode }, 'Submitting to CodeChef');
        const result = await submitToCodeChef(storageState, entry.problemUrl!, sourceCode, entry.language);
        
        if (result.ok) {
           const nextEntry = sourceIndex[currentIndex + 1];
           await completeCurrentProblem(account.id, {
             completedKey: entry.problemCode!,
             nextKey: nextEntry?.problemCode ?? null,
             submissionId: result.submissionId ?? null,
             verdict: result.verdict ?? 'Accepted',
           });
           
           await patchCodeChefAccount(account.id, {
             lastSubmissionDate: today,
             lastSubmissionId: result.submissionId,
             lastVerdict: result.verdict ?? 'Accepted',
             lastError: null,
           });
        } else {
           // If it failed because of login, maybe cookies expired. Clear cookies so next time it logs in.
           if (result.error && result.error.includes('login')) {
             await patchCodeChefAccount(account.id, {
               storageState: JSON.stringify({ username: stateData.username, password: stateData.password, cookies: [] })
             } as any);
           }

           await patchCodeChefAccount(account.id, {
             lastSubmissionDate: today,
             lastVerdict: result.verdict,
             lastError: result.error,
           });
        }
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.message : String(err), accountId: account.id }, 'CodeChef run for account failed');
      }
    }

  } finally {
    runInProgress = false;
  }
}

export function startCodeChefScheduler(): () => void {
  const fallback = config.schedule;
  const hour = fallback.hour;
  const minute = fallback.minute + 10; // offset from Leetcode and Codeforces
  
  const expression = `${minute % 60} ${hour + Math.floor(minute / 60)} * * *`;
  
  const task = cron.schedule(
    expression,
    () => {
      void runCodeChefNow();
    },
    { timezone: fallback.timezone },
  );
  
  logger.info({ expression, timezone: fallback.timezone }, 'CodeChef scheduler armed');
  return () => {
    task.stop();
  };
}
