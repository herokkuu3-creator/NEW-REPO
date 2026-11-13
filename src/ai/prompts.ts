import { ParsedProblem } from '../leetcode/parser';
import { LLMMessage } from './provider';

/**
 * Prompt construction. The output contract is strict: ONLY source code —
 * no markdown fences, no prose — because the response is pasted verbatim
 * into the LeetCode editor.
 */

const LANGUAGE_NAMES: Record<string, string> = {
  cpp: 'C++ (C++20)',
  javascript: 'JavaScript (Node.js)',
  typescript: 'TypeScript',
  python3: 'Python 3',
  python: 'Python 2',
  pythondata: 'Python 3 (Pandas)',
  java: 'Java',
  mysql: 'MySQL',
  postgresql: 'PostgreSQL',
  mssql: 'MS SQL Server (T-SQL)',
  oraclesql: 'Oracle SQL (PL/SQL)',
  bash: 'Bash / Linux Shell',
  c: 'C',
  csharp: 'C#',
  golang: 'Go',
  rust: 'Rust',
  ruby: 'Ruby',
  swift: 'Swift',
  kotlin: 'Kotlin',
  php: 'PHP',
  scala: 'Scala',
  dart: 'Dart',
};

const CODE_SHAPE_HINTS: Record<string, string> = {
  cpp:
    'Define the exact `class Solution` and method signatures from the starter code. ' +
    'Do not include `main()`, extra `#include` headers only if standard, and preserve exact parameter/return types.',
  javascript:
    'Define the exact class or function from the starter code. Export nothing. ' +
    'If the starter is `var name = function(...)`, keep that exact shape.',
  typescript:
    'Keep the exact signatures from the starter code, with full type annotations.',
  python3:
    'Define the exact class/method from the starter code. ' +
    'Use `from typing import List` style imports as needed. No type-annotation removal.',
  pythondata:
    'Define the exact Pandas function signature from the starter code (typically `import pandas as pd` and returning a `pd.DataFrame`).',
  java:
    'Define the exact `class Solution` and method signatures from the starter code without a `public` top-level `Main` wrapper.',
  mysql:
    'Return ONLY a valid MySQL query statement (no prose, no schema DDL unless part of a CTE). Match the required column names and ordering.',
  postgresql:
    'Return ONLY a valid PostgreSQL query statement matching the required column names and ordering.',
  mssql:
    'Return ONLY a valid T-SQL / MS SQL Server query statement matching the required column names and ordering.',
  oraclesql:
    'Return ONLY a valid Oracle SQL query statement matching the required column names and ordering.',
  bash:
    'Return ONLY the valid Bash one-liner / shell script reading from the file stated in the problem description.',
  golang:
    'Define the exact Go function signature(s) from the starter code without `package main` or `func main()`.',
  rust:
    'Keep `impl Solution` and the exact `pub fn` signature from the starter code.',
  csharp:
    'Keep `public class Solution` and the exact method signature from the starter code.',
};

export function buildSolvePrompt(problem: ParsedProblem, language: string): LLMMessage[] {
  const system = [
    'You are an expert competitive-programming and database solver producing LeetCode submissions.',
    '',
    'OUTPUT CONTRACT (non-negotiable):',
    '- Return ONLY the solution source code or SQL query.',
    '- NO markdown, NO code fences (```), NO explanations, NO comments describing the approach.',
    '- The code must compile/run as-is in the LeetCode environment for the target language.',
    '- Follow the exact class/function/method/query signature expected by the starter code.',
    '- Handle every stated constraint; prefer the most efficient correct algorithm.',
    '- Never output TODO, placeholder bodies, or unfinished code.',
  ].join('\n');

  const examples = problem.examples
    .map(
      (ex, i) =>
        `Example ${i + 1}:\nInput: ${ex.input}\nOutput: ${ex.output}` +
        (ex.explanation ? `\nExplanation: ${ex.explanation}` : ''),
    )
    .join('\n\n');

  const constraints = problem.constraints.length
    ? problem.constraints.map((c) => `- ${c}`).join('\n')
    : '(none extracted — infer from the statement)';

  const user = [
    `Problem ${problem.frontendId}: ${problem.title} (${problem.difficulty})`,
    '',
    'Statement:',
    problem.descriptionText,
    '',
    examples ? `Examples:\n${examples}` : '',
    '',
    `Constraints:\n${constraints}`,
    '',
    `Target language: ${LANGUAGE_NAMES[language] ?? language}`,
    CODE_SHAPE_HINTS[language] ?? '',
    '',
    'Starter code you must complete:',
    problem.starterCode,
    '',
    'Return ONLY the complete solution source code now.',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Follow-up message when local validation rejected a candidate: the model
 * gets its own broken code plus the exact failure, and must fix it.
 */
export function buildRepairMessage(failedCode: string, failureReport: string): LLMMessage {
  return {
    role: 'user',
    content: [
      'Your previous solution FAILED local validation. Fix it.',
      '',
      'Validation failure report:',
      failureReport.slice(0, 4000),
      '',
      'The failing code was:',
      failedCode.slice(0, 8000),
      '',
      'Return ONLY the corrected, complete source code. Same output contract as before: no markdown, no explanation.',
    ].join('\n'),
  };
}
