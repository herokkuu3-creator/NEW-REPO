import { describe, expect, it } from 'vitest';
import { isTerminalCodeforcesVerdict, shouldReleaseDailyAttempt } from '../src/codeforces/dailyGate';
import { isAfterCodeforcesSchedule, isAlreadySubmittedCodeError } from '../src/codeforces/worker';

/** The reported bug: a failed attempt consumed the whole day. */
describe('shouldReleaseDailyAttempt', () => {
  const today = '2026-09-29';

  it('always retries on a manual trigger, even after a success', () => {
    expect(shouldReleaseDailyAttempt({ manual: true, lastAttemptDate: today, lastVerdict: 'OK', today })).toBe(true);
    expect(shouldReleaseDailyAttempt({ manual: true, lastAttemptDate: today, lastVerdict: null, today })).toBe(true);
  });

  it('retries an automatic run when today has no submitted final verdict', () => {
    expect(
      shouldReleaseDailyAttempt({ manual: false, lastAttemptDate: today, lastVerdict: 'SUBMISSION_ERROR', today }),
    ).toBe(true);
    expect(shouldReleaseDailyAttempt({ manual: false, lastAttemptDate: today, lastVerdict: null, today })).toBe(true);
    expect(shouldReleaseDailyAttempt({ manual: false, lastAttemptDate: today, lastVerdict: 'TESTING', today })).toBe(true);
  });

  it('keeps the throttle after every final verdict today', () => {
    for (const verdict of ['OK', 'WRONG_ANSWER', 'TIME_LIMIT_EXCEEDED', 'RUNTIME_ERROR', 'COMPILATION_ERROR', 'DUPLICATE_CODE']) {
      expect(isTerminalCodeforcesVerdict(verdict)).toBe(true);
      expect(shouldReleaseDailyAttempt({ manual: false, lastAttemptDate: today, lastVerdict: verdict, today })).toBe(false);
    }
    for (const verdict of ['TESTING', 'QUEUE', 'QUEUED', 'RUNNING', 'SUBMISSION_ERROR']) {
      expect(isTerminalCodeforcesVerdict(verdict)).toBe(false);
    }
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
