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
  rankIndex?: number;
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
  randomize?: boolean;
  targetIndex?: number;
  excludeUuids?: string[] | Set<string>;
}

export interface CommunityArticleNode {
  uuid: string;
  title: string;
  slug: string;
  topicId?: number;
  tags?: Array<{ name: string; slug: string }>;
  author?: { userName?: string; realName?: string };
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

// In-memory cache for article lists: key = `${questionSlug}:${langTag}:${maxArticles}`
interface CachedArticleList {
  timestamp: number;
  edges: Array<{ node: CommunityArticleNode }>;
}
const articleListCache = new Map<string, CachedArticleList>();

// In-memory cache for article raw contents: key = articleId (uuid)
interface CachedArticleContent {
  timestamp: number;
  content: string;
}
const articleContentCache = new Map<string, CachedArticleContent>();

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export function clearCommunitySolutionsCache(): void {
  articleListCache.clear();
  articleContentCache.clear();
}

/**
 * Fetches the ranked community solution articles list from LeetCode GraphQL.
 * Caches results in memory to avoid duplicate network queries across multiple accounts.
 */
export async function fetchCommunityArticleList(
  questionSlug: string,
  options?: FetchCommunitySolutionOptions,
): Promise<Array<{ node: CommunityArticleNode }>> {
  const language = options?.language ?? 'cpp';
  const maxArticles = options?.maxArticles ?? 10;
  const langTag = language === 'cpp' ? 'cpp' : language === 'python3' ? 'python3' : language;
  const cacheKey = `${questionSlug}:${langTag}:${maxArticles}`;

  const cached = articleListCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS && cached.edges.length > 0) {
    return cached.edges;
  }

  // 1. Fetch solution articles tagged with the target language
  let edges: Array<{ node: CommunityArticleNode }> = [];
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

  // 2. Fallback to untagged if 0 tagged articles found
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

  if (edges.length > 0) {
    articleListCache.set(cacheKey, { timestamp: Date.now(), edges });
  }

  return edges;
}

/**
 * Fetches the markdown content for an article ID, caching in-memory.
 */
export async function fetchArticleContent(
  uuid: string,
  options?: FetchCommunitySolutionOptions,
): Promise<string | null> {
  const cached = articleContentCache.get(uuid);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.content;
  }

  const artData = await executeLeetCodeGraphQL<UgcArticleResponse>(
    UGC_SOLUTION_ARTICLE_QUERY,
    { articleId: uuid },
    options,
  );
  const content = artData.ugcArticleSolutionArticle?.content ?? null;
  if (content) {
    articleContentCache.set(uuid, { timestamp: Date.now(), content });
  }
  return content;
}

/**
 * Fetches and returns a verified community C++ solution for a LeetCode problem.
 *
 * Supports randomized candidate selection from top 10 results (or targetIndex):
 * - Picks a random candidate from 1..10 to avoid predictable solution patterns.
 * - Prioritizes unused candidates across accounts so each account receives a distinct solution.
 * - Validates C++ syntax and LeetCode method signature.
 * - Automatically falls back to other candidates among the top results if a candidate is invalid.
 */
