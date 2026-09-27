import { logger } from '../logger';

/**
 * Shares one solution across every account in a run.
 *
 * The daily question is the same for every account, so the solution only
 * needs to be produced once per (date, question, language, source):
 *
 *   - Concurrent / sequential callers for the same key share ONE in-flight
 *     fetch (no duplicate requests even if accounts ever run in parallel).
 *   - A successful solution is kept for the rest of the day, so a later
 *     re-run (e.g. POST /triggerSubmission) reuses it too.
 *   - A failure is NOT cached: the next account retries, exactly as it would
 *     have before caching existed — a transient walkccc/network error can
 *     never poison every remaining account.
 *   - Entries from other days are dropped automatically.
 */

export interface SolutionKey {
  date: string;
  questionId: string;
  language: string;
  source: string;
}

export class SolutionCache<T> {
  private readonly entries = new Map<string, Promise<T>>();
  private currentDate: string | null = null;

  static keyOf(k: SolutionKey): string {
    return `${k.date}|${k.source}|${k.language}|${k.questionId}`;
  }

  /** Returns the cached solution for `key`, producing it with `produce` at most once. */
  async get(key: SolutionKey, produce: () => Promise<T>): Promise<T> {
    this.pruneOtherDays(key.date);
    const k = SolutionCache.keyOf(key);

    const cached = this.entries.get(k);
    if (cached) {
      logger.info(
        { questionId: key.questionId, source: key.source, language: key.language },
        'reusing solution already fetched for this daily question',
      );
      return cached;
    }

    const pending = produce();
    this.entries.set(k, pending);
    try {
      return await pending;
    } catch (err) {
      // Only drop the entry if it is still ours (not replaced meanwhile).
      if (this.entries.get(k) === pending) this.entries.delete(k);
      throw err;
    }
  }

  has(key: SolutionKey): boolean {
    return this.entries.has(SolutionCache.keyOf(key));
  }

  clear(): void {
    this.entries.clear();
    this.currentDate = null;
  }

  get size(): number {
    return this.entries.size;
  }

  private pruneOtherDays(date: string): void {
    if (this.currentDate === date) return;
    for (const k of [...this.entries.keys()]) {
      if (!k.startsWith(`${date}|`)) this.entries.delete(k);
    }
    this.currentDate = date;
  }
}
