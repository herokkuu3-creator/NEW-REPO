import { describe, expect, it, vi } from 'vitest';
import {
  CommunitySolutionError,
  extractCppCode,
  fetchCommunitySolution,
  UGC_SOLUTION_ARTICLE_QUERY,
  UGC_SOLUTION_ARTICLES_QUERY,
} from '../src/solutions/communitySolutions';
import { ParsedProblem } from '../src/leetcode/parser';

const mockProblem3727 = {
  frontendId: '3727',
  slug: 'maximum-alternating-sum-of-squares',
  starterCode: `class Solution {\npublic:\n    long long maxAlternatingSum(vector<int>& nums) {\n        \n    }\n};`,
} as unknown as ParsedProblem;

describe('extractCppCode', () => {
  it('extracts C++ code from multi-language tab syntax (cpp [])', () => {
    const markdown = `
# Solution

\`\`\`java []
class Solution {
    public long maxAlternatingSum(int[] nums) {
        return 0;
    }
}
\`\`\`

\`\`\`cpp []
class Solution {
public:
    long long maxAlternatingSum(vector<int>& nums) {
        int n = nums.size();
        sort(nums.begin(), nums.end());
        return 42;
    }
};
\`\`\`

\`\`\`python []
class Solution:
    def maxAlternatingSum(self, nums: List[int]) -> int:
        return 0
\`\`\`
    `;

    const code = extractCppCode(markdown, mockProblem3727);
    expect(code).not.toBeNull();
    expect(code).toContain('long long maxAlternatingSum');
    expect(code).toContain('sort(nums.begin(), nums.end())');
    expect(code).not.toContain('class Solution { public long');
  });

  it('extracts standard ```cpp code block', () => {
    const markdown = `
Here is my C++ approach:

\`\`\`cpp
class Solution {
public:
    long long maxAlternatingSum(vector<int>& nums) {
        return 123;
    }
};
\`\`\`
    `;

    const code = extractCppCode(markdown, mockProblem3727);
    expect(code).not.toBeNull();
    expect(code).toBe(`class Solution {\npublic:\n    long long maxAlternatingSum(vector<int>& nums) {\n        return 123;\n    }\n};`);
  });

  it('extracts ```c++ code block with headers', () => {
    const markdown = `
\`\`\`c++
#include <vector>
using namespace std;

class Solution {
public:
    long long maxAlternatingSum(vector<int>& nums) {
        return 999;
    }
};
\`\`\`
    `;

    const code = extractCppCode(markdown, mockProblem3727);
    expect(code).not.toBeNull();
    expect(code).toContain('#include <vector>');
    expect(code).toContain('maxAlternatingSum');
  });

  it('rejects a code block if the method signature does not match the starter', () => {
    const markdown = `
\`\`\`cpp
class Solution {
public:
    int completelyDifferentMethod(vector<int>& nums) {
        return 0;
    }
};
\`\`\`
    `;

    const code = extractCppCode(markdown, mockProblem3727);
    expect(code).toBeNull();
  });

  it('rejects markdown with only Python or Java code', () => {
    const markdown = `
\`\`\`python3
class Solution:
    def maxAlternatingSum(self, nums: List[int]) -> int:
        return 0
\`\`\`
    `;

    const code = extractCppCode(markdown, mockProblem3727);
    expect(code).toBeNull();
  });
});

describe('fetchCommunitySolution', () => {
  it('fetches and extracts the first matching solution article', async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);

      if (body.query.includes('ugcArticleSolutionArticles')) {
        return new Response(
          JSON.stringify({
            data: {
              ugcArticleSolutionArticles: {
                totalNum: 1,
                pageInfo: { hasNextPage: false },
                edges: [
                  {
                    node: {
                      uuid: 'art-123',
                      title: 'Easy C++ Solution',
                      slug: 'easy-cpp-solution',
                      topicId: 999,
                      tags: [{ name: 'C++', slug: 'cpp' }],
                      author: { userName: 'coder123' },
                    },
                  },
                ],
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (body.query.includes('ugcArticleSolutionArticle')) {
        return new Response(
          JSON.stringify({
            data: {
              ugcArticleSolutionArticle: {
                uuid: 'art-123',
                title: 'Easy C++ Solution',
                slug: 'easy-cpp-solution',
                topicId: 999,
                content: `
\`\`\`cpp
class Solution {
public:
    long long maxAlternatingSum(vector<int>& nums) {
        return 100;
    }
};
\`\`\`
                `,
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response('{}', { status: 404 });
    });

    const solution = await fetchCommunitySolution('maximum-alternating-sum-of-squares', mockProblem3727, {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(solution.code).toContain('long long maxAlternatingSum');
    expect(solution.sourceUrl).toBe(
      'https://leetcode.com/problems/maximum-alternating-sum-of-squares/solutions/999/easy-cpp-solution/',
    );
    expect(solution.title).toBe('Easy C++ Solution');
    expect(solution.author).toBe('coder123');
  });

  it('skips non-matching articles and succeeds on the second article', async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);

      if (body.query.includes('ugcArticleSolutionArticles')) {
        return new Response(
          JSON.stringify({
            data: {
              ugcArticleSolutionArticles: {
                totalNum: 2,
                edges: [
                  {
                    node: {
                      uuid: 'art-python',
                      title: 'Python Only',
                      slug: 'python-only',
                      topicId: 111,
                    },
                  },
                  {
                    node: {
                      uuid: 'art-cpp',
                      title: 'Clean C++',
                      slug: 'clean-cpp',
                      topicId: 222,
                    },
                  },
                ],
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (body.query.includes('ugcArticleSolutionArticle')) {
        const artId = body.variables.articleId;
        const content =
          artId === 'art-python'
            ? '```python\nclass Solution:\n    def foo(): pass\n```'
            : '```cpp\nclass Solution {\npublic:\n    long long maxAlternatingSum(vector<int>& nums) {\n        return 1;\n    }\n};\n```';

        return new Response(
          JSON.stringify({
            data: {
              ugcArticleSolutionArticle: {
                uuid: artId,
                title: 'Title',
                slug: 'slug',
                content,
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response('{}', { status: 404 });
    });

    const solution = await fetchCommunitySolution('maximum-alternating-sum-of-squares', mockProblem3727, {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(solution.uuid).toBe('art-cpp');
    expect(solution.code).toContain('maxAlternatingSum');
  });

  it('throws CommunitySolutionError when no articles exist', async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: {
            ugcArticleSolutionArticles: {
              totalNum: 0,
              edges: [],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    await expect(
      fetchCommunitySolution('non-existent-problem', mockProblem3727, {
        fetchFn: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(CommunitySolutionError);
  });
});
