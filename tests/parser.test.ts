import { describe, expect, it } from 'vitest';
import {
  extractConstraints,
  extractExamples,
  htmlToText,
  parseProblem,
  ProblemParseError,
} from '../src/leetcode/parser';
import type { RawQuestionData } from '../src/leetcode/dailyChallenge';

const TWO_SUM_HTML = `
<p>Given an array of integers <code>nums</code> and an integer <code>target</code>, return <em>indices of the two numbers such that they add up to <code>target</code></em>.</p>
<p>&nbsp;</p>
<p><strong class="example">Example 1:</strong></p>
<pre>
<strong>Input:</strong> nums = [2,7,11,15], target = 9
<strong>Output:</strong> [0,1]
<strong>Explanation:</strong> Because nums[0] + nums[1] == 9, we return [0, 1].
</pre>
<p><strong class="example">Example 2:</strong></p>
<pre>
<strong>Input:</strong> nums = [3,2,4], target = 6
<strong>Output:</strong> [1,2]
</pre>
<p>&nbsp;</p>
<p><strong>Constraints:</strong></p>
<ul>
<li><code>2 &lt;= nums.length &lt;= 10<sup>4</sup></code></li>
<li><code>-10<sup>9</sup> &lt;= nums[i] &lt;= 10<sup>9</sup></code></li>
</ul>
`;

const RAW: RawQuestionData = {
  frontendId: '1',
  title: 'Two Sum',
  slug: 'two-sum',
  difficulty: 'Easy',
  contentHtml: TWO_SUM_HTML,
  exampleTestcases: '[2,7,11,15]\n9\n[3,2,4]\n6',
  metaData: { name: 'twoSum', params: [{ name: 'nums' }, { name: 'target' }] },
  codeSnippets: [
    { lang: 'JavaScript', langSlug: 'javascript', code: '/**\n * @param {number[]} nums\n * @param {number} target\n * @return {number[]}\n */\nvar twoSum = function(nums, target) {\n    \n};' },
    { lang: 'Python3', langSlug: 'python3', code: 'class Solution:\n    def twoSum(self, nums: List[int], target: int) -> List[int]:\n        ' },
  ],
};

describe('htmlToText', () => {
  it('strips tags and decodes entities', () => {
    const text = htmlToText('<p>a &lt; b &amp; c</p>');
    expect(text).toBe('a < b & c');
  });

  it('keeps line structure for pre blocks', () => {
    const text = htmlToText(TWO_SUM_HTML);
    expect(text).toContain('Example 1:');
    expect(text).toContain('Input: nums = [2,7,11,15], target = 9');
  });
});

describe('extractExamples', () => {
  it('extracts inputs, outputs and explanations', () => {
    const text = htmlToText(TWO_SUM_HTML);
    const examples = extractExamples(text);
    expect(examples.length).toBeGreaterThanOrEqual(2);
    expect(examples[0]?.input).toBe('nums = [2,7,11,15], target = 9');
    expect(examples[0]?.output).toBe('[0,1]');
    expect(examples[0]?.explanation).toContain('nums[0] + nums[1] == 9');
    expect(examples[1]?.output).toBe('[1,2]');
  });
});

describe('extractConstraints', () => {
  it('extracts bullet constraints', () => {
    const text = htmlToText(TWO_SUM_HTML);
    const constraints = extractConstraints(text);
    expect(constraints.length).toBeGreaterThanOrEqual(2);
    expect(constraints.some((c) => c.includes('nums.length'))).toBe(true);
  });
});

describe('parseProblem', () => {
  it('parses a well-formed payload', () => {
    const p = parseProblem(RAW, 'javascript');
    expect(p.slug).toBe('two-sum');
    expect(p.starterCode).toContain('var twoSum = function');
    expect(p.examples.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects empty content', () => {
    expect(() => parseProblem({ ...RAW, contentHtml: '' }, 'javascript')).toThrow(ProblemParseError);
  });

  it('rejects a missing language snippet', () => {
    expect(() => parseProblem(RAW, 'rust')).toThrow(ProblemParseError);
  });
});
