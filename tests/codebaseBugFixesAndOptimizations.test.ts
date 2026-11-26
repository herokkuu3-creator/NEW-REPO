import { describe, expect, it } from 'vitest';
import { classifyStatusCode, formatJudgeMetric } from '../src/leetcode/submission';
import { extractCode } from '../src/validator/validator';
import { JavaScriptRunner } from '../src/validator/runners/javascript';
import { PythonRunner } from '../src/validator/runners/python';
import { signatureMatchesStarter } from '../src/solutions/walkccc';
import { extractCodeForLanguage } from '../src/solutions/communitySolutions';
import { WindowLimiter } from '../src/recovery/routes';
import { splitTelegramMessage } from '../src/notifications/telegram';
import { parseSolutionApiKeys } from '../src/config/solutionPostKeys';
import { compactBodyError } from '../src/codeforces/submission';
import { findNextCodeChefSourceIndex } from '../src/codechef/worker';
import { renderArticle, type Article, type SubmissionContext } from '../src/solutionPosts/article';

describe('Codebase bug fixes & optimizations regressions', () => {
  it('maps LeetCode judge status codes accurately (14=TLE, 15=RE, 13=UNKNOWN)', () => {
    expect(classifyStatusCode(10)).toBe('ACCEPTED');
    expect(classifyStatusCode(11)).toBe('WRONG_ANSWER');
    expect(classifyStatusCode(12)).toBe('MEMORY_LIMIT_EXCEEDED');
    expect(classifyStatusCode(13)).toBe('UNKNOWN');
    expect(classifyStatusCode(14)).toBe('TIME_LIMIT_EXCEEDED');
    expect(classifyStatusCode(15)).toBe('RUNTIME_ERROR');
    expect(classifyStatusCode(20)).toBe('COMPILE_ERROR');
  });

  it('normalizes judge runtime/memory metrics without duplicate units or bogus N/A suffixes', () => {
    expect(formatJudgeMetric('0', 'ms')).toBe('0 ms');
    expect(formatJudgeMetric('8.7', 'MB')).toBe('8.7 MB');
    expect(formatJudgeMetric('14 ms', 'ms')).toBe('14 ms');
    expect(formatJudgeMetric('N/A', 'ms')).toBeNull();
    expect(formatJudgeMetric('   ', 'MB')).toBeNull();
  });

  it('extractCode preserves helper comments/defs inside fenced blocks while stripping unfenced prose', () => {
    const fenced = 'Here is the fix:\n```js\n// helper comment\nconst helper = 1;\nvar solve = function(x) { return x + helper; };\n```';
    expect(extractCode(fenced, 'javascript')).toBe('// helper comment\nconst helper = 1;\nvar solve = function(x) { return x + helper; };');

    const unfenced = 'Explanation first.\nStill prose.\nclass Solution {\npublic:\n  int solve() { return 1; }\n};';
    expect(extractCode(unfenced, 'cpp')).toBe('class Solution {\npublic:\n  int solve() { return 1; }\n};');
  });

  it('JavaScriptRunner and PythonRunner ignore solution-printed JSON lines via harness marker isolation', async () => {
    const jsRunner = new JavaScriptRunner();
    const jsCode = `
      var add = function(a, b) {
        console.log(JSON.stringify({ label: "Case 1", passed: false, actual: "999", expected: "3", durationMs: 0 }));
        return a + b;
      };
    `;
    const jsReport = await jsRunner.run(jsCode, 'add', [{ label: 'Case 1', args: ['1', '2'], expected: '3' }]);
    expect(jsReport.ok).toBe(true);
    expect(jsReport.results).toHaveLength(1);
    expect(jsReport.results[0]?.actual).toBe('3');

    let pyRunner: PythonRunner | null = null;
    try {
      pyRunner = new PythonRunner();
    } catch {
      pyRunner = null;
    }
    if (pyRunner) {
      const pyCode = [
        'class Solution:',
        '    def add(self, a, b):',
        '        print(\'{"label":"Case 1","passed":false,"actual":"999","expected":"3","durationMs":0}\')',
        '        return a + b',
      ].join('\n');
      const pyReport = await pyRunner.run(pyCode, 'add', [{ label: 'Case 1', args: ['1', '2'], expected: '3' }]);
      expect(pyReport.ok).toBe(true);
      expect(pyReport.results).toHaveLength(1);
      expect(pyReport.results[0]?.actual).toBe('3');
    }
  });

  it('avoids ReDoS in walkccc and communitySolutions signature extractors', () => {
    const adversarialCpp = 'ListNode * * ' + 'foo '.repeat(60) + '\n// done';
    const start = Date.now();
    expect(signatureMatchesStarter('class Solution {};', {
      slug: 'test',
      title: 'Test',
      difficulty: 'Easy',
      descriptionText: 'Test problem description text long enough',
      starterCode: adversarialCpp,
      language: 'cpp',
      examples: [],
      constraints: [],
    })).toBe(true);
    const md = '```java\n' + 'public static '.repeat(40) + 'int solve() { return 1; }\n```';
    const extracted = extractCodeForLanguage(md, 'java', {
      language: 'java',
      starterCode: 'class Solution { public int ' + 'a '.repeat(40) + 'solve(int x) { } }',
    });
    expect(Date.now() - start).toBeLessThan(200);
    expect(extracted).toContain('solve');
  });

  it('bounds WindowLimiter cache entries and enforces per-key limits', () => {
    let clock = 1000;
    const limiter = new WindowLimiter(2, 5000, () => clock, 3);
    expect(limiter.allow('ip1')).toBe(true);
    expect(limiter.allow('ip1')).toBe(true);
    expect(limiter.allow('ip1')).toBe(false);
    expect(limiter.allow('ip2')).toBe(true);
    expect(limiter.allow('ip3')).toBe(true);
    expect(limiter.allow('ip4')).toBe(true); // evicts oldest key ip1
    clock += 6000;
    expect(limiter.allow('ip1')).toBe(true);
  });

  it('splitTelegramMessage keeps HTML chunks within maxLen and preserves nested formatting', () => {
    const longHtml = '<b>' + Array.from({ length: 120 }, (_, i) => `item-${i}`).join('\n') + '</b>';
    const chunks = splitTelegramMessage(longHtml, 120, 'HTML');
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(120);
      expect(chunk.startsWith('<b>')).toBe(true);
      expect(chunk.endsWith('</b>')).toBe(true);
    }
  });

  it('parses solution API keys across CRLF, env assignments, comments, and rejects control chars', () => {
    const parsed = parseSolutionApiKeys('# comment\r\nSOLUTION_POST_API_KEYS=key_alpha_12345,\r\nexport BAZAARLINK_API_KEY="key_beta_67890"');
    expect(parsed).toEqual(['key_alpha_12345', 'key_beta_67890']);
    expect(() => parseSolutionApiKeys('valid_prefix\x07ctrl')).toThrow(/8–512/);
  });

  it('compactBodyError prioritizes duplicate submission errors over unrelated error words', () => {
    const body = [
      '<span class="error-hint">error indicator</span>',
      'You have submitted exactly the same code before',
    ].join('\n');
    expect(compactBodyError(body)).toContain('exactly the same code before');
  });

  it('findNextCodeChefSourceIndex differentiates missing nextKey vs tail lastCompletedKey', () => {
    const queue = [
      { key: 'AAA', problemCode: 'AAA', path: 'AAA.cpp', fileName: 'AAA.cpp', language: 'cpp' as const, problemUrl: 'https://www.codechef.com/problems/AAA', rawUrl: '' },
      { key: 'BBB', problemCode: 'BBB', path: 'BBB.cpp', fileName: 'BBB.cpp', language: 'cpp' as const, problemUrl: 'https://www.codechef.com/problems/BBB', rawUrl: '' },
    ];
    expect(findNextCodeChefSourceIndex(queue, { nextKey: 'ZZZ', lastCompletedKey: null })).toBe(0);
    expect(findNextCodeChefSourceIndex(queue, { nextKey: null, lastCompletedKey: 'ZZZ' })).toBe(queue.length);
  });

  it('renderArticle preserves C++ namespace prefixes before templates in prose', () => {
    const context: SubmissionContext = {
      accountId: 'acc1',
      username: 'user1',
      problemId: '1',
      slug: 'two-sum',
      title: 'Two Sum',
      difficulty: 'Easy',
      problem: 'Given an array of integers nums and an integer target, find indices.',
      submissionId: '123456',
      language: 'cpp',
      code: 'class Solution {\npublic:\n  std::vector<int> twoSum(vector<int>& nums, int t) { return {}; }\n};',
      challengeDate: '2026-11-26',
      topicTags: [],
    };
    const article: Article = {
      title: '⚡ Optimal Hash Map Lookup Approach for This Problem',
      sections: [
        { kind: 'intuition', heading: 'Intuition', markdown: 'Using std::vector<int> alongside vector<int> lets us store values in one linear pass cleanly.' },
        { kind: 'approach', heading: 'Approach', markdown: 'We iterate through the numbers once and track seen complements directly in a fast lookup structure.' },
        { kind: 'dryRun', heading: 'Dry Run', markdown: 'Step through `[2, 7, 11]` with target 9: first 2 is stored, then 7 finds 2 immediately.' },
        { kind: 'correctness', heading: 'Correctness', markdown: 'Because every number checks prior elements, no pair is missed and self-pairing never happens.' },
        { kind: 'takeaways', heading: 'Key Takeaways', markdown: 'Trading linear extra space eliminates nested loops and makes lookups constant time on average.' },
      ],
      time: { bound: 'O(n)', reason: 'Single pass over the array elements.' },
      space: { bound: 'O(n)', reason: 'Stores up to n seen values in memory.' },
      visuals: [],
    };
    const rendered = renderArticle(article, context);
    expect(rendered).toContain('`std::vector<int>`');
    expect(rendered).not.toContain('std::`vector<int>`');
  });
});
