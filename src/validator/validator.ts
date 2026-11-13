import { ParsedProblem } from '../leetcode/parser';
import { createRunner, RunReport } from './runners';
import { extractFunctionName, generateTestCases } from './testcaseGenerator';
import { logger } from '../logger';

/**
 * Pre-submission validation pipeline:
 *   1. strip markdown fences (and REJECT if the model insists on prose)
 *   2. placeholder / unfinished-code rejection
 *   3. syntax check
 *   4. run extracted examples (expected outputs verified)
 *   5. run generated edge cases (crash-only)
 *
 * Returns the cleaned code on success; on failure returns a structured
 * report that is fed back to the LLM by the solver loop.
 */

export interface ValidationSuccess {
  ok: true;
  code: string;
}

export interface ValidationFailure {
  ok: false;
  stage: 'format' | 'placeholder' | 'syntax' | 'examples' | 'edge-cases';
  report: string;
}

export type ValidationOutcome = ValidationSuccess | ValidationFailure;

const PLACEHOLDER_PATTERNS: RegExp[] = [
  /\bTODO\b/i,
  /\bFIXME\b/i,
  /\bplaceholder\b/i,
  /pass\s*#?\s*(implement|todo)/i,
  /throw\s+new\s+(NotImplemented)?Error\(\s*['"`]?(not implemented|todo)/i,
  /your code here/i,
  /\.\.\.\s*(implement|solution)/i,
];

const SQL_VALIDATOR_LANGS = new Set(['mysql', 'postgresql', 'mssql', 'oraclesql']);

/** Strips ``` fences and surrounding prose. Returns null if nothing usable. */
export function extractCode(raw: string, language?: string): string | null {
  let text = raw.trim();

  // Full fenced block(s): take the first complete fence body.
  const fence = /```(?:[a-zA-Z0-9_+-]*)\s*\n([\s\S]*?)```/.exec(text);
  if (fence && fence[1]) {
    text = fence[1].trim();
  } else {
    // Stray fence markers without a pair — strip them.
    text = text.replace(/```[a-zA-Z0-9_+-]*/g, '').trim();
  }

  const lang = language?.trim().toLowerCase();
  if (lang && SQL_VALIDATOR_LANGS.has(lang)) {
    const sqlStart = text.search(/^(?:SELECT|WITH|UPDATE|DELETE|INSERT|CREATE|ALTER|--|\/\*|#)/im);
    if (sqlStart > 0) text = text.slice(sqlStart);
    const cleaned = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').replace(/#[^\n]*/g, ' ').trim();
    if (
      cleaned.length < 10 ||
      !/\b(?:SELECT|WITH|UPDATE|DELETE|INSERT|CREATE|ALTER)\b/i.test(cleaned) ||
      /^(?:#include|def\s+\w+\s*\(|class\s+Solution\b)/im.test(cleaned)
    ) {
      return null;
    }
    return text.trim();
  }

  if (lang === 'bash') {
    const shStart = text.search(/^(?:#!|#|awk|sed|grep|sort|uniq|cut|tr|cat|head|tail|wc|echo|printf|while|for|if|read|[a-z_][a-z0-9_]*=)\b/im);
    if (shStart > 0) text = text.slice(shStart);
    const active = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'))
      .join('\n');
    if (active.length < 4 || /^(?:#include|class\s+Solution\b|def\s+\w+\s*\()/im.test(active)) {
      return null;
    }
    return text.trim();
  }

  // Leading prose line(s) before the first code-ish line.
  const codeStart = text.search(/^(?:class|function|var|let|const|def|import|from|export|\/\/|#|\/\*|public|interface|type|using|namespace|impl|pub\s+fn|fn|func|fun|package|object)\b/m);
  if (codeStart > 0) text = text.slice(codeStart);

  if (!/(class\s+\w+|function\s*\w*\s*\(|def\s+\w+\s*\(|=>|\bvar\s+\w+\s*=|\bimpl\s+\w+|\bfunc\s+\w+\s*\(|\bfn\s+\w+\s*\(|\bfun\s+\w+\s*\(|\bobject\s+\w+|\b(?:int|long|void|bool|char|double|float|string|vector)\s+[A-Za-z_]\w*\s*\(|\b(?:SELECT|WITH)\b[\s\S]*\bFROM\b)/i.test(text)) {
    return null; // no recognizable code at all
  }
  return text;
}

export function containsPlaceholder(code: string): string | null {
  for (const re of PLACEHOLDER_PATTERNS) {
    const m = re.exec(code);
    if (m) return `placeholder pattern matched: ${m[0]}`;
  }
  // Empty function bodies: `function f() {}` / `def f(): pass` / `return None`
  if (/function\s*[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{\s*\}/.test(code)) return 'empty function body';
  if (/\([^)]*\)\s*=>\s*\{\s*\}/.test(code)) return 'empty arrow function body';
  if (/def\s+\w+\s*\([^)]*\):\s*(pass|\.\.\.)\s*$/m.test(code)) return 'empty python body';
  return null;
}

export async function validateSolution(
  rawModelOutput: string,
  problem: ParsedProblem,
  language: string,
): Promise<ValidationOutcome> {
  // 1) format
  const code = extractCode(rawModelOutput, language);
  if (!code) {
    return {
      ok: false,
      stage: 'format',
      report:
        'The model output contained no recognizable source code (markdown/prose only or empty). ' +
        'Return ONLY the solution source code.',
    };
  }

  // 2) placeholders
  const placeholder = containsPlaceholder(code);
  if (placeholder) {
    return {
      ok: false,
      stage: 'placeholder',
      report: `The code contains an unfinished/placeholder section (${placeholder}). Provide a COMPLETE implementation.`,
    };
  }

  // 3) syntax
  let runner;
  try {
    runner = createRunner(language);
  } catch (err) {
    // No local runner for the language: log and accept after static checks.
    logger.warn({ language }, 'no local runner — skipping execution validation');
    return { ok: true, code };
  }

  const syntax = await runner.checkSyntax(code);
  if (!syntax.ok) {
    return {
      ok: false,
      stage: 'syntax',
      report: `The code does not parse/compile:\n${syntax.error ?? 'unknown syntax error'}`,
    };
  }

  // 4) + 5) examples and edge cases
  const functionName =
    extractFunctionName(problem.starterCode, language) ?? extractFunctionName(code, language);
  const tests = generateTestCases(problem);

  if (!functionName || tests.length === 0) {
    logger.info(
      { functionName: !!functionName, testCount: tests.length },
      'no executable testcases derivable — accepting after static validation',
    );
    return { ok: true, code };
  }

  const run: RunReport = await runner.run(code, functionName, tests);
  if (run.ok) {
    logger.info({ tests: run.results.length }, 'all local validation tests passed');
    return { ok: true, code };
  }

  const failed = run.results.filter((r) => !r.passed);
  const checkedExamples = failed.filter((r) => r.expected !== null);
  const stage: ValidationFailure['stage'] = checkedExamples.length > 0 ? 'examples' : 'edge-cases';
  const report = buildFailureReport(run, failed);
  logger.warn({ stage, failed: failed.length, total: run.results.length }, 'local validation failed');
  return { ok: false, stage, report };
}

function buildFailureReport(run: RunReport, failed: { label: string; actual?: string; expected?: string | null; error?: string }[]): string {
  const lines: string[] = ['Local validation failures:'];
  for (const f of failed.slice(0, 5)) {
    lines.push(`- ${f.label}:`);
    if (f.error) lines.push(`    error: ${f.error}`);
    else lines.push(`    expected: ${f.expected ?? '(crash-only)'}  actual: ${f.actual ?? 'undefined'}`);
  }
  if (run.stderr) lines.push(`stderr: ${run.stderr.slice(0, 1000)}`);
  lines.push('Fix the algorithm and return the COMPLETE corrected source code only.');
  return lines.join('\n');
}
