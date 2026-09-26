import { config } from '../config';
import { OpenAIProvider } from './openai';
import { GeminiProvider } from './gemini';

/**
 * LLM provider abstraction. The rest of the system only knows LLMProvider —
 * adding a provider means implementing this interface and adding one case to
 * createLLMProvider.
 *
 * Both shipped providers speak the OpenAI chat-completions protocol; Gemini
 * is reached through Google's OpenAI-compatible endpoint:
 * https://ai.google.dev/gemini-api/docs/openai
 */

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMGenerateOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  generate(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<string>;
}

export class LLMError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly cause_?: unknown,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

export const SUPPORTED_PROVIDERS = ['gemini', 'openai'] as const;

export function createLLMProvider(): LLMProvider {
  switch (config.llm.provider.toLowerCase()) {
    case 'gemini':
      return new GeminiProvider({
        apiKey: config.llm.apiKey,
        model: config.llm.model,
        baseUrl: config.llm.baseUrl || undefined,
        timeoutMs: config.llm.timeoutMs,
        reasoningEffort: config.llm.reasoningEffort,
        maxTokens: config.llm.maxTokens,
        temperature: config.llm.temperature,
      });
    case 'openai':
      return new OpenAIProvider({
        apiKey: config.llm.apiKey,
        model: config.llm.model,
        baseUrl: config.llm.baseUrl || undefined,
        timeoutMs: config.llm.timeoutMs,
      });
    default:
      throw new LLMError(
        `unsupported LLM_PROVIDER "${config.llm.provider}" — supported: ${SUPPORTED_PROVIDERS.join(', ')}`,
        config.llm.provider,
      );
  }
}
