import { Prisma, RunState } from '@prisma/client';
import { prisma } from './prisma';

export { RunState };

/** Terminal and non-terminal states for a daily execution. */
export const TERMINAL_STATES: ReadonlySet<RunState> = new Set([
  RunState.AUTHENTICATION_REQUIRED,
  RunState.CLOUDFLARE_VERIFICATION_REQUIRED,
  RunState.DAILY_PROBLEM_NOT_FOUND,
  RunState.PROBLEM_PARSE_FAILED,
  RunState.LLM_ERROR,
  RunState.SOLUTION_VALIDATION_FAILED,
  RunState.SUBMISSION_ERROR,
  RunState.SUBMISSION_REJECTED,
  RunState.SUCCESS,
]);

export interface DailyRunCreateInput {
  date: string; // YYYY-MM-DD in configured timezone
  problemSlug: string;
  title: string;
  difficulty: string;
  language: string;
}

export type DailyRunRecord = Prisma.DailyRunGetPayload<Record<string, never>>;

/**
 * Returns today's run if it exists. Used before any processing to make
 * duplicate submissions impossible — even across restarts or double-fires
 * of the cron trigger, the unique `date` constraint is the backstop.
 */
export async function findRunByDate(date: string): Promise<DailyRunRecord | null> {
  return prisma.dailyRun.findUnique({ where: { date } });
}

export async function createRun(input: DailyRunCreateInput): Promise<DailyRunRecord> {
  return prisma.dailyRun.create({
    data: { ...input, state: RunState.PENDING },
  });
}

export async function updateRun(
  id: string,
  data: Prisma.DailyRunUpdateInput,
): Promise<DailyRunRecord> {
  return prisma.dailyRun.update({ where: { id }, data });
}

export async function finalizeRun(
  id: string,
  state: RunState,
  extra: Prisma.DailyRunUpdateInput = {},
): Promise<DailyRunRecord> {
  return updateRun(id, { ...extra, state });
}

export async function latestRun(): Promise<DailyRunRecord | null> {
  return prisma.dailyRun.findFirst({ orderBy: { createdAt: 'desc' } });
}

// --- SystemState (key/value) ----------------------------------------------

export const SystemKeys = {
  authStatus: 'authStatus', // 'ok' | 'authentication_required' | 'unknown'
  authUsername: 'authUsername',
  authNotifiedAt: 'authNotifiedAt', // YYYY-MM-DD of the last session-expired alert (dedupe)
  lastError: 'lastError',
  lastRunSummary: 'lastRunSummary',
  storageState: 'storageStateJson', // Playwright storageState snapshot (DB-persisted)
} as const;

/**
 * storageState persistence in Postgres.
 *
 * Render's FREE tier has no persistent disks and no shell access, so the
 * storageState snapshot — the fallback credential — lives in the database
 * instead of on disk. On paid tiers this is harmless redundancy.
 */
export async function saveStorageStateToDb(json: string): Promise<void> {
  await setSystemState(SystemKeys.storageState, json);
}

export async function loadStorageStateFromDb(): Promise<string | null> {
  return getSystemState(SystemKeys.storageState);
}

export async function setSystemState(key: string, value: string): Promise<void> {
  await prisma.systemState.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

export async function getSystemState(key: string): Promise<string | null> {
  const row = await prisma.systemState.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function getAllSystemState(): Promise<Record<string, string>> {
  const rows = await prisma.systemState.findMany();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
