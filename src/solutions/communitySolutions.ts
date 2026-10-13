import { Page } from 'playwright';
import { logger } from '../logger';
import { ParsedProblem } from '../leetcode/parser';
import { signatureMatchesStarter } from './walkccc';

export interface CommunitySolution {
  code: string;
  sourceUrl: string;
  title: string;
  uuid: string;
  author?: string | null;
}

export class CommunitySolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommunitySolutionError';
  }
}

export interface FetchCommunitySolutionOptions {
  language?: string;
  maxArticles?: number;
  page?: Page;
  fetchFn?: typeof fetch;
}

export const UGC_SOLUTION_ARTICLES_QUERY = `
  query ugcArticleSolutionArticles($questionSlug: String!, $orderBy: ArticleOrderByEnum, $userInput: String, $tagSlugs: [String!], $skip: Int, $first: Int) {
    ugcArticleSolutionArticles(
      questionSlug: $questionSlug
      orderBy: $orderBy
      userInput: $userInput
      tagSlugs: $tagSlugs
      skip: $skip
      first: $first
    ) {
      totalNum
      pageInfo {
        hasNextPage
      }
      edges {
        node {
          uuid
          title
          slug
          topicId
          tags {
            name
            slug
          }
          author {
            userName
            realName
          }
        }
      }
    }
  }
`;

export const UGC_SOLUTION_ARTICLE_QUERY = `
  query ugcArticleSolutionArticle($articleId: ID, $topicId: ID) {
    ugcArticleSolutionArticle(articleId: $articleId, topicId: $topicId) {
      uuid
      title
      slug
      topicId
      content
    }
  }
`;

interface UgcArticlesResponse {
  ugcArticleSolutionArticles?: {
    totalNum?: number;
    edges?: Array<{
      node: {
        uuid: string;
        title: string;
        slug: string;
        topicId?: number;
        tags?: Array<{ name: string; slug: string }>;
        author?: { userName?: string; realName?: string };
      };
    }>;
  };
}

interface UgcArticleResponse {
  ugcArticleSolutionArticle?: {
    uuid: string;
    title: string;
    slug: string;
    topicId?: number;
    content?: string;
  } | null;
}

/**
 * Executes a GraphQL query against LeetCode's endpoint.
 * Works via direct fetch (standalone / API transport) or inside a Playwright page.
 */
export async function executeLeetCodeGraphQL<T>(
  query: string,
  variables: Record<string, unknown>,
  options?: FetchCommunitySolutionOptions,
): Promise<T> {
  if (options?.page) {
    try {
      const evalResult = await options.page.evaluate(
        async ({ query, variables }) => {
          const res = await fetch('https://leetcode.com/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ query, variables }),
          });
          const text = await res.text();
          return { status: res.status, body: text };
        },
        { query, variables },
      );

      if (evalResult.status !== 200) {
        throw new CommunitySolutionError(`LeetCode in-page GraphQL HTTP ${evalResult.status}`);
      }

      const json = JSON.parse(evalResult.body) as { data?: T; errors?: Array<{ message?: string }> };
      if (json.errors && json.errors.length > 0) {
        throw new CommunitySolutionError(`LeetCode GraphQL error: ${json.errors[0]?.message ?? 'unknown'}`);
      }
      if (!json.data) {
        throw new CommunitySolutionError('LeetCode GraphQL returned empty data');
      }
      return json.data;
    } catch (err) {
      logger.warn({ err: String(err) }, 'in-page GraphQL query failed, falling back to direct fetch');
    }
  }

  const fetchFn = options?.fetchFn || globalThis.fetch;
  const res = await fetchFn('https://leetcode.com/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Referer: 'https://leetcode.com/',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new CommunitySolutionError(`LeetCode GraphQL request failed with HTTP ${res.status}`);
  }

  const json = (await res.json()) as { data?: T; errors?: Array<{ message?: string }> };
  if (json.errors && json.errors.length > 0) {
    throw new CommunitySolutionError(`LeetCode GraphQL error: ${json.errors[0]?.message ?? 'unknown'}`);
  }
  if (!json.data) {
    throw new CommunitySolutionError('LeetCode GraphQL returned empty data');
  }
  return json.data;
}

