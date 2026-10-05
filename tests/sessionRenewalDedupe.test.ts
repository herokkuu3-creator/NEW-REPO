import { describe, expect, it } from 'vitest';
import { RunState } from '@prisma/client';
import { shouldSkipExistingDailyRun } from '../src/scheduler/dailyWorker';

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
});
