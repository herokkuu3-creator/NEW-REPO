import { ParsedExample, ParsedProblem } from '../leetcode/parser';
import { TestCase } from './runners/types';
import { logger } from '../logger';

/**
 * Converts LeetCode's example strings into executable TestCases, and
 * derives a few cheap edge cases (empty/minimal inputs) when the argument
 * shapes allow it. Runtime argument parsing is deliberately conservative:
 * anything it cannot parse is skipped, never guessed.
 */

/** "nums = [2,7,11,15], target = 9" → ['[2,7,11,15]', '9'] */
export function parseExampleInput(input: string): string[] | null {
  const args: string[] = [];
  // Split on top-level commas that are followed by `name =`
  const parts = input.split(/,\s*(?=[A-Za-z_][A-Za-z0-9_]*\s*=)/);
  for (const part of parts) {
    const m = /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*([\s\S]+)$/.exec(part);
    if (!m || !m[1]) return null;
    const value = m[1].trim();
    if (!isJsonLike(value)) return null;
    try {
      args.push(toJson(value));
    } catch {
      return null;
    }
  }
  return args.length > 0 ? args : null;
}

/** "true", "[0,1]", "\"abc\"", "3" → JSON string, else null */
export function parseExampleOutput(output: string): string | null {
  const firstLine = output.split('\n')[0]?.trim() ?? '';
  if (!firstLine) return null;
  if (!isJsonLike(firstLine)) return null;
  try {
    return toJson(firstLine);
  } catch {
    return null;
  }
}

function isJsonLike(v: string): boolean {
  return (
    /^-?\d+(\.\d+)?$/.test(v) ||
    /^(true|false|null)$/.test(v) ||
    /^".*"$/.test(v) ||
    /^\[.*\]$/.test(v) ||
    /^\{.*\}$/.test(v)
  );
}

/** LeetCode uses single quotes occasionally; normalize to JSON. */
function toJson(v: string): string {
  try {
    JSON.parse(v);
    return v;
  } catch {
    const fixed = v.replace(/'/g, '"');
    JSON.parse(fixed); // throws if still invalid — caller handles
    return fixed;
  }
}

/**
 * Example cases from the statement (expected outputs verified) plus
 * edge cases with expected=null (crash-only checks).
 */
export function generateTestCases(problem: ParsedProblem): TestCase[] {
  const tests: TestCase[] = [];

  problem.examples.forEach((ex: ParsedExample, i: number) => {
    const args = parseExampleInput(ex.input);
    if (!args) {
      logger.debug({ example: i + 1 }, 'example input not parseable — skipping');
      return;
    }
    let expected: string | null = null;
    try {
      expected = parseExampleOutput(ex.output);
    } catch {
      expected = null;
    }
    tests.push({ args, expected, label: `example-${i + 1}` });
  });

  tests.push(...generateEdgeCases(tests));
  return tests;
}

/**
 * Edge cases: for each array argument, an empty-array variant (expected
 * unknown — we only assert the code does not crash). Bounded and safe.
 */
function generateEdgeCases(exampleTests: TestCase[]): TestCase[] {
  const edges: TestCase[] = [];
  const first = exampleTests[0];
  if (!first) return edges;

  const emptyVariant: string[] = [];
  let replaced = false;
  for (const arg of first.args) {
    if (!replaced && /^\[.+\]$/.test(arg)) {
      emptyVariant.push('[]');
      replaced = true;
    } else if (!replaced && /^".*"$/.test(arg) && arg.length > 2) {
      emptyVariant.push('""');
      replaced = true;
    } else {
      emptyVariant.push(arg);
    }
  }
  if (replaced) {
    edges.push({ args: emptyVariant, expected: null, label: 'edge-empty-input' });
  }
  return edges;
}

/**
 * Extracts the primary callable name from starter code:
 *   JS: `var twoSum = function` → twoSum ; `class Solution` + method from metaData
 *   PY: `def twoSum(` → twoSum
 */
export function extractFunctionName(starterCode: string, language: string): string | null {
  if (language === 'python3' || language === 'python') {
    const cleaned = starterCode.replace(/#[^\n]*/g, '');
    for (const m of cleaned.matchAll(/\bdef\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      const name = m[1];
      if (name && name !== '__init__') return name;
    }
    return null;
  }

  const cleaned = starterCode
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  const varFnMatch = /(?:var|let|const)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?function\b/.exec(cleaned);
  if (varFnMatch?.[1]) return varFnMatch[1];

  const arrowPattern = /(?:export\s+)?(?:var|let|const)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?(?:<[^>\n]*>\s*)?(?:\((?:[^;\n()]|\([^;\n()]*\))*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^\n={;]+)?=>/;
  const topArrowMatch = new RegExp(`^${arrowPattern.source}`, 'm').exec(cleaned);
  if (topArrowMatch?.[1]) return topArrowMatch[1];

  const fnMatch = /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>\n]*>\s*)?\(/.exec(cleaned);
  if (fnMatch?.[1]) return fnMatch[1];

  const anyArrowMatch = arrowPattern.exec(cleaned);
  if (anyArrowMatch?.[1]) return anyArrowMatch[1];

  // class Solution { methodName(...) { ... } }
  const ignored = new Set(['constructor', 'if', 'for', 'while', 'switch', 'catch']);
  for (const m of cleaned.matchAll(/^\s{2,}(?:(?:public|private|protected|static|async)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>\n]*>\s*)?\(/gm)) {
    const name = m[1];
    if (name && !ignored.has(name)) return name;
  }
  return null;
}
