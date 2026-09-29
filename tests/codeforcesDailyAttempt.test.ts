import { describe, expect, it } from 'vitest';
import { shouldReleaseDailyAttempt } from '../src/codeforces/dailyGate';

/** The reported bug: a failed attempt consumed the whole day. */
describe('shouldReleaseDailyAttempt', () => {
  const today = '2026-09-29';

  it('always retries on a manual trigger, even after a success', () => {
    expect(shouldReleaseDailyAttempt({ manual: true, lastAttemptDate: today, lastVerdict: 'OK', today })).toBe(true);
    expect(shouldReleaseDailyAttempt({ manual: true, lastAttemptDate: today, lastVerdict: null, today })).toBe(true);
  });

  it('retries an automatic run when today did not succeed', () => {
    expect(
      shouldReleaseDailyAttempt({ manual: false, lastAttemptDate: today, lastVerdict: 'SUBMISSION_ERROR', today }),
    ).toBe(true);
    expect(shouldReleaseDailyAttempt({ manual: false, lastAttemptDate: today, lastVerdict: null, today })).toBe(true);
    expect(shouldReleaseDailyAttempt({ manual: false, lastAttemptDate: today, lastVerdict: 'WRONG_ANSWER', today })).toBe(true);
  });

  it('keeps the throttle after a successful attempt today', () => {
    expect(shouldReleaseDailyAttempt({ manual: false, lastAttemptDate: today, lastVerdict: 'OK', today })).toBe(false);
  });

  it('leaves another day alone', () => {
    expect(shouldReleaseDailyAttempt({ manual: false, lastAttemptDate: '2026-09-28', lastVerdict: null, today })).toBe(false);
    expect(shouldReleaseDailyAttempt({ manual: false, lastAttemptDate: null, lastVerdict: null, today })).toBe(false);
  });
});
