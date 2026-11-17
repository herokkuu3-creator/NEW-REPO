let cfRetryNextPollAt = 0;
let cfRetryCompletedDate: string | null = null;

/** Returns the current Codeforces retry poll cooldown and completion latch. */
export function getCodeforcesRetryPollGate(): { nextPollAt: number; completedDate: string | null } {
  return { nextPollAt: cfRetryNextPollAt, completedDate: cfRetryCompletedDate };
}

/** Sets the next allowed idle-poll timestamp for Codeforces automatic daily retries. */
export function setCodeforcesRetryNextPollAt(nextPollAt: number): void {
  cfRetryNextPollAt = nextPollAt;
}

/** Latches Codeforces automatic daily retries as finished for the given date. */
export function setCodeforcesRetryCompletedDate(date: string | null): void {
  cfRetryCompletedDate = date;
}

/** Clears the Codeforces retry poll gate on account saves or manual/admin triggers. */
export function resetCodeforcesRetryPollGate(): void {
  cfRetryNextPollAt = 0;
  cfRetryCompletedDate = null;
}