/**
 * Extracts clean, matching C++ source code from a solution post's markdown content.
 * Handles:
 * - LeetCode tabbed code blocks (` ```cpp [] ... ``` `)
 * - Standard fenced code blocks (` ```cpp ... ``` `, ` ```c++ ... ``` `)
 * - Multi-language solution posts by prioritizing C++ blocks
 * - Fallback to untagged code blocks containing `class Solution`
 * - Signature validation against LeetCode's C++ starter code
 */
export function extractCppCode(content: string, problem?: ParsedProblem): string | null {
  if (!content || typeof content !== 'string') return null;

  const codeBlocks: Array<{ tag: string; code: string }> = [];
  const fenceRegex = /```([^\n]*)\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(content)) !== null) {
    const rawTag = match[1] ?? '';
    const rawCode = match[2] ?? '';
    codeBlocks.push({
      tag: rawTag.trim().toLowerCase(),
      code: rawCode.trim(),
    });
  }

  // 1. Look for explicit C++ blocks (cpp, c++, c)
  for (const block of codeBlocks) {
    const isCppTag = /^(?:cpp|c\+\+|c)\b/.test(block.tag);
    if (isCppTag && block.code.length > 0) {
      if (isValidCppCandidate(block.code, problem)) {
        return cleanExtractedCode(block.code);
      }
    }
  }

  // 2. Look for code blocks positioned right after a C++ heading (e.g. "### C++" or "**C++**")
  const headingCppBlocks = findBlocksUnderCppHeading(content, codeBlocks);
  for (const block of headingCppBlocks) {
    if (isValidCppCandidate(block.code, problem)) {
      return cleanExtractedCode(block.code);
    }
  }

  // 3. Look for any code block that contains `class Solution` and matches the problem signature
  for (const block of codeBlocks) {
    // Avoid blocks explicitly tagged as other languages
    const isOtherLanguage = /^(?:java|python|python3|py|javascript|js|typescript|ts|ruby|rust|go|c#|csharp|swift|kotlin|php)\b/.test(
      block.tag,
    );
    if (!isOtherLanguage && isValidCppCandidate(block.code, problem)) {
      return cleanExtractedCode(block.code);
    }
  }

  return null;
}

function isValidCppCandidate(code: string, problem?: ParsedProblem): boolean {
  if (!code.includes('class Solution')) {
    // Some solutions omit the class wrapper and just provide the method
    const hasCppKeywords = /\b(?:vector|string|int|long|void|bool|auto|unordered_map|queue|stack)\b/.test(code);
    if (!hasCppKeywords) return false;
  }

  if (problem && !signatureMatchesStarter(code, problem)) {
    return false;
  }

  return true;
}

function findBlocksUnderCppHeading(
  content: string,
  codeBlocks: Array<{ tag: string; code: string }>,
): Array<{ tag: string; code: string }> {
  const result: Array<{ tag: string; code: string }> = [];
  const lines = content.split(/\r?\n/);
  let underCpp = false;

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim().toLowerCase();
    if (/(?:^|\s)(?:#+|\*\*|__|\b)(?:c\+\+|cpp)(?:#+|\*\*|__|\b|:)/.test(line)) {
      underCpp = true;
    } else if (/(?:^|\s)(?:#+|\*\*|__|\b)(?:java|python|javascript|golang|rust)(?:#+|\*\*|__|\b|:)/.test(line)) {
      underCpp = false;
    }

    if (underCpp && line.startsWith('```')) {
      // Find the corresponding block in codeBlocks
      const matched = codeBlocks.find((b) => b.code.startsWith(lines[i + 1]?.trim() ?? ''));
      if (matched && !result.includes(matched)) {
        result.push(matched);
      }
    }
  }

  return result;
}

