import OpenAI from 'openai';
import { LLMError, LLMGenerateOptions, LLMMessage, LLMProvider } from './provider';
import { logger } from '../logger';

/**
 * Google Gemini, reached through its OpenAI-compatible endpoint:
 *   https://generativelanguage.googleapis.com/v1beta/openai/
 *
 * Reusing the OpenAI SDK keeps a single code path for both providers — auth
 * is a bearer token either way and the request/response shapes match, so
 * this is a configuration difference rather than a second integration.
 * https://ai.google.dev/gemini-api/docs/openai
 */

export const GEMINI_OPENAI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai/';

/** Maps to OpenAI's `reasoning_effort`; `none` disables thinking on 2.5 models. */
export type GeminiReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'none';

export interface GeminiProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs: number;
  reasoningEffort?: GeminiReasoningEffort;
  maxTokens?: number;
  temperature?: number;
}

/** Free-tier keys are rate-limited (RPM/RPD); absorb brief 429s instead of failing the run. */
const MAX_RATE_LIMIT_RETRIES = 2;
const BASE_BACKOFF_MS = 5_000;

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  readonly model: string;
  private readonly client: OpenAI;
  private readonly reasoningEffort?: GeminiReasoningEffort;
  private readonly maxTokens: number;
  private readonly temperature?: number;

  constructor(opts: GeminiProviderOptions) {
    if (!opts.apiKey) {
      throw new LLMError(
        'GEMINI_API_KEY (or LLM_API_KEY) is required for the gemini provider',
        'gemini',
      );
    }
    if (!opts.model) {
      throw new LLMError('LLM_MODEL is required for the gemini provider', 'gemini');
    }
    this.model = opts.model;
    this.reasoningEffort = opts.reasoningEffort;
    this.maxTokens = opts.maxTokens ?? 8192;
    this.temperature = opts.temperature;
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl || GEMINI_OPENAI_BASE_URL,
      timeout: opts.timeoutMs,
      maxRetries: 0, // rate-limit retries are handled explicitly below
    });
  }

  async generate(messages: LLMMessage[], options: LLMGenerateOptions = {}): Promise<string> {
    const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages,
      // Thinking tokens count against this budget, so the default is
      // generous — a tight cap on a reasoning model yields empty output.
      max_tokens: options.maxTokens ?? this.maxTokens,
    };

    // Gemini's thinking models reason best at their default temperature and
    // some configurations reject an explicit value, so one is only sent when
    // the operator opts in via LLM_TEMPERATURE.
    const temperature = options.temperature ?? this.temperature;
    if (temperature !== undefined) params.temperature = temperature;

    if (this.reasoningEffort) {
      // `reasoning_effort` is Gemini-specific here, so it is attached below
      // the SDK's narrower typed surface.
      (params as unknown as Record<string, unknown>).reasoning_effort = this.reasoningEffort;
    }

    for (let attempt = 0; ; attempt++) {
      try {
        const completion = await this.client.chat.completions.create(params);
        const text = completion.choices[0]?.message?.content;
        if (!text || !text.trim()) {
          throw new LLMError(
            `gemini returned an empty completion (model ${this.model}) — if this persists, raise LLM_MAX_TOKENS`,
            this.name,
          );
        }
        return text;
      } catch (err) {
        if (err instanceof LLMError && !isRateLimit(err.cause_)) throw err;

        const status = statusOf(err);
        if (status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
          const waitMs = retryAfterMs(err) ?? BASE_BACKOFF_MS * 2 ** attempt;
          logger.warn(
            { attempt: attempt + 1, waitMs, model: this.model },
            'gemini rate limited — backing off before retry',
          );
          await sleep(waitMs);
          continue;
        }
        if (err instanceof LLMError) throw err;

        const msg = err instanceof Error ? err.message : String(err);
        throw new LLMError(`gemini request failed: ${msg}`, this.name, err);
      }
    }
  }
}

function statusOf(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null) {
    const s = (err as { status?: unknown }).status;
    if (typeof s === 'number') return s;
  }
  return undefined;
}

function isRateLimit(err: unknown): boolean {
  return statusOf(err) === 429;
}

/** Honour Gemini's Retry-After header when present, capped to stay responsive. */
function retryAfterMs(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const headers = (err as { headers?: Record<string, string> }).headers;
  const raw = headers?.['retry-after'];
  if (!raw) return null;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(seconds * 1000, 60_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
