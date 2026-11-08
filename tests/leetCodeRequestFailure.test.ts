import { expect, it } from 'vitest';
import { LeetCodeHttpError, leetCodeRequestFailure, looksLikeChallenge, isSubmissionLimitError } from '../src/leetcode/apiClient';
it('distinguishes CSRF rejection, transient server throttling, HTML verification and actual quota', () => {
  const csrf = new LeetCodeHttpError('submit HTTP 403: CSRF verification failed', 403);
  expect(leetCodeRequestFailure(csrf).category).toBe('session-csrf'); expect(looksLikeChallenge(csrf)).toBe(false);
  const rate = new LeetCodeHttpError('GraphQL HTTP 429', 429);
  expect(leetCodeRequestFailure(rate).category).toBe('rate-limit'); expect(isSubmissionLimitError(rate)).toBe(false);
  expect(leetCodeRequestFailure(new LeetCodeHttpError('submit HTTP 403: <!DOCTYPE html> Just a moment', 403)).category).toBe('challenge');
  expect(leetCodeRequestFailure(Error('submit rejected: You have reached the submission limit for today.')).category).toBe('submission-limit');
  expect(looksLikeChallenge(new LeetCodeHttpError('submit response contained no submission_id'))).toBe(false);
  expect(isSubmissionLimitError(Error('submission limit; try again in 10 seconds'))).toBe(false);
  expect(looksLikeChallenge(Error('submit rejected: You are submitting too fast, please try again later'))).toBe(true);
});