function cleanExtractedCode(code: string): string {
  // Strip any accidental leading/trailing backticks or markdown markers
  let cleaned = code.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-z0-9_+-]*\r?\n/i, '');
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.replace(/\r?\n```$/, '');
  }
  return cleaned.trim();
}

/**
 * Fetches and returns a verified community C++ solution for a LeetCode problem.
 *
 * Sequence:
 * 1. Queries `ugcArticleSolutionArticles` sorted by HOT/most votes, filtered by tag `cpp`.
 * 2. If no tagged articles exist, retries without language tags.
 * 3. Inspects each article via `ugcArticleSolutionArticle` and extracts the C++ block.
 * 4. Validates that the C++ code matches LeetCode's method signature for the problem.
 * 5. Returns the verified solution code and source URL.
 */
export async function fetchCommunitySolution(
  questionSlug: string,
  problem: ParsedProblem,
  options?: FetchCommunitySolutionOptions,
): Promise<CommunitySolution> {
  const language = options?.language ?? 'cpp';
  const maxArticles = options?.maxArticles ?? 10;
  const langTag = language === 'cpp' ? 'cpp' : language === 'python3' ? 'python3' : language;

  logger.info({ questionSlug, language, maxArticles }, 'fetching LeetCode community solutions fallback');

  // 1. Fetch solution articles tagged with the target language
  let edges: NonNullable<NonNullable<UgcArticlesResponse['ugcArticleSolutionArticles']>['edges']> = [];
  try {
    const listData = await executeLeetCodeGraphQL<UgcArticlesResponse>(
      UGC_SOLUTION_ARTICLES_QUERY,
      {
        questionSlug,
        orderBy: 'HOT',
        userInput: '',
        tagSlugs: [langTag],
        skip: 0,
        first: maxArticles,
      },
      options,
    );
    edges = listData.ugcArticleSolutionArticles?.edges ?? [];
    logger.info({ questionSlug, langTag, count: edges.length }, 'community solution articles found with language tag');
  } catch (err) {
    logger.warn({ questionSlug, err: String(err) }, 'failed to fetch tagged community solution articles; trying untagged');
  }

  // 2. If no tagged articles found, fall back to untagged articles
  if (edges.length === 0) {
    const untaggedData = await executeLeetCodeGraphQL<UgcArticlesResponse>(
      UGC_SOLUTION_ARTICLES_QUERY,
      {
        questionSlug,
        orderBy: 'HOT',
        userInput: '',
        tagSlugs: [],
        skip: 0,
        first: maxArticles,
      },
      options,
    );
    edges = untaggedData.ugcArticleSolutionArticles?.edges ?? [];
    logger.info({ questionSlug, count: edges.length }, 'community solution articles found without language tag');
  }

  if (edges.length === 0) {
    throw new CommunitySolutionError(`no community solution articles found for problem ${questionSlug}`);
  }

  // 3. Inspect articles in rank order until we extract a verified matching solution
  for (const edge of edges) {
    const node = edge.node;
    logger.info({ questionSlug, articleTitle: node.title, uuid: node.uuid }, 'inspecting community solution article');

    try {
      const artData = await executeLeetCodeGraphQL<UgcArticleResponse>(
        UGC_SOLUTION_ARTICLE_QUERY,
        { articleId: node.uuid },
        options,
      );

      const content = artData.ugcArticleSolutionArticle?.content;
      if (!content) {
        logger.warn({ questionSlug, uuid: node.uuid }, 'community solution article content was empty');
        continue;
      }

      const code = extractCppCode(content, problem);
      if (code) {
        const sourceUrl = `https://leetcode.com/problems/${questionSlug}/solutions/${node.topicId ?? ''}/${node.slug}/`;
        logger.info(
          { questionSlug, articleTitle: node.title, sourceUrl, codeLength: code.length },
          'verified community C++ solution obtained',
        );
        return {
          code,
          sourceUrl,
          title: node.title,
          uuid: node.uuid,
          author: node.author?.userName ?? node.author?.realName ?? null,
        };
      } else {
        logger.warn({ questionSlug, articleTitle: node.title }, 'article did not contain a matching C++ solution');
      }
    } catch (err) {
      logger.warn({ questionSlug, uuid: node.uuid, err: String(err) }, 'failed to inspect community solution article');
    }
  }

  throw new CommunitySolutionError(
    `none of the ${edges.length} inspected community solution articles for ${questionSlug} contained a valid matching ${language} solution`,
  );
}
