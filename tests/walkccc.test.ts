import { describe, expect, it } from 'vitest';
import {
  decodeEntities,
  extractCppSolution,
  looksLikeCppSolution,
} from '../src/solutions/walkccc';

/**
 * Extraction tests run against the real markup walkccc serves for problem 15
 * (captured during development): line-number gutter in one cell, code in the
 * adjacent cell, C++ first, then other languages.
 */

const CPP = `class Solution {
 public:
  vector&lt;vector&lt;int&gt;&gt; threeSum(vector&lt;int&gt;&amp; nums) {
    if (nums.size() &lt; 3)
      return {};
    ranges::sort(nums);
    return {};
  }
};`;

const JAVA = `class Solution {
  public List&lt;List&lt;Integer&gt;&gt; threeSum(int[] nums) {
    return new ArrayList&lt;&gt;();
  }
}`;

function wrap(code: string): string {
  return `<table><tbody><tr><td><div><pre><span></span><span> 1</span>\n<span> 2</span></pre></div></td><td><div><pre><span></span><code>${code
    .split('\n')
    .map((l) => `<span>${l}</span>`)
    .join('\n')}</code></pre></div></td></tr></tbody></table>`;
}

describe('extractCppSolution', () => {
  it('extracts and decodes the C++ block', () => {
    const html = `<div id="cpp">${wrap(CPP)}</div>`;
    const code = extractCppSolution(html);
    expect(code).not.toBeNull();
    expect(code).toContain('class Solution {');
    expect(code).toContain('public:');
    expect(code).toContain('vector<vector<int>> threeSum(vector<int>& nums) {');
    expect(code).toContain('if (nums.size() < 3)');
    expect(code).toContain('ranges::sort(nums);');
    expect(code).not.toContain('<span');
    expect(code).not.toContain('&lt;');
    expect(code).not.toContain('&amp;');
  });

  it('falls back to the first valid C++ block when no anchor exists', () => {
    const html = `${wrap(JAVA)}${wrap(CPP)}`;
    const code = extractCppSolution(html);
    expect(code).toContain('vector<vector<int>>');
    expect(code).not.toContain('ArrayList');
  });

  it('prefers the anchored C++ section over an earlier non-C++ block', () => {
    const html = `${wrap(JAVA)}<div id="cpp">${wrap(CPP)}</div><div id="java">${wrap(JAVA)}</div>`;
    const code = extractCppSolution(html);
    expect(code).toContain('vector<vector<int>>');
  });

  it('returns null when no C++ solution exists on the page', () => {
    const html = `<div id="java">${wrap(JAVA)}</div>`;
    expect(extractCppSolution(html)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(extractCppSolution('')).toBeNull();
  });
});

describe('looksLikeCppSolution', () => {
  it('accepts a real C++ solution', () => {
    expect(looksLikeCppSolution('class Solution {\n public:\n  int f() { return 1; }\n};')).toBe(true);
  });
  it('rejects a Java solution', () => {
    expect(looksLikeCppSolution('class Solution {\n  public int f() { return 1; }\n}')).toBe(false);
  });
  it('rejects placeholders', () => {
    expect(looksLikeCppSolution('class Solution {\n public:\n  // TODO: implement\n};')).toBe(false);
  });
  it('rejects tiny fragments', () => {
    expect(looksLikeCppSolution('class Solution {};')).toBe(false);
  });
});

describe('decodeEntities', () => {
  it('decodes named, decimal and hex entities', () => {
    expect(decodeEntities('a &lt; b &amp;&amp; c &gt; d &#40;x&#x29;')).toBe('a < b && c > d (x)');
  });
});
