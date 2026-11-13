import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearCommunitySolutionsCache,
  clearSlugByNumberCacheForTests,
  CommunitySolutionError,
  extractCodeForLanguage,
  extractCppCode,
  fetchCommunitySolution,
  resolveLeetCodeSlugByNumber,
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
  beforeEach(() => {
    clearCommunitySolutionsCache();
    clearSlugByNumberCacheForTests();
  });

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

  it('caches a confirmed empty article list across lookups', async () => {
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

    const lookup = () => fetchCommunitySolution('non-existent-problem', mockProblem3727, {
      fetchFn: mockFetch as unknown as typeof fetch,
    });
    await expect(lookup()).rejects.toThrow(CommunitySolutionError);
    await expect(lookup()).rejects.toThrow(CommunitySolutionError);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('picks a specific result rank when targetIndex is specified (e.g. 4th result)', async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);

      if (body.query.includes('ugcArticleSolutionArticles')) {
        return new Response(
          JSON.stringify({
            data: {
              ugcArticleSolutionArticles: {
                totalNum: 4,
                edges: [
                  { node: { uuid: 'art-1', title: 'Result 1', slug: 'r1', topicId: 1 } },
                  { node: { uuid: 'art-2', title: 'Result 2', slug: 'r2', topicId: 2 } },
                  { node: { uuid: 'art-3', title: 'Result 3', slug: 'r3', topicId: 3 } },
                  { node: { uuid: 'art-4', title: 'Result 4', slug: 'r4', topicId: 4 } },
                ],
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (body.query.includes('ugcArticleSolutionArticle')) {
        const artId = body.variables.articleId;
        const rank = artId.split('-')[1];
        return new Response(
          JSON.stringify({
            data: {
              ugcArticleSolutionArticle: {
                uuid: artId,
                title: `Result ${rank}`,
                slug: `r${rank}`,
                content: `\`\`\`cpp\nclass Solution {\npublic:\n long long maxAlternatingSum(vector<int>& nums) { return ${rank}; }\n};\n\`\`\``,
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response('{}', { status: 404 });
    });

    // targetIndex = 3 corresponds to the 4th result (0-indexed)
    const sol = await fetchCommunitySolution('maximum-alternating-sum-of-squares', mockProblem3727, {
      fetchFn: mockFetch as unknown as typeof fetch,
      targetIndex: 3,
    });

    expect(sol.uuid).toBe('art-4');
    expect(sol.rankIndex).toBe(4);
    expect(sol.code).toContain('return 4;');
  });

  it('guarantees different solutions across accounts by prioritizing unused candidates', async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);

      if (body.query.includes('ugcArticleSolutionArticles')) {
        return new Response(
          JSON.stringify({
            data: {
              ugcArticleSolutionArticles: {
                totalNum: 3,
                edges: [
                  { node: { uuid: 'art-1', title: 'Sol 1', slug: 's1', topicId: 1 } },
                  { node: { uuid: 'art-2', title: 'Sol 2', slug: 's2', topicId: 2 } },
                  { node: { uuid: 'art-3', title: 'Sol 3', slug: 's3', topicId: 3 } },
                ],
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (body.query.includes('ugcArticleSolutionArticle')) {
        const artId = body.variables.articleId;
        return new Response(
          JSON.stringify({
            data: {
              ugcArticleSolutionArticle: {
                uuid: artId,
                title: artId,
                slug: artId,
                content: `\`\`\`cpp\nclass Solution {\npublic:\n long long maxAlternatingSum(vector<int>& nums) { return 0; }\n};\n\`\`\``,
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response('{}', { status: 404 });
    });

    const usedUuids = new Set<string>();

    // Account 1
    const sol1 = await fetchCommunitySolution('maximum-alternating-sum-of-squares', mockProblem3727, {
      fetchFn: mockFetch as unknown as typeof fetch,
      excludeUuids: usedUuids,
    });
    usedUuids.add(sol1.uuid);

    // Account 2
    const sol2 = await fetchCommunitySolution('maximum-alternating-sum-of-squares', mockProblem3727, {
      fetchFn: mockFetch as unknown as typeof fetch,
      excludeUuids: usedUuids,
    });
    usedUuids.add(sol2.uuid);

    // Account 3
    const sol3 = await fetchCommunitySolution('maximum-alternating-sum-of-squares', mockProblem3727, {
      fetchFn: mockFetch as unknown as typeof fetch,
      excludeUuids: usedUuids,
    });
    usedUuids.add(sol3.uuid);

    // All 3 solutions must be completely distinct
    expect(sol1.uuid).not.toBe(sol2.uuid);
    expect(sol2.uuid).not.toBe(sol3.uuid);
    expect(sol1.uuid).not.toBe(sol3.uuid);
    expect(usedUuids.size).toBe(3);
  });
});


describe('resolveLeetCodeSlugByNumber', () => {
  beforeEach(() => {
    clearSlugByNumberCacheForTests();
  });

  it('resolves slug matching exact frontendQuestionId and caches the result', async () => {
    let fetchCount = 0;
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCount++;
      const body = JSON.parse(init?.body as string);
      expect(body.variables.filters.searchKeywords).toBe('3800');

      return new Response(
        JSON.stringify({
          data: {
            problemsetQuestionList: {
              total: 1,
              questions: [
                {
                  frontendQuestionId: '3800',
                  titleSlug: 'minimum-cost-to-make-two-binary-strings-equal',
                  title: 'Minimum Cost to Make Two Binary Strings Equal',
                  paidOnly: false,
                },
                {
                  frontendQuestionId: '380',
                  titleSlug: 'insert-delete-getrandom-o1',
                  title: 'Insert Delete GetRandom O(1)',
                  paidOnly: false,
                },
              ],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const slug1 = await resolveLeetCodeSlugByNumber(3800, { fetchFn: mockFetch as unknown as typeof fetch });
    expect(slug1).toBe('minimum-cost-to-make-two-binary-strings-equal');
    expect(fetchCount).toBe(1);

    // Second call should return cached slug without hitting network
    const slug2 = await resolveLeetCodeSlugByNumber(3800, { fetchFn: mockFetch as unknown as typeof fetch });
    expect(slug2).toBe('minimum-cost-to-make-two-binary-strings-equal');
    expect(fetchCount).toBe(1);
  });

  it('returns null when question number is not found in results', async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: {
            problemsetQuestionList: {
              total: 0,
              questions: [],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const slug = await resolveLeetCodeSlugByNumber(9999, { fetchFn: mockFetch as unknown as typeof fetch });
    expect(slug).toBeNull();
  });
});

describe('extractCodeForLanguage (multi-language)', () => {
  it('extracts MySQL queries (mysql and sql tags) and ignores PostgreSQL/C++ blocks', () => {
    const markdown = `
### PostgreSQL
\`\`\`postgresql
SELECT personId, city FROM Address;
\`\`\`

### MySQL
\`\`\`mysql []
# Write your MySQL query statement below
SELECT p.firstName, p.lastName, a.city, a.state
FROM Person p
LEFT JOIN Address a ON p.personId = a.personId;
\`\`\`
`;
    const mysqlProblem = {
      starterCode: '# Write your MySQL query statement below',
      language: 'mysql',
    } as unknown as ParsedProblem;

    const sql = extractCodeForLanguage(markdown, 'mysql', mysqlProblem);
    expect(sql).toContain('SELECT p.firstName');
    expect(sql).not.toContain('SELECT personId');
  });

  it('falls back to generic sql tag for mysql when mysql tag is absent', () => {
    const markdown = `
\`\`\`sql
SELECT name FROM Customer WHERE referee_id != 2 OR referee_id IS NULL;
\`\`\`
`;
    const sql = extractCodeForLanguage(markdown, 'mysql');
    expect(sql).toContain('FROM Customer');
  });

  it('extracts Python 3, Java, JavaScript, Pandas, and Bash solutions accurately', () => {
    const markdown = `
\`\`\`python3 []
class Solution:
    def twoSum(self, nums: List[int], target: int) -> List[int]:
        seen = {}
        for i, n in enumerate(nums):
            if target - n in seen:
                return [seen[target - n], i]
            seen[n] = i
\`\`\`

\`\`\`java []
class Solution {
    public int[] twoSum(int[] nums, int target) {
        return new int[]{0, 1};
    }
}
\`\`\`

\`\`\`javascript []
var twoSum = function(nums, target) {
    return [0, 1];
};
\`\`\`
`;
    const pyProblem = { starterCode: 'class Solution:\n    def twoSum(self, nums: List[int], target: int) -> List[int]:' } as ParsedProblem;
    const javaProblem = { starterCode: 'class Solution {\n    public int[] twoSum(int[] nums, int target) {' } as ParsedProblem;
    const jsProblem = { starterCode: 'var twoSum = function(nums, target) {' } as ParsedProblem;

    expect(extractCodeForLanguage(markdown, 'python3', pyProblem)).toContain('def twoSum');
    expect(extractCodeForLanguage(markdown, 'java', javaProblem)).toContain('public int[] twoSum');
    expect(extractCodeForLanguage(markdown, 'javascript', jsProblem)).toContain('var twoSum = function');

    const bashMd = `
\`\`\`bash []
# Read from the file file.txt and output the tenth line to stdout.
sed -n '10p' file.txt
\`\`\`
`;
    expect(extractCodeForLanguage(bashMd, 'bash')).toContain("sed -n '10p' file.txt");

    const pandasMd = `
\`\`\`python
import pandas as pd

def big_countries(world: pd.DataFrame) -> pd.DataFrame:
    return world[(world['area'] >= 3000000) | (world['population'] >= 25000000)][['name', 'population', 'area']]
\`\`\`
`;
    const pandasProblem = { starterCode: 'def big_countries(world: pd.DataFrame) -> pd.DataFrame:' } as ParsedProblem;
    expect(extractCodeForLanguage(pandasMd, 'pythondata', pandasProblem)).toContain('def big_countries');
  });

  it('fetchCommunitySolution works for non-C++ languages (mysql -> sql fallback tag)', async () => {
    clearCommunitySolutionsCache();
    const seenTags: string[][] = [];
    const mockGraphql = vi.fn(async (_query: string, vars: Record<string, unknown>) => {
      if (Array.isArray(vars.tagSlugs)) {
        seenTags.push(vars.tagSlugs as string[]);
        if (vars.tagSlugs[0] === 'mysql') {
          return { ugcArticleSolutionArticles: { edges: [] } };
        }
        return {
          ugcArticleSolutionArticles: {
            edges: [{ node: { uuid: 'sql-uuid-1', title: 'Simple SQL', slug: 'simple-sql', topicId: 42 } }],
          },
        };
      }
      return {
        ugcArticleSolutionArticle: {
          uuid: 'sql-uuid-1',
          title: 'Simple SQL',
          slug: 'simple-sql',
          content: '```sql\nSELECT 1 AS num;\n```',
        },
      };
    });

    const sol = await fetchCommunitySolution(
      'combine-two-tables',
      { starterCode: '# Write your MySQL query statement below' } as ParsedProblem,
      { language: 'mysql', graphql: mockGraphql as never, randomize: false },
    );

    expect(seenTags).toEqual([['mysql'], ['sql']]);
    expect(sol.uuid).toBe('sql-uuid-1');
    expect(sol.code).toBe('SELECT 1 AS num;');
    expect(sol.language).toBe('mysql');
  });
});
