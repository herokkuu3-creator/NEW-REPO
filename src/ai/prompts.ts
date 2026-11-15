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

function buildProblemUserContent(
  problem: ParsedProblem,
  language: string,
  closingInstruction: string
): string {
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

  return [
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
    closingInstruction,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

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

  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: buildProblemUserContent(
        problem,
        language,
        'Return ONLY the complete solution source code now.'
      ),
    },
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

export interface JudgeFailureDetail {
  statusMsg: string;
  compileError?: string | null;
  runtimeError?: string | null;
  lastTestcase?: string | null;
  expectedOutput?: string | null;
  codeOutput?: string | null;
}

/**
 * Contest Q1/Q2 prompt requesting either a clean helper-free 1-liner inside the
 * starter signature or (when relaxed) the shortest clean idiomatic solution.
 */
export function buildContestOneLinerSolvePrompt(
  problem: ParsedProblem,
  language: string,
  preferOneLiner = true
): LLMMessage[] {
  const styleGuidelines = preferOneLiner
    ? [
        'STYLE GOAL (Contest 1-Liner):',
        '- Produce a clean, idiomatic, helper-free 1-liner solution inside LeetCode\'s required class/method signature.',
        '- Prefer a single concise `return ...;` expression or a compact single-statement STL/lambda/list-comprehension/generator expression.',
        '- Do NOT use preprocessor macros (#define), comma-operator obfuscation, or unreadably compressed hacks.',
        '- Only fall back to 2-3 minimal, clean statements if the logic is truly impossible as a single statement.',
      ]
    : [
        'STYLE GOAL (Shortest Clean Fallback):',
        '- Produce the shortest, cleanest, beginner-friendly idiomatic solution inside LeetCode\'s required class/method signature.',
        '- Avoid helper classes, unnecessary abstractions, verbose boilerplate, or over-engineering.',
      ];

  const system = [
    'You are an expert competitive-programming solver producing clean LeetCode contest submissions.',
    '',
    'OUTPUT CONTRACT (non-negotiable):',
    '- Return ONLY the solution source code.',
    '- NO markdown, NO code fences (```), NO explanations, NO comments describing the approach.',
    '- The code must compile/run as-is in the LeetCode environment for the target language.',
    '- Follow the exact class/function/method signature expected by the starter code.',
    '- Handle every stated constraint and edge case accurately (overflow, empty/single-element inputs, negative values, duplicates).',
    '- Never output TODO, placeholder bodies, or unfinished code.',
    '',
    ...styleGuidelines,
  ].join('\n');

  const closingInstruction = preferOneLiner
    ? 'Return ONLY the complete 1-liner contest solution source code now.'
    : 'Return ONLY the complete shortest clean contest solution source code now.';

  return [
    { role: 'system', content: system },
    { role: 'user', content: buildProblemUserContent(problem, language, closingInstruction) },
  ];
}

/**
 * Follow-up message when LeetCode Judge rejected a submitted contest candidate.
 */
export function buildJudgeRepairMessage(
  failedCode: string,
  judgeFeedback: JudgeFailureDetail
): LLMMessage {
  const details: string[] = [`Judge verdict: ${judgeFeedback.statusMsg || 'Rejected'}`];

  if (judgeFeedback.compileError) {
    details.push(`Compile error:\n${judgeFeedback.compileError.slice(0, 2000)}`);
  }
  if (judgeFeedback.runtimeError) {
    details.push(`Runtime error:\n${judgeFeedback.runtimeError.slice(0, 2000)}`);
  }
  if (judgeFeedback.lastTestcase !== undefined && judgeFeedback.lastTestcase !== null && judgeFeedback.lastTestcase !== '') {
    details.push(`Last testcase input:\n${judgeFeedback.lastTestcase.slice(0, 1500)}`);
  }
  if (judgeFeedback.expectedOutput !== undefined && judgeFeedback.expectedOutput !== null && judgeFeedback.expectedOutput !== '') {
    details.push(`Expected output:\n${judgeFeedback.expectedOutput.slice(0, 1000)}`);
  }
  if (judgeFeedback.codeOutput !== undefined && judgeFeedback.codeOutput !== null && judgeFeedback.codeOutput !== '') {
    details.push(`Your code output:\n${judgeFeedback.codeOutput.slice(0, 1000)}`);
  }

  return {
    role: 'user',
    content: [
      'Your previous submission was REJECTED by LeetCode Judge. Fix the bug completely.',
      '',
      ...details,
      '',
      'The rejected code was:',
      failedCode.slice(0, 8000),
      '',
      'Return ONLY the corrected, complete source code. Same output contract as before: no markdown, no explanation, no comments.',
    ].join('\n'),
  };
}
