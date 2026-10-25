import OpenAI from 'openai';
import { z } from 'zod';
import { LLMMessage } from '../ai/provider';

export interface RouterOptions {
  apiKey: string;
  apiKeys?: string[];
  baseUrl: string;
  models: string[];
  timeoutMs: number;
  retries: number;
  maxTokens: number;
  modelTimeoutMs?: Record<string, number>;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
}
export interface ModelAttempt {
  model: string;
  attempt: number;
  outcome: string;
  elapsedMs: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  cost?: number;
  keySlot?: number;
}
export class RoutingError extends Error {
  constructor(public readonly attempts: ModelAttempt[], public readonly lastFailure?: string) {
    super(lastFailure ? `AI generation failed: ${lastFailure}` : 'AI generation exhausted the configured models; inspect attempt outcomes');
  }
}
export class OutputValidationError extends Error {
  constructor(public readonly category: string) { super(category); }
}

/** Uses the existing OpenAI SDK/protocol, with one bounded retry owner. Never logs provider bodies. */
export class AIModelRouter {
  private readonly apiKeys: string[];
  private readonly exhaustedKeys = new Set<string>();
  private readonly firstClient?: OpenAI;
  constructor(private readonly options: RouterOptions, client?: OpenAI,
    private readonly sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms)),
    private readonly onAttempt: (attempt: ModelAttempt) => void = () => {},
    private readonly onKeyExhausted: (key: string, reason: string) => Promise<void> | void = () => {},
    private readonly createClient: (key: string) => OpenAI = key => new OpenAI({ apiKey: key, baseURL: options.baseUrl,
      timeout: options.timeoutMs, maxRetries: 0 })) {
    this.apiKeys = [...new Set((options.apiKeys?.length ? options.apiKeys : [options.apiKey]).map(key => key.trim()).filter(Boolean))];
    if (!this.apiKeys.length) throw new Error('SOLUTION_POST_API_KEYS is required');
    this.firstClient = client;
  }

  async generate<T>(messages: LLMMessage[], validate: (text: string) => T, maxTokens = this.options.maxTokens,
    jsonMode = false): Promise<{
    value: T; model: string; attempts: ModelAttempt[];
  }> {
    const attempts: ModelAttempt[] = [];
    let lastFailureReason: string | undefined;
    for (let keyIndex = 0; keyIndex < this.apiKeys.length; keyIndex++) {
      const key = this.apiKeys[keyIndex]!;
      if (this.exhaustedKeys.has(key)) continue;
      const client = keyIndex === 0 && this.firstClient ? this.firstClient : this.createClient(key);
      let available: Set<string>;
      try {
        const list = await client.models.list({ timeout: this.options.timeoutMs });
        available = new Set(list.data.map(m => m.id));
      } catch (error) {
        const discoveryForbidden = isModelDiscoveryForbidden(error);
        const record = { model: 'discovery', attempt: 1, keySlot: keyIndex + 1, elapsedMs: 0,
          outcome: discoveryForbidden ? 'MODELS_READ_FORBIDDEN' : safeOutcome(error) };
        attempts.push(record); this.onAttempt(record);
        // CodeCraft separates `models:read` from `inference`. A restricted key
        // can legitimately reject GET /models while still being authorized for
        // POST /chat/completions. The configured allow-list is sufficient for
        // that case; never infer arbitrary provider models.
        if (discoveryForbidden) {
          available = new Set(this.options.models);
        } else {
          lastFailureReason = safeOutcome(error);
          if (isKeyExhausted(error)) { await this.markExhausted(key, record.outcome); continue; }
          throw new RoutingError(attempts, lastFailureReason);
        }
      }
      let exhausted = false;
      for (const model of [...new Set(this.options.models)]) {
        if (!available.has(model)) {
          const record = { model, attempt: 0, keySlot: keyIndex + 1, elapsedMs: 0, outcome: 'UNAVAILABLE' };
          attempts.push(record); this.onAttempt(record); continue;
        }
        let attemptMaxTokens = maxTokens;
        for (let n = 0; n <= this.options.retries; n++) {
          const started = Date.now();
          const record: ModelAttempt = { model, attempt: n + 1, keySlot: keyIndex + 1, elapsedMs: 0, outcome: 'INVALID_OUTPUT' };
          let transient = false;
          try {
            const request = { model, messages, max_tokens: attemptMaxTokens,
              ...(jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
              ...(this.options.reasoningEffort ? { reasoning_effort: this.options.reasoningEffort } : {}) };
            const response = await client.chat.completions.create(
              request as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
            { timeout: this.options.modelTimeoutMs?.[model] ?? this.options.timeoutMs });
            record.usage = response.usage;
            const cost = (response as unknown as { cost?: unknown }).cost;
            if (typeof cost === 'number' && Number.isFinite(cost)) record.cost = cost;
            if (response.choices[0]?.finish_reason !== 'stop') throw new Error('INCOMPLETE_OUTPUT');
            const text = response.choices[0]?.message.content;
            if (!text?.trim()) throw new Error('EMPTY_OUTPUT');
            const value = validate(text);
            record.outcome = 'SUCCESS'; record.elapsedMs = Date.now() - started;
            attempts.push(record); this.onAttempt(record);
            return { value, model, attempts };
          } catch (error) {
            if (isKeyExhausted(error)) {
              const apiErr = error instanceof OpenAI.APIError ? error : undefined;
              record.outcome = apiErr?.status === 402 ? 'HTTP_402_BILLING_REQUIRED' : 'KEY_EXHAUSTED';
              lastFailureReason = record.outcome;
              exhausted = true;
            } else {
              const status = error instanceof OpenAI.APIError ? error.status : undefined;
              record.outcome = safeOutcome(error);
              lastFailureReason = record.outcome;
              transient = status === 429 || (status != null && status >= 500) || error instanceof OpenAI.APIConnectionError;
            }
            record.elapsedMs = Date.now() - started;
            attempts.push(record); this.onAttempt(record);
          }
          if (record.outcome === 'PROVIDER_ACCESS_BLOCKED') throw new RoutingError(attempts, record.outcome);
          // Some reasoning/free-tier models occasionally stop at their token
          // boundary even for short structured outputs. Retry that response
          // once under the configured bounded retry budget.
          if (record.outcome === 'INCOMPLETE_OUTPUT' && /openrouter\.ai/i.test(this.options.baseUrl)) {
            attemptMaxTokens = Math.min(maxTokens * 2, 2048);
          }
          transient ||= record.outcome === 'INCOMPLETE_OUTPUT';
          if (exhausted || !transient || n === this.options.retries) break;
          await this.sleep(Math.min(1000 * 2 ** n, 8000));
        }
        if (exhausted) break;
      }
      if (exhausted) { await this.markExhausted(key, lastFailureReason ?? 'KEY_EXHAUSTED'); continue; }
      // The provider answered but no configured model produced valid output. A different key cannot fix that.
      break;
    }
    throw new RoutingError(attempts, lastFailureReason);
  }

  private async markExhausted(key: string, reason: string): Promise<void> {
    this.exhaustedKeys.add(key);
    try { await this.onKeyExhausted(key, reason); } catch { /* use the next in-memory key even if persistence is briefly unavailable */ }
  }
}

