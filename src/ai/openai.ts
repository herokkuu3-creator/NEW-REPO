import OpenAI from 'openai';
import { LLMError, LLMGenerateOptions, LLMMessage, LLMProvider } from './provider';

export interface OpenAIProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs: number;
}

/** OpenAI (or any OpenAI-compatible endpoint via baseUrl). */
export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  readonly model: string;
  private readonly client: OpenAI;

  constructor(opts: OpenAIProviderOptions) {
    if (!opts.apiKey) {
      throw new LLMError('LLM_API_KEY is required for the openai provider', 'openai');
    }
    this.model = opts.model;
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl,
      timeout: opts.timeoutMs,
      maxRetries: 1, // retries are orchestrated by the solver loop, not the SDK
    });
  }

  async generate(messages: LLMMessage[], options: LLMGenerateOptions = {}): Promise<string> {
    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? 4096,
      });
      const text = completion.choices[0]?.message?.content;
      if (!text || !text.trim()) {
        throw new LLMError('model returned an empty completion', this.name);
      }
      return text;
    } catch (err) {
      if (err instanceof LLMError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new LLMError(`openai request failed: ${msg}`, this.name, err);
    }
  }
}
