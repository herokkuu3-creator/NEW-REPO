import { config } from '../config';
import { ParsedProblem } from '../leetcode/parser';
import { logger } from '../logger';

/**
 * Solution source: walkccc.me
 *
 * The curated C++ solution for a problem lives at
 *   https://walkccc.me/LeetCode/problems/<questionFrontendId>/
 * where the id is the plain question number (the same `questionFrontendId`
 * LeetCode's own GraphQL returns — no separate lookup needed).
 *
 * Extraction prefers the page's own semantic language anchor
 * (`<div id="cpp">`) and falls back to structural heuristics, so a small
 * Hugo/Bootstrap markup change is far less likely to silently break it.
 */

export class WalkcccError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalkcccError';
  }
}

export interface WalkcccSolution {
  code: string;
  sourceUrl: string;
}

/** A walkccc page resolved from a question NUMBER: the solution + which LeetCode problem it is. */
export interface WalkcccProblem extends WalkcccSolution {
  slug: string;
  title: string | null;
}

/**
 * The raw page. `code` is null when the page exists but has no C++ solution —
 * premium problems show a locked notice, SQL problems have no C++ — while the
 * slug still resolves, so callers can ask LeetCode what the question is.
 */
export interface WalkcccPage {
  code: string | null;
  sourceUrl: string;
  slug: string | null;
  title: string | null;
}

const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export async function fetchWalkcccSolution(
  questionFrontendId: string,
): Promise<WalkcccSolution> {
  const page = await fetchWalkcccPage(questionFrontendId);
  if (!page.code) {
    throw new WalkcccError(`could not extract a C++ solution from ${page.sourceUrl}`);
  }
  return { code: page.code, sourceUrl: page.sourceUrl };
}

/**
 * Same single page fetch, but also resolves the LeetCode slug from the page's
 * own title link (`<h1><a href="https://leetcode.com/problems/<slug>">N. Title</a>`),
 * so a bare question NUMBER is enough — no LeetCode problem-list crawl needed.
 */
export async function fetchWalkcccProblem(questionNumber: number | string): Promise<WalkcccProblem> {
  const page = await fetchWalkcccPage(String(questionNumber));
  if (!page.slug) {
    throw new WalkcccError(`could not find the LeetCode problem link on ${page.sourceUrl}`);
  }
  if (!page.code) {
    throw new WalkcccError(`could not extract a C++ solution from ${page.sourceUrl}`);
  }
  return { code: page.code, sourceUrl: page.sourceUrl, slug: page.slug, title: page.title };
}

/** One walkccc page — never fails for a missing solution, only for a missing page. */
export async function fetchWalkcccPage(questionNumber: number | string): Promise<WalkcccPage> {
  const base = config.solution.walkcccBaseUrl.replace(/\/+$/, '');
  const url = `${base}/problems/${encodeURIComponent(String(questionNumber))}/`;

  logger.info({ url, questionNumber }, 'fetching solution from walkccc');

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  });

  if (res.status === 404) {
    throw new WalkcccError(
      `no walkccc page for problem ${questionNumber} — the problem is too new, or is a premium problem walkccc does not cover`,
    );
  }
  if (!res.ok) {
    throw new WalkcccError(`walkccc request failed with HTTP ${res.status}`);
  }

  const html = await res.text();
  const code = extractCppSolution(html);

  logger.info({ url, hasSolution: Boolean(code), codeLength: code?.length ?? 0 }, 'walkccc page fetched');
  const link = extractProblemLink(html);
  return { code: code ?? null, sourceUrl: url, slug: link?.slug ?? null, title: link?.title ?? null };
}

/** The LeetCode problem a walkccc page is about, from its title link. Exposed for testing. */
export function extractProblemLink(html: string): { slug: string; title: string | null } | null {
  const heading = /<h1[^>]*>\s*<a[^>]+href="https?:\/\/leetcode\.com\/problems\/([a-z0-9-]+)\/?"[^>]*>([^<]*)<\/a>/i.exec(html);
  const m = heading ?? /href="https?:\/\/leetcode\.com\/problems\/([a-z0-9-]+)\/?"[^>]*>([^<]*)</i.exec(html);
  if (!m || !m[1]) return null;
  const title = decodeEntities(m[2] ?? '').replace(/^\s*\d+\.\s*/, '').trim();
  return { slug: m[1], title: title || null };
}

