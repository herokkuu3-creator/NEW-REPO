import { config } from '../config';
import { ParsedProblem } from '../leetcode/parser';
import { logger } from '../logger';
import { AIModelRouter, OutputValidationError } from '../solutionPosts/router';
import { createCodeSolverRouter, PostError } from '../solutionPosts/service';
import { containsPlaceholder, extractCode, validateSolution } from '../validator/validator';
import { buildRepairMessage, buildSolvePrompt } from './prompts';
import { createLLMProvider, LLMMessage } from './provider';
import { solveProblem } from './solver';

export interface AiSolveResult {
  code: string;
  model: string;
  providerLabel?: string;
}

const SQL_LANGS = new Set(['mysql', 'postgresql', 'mssql', 'oraclesql']);

/**
 * Synchronous structural validation used inside AIModelRouter.generate so empty,
 * placeholder, or wrong-language outputs trigger automatic repair / model failover.
 */
export function validateAiOutputForLanguage(raw: string, language: string): string {
  const code = extractCode(raw, language);
  if (!code) {
    throw new OutputValidationError('EMPTY_OR_PROSE_CODE');
  }
  const placeholder = containsPlaceholder(code);
  if (placeholder) {
    throw new OutputValidationError('PLACEHOLDER_CODE');
  }
  const lang = language.trim().toLowerCase();
  if (lang === 'cpp') {
    if (/^\s*def\s+\w+\s*\(/m.test(code) && !/#include\b|\bclass\s+Solution\b/.test(code)) {
      throw new OutputValidationError('WRONG_LANGUAGE');
    }
  } else if (lang === 'python3' || lang === 'python' || lang === 'pythondata') {
    if (/#include\b|\bpublic\s+class\b|\bpublic\s*:/.test(code)) {
      throw new OutputValidationError('WRONG_LANGUAGE');
    }
  } else if (lang === 'java') {
    if (/#include\b|\bpublic\s*:/.test(code)) {
      throw new OutputValidationError('WRONG_LANGUAGE');
    }
  } else if (SQL_LANGS.has(lang)) {
    if (!/\b(?:SELECT|WITH|UPDATE|DELETE|INSERT|CREATE|ALTER)\b/i.test(code)) {
      throw new OutputValidationError('INVALID_SQL');
    }
  }
  return code;
}

async function resolveRouter(onProvider?: (label: string) => void): Promise<AIModelRouter | null> {
  try {
    return await createCodeSolverRouter({}, onProvider);
  } catch (err) {
    if (err instanceof PostError && (err.code === 'API_KEY_REQUIRED' || err.code === 'SOLUTION_KEYS_EXHAUSTED')) {
      logger.warn({ code: err.code }, 'configured Coarena/Discovery keys unavailable for question AI solver');
      return null;
    }
    // If DB state isn't initialized in an offline/test environment, fall back to env keys if configured.
    if (config.solutionPosts.apiKeys.length > 0) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'falling back to env solution post API keys for AI solver');
      return new AIModelRouter({
        ...config.solutionPosts,
        apiKeys: config.solutionPosts.apiKeys,
      });
    }
    return null;
  }
}

/**
 * Solves a LeetCode problem using the configured AI providers and keys:
 * 1) Coarena -> Discovery / Sage key pool (via createCodeSolverRouter)
 * 2) Direct LLM provider fallback (if LLM_API_KEY / GEMINI_API_KEY is set)
 */
export async function solveQuestionWithConfiguredAi(
  problem: ParsedProblem,
  language: string,
  onProvider?: (label: string) => void,
): Promise<AiSolveResult> {
  let providerLabel: string | undefined;
  const router = await resolveRouter((label) => {
    providerLabel = label;
    onProvider?.(label);
  });

  if (router) {
    try {
      const messages: LLMMessage[] = [...buildSolvePrompt(problem, language)];
      let current = await router.generate(
        messages,
        (raw) => validateAiOutputForLanguage(raw, language),
        Math.max(1536, config.llm.maxTokens || 2048),
        false,
        'question-code-solve',
      );
      let code = current.value;
      const maxRepairs = Math.min(2, Math.max(0, config.llm.maxSolutionRetries));

      for (let repair = 0; repair <= maxRepairs; repair++) {
        const outcome = await validateSolution(code, problem, language);
        if (outcome.ok) {
          logger.info(
            { slug: problem.slug, language, model: current.model, providerLabel, repair },
            'AI question solver produced validated solution',
          );
          return { code: outcome.code, model: current.model, providerLabel };
        }
        if (repair >= maxRepairs) {
          throw new Error(`AI solution failed local validation: ${outcome.report}`);
        }
        logger.warn(
          { slug: problem.slug, language, stage: outcome.stage, repair: repair + 1 },
          'AI question solver retrying with local validation feedback',
        );
        messages.push({ role: 'assistant', content: code });
        messages.push(buildRepairMessage(code, outcome.report));
        current = await router.generate(
          messages,
          (raw) => validateAiOutputForLanguage(raw, language),
          Math.max(1536, config.llm.maxTokens || 2048),
          false,
          `question-code-repair-${repair + 1}`,
        );
        code = current.value;
      }
    } catch (routerErr) {
      if (!config.llm.apiKey) {
        throw routerErr;
      }
      logger.warn(
        { err: routerErr instanceof Error ? routerErr.message : String(routerErr) },
        'configured router AI solver failed; falling back to direct LLM provider',
      );
    }
  }

  if (config.llm.apiKey) {
    const provider = createLLMProvider();
    const res = await solveProblem(provider, problem, language, Math.max(0, config.llm.maxSolutionRetries));
    if (res.ok) {
      return { code: res.code, model: config.llm.model, providerLabel: config.llm.provider };
    }
    throw new Error(res.reason === 'LLM_ERROR' ? res.error : res.lastReport);
  }

  throw new Error('AI solver unavailable: no configured Coarena, Discovery/Sage, or LLM API key succeeded');
}
