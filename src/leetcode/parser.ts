import { z } from 'zod';
import { RawQuestionData } from './dailyChallenge';

/**
 * Turns the raw GraphQL question payload into a validated, structured
 * problem description the LLM prompt and the local validator can consume.
 * Any structural failure raises ProblemParseError → PROBLEM_PARSE_FAILED.
 */

export class ProblemParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProblemParseError';
  }
}

export interface ParsedExample {
  input: string;
  output: string;
  explanation?: string;
}

export interface ParsedProblem {
  slug: string;
  title: string;
  difficulty: string;
  frontendId: string;
  /** Plain-text statement (HTML stripped) */
  descriptionText: string;
  /** Original HTML, for reference/debugging */
  descriptionHtml: string;
  examples: ParsedExample[];
  constraints: string[];
  /** Starter code for the configured language, from LeetCode itself */
  starterCode: string;
  /** Language slug the starter code belongs to */
  language: string;
  /** Raw example testcases in LeetCode's flat format (arg per line per case) */
  exampleTestcasesRaw: string;
}

export function parseProblem(raw: RawQuestionData, language: string): ParsedProblem {
  if (!raw.contentHtml || raw.contentHtml.trim().length < 20) {
    throw new ProblemParseError('problem content is empty or suspiciously short');
  }

  const descriptionText = htmlToText(raw.contentHtml);
  const examples = extractExamples(descriptionText);
  const constraints = extractConstraints(descriptionText);
  const starterCode = pickStarterCode(raw, language);

  const parsed: ParsedProblem = {
    slug: raw.slug,
    title: raw.title,
    difficulty: raw.difficulty,
    frontendId: raw.frontendId,
    descriptionText,
    descriptionHtml: raw.contentHtml,
    examples,
    constraints,
    starterCode,
    language,
    exampleTestcasesRaw: raw.exampleTestcases,
  };

  validateParsedProblem(parsed);
  return parsed;
}

// ---------------------------------------------------------------------------

export function htmlToText(html: string): string {
  let text = html;
  text = text.replace(/<\s*br\s*\/?>/gi, '\n');
  text = text.replace(/<\/\s*(p|div|li|ul|ol|pre|h[1-6])\s*>/gi, '\n');
  text = text.replace(/<\s*li[^>]*>/gi, '\n- ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeEntities(text);
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

const ENTITY_MAP: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&times;': '×',
  '&le;': '≤',
  '&ge;': '≥',
  '&ne;': '≠',
  '&minus;': '-',
  '&hellip;': '…',
};

export function decodeEntities(text: string): string {
  let out = text;
  for (const [entity, char] of Object.entries(ENTITY_MAP)) {
    out = out.split(entity).join(char);
  }
  out = out.replace(/&#(\d+);/g, (_, code: string) =>
    String.fromCodePoint(Number.parseInt(code, 10)),
  );
  return out;
}

export function extractExamples(text: string): ParsedExample[] {
  const examples: ParsedExample[] = [];
  // Matches: "Example 1:" ... "Input: ..." "Output: ..." optional "Explanation: ..."
  const re =
    /Example\s*\d+\s*:\s*([\s\S]*?)Input\s*:\s*([\s\S]*?)\n?\s*Output\s*:\s*([\s\S]*?)(?:\n?\s*Explanation\s*:\s*([\s\S]*?))?(?=\n\s*Example\s*\d+\s*:|\n\s*Constraints\s*:|$)/gi;

  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    examples.push({
      input: (match[2] ?? '').trim(),
      output: (match[3] ?? '').trim(),
      explanation: match[4]?.trim() || undefined,
    });
  }
  return examples;
}

export function extractConstraints(text: string): string[] {
  const m = /Constraints\s*:\s*([\s\S]*?)$/i.exec(text);
  if (!m || !m[1]) return [];
  return m[1]
    .split('\n')
    .map((line) => line.replace(/^[-*•]\s*/, '').trim())
    .filter((line) => line.length > 0);
}

function pickStarterCode(raw: RawQuestionData, language: string): string {
  const snippet = raw.codeSnippets.find((s) => s.langSlug === language);
  if (!snippet || !snippet.code.trim()) {
    const available = raw.codeSnippets.map((s) => s.langSlug).join(', ');
    throw new ProblemParseError(
      `no starter code snippet for language "${language}" (available: ${available || 'none'})`,
    );
  }
  return snippet.code;
}

const parsedProblemGuard = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  difficulty: z.enum(['Easy', 'Medium', 'Hard']),
  descriptionText: z.string().min(20),
  starterCode: z.string().min(5),
});

function validateParsedProblem(p: ParsedProblem): void {
  const check = parsedProblemGuard.safeParse(p);
  if (!check.success) {
    throw new ProblemParseError(
      `parsed problem failed validation: ${check.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  // The starter code must define SOMETHING — a class, function, or method.
  if (!/(class\s+\w+|function\s+\w+|def\s+\w+|var\s+\w+\s*=|const\s+\w+\s*=|[A-Za-z_][\w:<>,\[\]&*]*\s+[A-Za-z_]\w*\s*\()/.test(p.starterCode)) {
    throw new ProblemParseError('starter code contains no recognizable function/class definition');
  }
}
