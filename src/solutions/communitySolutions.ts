import { Page } from 'playwright';
import { logger } from '../logger';
import { ParsedProblem } from '../leetcode/parser';
import { signatureMatchesStarter } from './walkccc';
import { looksLikeChallenge } from '../leetcode/apiClient';

export interface CommunitySolution {
  code: string;
  sourceUrl: string;
  title: string;
  uuid: string;
  author?: string | null;
  rankIndex?: number;
  language?: string;
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
  graphql?: <T>(query: string, variables: Record<string, unknown>) => Promise<T>;
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
  if (options?.graphql) return options.graphql<T>(query, variables);
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
 * - Multi-language solution posts by prioritizing matching language blocks
 * - Fallback to untagged/heading-grouped code blocks
 * - Signature validation against LeetCode's starter code for the target language
 */
export function extractCppCode(content: string, problem?: ParsedProblem): string | null {
  return extractCodeForLanguage(content, 'cpp', problem);
}

interface ParsedFenceBlock {
  tag: string;
  code: string;
  headingHint: string;
}

interface LanguageSpec {
  primaryTags: RegExp;
  secondaryTags?: RegExp;
  headings: RegExp;
  otherLanguages: RegExp;
  validator: (code: string, problem?: ParsedProblem) => boolean;
}

const OTHER_LANG_FENCE_BASE =
  'cpp|c\\+\\+|c|java|python|python3|py|pythondata|pandas|javascript|js|typescript|ts|ruby|rb|rust|rs|go|golang|c#|csharp|cs|swift|kotlin|kt|php|scala|dart|mysql|postgresql|postgres|psql|pgsql|mssql|tsql|oraclesql|oracle|plsql|sql|bash|sh|shell|zsh';

const isSqlLanguage = (lang: string): boolean =>
  lang === 'mysql' || lang === 'postgresql' || lang === 'mssql' || lang === 'oraclesql';

const stripSqlComments = (code: string): string =>
  code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ')
    .trim();

function isValidSqlCandidate(code: string): boolean {
  const stripped = stripSqlComments(code);
  if (stripped.length < 10) return false;
  if (/^\s*(?:#include\b|import\s+|from\s+\w+\s+import\b|def\s+\w+\s*\(|class\s+Solution\b)/m.test(stripped)) {
    return false;
  }
  return /\b(?:SELECT|WITH|UPDATE|DELETE|INSERT|CREATE|ALTER|DROP|MERGE|SHOW|EXPLAIN)\b/i.test(stripped);
}

function starterIdentifierForLanguage(starterCode: string, language: string): string | null {
  if (!starterCode) return null;
  if (language === 'cpp') {
    const m = /\b(?:[\w:<>,\[\]&*]+\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(starterCode);
    return m?.[1] ?? null;
  }
  if (language === 'python3' || language === 'python' || language === 'pythondata') {
    const defs = [...starterCode.matchAll(/\bdef\s+([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]!);
    return defs.find((d) => d !== '__init__') ?? defs[0] ?? null;
  }
  if (language === 'java' || language === 'csharp') {
    const ignored = new Set(['class', 'interface', 'if', 'for', 'while', 'switch', 'return', 'new', 'Solution']);
    for (const m of starterCode.matchAll(/(?:\b(?:public|private|protected|static|final)\s+)*[\w<>\[\], ?]+\s+([A-Za-z_]\w*)\s*\(/g)) {
      if (m[1] && !ignored.has(m[1])) return m[1];
    }
    return null;
  }
  if (language === 'javascript' || language === 'typescript') {
    const m =
      /(?:var|let|const)\s+([A-Za-z_]\w*)\s*=|\bfunction\s+([A-Za-z_]\w*)\s*\(/.exec(starterCode);
    return m?.[1] ?? m?.[2] ?? null;
  }
  if (language === 'golang') {
    const m = /\bfunc\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)\s*\(/.exec(starterCode);
    return m?.[1] ?? null;
  }
  if (language === 'rust') {
    const m = /(?:pub\s+)?fn\s+([A-Za-z_]\w*)\s*\(/.exec(starterCode);
    return m?.[1] ?? null;
  }
  return null;
}

function matchesStarterSignature(code: string, language: string, problem?: ParsedProblem): boolean {
  if (!problem?.starterCode) return true;
  if (language === 'cpp') return signatureMatchesStarter(code, problem);
  if (isSqlLanguage(language) || language === 'bash') return true;
  const ident = starterIdentifierForLanguage(problem.starterCode, language);
  if (!ident) return true;
  return code.includes(ident);
}

function isValidPythonCandidate(code: string, language: string, problem?: ParsedProblem): boolean {
  const noComments = code.replace(/#[^\n]*/g, '').trim();
  if (noComments.length < 10) return false;
  if (/#include\b|\bpublic\s+class\b|\bfunction\s*\(/.test(noComments)) return false;
  if (!/\b(?:def\s+\w+|class\s+Solution\b|lambda\b|import\s+\w+)\b/.test(noComments)) return false;
  return matchesStarterSignature(code, language, problem);
}

function isValidJavaCandidate(code: string, problem?: ParsedProblem): boolean {
  if (/#include\b|\bpublic\s*:\s*/.test(code)) return false;
  if (!/\bclass\s+Solution\b|\bpublic\s+(?:static\s+)?[\w<>\[\], ?]+\s+\w+\s*\(/.test(code)) return false;
  return matchesStarterSignature(code, 'java', problem);
}

function isValidJsTsCandidate(code: string, language: string, problem?: ParsedProblem): boolean {
  if (/#include\b|\bdef\s+\w+\s*\(|\bpublic\s*:\s*/.test(code)) return false;
  if (!/\bfunction\b|=>|\bclass\s+\w+|\b(?:var|let|const)\s+\w+\s*=/.test(code)) return false;
  return matchesStarterSignature(code, language, problem);
}

function isValidBashCandidate(code: string): boolean {
  const activeLines = code
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  const joined = activeLines.join('\n');
  if (joined.length < 4) return false;
  if (/^\s*(?:#include\b|class\s+Solution\b|SELECT\b|def\s+\w+\s*\()/im.test(joined)) return false;
  return true;
}

const FENCE_END = '(?:$|\\s|\\[|[^a-z0-9_+])';

function getLanguageSpec(rawLanguage: string): LanguageSpec {
  const language = rawLanguage.trim().toLowerCase();
  if (language === 'cpp') {
    return {
      primaryTags: /^(?:cpp|c\+\+|c(?![+#]))(?:$|\s|\[)/i,
      headings: /(?:^|\s)(?:#+|\*\*|__|\b)(?:c\+\+|cpp)(?:#+|\*\*|__|\b|:|$)/i,
      otherLanguages: /^(?:java|python|python3|py|pythondata|pandas|javascript|js|typescript|ts|ruby|rust|go|golang|c#|csharp|swift|kotlin|php|mysql|postgresql|mssql|oraclesql|sql|bash|sh|shell)\b/i,
      validator: isValidCppCandidate,
    };
  }
  if (isSqlLanguage(language)) {
    const dialectPattern: Record<string, RegExp> = {
      mysql: /^mysql\b/i,
      postgresql: /^(?:postgresql|postgres|psql|pgsql)\b/i,
      mssql: /^(?:mssql|tsql)\b/i,
      oraclesql: /^(?:oraclesql|oracle|plsql)\b/i,
    };
    const dialectHeading: Record<string, RegExp> = {
      mysql: /(?:^|\s)(?:#+|\*\*|__|\b)(?:mysql|sql)(?:#+|\*\*|__|\b|:|$)/i,
      postgresql: /(?:^|\s)(?:#+|\*\*|__|\b)(?:postgresql|postgres|sql)(?:#+|\*\*|__|\b|:|$)/i,
      mssql: /(?:^|\s)(?:#+|\*\*|__|\b)(?:ms\s*sql|mssql|tsql|sql)(?:#+|\*\*|__|\b|:|$)/i,
      oraclesql: /(?:^|\s)(?:#+|\*\*|__|\b)(?:oracle|oraclesql|plsql|sql)(?:#+|\*\*|__|\b|:|$)/i,
    };
    const otherSqlDialects = ['mysql', 'postgresql', 'postgres', 'psql', 'pgsql', 'mssql', 'tsql', 'oraclesql', 'oracle', 'plsql']
      .filter((d) => !dialectPattern[language]!.test(d))
      .join('|');
    return {
      primaryTags: dialectPattern[language]!,
      secondaryTags: /^sql\b/i,
      headings: dialectHeading[language]!,
      otherLanguages: new RegExp(`^(?:${otherSqlDialects}|cpp|c\\+\\+|java|python|python3|py|javascript|js|typescript|ts|ruby|rust|go|golang|c#|csharp|swift|kotlin|php|bash|sh|shell)\\b`, 'i'),
      validator: (code) => isValidSqlCandidate(code),
    };
  }
  if (language === 'pythondata') {
    return {
      primaryTags: /^(?:pythondata|pandas)\b/i,
      secondaryTags: /^(?:python3|python|py)\b/i,
      headings: /(?:^|\s)(?:#+|\*\*|__|\b)(?:pandas|pythondata|python3?)(?:#+|\*\*|__|\b|:|$)/i,
      otherLanguages: /^(?:cpp|c\+\+|c|java|javascript|js|typescript|ts|ruby|rust|go|golang|c#|csharp|swift|kotlin|php|mysql|postgresql|mssql|oraclesql|sql|bash|sh|shell)\b/i,
      validator: (code, problem) => isValidPythonCandidate(code, language, problem),
    };
  }
  if (language === 'python3' || language === 'python') {
    return {
      primaryTags: /^(?:python3|python|py)\b/i,
      headings: /(?:^|\s)(?:#+|\*\*|__|\b)(?:python3|python|py)(?:#+|\*\*|__|\b|:|$)/i,
      otherLanguages: /^(?:cpp|c\+\+|c|java|javascript|js|typescript|ts|ruby|rust|go|golang|c#|csharp|swift|kotlin|php|mysql|postgresql|mssql|oraclesql|sql|bash|sh|shell)\b/i,
      validator: (code, problem) => isValidPythonCandidate(code, language, problem),
    };
  }
  if (language === 'java') {
    return {
      primaryTags: /^java\b/i,
      headings: /(?:^|\s)(?:#+|\*\*|__|\b)java(?:#+|\*\*|__|\b|:|$)/i,
      otherLanguages: /^(?:cpp|c\+\+|c|python|python3|py|javascript|js|typescript|ts|ruby|rust|go|golang|c#|csharp|swift|kotlin|php|mysql|sql|bash|sh|shell)\b/i,
      validator: (code, problem) => isValidJavaCandidate(code, problem),
    };
  }
  if (language === 'javascript') {
    return {
      primaryTags: /^(?:javascript|js)\b/i,
      headings: /(?:^|\s)(?:#+|\*\*|__|\b)(?:javascript|js)(?:#+|\*\*|__|\b|:|$)/i,
      otherLanguages: /^(?:cpp|c\+\+|c|java|python|python3|py|typescript|ts|ruby|rust|go|golang|c#|csharp|swift|kotlin|php|mysql|sql|bash|sh|shell)\b/i,
      validator: (code, problem) => isValidJsTsCandidate(code, language, problem),
    };
  }
  if (language === 'typescript') {
    return {
      primaryTags: /^(?:typescript|ts)\b/i,
      headings: /(?:^|\s)(?:#+|\*\*|__|\b)(?:typescript|ts)(?:#+|\*\*|__|\b|:|$)/i,
      otherLanguages: /^(?:cpp|c\+\+|c|java|python|python3|py|javascript|js|ruby|rust|go|golang|c#|csharp|swift|kotlin|php|mysql|sql|bash|sh|shell)\b/i,
      validator: (code, problem) => isValidJsTsCandidate(code, language, problem),
    };
  }
  if (language === 'bash') {
    return {
      primaryTags: /^(?:bash|sh|shell|zsh)\b/i,
      headings: /(?:^|\s)(?:#+|\*\*|__|\b)(?:bash|shell)(?:#+|\*\*|__|\b|:|$)/i,
      otherLanguages: /^(?:cpp|c\+\+|c|java|python|python3|py|javascript|js|typescript|ts|ruby|rust|go|golang|c#|csharp|swift|kotlin|php|mysql|sql)\b/i,
      validator: (code) => isValidBashCandidate(code),
    };
  }
  const tagMap: Record<string, RegExp> = {
    c: /^c\b(?![+#])/i,
    csharp: new RegExp(`^(?:csharp|c#|cs)${FENCE_END}`, 'i'),
    golang: /^(?:go|golang)\b/i,
    rust: /^(?:rust|rs)\b/i,
    ruby: /^(?:ruby|rb)\b/i,
    swift: /^swift\b/i,
    kotlin: /^(?:kotlin|kt)\b/i,
    php: /^php\b/i,
    scala: /^scala\b/i,
    dart: /^dart\b/i,
  };
  const primary = tagMap[language] ?? new RegExp(`^${language.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return {
    primaryTags: primary,
    headings: new RegExp(`(?:^|\\s)(?:#+|\\*\\*|__|\\b)${language.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:#+|\\*\\*|__|\\b|:|$)`, 'i'),
    otherLanguages: new RegExp(`^(?:${OTHER_LANG_FENCE_BASE})(?:$|\\s|\\[)`, 'i'),
    validator: (code, problem) => code.length >= 10 && matchesStarterSignature(code, language, problem),
  };
}

function parseMarkdownCodeBlocks(content: string): ParsedFenceBlock[] {
  const blocks: ParsedFenceBlock[] = [];
  const lines = content.split(/\r?\n/);
  let currentHeading = '';
  let inFence = false;
  let fenceTag = '';
  let fenceLines: string[] = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!inFence) {
      if (trimmed.startsWith('```')) {
        inFence = true;
        fenceTag = trimmed.slice(3).trim().toLowerCase();
        fenceLines = [];
      } else if (/^(?:#{1,6}\s+|\*\*|__)/.test(trimmed) || /^(?:c\+\+|cpp|java|python3?|mysql|postgresql|sql|javascript|typescript|bash|shell|pandas|golang|rust|csharp)\b[:\s]*$/i.test(trimmed)) {
        currentHeading = trimmed.toLowerCase();
      }
    } else if (trimmed.startsWith('```')) {
      blocks.push({
        tag: fenceTag,
        code: fenceLines.join('\n').trim(),
        headingHint: currentHeading,
      });
      inFence = false;
      fenceTag = '';
      fenceLines = [];
    } else {
      fenceLines.push(rawLine);
    }
  }

  return blocks;
}

/**
 * Extracts clean, matching source code for a target LeetCode `langSlug` from a solution post's markdown.
 */
export function extractCodeForLanguage(
  content: string,
  language: string,
  problem?: ParsedProblem,
): string | null {
  if (!content || typeof content !== 'string') return null;

  const lang = language.trim().toLowerCase() || 'cpp';
  const spec = getLanguageSpec(lang);
  const blocks = parseMarkdownCodeBlocks(content);

  // 1a. Explicit primary fence tag match (e.g. ```mysql, ```cpp, ```python3)
  for (const block of blocks) {
    if (block.code.length > 0 && spec.primaryTags.test(block.tag)) {
      if (spec.validator(block.code, problem)) {
        return cleanExtractedCode(block.code);
      }
    }
  }

  // 1b. Secondary compatible fence tag match (e.g. generic ```sql for mysql, ```python for pythondata)
  if (spec.secondaryTags) {
    for (const block of blocks) {
      if (block.code.length > 0 && spec.secondaryTags.test(block.tag)) {
        if (spec.validator(block.code, problem)) {
          return cleanExtractedCode(block.code);
        }
      }
    }
  }

  // 2. Untagged or compatible blocks under a matching language heading (e.g. "### MySQL", "**Python**")
  for (const block of blocks) {
    if (block.code.length === 0) continue;
    if (block.tag && !spec.primaryTags.test(block.tag) && !spec.secondaryTags?.test(block.tag) && spec.otherLanguages.test(block.tag)) {
      continue;
    }
    if (spec.headings.test(block.headingHint) && spec.validator(block.code, problem)) {
      return cleanExtractedCode(block.code);
    }
  }

  // 3. Fallback: untagged blocks not labelled as another language that pass validation
  for (const block of blocks) {
    if (block.code.length === 0) continue;
    const isOther = block.tag.length > 0 && !spec.primaryTags.test(block.tag) && !spec.secondaryTags?.test(block.tag) && spec.otherLanguages.test(block.tag);
    if (!isOther && spec.validator(block.code, problem)) {
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
const EMPTY_LIST_CACHE_TTL_MS = 5 * 60 * 1000;

export function clearCommunitySolutionsCache(): void {
  articleListCache.clear();
  articleContentCache.clear();
}

/**
 * Fetches the ranked community solution articles list from LeetCode GraphQL.
 * Caches results in memory to avoid duplicate network queries across multiple accounts.
 */
function communityTagCandidates(language: string): string[] {
  const lang = language.trim().toLowerCase();
  if (lang === 'mysql' || lang === 'postgresql' || lang === 'mssql' || lang === 'oraclesql') {
    return [lang, 'sql'];
  }
  if (lang === 'pythondata') return ['pythondata', 'pandas', 'python3'];
  if (lang === 'golang') return ['golang', 'go'];
  return [lang];
}

export async function fetchCommunityArticleList(
  questionSlug: string,
  options?: FetchCommunitySolutionOptions,
): Promise<Array<{ node: CommunityArticleNode }>> {
  const language = options?.language ?? 'cpp';
  const maxArticles = options?.maxArticles ?? 10;
  const langTag = language === 'cpp' ? 'cpp' : language === 'python3' ? 'python3' : language;
  const cacheKey = `${questionSlug}:${langTag}:${maxArticles}`;

  const cached = articleListCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < (cached.edges.length ? CACHE_TTL_MS : EMPTY_LIST_CACHE_TTL_MS)) {
    return cached.edges;
  }

  // 1. Fetch solution articles tagged with the target language (and close tag aliases like sql/pandas)
  let edges: Array<{ node: CommunityArticleNode }> = [];
  let confirmedEmpty = false;
  for (const candidateTag of communityTagCandidates(langTag)) {
    try {
      const listData = await executeLeetCodeGraphQL<UgcArticlesResponse>(
        UGC_SOLUTION_ARTICLES_QUERY,
        {
          questionSlug,
          orderBy: 'HOT',
          userInput: '',
          tagSlugs: [candidateTag],
          skip: 0,
          first: maxArticles,
        },
        options,
      );
      const tagged = listData.ugcArticleSolutionArticles?.edges;
      edges = tagged ?? [];
      confirmedEmpty = Array.isArray(tagged) && tagged.length === 0;
      logger.info({ questionSlug, langTag: candidateTag, count: edges.length }, 'community solution articles found with language tag');
      if (edges.length > 0) break;
    } catch (err) {
      if (options?.graphql && looksLikeChallenge(err)) throw err;
      logger.warn({ questionSlug, langTag: candidateTag, err: String(err) }, 'failed to fetch tagged community solution articles; trying next');
    }
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
    const untagged = untaggedData.ugcArticleSolutionArticles?.edges;
    edges = untagged ?? [];
    confirmedEmpty = confirmedEmpty && Array.isArray(untagged) && untagged.length === 0;
    logger.info({ questionSlug, count: edges.length }, 'community solution articles found without language tag');
  }

  if (edges.length > 0 || confirmedEmpty) {
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

      const code = extractCodeForLanguage(content, language, problem);
      if (code) {
        const sourceUrl = `https://leetcode.com/problems/${questionSlug}/solutions/${node.topicId ?? ''}/${node.slug}/`;
        logger.info(
          {
            questionSlug,
            language,
            rank: rank1Based,
            articleTitle: node.title,
            sourceUrl,
            codeLength: code.length,
            author: node.author?.userName ?? node.author?.realName,
          },
          'verified community solution obtained at selected rank',
        );
        return {
          code,
          sourceUrl,
          title: node.title,
          uuid: node.uuid,
          author: node.author?.userName ?? node.author?.realName ?? null,
          rankIndex: rank1Based,
          language,
        };
      } else {
        logger.warn(
          { questionSlug, language, rank: rank1Based, articleTitle: node.title },
          'community article did not contain a matching solution; checking next candidate',
        );
      }
    } catch (err) {
      if (options?.graphql && looksLikeChallenge(err)) throw err;
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
    if (options?.graphql && looksLikeChallenge(err)) throw err;
    logger.error({ questionNumber, err: String(err) }, 'failed to resolve LeetCode slug by question number');
    return null;
  }
}

export function clearSlugByNumberCacheForTests(): void {
  slugByNumberCache.clear();
}