function safeOutcome(error: unknown): string {
  if (error instanceof OpenAI.APIConnectionTimeoutError) return 'TIMEOUT';
  if (error instanceof OpenAI.APIConnectionError) return 'CONNECTION_ERROR';
  if (error instanceof Error && ['INCOMPLETE_OUTPUT', 'EMPTY_OUTPUT'].includes(error.message)) return error.message;
  if (error instanceof OpenAI.APIError) {
    if (error.status === 403 && /<!doctype html|<html|just a moment|cf-chl-/i.test(error.message)) return 'PROVIDER_ACCESS_BLOCKED';
    return `HTTP_${error.status ?? 'ERROR'}`;
  }
  if (error instanceof OutputValidationError) return error.category;
  if (error instanceof z.ZodError) return `SCHEMA:${error.issues.map(i => i.path.join('.')).join(',').slice(0,200)}`;
  // Validation messages and provider content can contain secrets: persist categories only.
  return 'INVALID_OUTPUT';
}

/** Quota exhaustion is distinct from a short-lived rate limit: only this rotates a saved key pool. */
export function isKeyExhausted(error: unknown): boolean {
  const api = error instanceof OpenAI.APIError ? error : undefined;
  const status = api?.status;
  if (status === 401 || status === 402) return true;
  if (status !== 429) return false;
  const candidate = error as { code?: unknown; type?: unknown; message?: unknown };
  const detail = [candidate.code, candidate.type, candidate.message].filter(v => typeof v === 'string').join(' ').toLowerCase();
  return /quota|credit|balance|billing|payment|monthly|insufficient_funds/.test(detail);
}

/** A CodeCraft key may intentionally omit models:read while retaining inference. */
function isModelDiscoveryForbidden(error: unknown): boolean {
  return error instanceof OpenAI.APIError && error.status === 403 &&
    (error.code === 'insufficient_scope' || /models:read/.test(error.message)) &&
    !/<!doctype html|<html|just a moment|cf-chl-/i.test(error.message);
}
