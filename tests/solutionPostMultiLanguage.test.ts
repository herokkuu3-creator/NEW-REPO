import { describe, expect, it, vi } from 'vitest';
import {
  articleSchema,
  buildArticleTags,
  contextSchema,
  renderArticle,
} from '../src/solutionPosts/article';
import {
  buildOrderedCodeBlocks,
  extractRelevantCodeSnippets,
  generateMultiLanguageCode,
  MULTI_LANGUAGE_TARGETS,
  supportsMultiLanguage,
} from '../src/solutionPosts/multiLanguage';
import { verifyArticleCode } from '../src/solutionPosts/publisher';
import { postPresentationVariant } from '../src/solutionPosts/presentationStyles';
import type { AIModelRouter } from '../src/solutionPosts/router';

const baseContext = contextSchema.parse({
  accountId: 'acc1',
  username: 'alice',
  problemId: '746',
  slug: 'climb-stairs',
  title: 'Climb Stairs',
  difficulty: 'Medium',
  problem: 'Find the minimum cost to climb stairs using dynamic programming.',
  submissionId: '12345',
  language: 'cpp',
  code: 'class Solution {\npublic:\n    int climbStairs(int n, vector<int>& costs) { return 0; }\n};',
  challengeDate: '2026-11-20',
  articleImplementation: {
    code: 'class Solution {\npublic:\n    int climbStairs(int n, vector<int>& costs) {\n        return costs[0];\n    }\n};',
    approach: 'Use bottom-up dynamic programming.',
  },
  presentation: postPresentationVariant(0, 0),
  topicTags: [{ name: 'Dynamic Programming', slug: 'dynamic-programming' }],
});

const sampleArticle = articleSchema.parse({
  title: '🚀 Minimum Step DP | Clean State Transitions',
  sections: ['intuition', 'approach', 'correctness', 'dryRun', 'takeaways'].map(kind => ({
    kind,
    heading: `${kind} heading`,
    markdown: 'Track the minimum cost at each step and transition from the previous steps cleanly.',
  })),
  time: { bound: 'O(n)', reason: 'Each step is visited once with constant work.' },
  space: { bound: 'O(1)', reason: 'Only a constant number of state variables are kept.' },
  visuals: [
    {
      id: 'visual-1',
      after: 'intuition',
      title: 'Step transitions',
      caption: 'Watch each step choose the cheapest jump.',
      theme: 'aurora',
      frames: [
        { label: 'Init', items: ['0', '1'], active: [0], state: 'dp=0', metric: 'cost=0', note: 'Start at 0.' },
        { label: 'Jump', items: ['0', '1'], active: [1], state: 'dp=1', metric: 'cost=1', note: 'Move to 1.' },
      ],
    },
    {
      id: 'visual-2',
      after: 'dryRun',
      title: 'Trace cost',
      caption: 'Accumulate the cheapest path to top.',
      theme: 'ocean',
      frames: [
        { label: 'Step 1', items: ['1', '2'], active: [0], state: 'ans=1', metric: '+1', note: 'Take step 1.' },
        { label: 'Step 2', items: ['1', '2'], active: [1], state: 'ans=2', metric: '+1', note: 'Reach top.' },
      ],
    },
  ],
});

const allSixTranslations = [
  { language: 'python3' as const, code: 'class Solution:\n    def climbStairs(self, n: int, costs: list[int]) -> int:\n        return costs[0]' },
  { language: 'cpp' as const, code: baseContext.articleImplementation!.code },
  { language: 'java' as const, code: 'class Solution {\n    public int climbStairs(int n, int[] costs) {\n        return costs[0];\n    }\n}' },
  { language: 'golang' as const, code: 'func climbStairs(n int, costs []int) int {\n    return costs[0]\n}' },
  { language: 'javascript' as const, code: 'var climbStairs = function(n, costs) {\n    return costs[0];\n};' },
  { language: 'typescript' as const, code: 'function climbStairs(n: number, costs: number[]): number {\n    return costs[0];\n}' },
];

