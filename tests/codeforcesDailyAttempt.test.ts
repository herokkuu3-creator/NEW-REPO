import { describe, expect, it } from 'vitest';
import { shouldReleaseDailyAttempt } from '../src/codeforces/dailyGate';
import { isAfterCodeforcesSchedule, isAlreadySubmittedCodeError } from '../src/codeforces/worker';

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

describe('duplicate Codeforces submissions', () => {
  it('recognizes the duplicate-code response even when no submission ID exists', () => {
    expect(isAlreadySubmittedCodeError('You have submitted exactly the same code before')).toBe(true);
    expect(isAlreadySubmittedCodeError('Codeforces verdict: WRONG_ANSWER')).toBe(false);
  });
});

describe('automatic Codeforces retry window', () => {
  it('starts retries only after the configured daily time', () => {
    expect(isAfterCodeforcesSchedule(new Date('2026-10-05T03:44:00.000Z'), 9, 15, 'Asia/Kolkata')).toBe(false);
    expect(isAfterCodeforcesSchedule(new Date('2026-10-05T03:45:00.000Z'), 9, 15, 'Asia/Kolkata')).toBe(false);
    expect(isAfterCodeforcesSchedule(new Date('2026-10-05T03:50:00.000Z'), 9, 15, 'Asia/Kolkata')).toBe(true);
  });
});
