let dailyRetryNextPollAt = 0;
let dailyRetryCompletedDate: string | null = null;

/** Returns the current LeetCode daily-retry poll cooldown and completion latch. */
export function getDailyRetryPollGate(): { nextPollAt: number; completedDate: string | null } {
  return { nextPollAt: dailyRetryNextPollAt, completedDate: dailyRetryCompletedDate };
}

/** Sets the next allowed idle-poll timestamp for LeetCode daily retries. */
export function setDailyRetryNextPollAt(nextPollAt: number): void {
  dailyRetryNextPollAt = nextPollAt;
}

/** Latches LeetCode daily retries as finished for the given UTC challenge day. */
export function setDailyRetryCompletedDate(date: string | null): void {
  dailyRetryCompletedDate = date;
}

/** Clears the LeetCode daily-retry poll gate when accounts or sessions change. */
export function resetDailyRetryPollGate(): void {
  dailyRetryNextPollAt = 0;
  dailyRetryCompletedDate = null;
}
