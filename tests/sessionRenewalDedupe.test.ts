import { describe, expect, it } from 'vitest';
import { RunState } from '@prisma/client';
import { shouldSkipExistingDailyRun } from '../src/scheduler/dailyWorker';

describe('session-renewal daily dedupe', () => {
  it('skips an account whose daily submission already succeeded', () => {
    expect(
      shouldSkipExistingDailyRun(
        { state: RunState.SUCCESS, submissionStatus: 'Accepted' },
        false, // session-renewal does not force a repeat
      ),
    ).toBe(true);
  });

  it('skips a pending daily run instead of submitting a duplicate on renewal', () => {
    expect(
      shouldSkipExistingDailyRun(
        { state: RunState.PENDING, submissionStatus: null },
        false,
      ),
    ).toBe(true);
  });

  it('allows a renewal-triggered run when there is no daily row yet', () => {
    expect(shouldSkipExistingDailyRun(null, false)).toBe(false);
  });

  it('allows a renewal-triggered retry when the earlier run reached the solution but did not submit', () => {
    expect(
      shouldSkipExistingDailyRun(
        { state: RunState.SUCCESS, submissionStatus: 'SOLVED_NOT_SUBMITTED' },
        false,
      ),
    ).toBe(false);

    expect(
      shouldSkipExistingDailyRun(
        { state: RunState.SUCCESS, submissionStatus: 'EDITOR_FILLED' },
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

  it('allows a renewed account with a prior non-success terminal run to follow the normal pipeline', () => {
    expect(
      shouldSkipExistingDailyRun(
        { state: RunState.SUBMISSION_ERROR, submissionStatus: null },
        false,
      ),
    ).toBe(false);

    expect(
      shouldSkipExistingDailyRun(
        { state: RunState.AUTHENTICATION_REQUIRED, submissionStatus: null },
        false,
      ),
    ).toBe(false);
  });
});
