let ccRetryNextPollAt = 0;
let ccRetryCompletedDate: string | null = null;

/** Returns the current CodeChef retry poll cooldown and completion latch. */
export function getCodeChefRetryPollGate(): { nextPollAt: number; completedDate: string | null } {
  return { nextPollAt: ccRetryNextPollAt, completedDate: ccRetryCompletedDate };
}

/** Sets the next allowed idle-poll timestamp for CodeChef automatic daily retries. */
export function setCodeChefRetryNextPollAt(nextPollAt: number): void {
  ccRetryNextPollAt = nextPollAt;
}

/** Latches CodeChef automatic daily retries as finished for the given date. */
export function setCodeChefRetryCompletedDate(date: string | null): void {
  ccRetryCompletedDate = date;
}

/** Clears the CodeChef retry poll gate on account seeding or manual triggers. */
export function resetCodeChefRetryPollGate(): void {
  ccRetryNextPollAt = 0;
  ccRetryCompletedDate = null;
}
