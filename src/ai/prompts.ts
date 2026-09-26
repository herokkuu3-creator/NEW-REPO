import { ParsedProblem } from '../leetcode/parser';
import { LLMMessage } from './provider';

/**
 * Prompt construction. The output contract is strict: ONLY source code —
 * no markdown fences, no prose — because the response is pasted verbatim
 * into the LeetCode editor.
 */

const LANGUAGE_NAMES: Record<string, string> = {
  javascript: 'JavaScript (Node.js)',
  typescript: 'TypeScript',
  python3: 'Python 3',
};

const CODE_SHAPE_HINTS: Record<string, string> = {
  javascript:
    'Define the exact class or function from the starter code. Export nothing. ' +
    'If the starter is `var name = function(...)`, keep that exact shape.',
  typescript:
    'Keep the exact signatures from the starter code, with full type annotations.',
  python3:
    'Define the exact class/method from the starter code. ' +
    'Use `from typing import List` style imports as needed. No type-annotation removal.',
};

export function buildSolvePrompt(problem: ParsedProblem, language: string): LLMMessage[] {
  const system = [
    'You are an expert competitive-programming solver producing LeetCode submissions.',
    '',
    'OUTPUT CONTRACT (non-negotiable):',
    '- Return ONLY the solution source code.',
    '- NO markdown, NO code fences (```), NO explanations, NO comments describing the approach.',
    '- The code must compile/run as-is in the LeetCode environment for the target language.',
    '- The code must contain the exact class/function/method the starter code defines.',
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
