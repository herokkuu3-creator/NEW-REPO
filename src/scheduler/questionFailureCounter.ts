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

interface DirtyQuestionEntry {
  deltaFailures: number;
  failedUuids: string[];
  lastFailureReason?: string;
  updatedAt: string;
  resetPending: boolean;
}

function mergeRecord(
  dbRec: QuestionFailureRecord | undefined,
  dirtyEntry: DirtyQuestionEntry | undefined,
): QuestionFailureRecord {
  if (!dirtyEntry) return dbRec ?? emptyRecord();
  if (dirtyEntry.resetPending) {
    return {
      failures: dirtyEntry.deltaFailures,
      failedUuids: [...dirtyEntry.failedUuids].slice(-MAX_FAILED_UUIDS_PER_QUESTION),
      ...(dirtyEntry.lastFailureReason && { lastFailureReason: dirtyEntry.lastFailureReason }),
      updatedAt: dirtyEntry.updatedAt,
    };
  }
  const base = dbRec ?? emptyRecord();
  const mergedUuids = [...base.failedUuids];
  for (const uuid of dirtyEntry.failedUuids) {
    if (!mergedUuids.includes(uuid)) {
      mergedUuids.push(uuid);
    }
  }
  const lastFailureReason = dirtyEntry.lastFailureReason ?? base.lastFailureReason;
  return {
    failures: base.failures + dirtyEntry.deltaFailures,
    failedUuids: mergedUuids.slice(-MAX_FAILED_UUIDS_PER_QUESTION),
    ...(lastFailureReason && { lastFailureReason }),
    updatedAt: dirtyEntry.updatedAt,
  };
}

/**
 * Postgres-backed persistent question failure store using `SystemState`.
 * Serializes updates within the process and degrades gracefully to in-memory
 * dirty delta tracking only for unpersisted outage updates.
 */
export function createDbQuestionFailureStore(): QuestionFailureStore {
  const dirty = new Map<string, DirtyQuestionEntry>();
  let lastDbSnapshot = new Map<string, QuestionFailureRecord>();
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
      const parsed = parseStateMap(raw);
      lastDbSnapshot = new Map(parsed);
      return parsed;
    } catch (err) {
      if (!warnedDbFailure) {
        warnedDbFailure = true;
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'question failure counter DB read failed; using unpersisted dirty outage map');
      }
      return null;
    }
  };

  const applyDirtyToMap = (
    map: Map<string, QuestionFailureRecord>,
    overrideKey?: string,
    overrideEntry?: DirtyQuestionEntry,
  ): void => {
    for (const [dKey, dEntry] of dirty.entries()) {
      if (dKey === overrideKey) continue;
      const merged = mergeRecord(map.get(dKey), dEntry);
      if (merged.failures > 0 || merged.failedUuids.length > 0) {
        map.set(dKey, merged);
      } else {
        map.delete(dKey);
      }
    }
    if (overrideKey !== undefined && overrideEntry !== undefined) {
      const merged = mergeRecord(map.get(overrideKey), overrideEntry);
      if (merged.failures > 0 || merged.failedUuids.length > 0) {
        map.set(overrideKey, merged);
      } else {
        map.delete(overrideKey);
      }
    }
  };

  return {
    async get(questionNumber: number): Promise<QuestionFailureRecord> {
      return enqueue(async () => {
        const key = String(questionNumber);
        const map = await loadMap();
        const dbRec = map ? map.get(key) : lastDbSnapshot.get(key);
        return mergeRecord(dbRec, dirty.get(key));
      });
    },

    async recordFailure(
      questionNumber: number,
      update: { reason?: string; communityUuid?: string } = {},
    ): Promise<QuestionFailureRecord> {
      return enqueue(async () => {
        const key = String(questionNumber);
        const prevDirty = dirty.get(key);
        const uuids = update.communityUuid && !(prevDirty?.failedUuids ?? []).includes(update.communityUuid)
          ? [...(prevDirty?.failedUuids ?? []), update.communityUuid].slice(-MAX_FAILED_UUIDS_PER_QUESTION)
          : [...(prevDirty?.failedUuids ?? [])];
        const nextDirty: DirtyQuestionEntry = {
          deltaFailures: (prevDirty?.deltaFailures ?? 0) + 1,
          failedUuids: uuids,
          lastFailureReason: update.reason ?? prevDirty?.lastFailureReason,
          updatedAt: new Date().toISOString(),
          resetPending: prevDirty?.resetPending ?? false,
        };

        const map = await loadMap();
        if (!map) {
          dirty.set(key, nextDirty);
          return mergeRecord(lastDbSnapshot.get(key), nextDirty);
        }

        const next = mergeRecord(map.get(key), nextDirty);
        applyDirtyToMap(map, key, nextDirty);
        try {
          await setSystemState(SystemKeys.questionSolutionFailures, serializeStateMap(map));
          dirty.clear();
          lastDbSnapshot = new Map(map);
        } catch (err) {
          dirty.set(key, nextDirty);
          logger.warn({ question: questionNumber, err: err instanceof Error ? err.message : String(err) }, 'failed to persist question failure counter to DB');
        }
        return next;
      });
    },

    async reset(questionNumber: number): Promise<void> {
      return enqueue(async () => {
        const key = String(questionNumber);
        const resetEntry: DirtyQuestionEntry = {
          deltaFailures: 0,
          failedUuids: [],
          updatedAt: new Date().toISOString(),
          resetPending: true,
        };
        const map = await loadMap();
        if (!map) {
          dirty.set(key, resetEntry);
          lastDbSnapshot.delete(key);
          return;
        }
        const hadKeyInDb = map.has(key);
        const hasOtherDirty = Array.from(dirty.keys()).some((k) => k !== key);
        if (!hadKeyInDb && !hasOtherDirty) {
          dirty.delete(key);
          return;
        }
        applyDirtyToMap(map, key, resetEntry);
        try {
          await setSystemState(SystemKeys.questionSolutionFailures, serializeStateMap(map));
          dirty.clear();
          lastDbSnapshot = new Map(map);
        } catch (err) {
          dirty.set(key, resetEntry);
          logger.warn({ question: questionNumber, err: err instanceof Error ? err.message : String(err) }, 'failed to reset question failure counter in DB');
        }
      });
    },
  };
}