describe('multi-language article submissions', () => {
  it('renders LeetCode tabbed code blocks in Python3 | C++ | Java | Go | JavaScript | TypeScript order', () => {
    const ctx = { ...baseContext, multiLanguageCode: allSixTranslations };
    const markdown = renderArticle(sampleArticle, ctx);

    expect(markdown).toContain('```python3 []\n' + allSixTranslations[0]!.code + '\n```\n```cpp []\n' + baseContext.articleImplementation!.code + '\n```');
    expect(markdown).toContain('```java []\n' + allSixTranslations[2]!.code + '\n```\n```golang []\n' + allSixTranslations[3]!.code + '\n```');
    expect(markdown).toContain('```javascript []\n' + allSixTranslations[4]!.code + '\n```\n```typescript []\n' + allSixTranslations[5]!.code + '\n```');

    // Verify exact order of tabs
    const headers = [...markdown.matchAll(/^```(\w+) \[\]$/gm)].map(m => m[1]);
    expect(headers).toEqual([...MULTI_LANGUAGE_TARGETS]);

    // Code integrity verification passes for multi-language markdown
    expect(() => verifyArticleCode(markdown, ctx)).not.toThrow();
  });

  it('keeps single-language rendering identical when multiLanguageCode is absent (zero regression)', () => {
    const markdown = renderArticle(sampleArticle, baseContext);
    expect(markdown).toContain('```cpp\n' + baseContext.articleImplementation!.code + '\n```');
    expect(markdown).not.toContain('```cpp []');
    expect(() => verifyArticleCode(markdown, baseContext)).not.toThrow();
  });

  it('adds all multi-language slugs to article tags alongside topic tags', () => {
    const ctx = { ...baseContext, multiLanguageCode: allSixTranslations };
    const markdown = renderArticle(sampleArticle, ctx);
    const tags = buildArticleTags(ctx, markdown);

    for (const lang of MULTI_LANGUAGE_TARGETS) {
      expect(tags).toContain(lang);
    }
    expect(tags).toContain('dynamic-programming');
    // Deduplicated
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('keeps single-language tags unchanged when multiLanguageCode is absent', () => {
    const tags = buildArticleTags(baseContext);
    expect(tags).toContain('cpp');
    expect(tags).not.toContain('python3');
    expect(tags).not.toContain('java');
    expect(tags).not.toContain('golang');
    expect(tags).not.toContain('javascript');
    expect(tags).not.toContain('typescript');
  });

  it('detects tampering in any language tab during verifyArticleCode', () => {
    const ctx = { ...baseContext, multiLanguageCode: allSixTranslations };
    const markdown = renderArticle(sampleArticle, ctx);
    const tamperedJava = markdown.replace('public int climbStairs', 'public int tampered');
    expect(() => verifyArticleCode(tamperedJava, ctx)).toThrow('SOURCE_INTEGRITY_FAILED');

    const tamperedPrimary = markdown.replace('return costs[0];', 'return -1;');
    expect(() => verifyArticleCode(tamperedPrimary, ctx)).toThrow('SOURCE_INTEGRITY_FAILED');
  });

  it('translates all remaining languages in a single AI call and validates signatures', async () => {
    const generate = vi.fn(async (_messages, validate) => {
      const payload = JSON.stringify({
        python3: 'class Solution:\n    def climbStairs(self, n: int, costs: list[int]) -> int:\n        return costs[0]',
        java: 'class Solution {\n    public int climbStairs(int n, int[] costs) {\n        return costs[0];\n    }\n}',
        golang: 'func climbStairs(n int, costs []int) int {\n    return costs[0]\n}',
        javascript: 'var climbStairs = function(n, costs) {\n    return costs[0];\n};',
        typescript: 'function climbStairs(n: number, costs: number[]): number {\n    return costs[0];\n}',
      });
      return {
        value: validate(payload),
        model: 'test-model',
        attempts: [{ model: 'test-model', attempt: 1, elapsedMs: 120, outcome: 'SUCCESS', stage: 'multi-language code translation' }],
      };
    });

    const ctx = {
      ...baseContext,
      codeSnippets: {
        python3: 'class Solution:\n    def climbStairs(self, n: int, costs: List[int]) -> int:\n        ',
        cpp: 'class Solution {\npublic:\n    int climbStairs(int n, vector<int>& costs) {\n        \n    }\n};',
        java: 'class Solution {\n    public int climbStairs(int n, int[] costs) {\n        \n    }\n}',
        golang: 'func climbStairs(n int, costs []int) int {\n    \n}',
        javascript: 'var climbStairs = function(n, costs) {\n    \n};',
        typescript: 'function climbStairs(n: number, costs: number[]): number {\n    \n};',
      },
    };

    const result = await generateMultiLanguageCode({ generate } as unknown as AIModelRouter, ctx);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
    expect(result!.value.map(e => e.language)).toEqual([...MULTI_LANGUAGE_TARGETS]);
    expect(result!.value.find(e => e.language === 'cpp')!.code).toBe(baseContext.articleImplementation!.code);
  });

  it('skips non-algorithmic languages like SQL and bash immediately without calling AI', async () => {
    expect(supportsMultiLanguage('mysql')).toBe(false);
    expect(supportsMultiLanguage('postgresql')).toBe(false);
    expect(supportsMultiLanguage('bash')).toBe(false);
    expect(supportsMultiLanguage('pythondata')).toBe(false);
    expect(supportsMultiLanguage('cpp')).toBe(true);
    expect(supportsMultiLanguage('python3')).toBe(true);

    const generate = vi.fn();
    const sqlCtx = { ...baseContext, language: 'mysql' as const, code: 'SELECT 1;' };
    expect(await generateMultiLanguageCode({ generate } as unknown as AIModelRouter, sqlCtx)).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it('fails open (returns null) if AI translation throws so article generation never regresses', async () => {
    const generate = vi.fn(async () => {
      throw new Error('rate limit');
    });
    const result = await generateMultiLanguageCode({ generate } as unknown as AIModelRouter, baseContext);
    expect(result).toBeNull();
  });

  it('extracts only relevant starter snippets and preserves exact primary bytes in buildOrderedCodeBlocks', () => {
    const snippets = extractRelevantCodeSnippets([
      { langSlug: 'python3', code: 'def f(): pass' },
      { langSlug: 'ruby', code: 'def f; end' },
      { langSlug: 'golang', code: 'func f() {}' },
    ], 'cpp');
    expect(snippets).toEqual({
      python3: 'def f(): pass',
      golang: 'func f() {}',
    });

    const crlfCode = 'class Solution {\r\npublic:\r\n    int f() { return 1; }\r\n};\r\n';
    const blocks = buildOrderedCodeBlocks({
      language: 'cpp',
      code: crlfCode,
      multiLanguageCode: [
        { language: 'python3', code: 'class Solution:\n    def f(self) -> int:\n        return 1' },
        { language: 'cpp', code: 'trimmed copy' },
      ],
    });
    expect(blocks.map(b => b.language)).toEqual(['python3', 'cpp']);
    expect(blocks[1]!.code).toBe(crlfCode);
  });
});
