let nextScheduledPostsPollAt = 0;
let nextCoarenaResumePollAt = 0;

/** Returns the current idle-poll cooldown timestamps for the solution-post scheduler. */
export function getSolutionPostSchedulerGate(): {
  nextScheduledPostsPollAt: number;
  nextCoarenaResumePollAt: number;
} {
  return { nextScheduledPostsPollAt, nextCoarenaResumePollAt };
}

/** Sets the next allowed idle-poll timestamp for scheduled daily solution posts. */
export function setNextScheduledPostsPollAt(ts: number): void {
  nextScheduledPostsPollAt = ts;
}

/** Sets the next allowed idle-poll timestamp for paused Coarena article resumptions. */
export function setNextCoarenaResumePollAt(ts: number): void {
  nextCoarenaResumePollAt = ts;
}

/** Wakes the solution-post scheduler immediately on schedule, retry, or wake-endpoint activity. */
export function notifySolutionPostSchedulerWork(): void {
  nextScheduledPostsPollAt = 0;
  nextCoarenaResumePollAt = 0;
}