/**
 * Exposed for testing. Returns the cleaned C++ source, or null if nothing
 * usable was found.
 */
export function extractCppSolution(html: string): string | null {
  // Strategy 1 (preferred): the code block inside the anchored C++ section.
  // Checked even when it sits INSIDE the anchor div itself.
  const anchored = extractAnchoredLanguageBlock(html, 'cpp') ?? extractAnchoredLanguageBlock(html, 'c++');
  if (anchored) {
    const code = firstUsableCode(anchored);
    if (code) return code;
  }

  // Strategy 2 (fallback): first code block on the page that is a valid C++
  // solution — walkccc puts C++ first.
  return firstUsableCode(html);
}

/** Escape a string for use inside a RegExp (anchors like "c++" need this). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Pull the HTML between `<div id="cpp">` and the next same-level heading/div id. */
function extractAnchoredLanguageBlock(html: string, anchor: string): string | null {
  const re = new RegExp(
    `<div[^>]+id="${escapeRegExp(anchor)}"[^>]*>([\\s\\S]*?)(?=<(?:div|h[23])[^>]+id=|$)`,
    'i',
  );
  const m = re.exec(html);
  return m && m[1] ? m[1] : null;
}

/**
 * The first <pre><code> block in the region that parses as a plausible C++
 * Solution class. walkccc's solution blocks never carry a `language-` class,
 * so validity is judged by content, not by CSS class.
 */
function firstUsableCode(html: string): string | null {
  // Note: `[^>]*` on <pre>/<code> would wrongly span the close of a nested
  // highlight block's OPENING tag and then match into the wrong block, so the
  // tag-attribute match is kept inside the tags only.
  const blockRe = /<pre[^>]*>(?:(?!<pre)[\s\S])*?<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) {
    const raw = m[1];
    if (!raw) continue;
    const cleaned = cleanCodeBlock(raw);
    if (looksLikeCppSolution(cleaned)) return cleaned;
  }
  return null;
}

/** Strip syntax-highlighting tags, decode entities, normalize whitespace. */
function cleanCodeBlock(fragment: string): string {
  let text = fragment.replace(/<[^>]+>/g, '');
  text = decodeEntities(text);
  // Trim trailing spaces per line, collapse 3+ blank lines, drop surrounding blank lines.
  text = text
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s*\n+|\n+\s*$/g, '');
  return text;
}

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

export function decodeEntities(text: string): string {
  let out = text;
  for (const [entity, char] of Object.entries(ENTITY_MAP)) {
    out = out.split(entity).join(char);
  }
  out = out.replace(/&#(\d+);/g, (_, code: string) =>
    String.fromCodePoint(Number.parseInt(code, 10)),
  );
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) =>
    String.fromCodePoint(Number.parseInt(code, 16)),
  );
  return out;
}

/**
 * A real C++ solution for a LeetCode problem: declares `class Solution` with
 * a method, and is not a placeholder. Deliberately strict enough that a
 * Java/Python block (which lacks `class Solution { public:`) is rejected.
 */
export function looksLikeCppSolution(code: string): boolean {
  if (code.length < 20) return false;
  if (!/class\s+Solution\b/.test(code)) return false;
  if (!/public\s*:/.test(code)) return false;
  if (/\b(TODO|FIXME|implement me|your code here)\b/i.test(code)) return false;
  return true;
}

/**
 * Guard against a subtle failure mode: walkccc's C++ must match the exact
 * signature LeetCode's own C++ starter expects. If the method name differs
 * (rare, but it happens on restructured problems), submitting it is a
 * guaranteed compile error — flag it instead.
 */
export function signatureMatchesStarter(walkcccCode: string, problem: ParsedProblem): boolean {
  const starterName = extractMethodName(problem.starterCode);
  if (!starterName) return true; // can't tell — don't block on it
  return walkcccCode.includes(starterName);
}

function extractMethodName(starterCode: string): string | null {
  const m = /\b(?:[\w:<>,\[\]&*]+\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(starterCode);
  return m?.[1] ?? null;
}
