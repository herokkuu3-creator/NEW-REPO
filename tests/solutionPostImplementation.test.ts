import { expect, it, vi } from 'vitest';
import { contextSchema } from '../src/solutionPosts/article';
import { generateImplementation, implementationFingerprint } from '../src/solutionPosts/implementation';
import { AIModelRouter } from '../src/solutionPosts/router';

const context = contextSchema.parse({ accountId: 'a', username: 'alice', problemId: '1', slug: 'count-ones', title: 'Count Ones',
  difficulty: 'Easy', problem: 'Count occurrences of 1 in a list of integers.', submissionId: '123', language: 'cpp',
  code: 'class Solution { public: int count(vector<int>& nums) { int total = 0; for (int x : nums) { if (x == 1) total++; } return total; } };',
  challengeDate: '2026-11-11' });
const renamed = 'class Solution { public: int count(vector<int>& values) { int answer = 0; /* accumulate */ for (int value : values) if (value == 1) answer++; return answer; } };';
const distinct = { code: 'class Solution { public: int count(vector<int>& nums) { return std::count(nums.begin(), nums.end(), 1); } };',
  approach: 'Count matches with one standard library call.' };

function mockRouter(...outputs: unknown[]) {
  const router = new AIModelRouter({ apiKey: 'test', baseUrl: 'https://example.test', models: ['test'], timeoutMs: 1000, retries: 0, maxTokens: 4096 });
  const generate = vi.spyOn(router, 'generate').mockImplementation(async (_messages, validate, _tokens, _json, stage) => ({
    value: validate(JSON.stringify(outputs.shift())), model: 'test', attempts: [{ model: 'test', attempt: 1, elapsedMs: 1, outcome: 'SUCCESS', stage }],
  }));
  return { router, generate };
}

it('rejects rename, formatting, comment, and brace changes before technical review', async () => {
  const { router, generate } = mockRouter({ ...distinct, code: renamed }, distinct, { issues: [] });
  const reserve = vi.fn(async () => true);
  const result = await generateImplementation(router, context, [], reserve);
  expect(result.value).toEqual(distinct);
  expect(result.attempts.map(attempt => attempt.outcome)).toEqual(['ARTICLE_CODE_TOO_SIMILAR', 'SUCCESS', 'SUCCESS']);
  expect(generate).toHaveBeenCalledTimes(3);
  const review = JSON.parse(generate.mock.calls[2]![0][1]!.content);
  expect(review.source.code).toBe(context.code);
  expect(review.proposedCode).toBe(distinct.code);
  expect(reserve).toHaveBeenCalledOnce();
});

it('rejects an implementation already used for the problem, even when identifiers differ', async () => {
  const duplicate = { ...distinct, code: distinct.code.replaceAll('nums', 'values') };
  const { router, generate } = mockRouter(duplicate, duplicate);
  const reserve = vi.fn(async () => true);
  await expect(generateImplementation(router, context, [distinct], reserve)).rejects.toMatchObject({ lastFailure: 'ARTICLE_CODE_TOO_SIMILAR' });
  expect(generate).toHaveBeenCalledTimes(2);
  expect(reserve).not.toHaveBeenCalled();
});

it('passes reviewer feedback to the next rewrite and fails when another worker has claimed its structure', async () => {
  const { router, generate } = mockRouter(distinct, { issues: ['Use the expected method signature.'] }, distinct, { issues: [] });
  const reserve = vi.fn(async () => false);
  await expect(generateImplementation(router, context, [], reserve)).rejects.toMatchObject({ lastFailure: 'ARTICLE_CODE_TOO_SIMILAR' });
  expect(JSON.parse(generate.mock.calls[2]![0][1]!.content).feedback).toEqual(['Use the expected method signature.']);
  expect(reserve).toHaveBeenCalledOnce();
});

it('handles Python comments without treating floor division as a comment', () => {
  const original = 'def count(self, values):\n    return values[0] // 2';
  const renamed = 'def count(self, nums):\n    return nums[0] // 2  # divide';
  expect(implementationFingerprint(original, 'python3')).toBe(implementationFingerprint(renamed, 'python3'));
  expect(implementationFingerprint(original, 'python3')).not.toBe(implementationFingerprint(original.replace('//', '/'), 'python3'));
});
