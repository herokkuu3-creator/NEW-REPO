import { describe, expect, it } from 'vitest';
import {
  containsPlaceholder,
  extractCode,
  validateSolution,
} from '../src/validator/validator';
import {
  extractFunctionName,
  generateTestCases,
  parseExampleInput,
  parseExampleOutput,
} from '../src/validator/testcaseGenerator';
import { parseProblem } from '../src/leetcode/parser';
import type { RawQuestionData } from '../src/leetcode/dailyChallenge';

const RAW: RawQuestionData = {
  frontendId: '1',
  title: 'Two Sum',
  slug: 'two-sum',
  difficulty: 'Easy',
  contentHtml: `
<p>Given an array of integers nums and an integer target, return indices.</p>
<p><strong class="example">Example 1:</strong></p>
<pre>
<strong>Input:</strong> nums = [2,7,11,15], target = 9
<strong>Output:</strong> [0,1]
</pre>
<p><strong class="example">Example 2:</strong></p>
<pre>
<strong>Input:</strong> nums = [3,2,4], target = 6
<strong>Output:</strong> [1,2]
</pre>
<p><strong>Constraints:</strong></p>
<ul><li>2 &lt;= nums.length &lt;= 10000</li></ul>
`,
  exampleTestcases: '[2,7,11,15]\n9',
  metaData: null,
  codeSnippets: [
    { lang: 'JavaScript', langSlug: 'javascript', code: 'var twoSum = function(nums, target) {\n    \n};' },
  ],
};

describe('extractCode', () => {
  it('strips markdown fences', () => {
    const code = extractCode('Here you go:\n```javascript\nvar x = function() { return 1; };\n```\nHope this helps!');
    expect(code).toContain('var x = function()');
    expect(code).not.toContain('```');
  });

  it('returns null for prose-only output', () => {
    expect(extractCode('I cannot solve this problem, sorry.')).toBeNull();
  });
});

describe('containsPlaceholder', () => {
  it('flags TODO comments', () => {
    expect(containsPlaceholder('function f() { // TODO: implement\n return 0; }')).toBeTruthy();
  });
  it('flags empty bodies', () => {
    expect(containsPlaceholder('function f() {}')).toBeTruthy();
  });
  it('passes real code', () => {
    expect(containsPlaceholder('function f(a) { return a + 1; }')).toBeNull();
  });
});

describe('testcaseGenerator', () => {
  it('parses named-argument example inputs', () => {
    expect(parseExampleInput('nums = [2,7,11,15], target = 9')).toEqual(['[2,7,11,15]', '9']);
  });
  it('parses outputs', () => {
    expect(parseExampleOutput('[0,1]')).toBe('[0,1]');
    expect(parseExampleOutput('true')).toBe('true');
  });
  it('extracts function names from starter code', () => {
    expect(extractFunctionName('var twoSum = function(nums, target) {}', 'javascript')).toBe('twoSum');
    expect(extractFunctionName('class Solution:\n    def twoSum(self, nums):', 'python3')).toBe('twoSum');
  });
});

describe('validateSolution (javascript, end-to-end)', () => {
  const problem = parseProblem(RAW, 'javascript');

  it('accepts a correct solution', async () => {
    const good = `
var twoSum = function(nums, target) {
  const seen = new Map();
  for (let i = 0; i < nums.length; i++) {
    const need = target - nums[i];
    if (seen.has(need)) return [seen.get(need), i];
    seen.set(nums[i], i);
  }
  return [];
};`;
    const result = await validateSolution(good, problem, 'javascript');
    expect(result.ok).toBe(true);
  });

  it('rejects a wrong answer with an example-stage report', async () => {
    const bad = 'var twoSum = function(nums, target) { return [0, 0]; };';
    const result = await validateSolution(bad, problem, 'javascript');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe('examples');
      expect(result.report).toContain('expected');
    }
  });

  it('rejects syntax errors', async () => {
    const broken = 'var twoSum = function(nums, target) { return [;';
    const result = await validateSolution(broken, problem, 'javascript');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe('syntax');
  });

  it('generates example + edge testcases', () => {
    const tests = generateTestCases(problem);
    expect(tests.some((t) => t.label === 'example-1')).toBe(true);
    expect(tests.some((t) => t.label.startsWith('edge-'))).toBe(true);
  });

  it('extracts and validates non-JS/Python code such as MySQL queries, Bash scripts, and C++', async () => {
    const rawSql = '```mysql\nSELECT a.id FROM Weather a;\n```';
    expect(extractCode(rawSql, 'mysql')).toBe('SELECT a.id FROM Weather a;');
    const sqlValidation = await validateSolution(rawSql, { ...problem, starterCode: '# MySQL', language: 'mysql' }, 'mysql');
    expect(sqlValidation.ok).toBe(true);

    const rawBash = '```bash\n# print tenth line\nsed -n "10p" file.txt\n```';
    expect(extractCode(rawBash, 'bash')).toContain('sed -n "10p" file.txt');
    const bashValidation = await validateSolution(rawBash, { ...problem, starterCode: '# Bash', language: 'bash' }, 'bash');
    expect(bashValidation.ok).toBe(true);

    const rawCpp = '```cpp\nclass Solution {\npublic:\n  vector<int> twoSum(vector<int>& a, int t) { return {}; }\n};\n```';
    expect(extractCode(rawCpp, 'cpp')).toContain('class Solution');
  });
});