export async function fetchCommunitySolution(
  questionSlug: string,
  problem: ParsedProblem,
  options?: FetchCommunitySolutionOptions,
): Promise<CommunitySolution> {
  const language = options?.language ?? 'cpp';
  const maxArticles = options?.maxArticles ?? 10;
  logger.info({ questionSlug, language, maxArticles }, 'fetching LeetCode community solutions');

  const edges = await fetchCommunityArticleList(questionSlug, options);
  if (edges.length === 0) {
    throw new CommunitySolutionError(`no community solution articles found for problem ${questionSlug}`);
  }

  const N = edges.length;
  const excluded = new Set<string>();
  if (options?.excludeUuids) {
    for (const u of options.excludeUuids) excluded.add(u);
  }

  let inspectionOrder: number[] = [];

  if (options?.targetIndex !== undefined) {
    const start = Math.max(0, options.targetIndex) % N;
    const cycle: number[] = [];
    for (let i = 0; i < N; i++) {
      cycle.push((start + i) % N);
    }
    const unused = cycle.filter((idx) => !excluded.has(edges[idx]!.node.uuid));
    const used = cycle.filter((idx) => excluded.has(edges[idx]!.node.uuid));
    inspectionOrder = [...unused, ...used];
  } else if (options?.randomize === false) {
    const seq = Array.from({ length: N }, (_, i) => i);
    const unused = seq.filter((idx) => !excluded.has(edges[idx]!.node.uuid));
    const used = seq.filter((idx) => excluded.has(edges[idx]!.node.uuid));
    inspectionOrder = [...unused, ...used];
  } else {
    // Randomized variation per account from 1..N
    const allIndices = Array.from({ length: N }, (_, i) => i);
    const unusedIndices = allIndices.filter((idx) => !excluded.has(edges[idx]!.node.uuid));
    const usedIndices = allIndices.filter((idx) => excluded.has(edges[idx]!.node.uuid));

    const shuffle = (arr: number[]) => {
      const copy = [...arr];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      }
      return copy;
    };

    if (unusedIndices.length > 0) {
      inspectionOrder = [...shuffle(unusedIndices), ...shuffle(usedIndices)];
    } else {
      inspectionOrder = shuffle(allIndices);
    }
  }

  const targetChoice = (inspectionOrder[0] ?? 0) + 1;
  logger.info(
    { questionSlug, targetResultRank: targetChoice, totalArticles: N, excludedCount: excluded.size },
    'evaluating community solution articles with randomized target rank',
  );

  for (const candidateIndex of inspectionOrder) {
    const node = edges[candidateIndex]!.node;
    const rank1Based = candidateIndex + 1;

    try {
      const content = await fetchArticleContent(node.uuid, options);
      if (!content) {
        logger.warn({ questionSlug, uuid: node.uuid, rank: rank1Based }, 'community solution article content was empty');
        continue;
      }

      const code = extractCppCode(content, problem);
      if (code) {
        const sourceUrl = `https://leetcode.com/problems/${questionSlug}/solutions/${node.topicId ?? ''}/${node.slug}/`;
        logger.info(
          {
            questionSlug,
            rank: rank1Based,
            articleTitle: node.title,
            sourceUrl,
            codeLength: code.length,
            author: node.author?.userName ?? node.author?.realName,
          },
          'verified community C++ solution obtained at selected rank',
        );
        return {
          code,
          sourceUrl,
          title: node.title,
          uuid: node.uuid,
          author: node.author?.userName ?? node.author?.realName ?? null,
          rankIndex: rank1Based,
        };
      } else {
        logger.warn(
          { questionSlug, rank: rank1Based, articleTitle: node.title },
          'community article did not contain a matching C++ solution; checking next candidate',
        );
      }
    } catch (err) {
      logger.warn(
        { questionSlug, rank: rank1Based, uuid: node.uuid, err: String(err) },
        'failed to inspect community solution article; checking next candidate',
      );
    }
  }

  throw new CommunitySolutionError(
    `none of the ${N} inspected community solution articles for ${questionSlug} contained a valid matching ${language} solution`,
  );
}

export const PROBLEMSET_QUESTION_LIST_QUERY = `
  query problemsetQuestionList($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
    problemsetQuestionList: questionList(
      categorySlug: $categorySlug
      limit: $limit
      skip: $skip
      filters: $filters
    ) {
      total: totalNum
      questions: data {
        frontendQuestionId: questionFrontendId
        titleSlug
        title
        paidOnly: isPaidOnly
      }
    }
  }
`;

const slugByNumberCache = new Map<number, string>();

/**
 * Resolves a LeetCode problem's titleSlug given its frontend question number.
 * Uses the GraphQL problemsetQuestionList query with keyword filter.
 * Caches resolved slugs in memory so each question number is looked up at most once.
 */
export async function resolveLeetCodeSlugByNumber(
  questionNumber: number,
  options?: FetchCommunitySolutionOptions,
): Promise<string | null> {
  const cached = slugByNumberCache.get(questionNumber);
  if (cached) return cached;

  const targetStr = String(questionNumber);
  try {
    const data = await executeLeetCodeGraphQL<{
      problemsetQuestionList?: {
        total?: number;
        questions?: Array<{
          frontendQuestionId?: string;
          titleSlug?: string;
          title?: string;
          paidOnly?: boolean;
        }>;
      };
    }>(
      PROBLEMSET_QUESTION_LIST_QUERY,
      {
        categorySlug: '',
        skip: 0,
        limit: 10,
        filters: { searchKeywords: targetStr },
      },
      options,
    );

    const questions = data.problemsetQuestionList?.questions ?? [];
    const matched = questions.find((q) => q.frontendQuestionId === targetStr);
    if (matched?.titleSlug) {
      slugByNumberCache.set(questionNumber, matched.titleSlug);
      logger.info(
        { questionNumber, slug: matched.titleSlug, title: matched.title },
        'resolved LeetCode slug by question number',
      );
      return matched.titleSlug;
    }
    logger.warn({ questionNumber, totalResults: questions.length }, 'no exact frontendQuestionId match found in LeetCode problemset query');
    return null;
  } catch (err) {
    logger.error({ questionNumber, err: String(err) }, 'failed to resolve LeetCode slug by question number');
    return null;
  }
}

export function clearSlugByNumberCacheForTests(): void {
  slugByNumberCache.clear();
}
