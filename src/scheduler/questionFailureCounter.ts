import { getSystemState, setSystemState, SystemKeys } from '../database/models';
import { logger } from '../logger';

/** After 3 failed solution-section attempts, the 4th attempt triggers AI solving. */
export const AI_SOLVE_FAILURE_THRESHOLD = 3;

const MAX_FAILED_UUIDS_PER_QUESTION = 25;
const MAX_TRACKED_QUESTIONS = 2000;

export interface QuestionFailureRecord {
  failures: number;
  failedUuids: string[];
  lastFailureReason?: string;
  updatedAt: string;
}

export interface QuestionFailureStore {
  get(questionNumber: number): Promise<QuestionFailureRecord>;
  recordFailure(
    questionNumber: number,
    update?: { reason?: string; communityUuid?: string },
  ): Promise<QuestionFailureRecord>;
  reset(questionNumber: number): Promise<void>;
}

function emptyRecord(): QuestionFailureRecord {
  return {
    failures: 0,
    failedUuids: [],
    updatedAt: new Date(0).toISOString(),
  };
}

function normalizeRecord(raw: unknown): QuestionFailureRecord {
  if (!raw || typeof raw !== 'object') return emptyRecord();
  const obj = raw as Record<string, unknown>;
  const failures = typeof obj.failures === 'number' && Number.isFinite(obj.failures) && obj.failures >= 0
    ? Math.floor(obj.failures)
    : 0;
  const failedUuids = Array.isArray(obj.failedUuids)
    ? obj.failedUuids.filter((u): u is string => typeof u === 'string' && u.length > 0).slice(-MAX_FAILED_UUIDS_PER_QUESTION)
    : [];
  const lastFailureReason = typeof obj.lastFailureReason === 'string' ? obj.lastFailureReason.slice(0, 200) : undefined;
  const updatedAt = typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString();
  return { failures, failedUuids, ...(lastFailureReason && { lastFailureReason }), updatedAt };
}

function parseStateMap(raw: string | null): Map<string, QuestionFailureRecord> {
  const map = new Map<string, QuestionFailureRecord>();
  if (!raw) return map;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return map;
    for (const [k, v] of Object.entries(parsed)) {
      if (!/^\d+$/.test(k)) continue;
      const rec = normalizeRecord(v);
      if (rec.failures > 0 || rec.failedUuids.length > 0) {
        map.set(k, rec);
      }
    }
  } catch {
    logger.warn('failed to parse persisted question failure counter; starting fresh');
  }
  return map;
}

function serializeStateMap(map: Map<string, QuestionFailureRecord>): string {
  if (map.size > MAX_TRACKED_QUESTIONS) {
    const sorted = [...map.entries()].sort((a, b) => a[1].updatedAt.localeCompare(b[1].updatedAt));
    const excess = map.size - MAX_TRACKED_QUESTIONS;
    for (let i = 0; i < excess; i++) {
      map.delete(sorted[i]![0]);
    }
  }
  return JSON.stringify(Object.fromEntries(map.entries()));
}

/**
 * In-memory failure counter store (used in tests and as graceful fallback when DB is absent).
 */
export function createMemoryQuestionFailureStore(
  initial: Record<number, Partial<QuestionFailureRecord>> = {},
): QuestionFailureStore {
  const state = new Map<string, QuestionFailureRecord>();
  for (const [k, v] of Object.entries(initial)) {
    state.set(k, normalizeRecord(v));
  }

  return {
    async get(questionNumber: number): Promise<QuestionFailureRecord> {
      return state.get(String(questionNumber)) ?? emptyRecord();
    },
    async recordFailure(
      questionNumber: number,
      update: { reason?: string; communityUuid?: string } = {},
    ): Promise<QuestionFailureRecord> {
      const key = String(questionNumber);
      const prev = state.get(key) ?? emptyRecord();
      const uuids = update.communityUuid && !prev.failedUuids.includes(update.communityUuid)
        ? [...prev.failedUuids, update.communityUuid].slice(-MAX_FAILED_UUIDS_PER_QUESTION)
        : [...prev.failedUuids];
      const next: QuestionFailureRecord = {
        failures: prev.failures + 1,
        failedUuids: uuids,
        lastFailureReason: update.reason ?? prev.lastFailureReason,
        updatedAt: new Date().toISOString(),
      };
      state.set(key, next);
      return next;
    },
    async reset(questionNumber: number): Promise<void> {
      state.delete(String(questionNumber));
    },
  };
}

/**
 * Postgres-backed persistent question failure store using `SystemState`.
 * Serializes updates within the process and degrades gracefully to in-memory if DB is unavailable.
 */
export function createDbQuestionFailureStore(): QuestionFailureStore {
  const memoryFallback = createMemoryQuestionFailureStore();
  let queue: Promise<unknown> = Promise.resolve();
  let warnedDbFailure = false;

  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  const loadMap = async (): Promise<Map<string, QuestionFailureRecord> | null> => {
    try {
      const raw = await getSystemState(SystemKeys.questionSolutionFailures);
      return parseStateMap(raw);
    } catch (err) {
      if (!warnedDbFailure) {
        warnedDbFailure = true;
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'question failure counter DB read failed; using in-memory store');
      }
      return null;
    }
  };

  return {
    async get(questionNumber: number): Promise<QuestionFailureRecord> {
      return enqueue(async () => {
        const map = await loadMap();
        if (!map) return memoryFallback.get(questionNumber);
        const rec = map.get(String(questionNumber));
        return rec ?? memoryFallback.get(questionNumber);
      });
    },

    async recordFailure(
      questionNumber: number,
      update: { reason?: string; communityUuid?: string } = {},
    ): Promise<QuestionFailureRecord> {
      return enqueue(async () => {
        const memNext = await memoryFallback.recordFailure(questionNumber, update);
        const map = await loadMap();
        if (!map) return memNext;
        const key = String(questionNumber);
        const prev = map.get(key) ?? emptyRecord();
        const uuids = update.communityUuid && !prev.failedUuids.includes(update.communityUuid)
          ? [...prev.failedUuids, update.communityUuid].slice(-MAX_FAILED_UUIDS_PER_QUESTION)
          : [...prev.failedUuids];
        const next: QuestionFailureRecord = {
          failures: prev.failures + 1,
          failedUuids: uuids,
          lastFailureReason: update.reason ?? prev.lastFailureReason,
          updatedAt: new Date().toISOString(),
        };
        map.set(key, next);
        try {
          await setSystemState(SystemKeys.questionSolutionFailures, serializeStateMap(map));
        } catch (err) {
          logger.warn({ question: questionNumber, err: err instanceof Error ? err.message : String(err) }, 'failed to persist question failure counter to DB');
        }
        return next;
      });
    },

    async reset(questionNumber: number): Promise<void> {
      return enqueue(async () => {
        await memoryFallback.reset(questionNumber);
        const map = await loadMap();
        if (!map) return;
        const key = String(questionNumber);
        if (!map.has(key)) return;
        map.delete(key);
        try {
          await setSystemState(SystemKeys.questionSolutionFailures, serializeStateMap(map));
        } catch (err) {
          logger.warn({ question: questionNumber, err: err instanceof Error ? err.message : String(err) }, 'failed to reset question failure counter in DB');
        }
      });
    },
  };
}
