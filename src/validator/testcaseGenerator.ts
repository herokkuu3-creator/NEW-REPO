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
    args.push(toJson(value));
  }
  return args.length > 0 ? args : null;
}

/** "true", "[0,1]", "\"abc\"", "3" → JSON string, else null */
export function parseExampleOutput(output: string): string | null {
  const firstLine = output.split('\n')[0]?.trim() ?? '';
  if (!firstLine) return null;
  if (!isJsonLike(firstLine)) return null;
  return toJson(firstLine);
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
  if (language === 'python3') {
    const m = /def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(starterCode);
    return m?.[1] ?? null;
  }
  const varMatch = /(?:var|let|const)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*function/.exec(starterCode);
  if (varMatch?.[1]) return varMatch[1];
  const fnMatch = /function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(starterCode);
  if (fnMatch?.[1]) return fnMatch[1];
  // class Solution { methodName(...) { ... } }
  const methodMatch = /^\s{2,}([A-Za-z_][A-Za-z0-9_]*)\s*\(/m.exec(starterCode);
  return methodMatch?.[1] ?? null;
}
