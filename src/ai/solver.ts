import { LLMMessage, LLMProvider } from './provider';
import { buildRepairMessage, buildSolvePrompt } from './prompts';
import { validateSolution } from '../validator/validator';
import { ParsedProblem } from '../leetcode/parser';
import { logger } from '../logger';

/**
 * The generate → validate → repair loop.
 *
 * Bounded by MAX_SOLUTION_RETRIES — it can NEVER loop forever. Each
 * rejection is fed back to the model with its own broken code and the
 * exact failure report.
 */

export type SolveResult =
  | { ok: true; code: string; attempts: number }
  | { ok: false; reason: 'LLM_ERROR'; error: string; attempts: number }
  | { ok: false; reason: 'SOLUTION_VALIDATION_FAILED'; lastReport: string; lastCode: string | null; attempts: number };

export async function solveProblem(
  llm: LLMProvider,
  problem: ParsedProblem,
  language: string,
  maxRetries: number,
): Promise<SolveResult> {
  const messages: LLMMessage[] = [...buildSolvePrompt(problem, language)];
  let lastCode: string | null = null;
  let lastReport = 'no attempt made';

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    logger.info(
      { attempt, maxAttempts: maxRetries + 1, provider: llm.name, model: llm.model },
      'requesting solution from LLM',
    );

    let raw: string;
    try {
      raw = await llm.generate(messages);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ attempt, err: msg }, 'LLM request failed');
      return { ok: false, reason: 'LLM_ERROR', error: msg, attempts: attempt };
    }

    messages.push({ role: 'assistant', content: raw });

    const validation = await validateSolution(raw, problem, language);
    if (validation.ok) {
      logger.info({ attempt, codeLength: validation.code.length }, 'solution validated locally');
      return { ok: true, code: validation.code, attempts: attempt };
    }

    lastCode = raw;
    lastReport = validation.report;
    logger.warn({ attempt, stage: validation.stage }, 'solution rejected by validator');

    if (attempt <= maxRetries) {
      messages.push(buildRepairMessage(raw, validation.report));
    }
  }

  return {
    ok: false,
    reason: 'SOLUTION_VALIDATION_FAILED',
    lastReport,
    lastCode,
    attempts: maxRetries + 1,
  };
}
