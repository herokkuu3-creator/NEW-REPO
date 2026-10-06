import { describe, expect, it } from 'vitest';
import { RunState } from '@prisma/client';
import { isPastScheduledDailyTime, leetcodeDayKey, shouldSkipExistingDailyRun, todayInTimezone } from '../src/scheduler/dailyWorker';

describe('session-renewal daily dedupe', () => {
  it('does not re-submit an account whose daily submission already succeeded during cookie renewal', () => {
    expect(
      shouldSkipExistingDailyRun(
        { state: RunState.SUCCESS, submissionStatus: 'Accepted' },
        false,
        true,
      ),
    ).toBe(true);
  });

  it('does not re-submit an account with a pending daily run during cookie renewal', () => {
    expect(
      shouldSkipExistingDailyRun(
        { state: RunState.PENDING, submissionStatus: null },
        false,
        true,
      ),
    ).toBe(true);
  });

  it('does not re-submit an account whose earlier submission was already rejected during cookie renewal', () => {
    expect(
      shouldSkipExistingDailyRun(
        { state: RunState.SUBMISSION_REJECTED, submissionStatus: 'Wrong Answer' },
        false,
        true,
      ),
    ).toBe(true);
  });

  it('does not re-submit an account whose earlier daily attempt failed during cookie renewal', () => {
    expect(
      shouldSkipExistingDailyRun(
        { state: RunState.SUBMISSION_ERROR, submissionStatus: null },
        false,
        true,
      ),
    ).toBe(true);
  });

  it('allows a new account or an expired account whose daily run never created a row to run after renewal', () => {
    expect(shouldSkipExistingDailyRun(null, false, true)).toBe(false);
  });

  it('keeps the existing retry behavior for non-renewal runs', () => {
    expect(
      shouldSkipExistingDailyRun(
        { state: RunState.PENDING, submissionStatus: null },
        false,
      ),
    ).toBe(false);

    expect(
      shouldSkipExistingDailyRun(
        { state: RunState.SUBMISSION_ERROR, submissionStatus: null },
        false,
      ),
    ).toBe(false);

    expect(
      shouldSkipExistingDailyRun(
        { state: RunState.SUCCESS, submissionStatus: 'SOLVED_NOT_SUBMITTED' },
        false,
      ),
    ).toBe(false);
  });

  it('preserves the explicit force behavior for /triggersubmission', () => {
    expect(
      shouldSkipExistingDailyRun(
        { state: RunState.SUCCESS, submissionStatus: 'Accepted' },
        true,
      ),
    ).toBe(false);
  });

  it('skips a normal run only with proof for the current daily problem', () => {
    expect(shouldSkipExistingDailyRun(
      { state: RunState.SUCCESS, submissionStatus: 'Accepted', submissionId: '123', problemSlug: 'today' },
      false,
      false,
      'today',
    )).toBe(true);
    expect(shouldSkipExistingDailyRun(
      { state: RunState.SUCCESS, submissionStatus: 'Accepted', submissionId: '123', problemSlug: 'yesterday' },
      false,
      false,
      'today',
    )).toBe(false);
    expect(shouldSkipExistingDailyRun(
      { state: RunState.SUCCESS, submissionStatus: 'Accepted', submissionId: null, problemSlug: 'today' },
      false,
      false,
      'today',
    )).toBe(false);
  });

  it('uses LeetCode UTC midnight instead of IST midnight for the daily key', () => {
    expect(leetcodeDayKey(new Date('2026-10-04T19:30:00.000Z'))).toBe('2026-10-04');
    expect(leetcodeDayKey(new Date('2026-10-05T00:00:00.000Z'))).toBe('2026-10-05');
  });

  it('prevents daily retry from triggering early before the scheduled run time', () => {
    // 00:00 UTC (05:30 IST) when challenge rotates - NOT past 09:00 IST scheduled time
    expect(isPastScheduledDailyTime(new Date('2026-10-06T00:00:00.000Z'))).toBe(false);
    // 03:00 UTC (08:30 IST) - NOT past 09:00 IST
    expect(isPastScheduledDailyTime(new Date('2026-10-06T03:00:00.000Z'))).toBe(false);
    // 03:29 UTC (08:59 IST) - NOT past 09:00 IST
    expect(isPastScheduledDailyTime(new Date('2026-10-06T03:29:00.000Z'))).toBe(false);
    // 03:30 UTC (09:00 IST) - exactly scheduled time
    expect(isPastScheduledDailyTime(new Date('2026-10-06T03:30:00.000Z'))).toBe(true);
    // 03:35 UTC (09:05 IST) - after scheduled time (valid recovery window)
    expect(isPastScheduledDailyTime(new Date('2026-10-06T03:35:00.000Z'))).toBe(true);
    // 19:00 UTC (00:30 IST next day, but previous UTC day) - day key mismatch
    expect(isPastScheduledDailyTime(new Date('2026-10-05T19:00:00.000Z'))).toBe(false);
  });
});
