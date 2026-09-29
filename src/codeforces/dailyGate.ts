/**
 * The once-per-day attempt is a scheduler throttle, not a trap. A manual
 * trigger always retries; an automatic run retries only when today's attempt
 * did not succeed, so a failed attempt can never cost an account its whole day.
 */
export function shouldReleaseDailyAttempt(input: {
  manual: boolean;
  lastAttemptDate: string | null;
  lastVerdict: string | null;
  today: string;
}): boolean {
  if (input.manual) return true;
  return input.lastAttemptDate === input.today && input.lastVerdict !== 'OK';
}
