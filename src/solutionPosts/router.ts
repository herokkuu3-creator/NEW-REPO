import OpenAI from 'openai';
import { z } from 'zod';
import { LLMMessage } from '../ai/provider';
import { isBazaarLinkProvider, isCloudflareAiProvider, isSageProvider, solutionPostProviderHeaders } from '../config/solutionPostProvider';

// BazaarLink documents 10 free requests/minute. Reserve starts across routers
// in this process, with a little headroom for diagnostics. Never enable paid fallback.
let nextBazaarFreeRequestAt = 0;
let bazaarFreeBlockedUntil = 0;
let nextSageRequestAt = 0;
const sageBlockedUntilByKey = new Map<string, number>();
const getSageBlockedUntil = (key: string): number => sageBlockedUntilByKey.get(key) ?? 0;
const setSageBlockedUntil = (key: string, until: number): void => {
  const prev = sageBlockedUntilByKey.get(key) ?? 0;
  if (until > prev) sageBlockedUntilByKey.set(key, until);
};
const sageModelHealth = new Map<string, { failures: number; until: number; lastFailureAt: number }>();
const SAGE_MODEL_COOLDOWN_MS = 30 * 60 * 1000;
export const SOLUTION_ARTICLE_WORK_MS = Number(process.env.SOLUTION_ARTICLE_WORK_MS) || 12 * 60_000;
export const SAGE_REPAIR_TIMEOUT_MS = 300000;
export const SAGE_REVIEW_TIMEOUT_MS = 300000;

export interface RouterOptions {
  apiKey: string;
  apiKeys?: string[];
  baseUrl: string;
  models: string[];
  reviewModels?: readonly string[];
  writingModels?: readonly string[];
  fallbackModels?: readonly string[];
  timeoutMs: number;
  retries: number;
  maxTokens: number;
  modelTimeoutMs?: Record<string, number>;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  minRequestIntervalMs?: number;
  beforeInference?: (attempts: ModelAttempt[]) => Promise<void>;
  stopAfterAttempt?: (attempt: ModelAttempt) => boolean;
  getCoarenaPrioritizedModels?: (stage?: string) => { skip: ReadonlySet<string>; prefer: readonly string[] };
  onCoarenaPaymentRequired?: (model: string, discoveredFreeModels: string[]) => void;
  onCoarenaModelSuccess?: (model: string, stage?: string) => void;
  deferOnRateLimit?: boolean;
  deadlineAt?: number;
}
export interface ModelAttempt {
  provider?: 'coarena' | 'cloudflare' | 'discovery';
  model: string;
  requestedModel?: string;
  attempt: number;
  outcome: string;
  elapsedMs: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  cost?: number;
  keySlot?: number;
  stage?: string;
  httpStatus?: number;
  retryAfterMs?: number;
  providerCode?: string;
  retryAllowed?: boolean;
  deferred?: boolean;
  agentCreditsUsed?: number;
  providerLimit?: 'requests_per_minute' | 'concurrency' | 'daily' | 'unknown';
  reviewIssues?: string[];
  requestedMaxTokens?: number;
}
export class RoutingError extends Error {
  constructor(public readonly attempts: ModelAttempt[], public readonly lastFailure?: string) {
    super(lastFailure ? `AI generation failed: ${lastFailure}` : 'AI generation exhausted the configured models; inspect attempt outcomes');
  }
}
export class OutputValidationError extends Error {
  constructor(public readonly category: string) { super(category); }
}

export function parseJSON(text: string): unknown {
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*\r?\n/, '').replace(/\r?\n```$/, ''));
}

/** Uses the existing OpenAI SDK/protocol, with one bounded retry owner. Never logs provider bodies. */
export class AIModelRouter {
  private readonly apiKeys: string[];
  private readonly exhaustedKeys = new Set<string>();
  private readonly failedCoarenaModels = new Set<string>();
  private readonly catalogs = new Map<string, Set<string>>();
  private readonly catalogAliases = new Map<string, Map<string, string>>();
  private readonly firstClient?: OpenAI;
  constructor(private readonly options: RouterOptions, client?: OpenAI,
    private readonly sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms)),
    private readonly onAttempt: (attempt: ModelAttempt) => void = () => {},
    private readonly onKeyExhausted: (key: string, reason: string) => Promise<void> | void = () => {},
    private readonly createClient: (key: string) => OpenAI = key => new OpenAI({ apiKey: key, baseURL: options.baseUrl,
      timeout: options.timeoutMs, maxRetries: 0, defaultHeaders: solutionPostProviderHeaders(options.baseUrl) })) {
    this.apiKeys = [...new Set((options.apiKeys?.length ? options.apiKeys : [options.apiKey]).map(key => key.trim()).filter(Boolean))];
    if (!this.apiKeys.length) throw new Error('SOLUTION_POST_API_KEYS is required');
    this.firstClient = client;
  }

  async generate<T>(messages: LLMMessage[], validate: (text: string) => T, maxTokens = this.options.maxTokens,
    jsonMode = false, stage?: string): Promise<{
    value: T; model: string; attempts: ModelAttempt[];
  }> {
    const attempts: ModelAttempt[] = [];
    const coarena = isCoarenaUrl(this.options.baseUrl);
    const cloudflareAi = isCloudflareAiProvider(this.options.baseUrl);
    let lastFailureReason: string | undefined;
    const remainingTime = (timeout: number) => {
      const remaining = (this.options.deadlineAt ?? Infinity) - Date.now();
      if (remaining <= 0) throw new RoutingError(attempts, 'ARTICLE_TIME_BUDGET_EXCEEDED');
      return Math.min(timeout, remaining);
    };
    const deferRateLimit = this.options.deferOnRateLimit && stage !== 'telegram-chat';
    for (let keyIndex = 0; keyIndex < this.apiKeys.length; keyIndex++) {
      const key = this.apiKeys[keyIndex]!;
      if (this.exhaustedKeys.has(key)) continue;
      const client = keyIndex === 0 && this.firstClient ? this.firstClient : this.createClient(key);
      let available: Set<string>;
      const discoveryTimeout = remainingTime(this.options.timeoutMs);
      if (deferRateLimit && isSageProvider(this.options.baseUrl) && getSageBlockedUntil(key) > Date.now()) {
        const record: ModelAttempt = { model: 'discovery', attempt: 0, keySlot: keyIndex + 1, elapsedMs: 0, stage, outcome: 'HTTP_429',
          retryAfterMs: getSageBlockedUntil(key) - Date.now(), deferred: true };
        attempts.push(record);
        this.onAttempt(record);
        const hasOtherKey = this.apiKeys.some((other, idx) => idx > keyIndex && !this.exhaustedKeys.has(other) && getSageBlockedUntil(other) <= Date.now());
        if (hasOtherKey) {
          lastFailureReason = 'HTTP_429';
          continue;
        }
        throw new RoutingError(attempts, 'HTTP_429');
      }
      if (cloudflareAi) {
        available = new Set(this.options.models);
        this.catalogs.set(key, available);
      } else {
        try {
          const cached = this.catalogs.get(key);
          if (cached) available = cached;
          else {
            const list = await client.models.list({ timeout: discoveryTimeout });
            available = new Set(list.data.map(m => m.id));
            const aliasMap = new Map<string, string>();
            for (const m of list.data) {
              aliasMap.set(m.id.toLowerCase(), m.id);
              const aliases = (m as unknown as { aliases?: unknown }).aliases;
              if (Array.isArray(aliases)) {
                for (const alias of aliases) {
                  if (typeof alias === 'string' && alias.trim()) {
                    aliasMap.set(alias.trim().toLowerCase(), m.id);
                  }
                }
              }
            }
            this.catalogs.set(key, available);
            this.catalogAliases.set(key, aliasMap);
          }
        } catch (error) {
          const discoveryForbidden = isModelDiscoveryForbidden(error);
          const record: ModelAttempt = { model: 'discovery', attempt: 1, keySlot: keyIndex + 1, elapsedMs: 0, stage,
            ...httpFailureDetails(error),
            outcome: discoveryForbidden ? 'MODELS_READ_FORBIDDEN' : safeOutcome(error) };
          attempts.push(record); this.onAttempt(record);
          // CodeCraft separates `models:read` from `inference`. A restricted key
          // can legitimately reject GET /models while still being authorized for
          // POST /chat/completions. The configured allow-list is sufficient for
          // that case; never infer arbitrary provider models.
          if (discoveryForbidden) {
            available = new Set(this.options.models);
            this.catalogs.set(key, available);
          } else {
            lastFailureReason = safeOutcome(error);
            if (isKeyExhausted(error, this.options.baseUrl)) { await this.markExhausted(key, record.outcome); continue; }
            throw new RoutingError(attempts, lastFailureReason);
          }
        }
      }
      const aliasMap = this.catalogAliases.get(key);
      let exhausted = false;
      let rotateToNextKey = false;
      const sageReasoning = isSageProvider(this.options.baseUrl);
      const roleModels = stage?.startsWith('technical review') ? this.options.reviewModels : this.options.writingModels;
      const modelOrder = [...new Set(roleModels?.length ? roleModels.filter(model => this.options.models.includes(model)) : this.options.models)];
      const queue: Array<{ model: string; secondary: boolean }> = [];
      if (coarena) {
        const priority = this.options.getCoarenaPrioritizedModels?.(stage);
        const skipSet = priority?.skip;
        const preferList = priority?.prefer ?? [];
        const fallbackList = this.options.fallbackModels ?? [];
        const hasNonSkippedAvailable =
          preferList.some(m => available.has(m) && !skipSet?.has(m) && !this.failedCoarenaModels.has(m)) ||
          modelOrder.some(m => available.has(m) && !skipSet?.has(m) && !this.failedCoarenaModels.has(m)) ||
          fallbackList.some(m => available.has(m) && !skipSet?.has(m) && !this.failedCoarenaModels.has(m));
        const seenQueued = new Set<string>();
        for (const m of preferList) {
          if (available.has(m) && !skipSet?.has(m) && !this.failedCoarenaModels.has(m) && !seenQueued.has(m)) {
            seenQueued.add(m);
            queue.push({ model: m, secondary: false });
          }
        }
        for (const m of modelOrder) {
          if (skipSet?.has(m) && hasNonSkippedAvailable) continue;
          if (!seenQueued.has(m)) {
            seenQueued.add(m);
            queue.push({ model: m, secondary: false });
          }
        }
        for (const m of fallbackList) {
          if (available.has(m) && !skipSet?.has(m) && !this.failedCoarenaModels.has(m) && !seenQueued.has(m)) {
            seenQueued.add(m);
            queue.push({ model: m, secondary: true });
          }
        }
      } else {
        for (const m of modelOrder) queue.push({ model: m, secondary: false });
      }
      const triedModels = new Set<string>();
      for (let qi = 0; qi < queue.length; qi++) {
        const { model, secondary } = queue[qi]!;
        if (triedModels.has(model)) continue;
        triedModels.add(model);
        if (!available.has(model) || this.failedCoarenaModels.has(model)) {
          if (!secondary) {
            const record = { model, attempt: 0, keySlot: keyIndex + 1, elapsedMs: 0, stage,
              outcome: available.has(model) ? 'MODEL_TEMPORARILY_UNAVAILABLE' : 'UNAVAILABLE' };
            attempts.push(record); this.onAttempt(record);
            lastFailureReason ??= record.outcome;
          }
          continue;
        }
        const healthKey = `${new URL(this.options.baseUrl).origin}:${model}`;
        const blockedUntil = sageReasoning ? sageModelHealth.get(healthKey)?.until ?? 0 : 0;
        if (blockedUntil > Date.now()) {
          const record: ModelAttempt = { model, attempt: 0, keySlot: keyIndex + 1, elapsedMs: 0, stage,
            outcome: 'MODEL_TEMPORARILY_UNAVAILABLE', deferred: true, retryAfterMs: blockedUntil - Date.now() };
          attempts.push(record); this.onAttempt(record); lastFailureReason ??= record.outcome; continue;
        }
        // Sage Inkstone reasoning models (deepseek, qwen3.8) spend a large
        // portion of max_tokens on internal reasoning_content. The visible
        // JSON output only appears after reasoning finishes. A 512-token
        // budget is entirely consumed by reasoning, leaving zero content.
        // Guarantee at least 4096 tokens so the model has room for both
        // reasoning AND the actual structured JSON output.
        // A full-article repair needs output plus reasoning headroom, but
        // reserving 6x its 4096-token output can itself trip provider TPM limits.
        const fullRepair = stage === 'technical review repair';
        const fullReview = stage === 'technical review';
        const tokenCeiling = fullRepair || fullReview ? 32768 : 16384;
        let attemptMaxTokens = sageReasoning ? Math.min(Math.max(maxTokens * (fullRepair ? 4 : 2),
          fullReview ? 16384 : fullRepair ? 8192 : 4096), tokenCeiling) :
          cloudflareAi ? Math.min(Math.max(maxTokens * 2, 4096), 16384) : maxTokens;
        let maxRetries = this.options.retries;
        let incompleteBumped = false;
        for (let n = 0; n <= maxRetries; n++) {
          await this.options.beforeInference?.(attempts);
          const started = Date.now();
          const record: ModelAttempt = { model, attempt: n + 1, keySlot: keyIndex + 1, elapsedMs: 0,
            outcome: 'INVALID_OUTPUT', stage, requestedMaxTokens: attemptMaxTokens };
          let transient = false;
          let lastError: unknown;
          try {
            if (isSageProvider(this.options.baseUrl)) {
              // Intern-AI enforces 50 RPM on generation models (~1200ms per request).
              // Space requests by at least 1500ms across the process to guarantee staying
              // safely within RPM limits and prevent burst concurrency 429s.
              if (deferRateLimit && getSageBlockedUntil(key) > Date.now()) {
                const deferred: ModelAttempt = {
                  model, attempt: n + 1, keySlot: keyIndex + 1, elapsedMs: 0, stage,
                  outcome: 'HTTP_429', retryAfterMs: getSageBlockedUntil(key) - Date.now(), deferred: true,
                };
                attempts.push(deferred); this.onAttempt(deferred);
                throw new RoutingError(attempts, 'HTTP_429');
              }
              const interval = this.options.minRequestIntervalMs ?? (process.env.NODE_ENV === 'test' ? 0 : 1500);
              if (interval > 0) {
                const waitForSageSlot = async (target: number) => {
                  const waitMs = target - Date.now();
                  if (waitMs <= 0) return;
                  const bounded = remainingTime(waitMs);
                  await this.sleep(bounded);
                  if (bounded < waitMs) throw new RoutingError(attempts, 'ARTICLE_TIME_BUDGET_EXCEEDED');
                  if (deferRateLimit && getSageBlockedUntil(key) > Date.now()) {
                    const deferred: ModelAttempt = {
                      model, attempt: n + 1, keySlot: keyIndex + 1, elapsedMs: 0, stage,
                      outcome: 'HTTP_429', retryAfterMs: getSageBlockedUntil(key) - Date.now(), deferred: true,
                    };
                    attempts.push(deferred); this.onAttempt(deferred);
                    throw new RoutingError(attempts, 'HTTP_429');
                  }
                };
                let start = Math.max(Date.now(), nextSageRequestAt, getSageBlockedUntil(key));
                if (start <= (this.options.deadlineAt ?? Infinity)) nextSageRequestAt = start + interval;
                await waitForSageSlot(start);
                while (start < getSageBlockedUntil(key)) {
                  start = Math.max(Date.now(), nextSageRequestAt, getSageBlockedUntil(key));
                  if (start <= (this.options.deadlineAt ?? Infinity)) nextSageRequestAt = start + interval;
                  await waitForSageSlot(start);
                }
              }
            } else if (isBazaarLinkProvider(this.options.baseUrl) && model.endsWith(':free')) {
              const interval = this.options.minRequestIntervalMs ?? 6500;
              if (interval > 0) {
                assertBazaarCooldownBudget(record);
                let start = Math.max(Date.now(), nextBazaarFreeRequestAt, bazaarFreeBlockedUntil);
                nextBazaarFreeRequestAt = start + interval;
                if (start > Date.now()) await this.sleep(start - Date.now());
                // A different router may have received Retry-After while this
                // reservation was waiting. Rebook its start behind the cooldown.
                while (start < bazaarFreeBlockedUntil) {
                  assertBazaarCooldownBudget(record);
                  start = Math.max(Date.now(), nextBazaarFreeRequestAt, bazaarFreeBlockedUntil);
                  nextBazaarFreeRequestAt = start + interval;
                  if (start > Date.now()) await this.sleep(start - Date.now());
                }
              }
            }
            const request = { model, messages, max_tokens: attemptMaxTokens,
              ...(jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
              ...(this.options.reasoningEffort ? { reasoning_effort: this.options.reasoningEffort } : {}) };
            const completion = client.chat.completions.create(
              request as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
            { timeout: remainingTime(sageReasoning && stage?.startsWith('technical review') ?
              Math.max(this.options.modelTimeoutMs?.[model] ?? this.options.timeoutMs,
                fullRepair ? SAGE_REPAIR_TIMEOUT_MS : SAGE_REVIEW_TIMEOUT_MS) :
              this.options.modelTimeoutMs?.[model] ?? this.options.timeoutMs) });
            let response: OpenAI.Chat.Completions.ChatCompletion;
            if (coarena) {
              const { data, response: http } = await completion.withResponse();
              // Coarena can return a padded HTTP 200 carrying an upstream error.
              const embedded = (data as unknown as { error?: { code?: string; message?: string } }).error;
              if (embedded?.code) {
                throw new OpenAI.APIError(coarenaErrorStatus(embedded.code), embedded, embedded.message, {
                  'retry-after': http.headers.get('retry-after') ?? '',
                  'x-should-retry': http.headers.get('x-should-retry') ?? '',
                });
              }
              const served = http.headers.get('x-coarena-model') || data.model;
              if (typeof served === 'string' && /^[a-zA-Z0-9_.:/-]{1,128}$/.test(served) && served !== model) {
                record.requestedModel = model;
                record.model = served;
              }
              response = data;
            } else {
              response = await completion;
            }
            if (sageReasoning) sageModelHealth.delete(healthKey);
            record.usage = response.usage;
            const cost = (response as unknown as { cost?: unknown }).cost;
            if (typeof cost === 'number' && Number.isFinite(cost)) record.cost = cost;
            const finishReason = response.choices?.[0]?.finish_reason;
            if (finishReason !== 'stop') {
              throw new Error('INCOMPLETE_OUTPUT');
            }
            const rawContent: unknown = response.choices[0]?.message.content;
            const text = typeof rawContent === 'string'
              ? rawContent
              : rawContent && typeof rawContent === 'object'
                ? JSON.stringify(rawContent)
                : '';
            if (!text.trim()) throw new Error('EMPTY_OUTPUT');
            const value = validate(text);
            record.outcome = 'SUCCESS'; record.elapsedMs = Date.now() - started;
            attempts.push(record); this.onAttempt(record);
            if (coarena) this.options.onCoarenaModelSuccess?.(record.model, stage);
            return { value, model: record.model, attempts };
          } catch (error) {
            if (error instanceof RoutingError) throw error;
            lastError = error;
            Object.assign(record, httpFailureDetails(error));
            if (sageReasoning && (error instanceof OpenAI.APIConnectionError || (record.httpStatus ?? 0) >= 500)) {
              const old = sageModelHealth.get(healthKey);
              const failures = (old && Date.now() - old.lastFailureAt <= SAGE_MODEL_COOLDOWN_MS ? old.failures : 0) + 1;
              sageModelHealth.set(healthKey, { failures, until: failures >= 2 ? Date.now() + SAGE_MODEL_COOLDOWN_MS : 0,
                lastFailureAt: Date.now() });
            }
            if (sageReasoning && record.httpStatus === 429) {
              if (record.retryAfterMs == null || deferRateLimit) {
                record.retryAfterMs ??= 60000;
                setSageBlockedUntil(key, Date.now() + record.retryAfterMs);
              }
            }
            if (!record.deferred && record.httpStatus === 429 && isBazaarLinkProvider(this.options.baseUrl)) {
              bazaarFreeBlockedUntil = Math.max(bazaarFreeBlockedUntil, Date.now() + (record.retryAfterMs ?? 1000));
            }
            if (isKeyExhausted(error, this.options.baseUrl)) {
              const apiErr = error instanceof OpenAI.APIError ? error : undefined;
              record.outcome = apiErr?.status === 401 ? 'HTTP_401' :
                apiErr?.status === 402 ? 'HTTP_402_BILLING_REQUIRED' : 'KEY_EXHAUSTED';
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
          if (this.options.stopAfterAttempt?.(record)) throw new RoutingError(attempts, record.outcome);
          if (coarena && !exhausted && record.httpStatus === 402) {
            this.failedCoarenaModels.add(model);
            const discovered = extractCoarenaFreeModels(lastError, model, available, aliasMap)
              .filter(id => !triedModels.has(id) && !this.failedCoarenaModels.has(id));
            this.options.onCoarenaPaymentRequired?.(model, discovered);
            if (discovered.length) {
              const discoveredSet = new Set(discovered);
              for (let j = queue.length - 1; j > qi; j--) {
                if (discoveredSet.has(queue[j]!.model)) queue.splice(j, 1);
              }
              queue.splice(qi + 1, 0, ...discovered.map(id => ({ model: id, secondary: true })));
            }
          } else if (coarena && !exhausted && (record.httpStatus === 404 || record.httpStatus === 408 ||
            (record.httpStatus ?? 0) >= 500 || ['TIMEOUT', 'CONNECTION_ERROR', 'model_off', 'provider_restricted',
              'model_region_restricted', 'region_not_supported', 'model_not_found'].includes(record.providerCode ?? record.outcome))) {
            this.failedCoarenaModels.add(model);
          }
          if (sageReasoning && record.httpStatus === 429 && record.providerCode === 'quota_exceeded') {
            lastFailureReason = 'AI_QUOTA_EXCEEDED';
            setSageBlockedUntil(key, Date.now() + Math.max(record.retryAfterMs ?? 60_000, 60_000));
            const hasOtherKey = this.apiKeys.some((other, idx) => idx > keyIndex && !this.exhaustedKeys.has(other));
            if (hasOtherKey) {
              this.exhaustedKeys.add(key);
              await this.markRotated(key, 'HTTP_429');
              rotateToNextKey = true;
              break;
            }
            throw new RoutingError(attempts, 'AI_QUOTA_EXCEEDED');
          }
          if (deferRateLimit && record.httpStatus === 429) {
            if (this.apiKeys.length > 1) await this.markRotated(key, 'HTTP_429');
            throw new RoutingError(attempts, 'HTTP_429');
          }
          if (record.outcome === 'PROVIDER_ACCESS_BLOCKED') throw new RoutingError(attempts, record.outcome);
          if (sageReasoning && (sageModelHealth.get(healthKey)?.until ?? 0) > Date.now()) break;
          // Some reasoning/free-tier models occasionally stop at their token
          // boundary even for short structured outputs. Retry that response
          // once under the configured bounded retry budget.
          if ((coarena || cloudflareAi) && record.outcome === 'INCOMPLETE_OUTPUT' && !incompleteBumped &&
              attemptMaxTokens < (cloudflareAi ? 16384 : 8192)) {
            incompleteBumped = true;
            attemptMaxTokens = Math.min(attemptMaxTokens * 2, cloudflareAi ? 16384 : 8192);
            if (n === maxRetries) maxRetries++;
          }
          if (record.outcome === 'INCOMPLETE_OUTPUT' && (/openrouter\.ai/i.test(this.options.baseUrl) || sageReasoning)) {
            attemptMaxTokens = Math.min(attemptMaxTokens * 2, sageReasoning ? tokenCeiling : 2048);
          }
          transient ||= record.outcome === 'INCOMPLETE_OUTPUT';
          if (exhausted || !transient || n === maxRetries) break;
          // Defer instead of retrying before a long provider-specified reset.
          if ((record.retryAfterMs ?? 0) > 60000) break;
          await this.sleep(remainingTime(Math.max(Math.min(1000 * 2 ** n, 8000), record.retryAfterMs ?? 0)));
        }
        if (exhausted || rotateToNextKey) break;
      }
      if (exhausted) { await this.markExhausted(key, lastFailureReason ?? 'KEY_EXHAUSTED'); continue; }
      if (rotateToNextKey) continue;
      // If the current key hit a rate limit (HTTP 429) and more keys exist, rotate to the next key!
      if (lastFailureReason === 'HTTP_429' && this.apiKeys.length > 1) {
        await this.markRotated(key, 'HTTP_429');
        continue;
      }
      // The provider answered but no configured model produced valid output. A different key cannot fix that.
      break;
    }
    throw new RoutingError(attempts, lastFailureReason);
  }

  private async markRotated(key: string, reason: string): Promise<void> {
    try { await this.onKeyExhausted(key, reason); } catch { /* use next in-memory key even if callback fails */ }
  }

  private async markExhausted(key: string, reason: string): Promise<void> {
    this.exhaustedKeys.add(key);
    try { await this.onKeyExhausted(key, reason); } catch { /* use the next in-memory key even if persistence is briefly unavailable */ }
  }
}

function isCoarenaUrl(baseUrl: string): boolean {
  try { return new URL(baseUrl).hostname === 'coarena.ai'; }
  catch { return false; }
}

function coarenaErrorStatus(code: string): number {
  if (['rate_limit_exceeded', 'concurrency_limit_exceeded', 'insufficient_quota'].includes(code)) return 429;
  if (['invalid_api_key', 'api_key_revoked', 'api_key_expired', 'api_keys_disabled'].includes(code)) return 401;
  if (['payment_required', 'insufficient_balance'].includes(code)) return 402;
  if (['insufficient_scope', 'model_api_terms_required', 'account_blocked', 'account_withdrawn', 'region_not_supported'].includes(code)) return 403;
  if (['model_not_found', 'not_found'].includes(code)) return 404;
  if (['content_filtered', 'model_off', 'provider_restricted', 'model_region_restricted', 'invalid_json', 'invalid_request',
    'unsupported_parameter', 'unsupported_value', 'unsupported_content', 'context_length_exceeded', 'assistant_prefill_unsupported'].includes(code)) return 400;
  if (['server_busy', 'server_draining', 'quota_unavailable', 'upstream_capacity', 'model_unavailable', 'model_api_disabled'].includes(code)) return 503;
  if (code === 'upstream_timeout') return 504;
  return 502;
}

function extractCoarenaFreeModels(
  error: unknown,
  failedModel: string,
  available: ReadonlySet<string>,
  aliasMap?: ReadonlyMap<string, string>,
): string[] {
  const resolved: string[] = [];
  const addCandidate = (raw: string) => {
    const trimmed = raw.trim().replace(/^['"`(\[]+|['"`,.;:)\]]+$/g, '');
    if (!trimmed) return;
    const canonical = available.has(trimmed) ? trimmed : aliasMap?.get(trimmed.toLowerCase());
    if (canonical && canonical !== failedModel && available.has(canonical) && !resolved.includes(canonical)) {
      resolved.push(canonical);
    }
  };

  const errObj = error instanceof OpenAI.APIError ? (error.error as Record<string, unknown> | undefined) : undefined;
  const nestedErr = errObj && typeof errObj.error === 'object' && errObj.error !== null
    ? (errObj.error as Record<string, unknown>)
    : undefined;
  for (const source of [errObj, nestedErr]) {
    if (!source) continue;
    for (const field of ['free_models', 'models', 'allowed_models', 'available_free_models']) {
      const list = source[field];
      if (Array.isArray(list)) {
        for (const item of list) {
          if (typeof item === 'string') addCandidate(item);
        }
      }
    }
  }

  const textParts: string[] = [];
  if (error instanceof Error && error.message) textParts.push(error.message);
  if (typeof errObj?.message === 'string') textParts.push(errObj.message);
  if (typeof nestedErr?.message === 'string') textParts.push(nestedErr.message);
  const text = textParts.join(' ');
  for (const match of text.matchAll(/[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}/g)) {
    addCandidate(match[0]);
  }
  return resolved;
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

/** Invalid credentials and spent allowances retire a key; ordinary rate limits do not. */
export function isKeyExhausted(error: unknown, baseUrl?: string): boolean {
  const api = error instanceof OpenAI.APIError ? error : undefined;
  const status = api?.status;
  if (status === 401) return true;
  if (status === 402) return !(baseUrl && isCoarenaUrl(baseUrl));
  if (status !== 429) return false;
  // BazaarLink and Sage Inkstone (discovery-api.intern-ai.org.cn) use 429 for
  // RPM/TPM/concurrency and daily free allowances; monthly balance/allowance
  // failures use 402. Do not retire a valid key for a month on 429.
  if (baseUrl && (isBazaarLinkProvider(baseUrl) || isSageProvider(baseUrl) || isCoarenaUrl(baseUrl) || isCloudflareAiProvider(baseUrl))) return false;
  const candidate = error as { code?: unknown; type?: unknown; message?: unknown };
  const detail = [candidate.code, candidate.type, candidate.message].filter(v => typeof v === 'string').join(' ').toLowerCase();
  return /quota|credit|balance|billing|payment|monthly|insufficient_funds/.test(detail);
}

function httpFailureDetails(error: unknown): Pick<ModelAttempt, 'httpStatus' | 'retryAfterMs' | 'providerCode' | 'retryAllowed'> {
  if (!(error instanceof OpenAI.APIError)) return {};
  const headers = error.headers as Headers | Record<string, string> | undefined;
  const header = (name: string) => headers instanceof Headers ? headers.get(name) : headers?.[name];
  const value = header('retry-after');
  const delay = value ? (/^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now()) : NaN;
  const errObj = error.error as { code?: unknown; error?: { code?: unknown } } | undefined;
  const nestedCode = errObj?.code ?? errObj?.error?.code;
  const code = error.code ?? (typeof nestedCode === 'string' ? nestedCode : undefined);
  return { httpStatus: error.status, ...(Number.isFinite(delay) ? { retryAfterMs: Math.max(0, delay) } : {}),
    ...(code && /^[a-z0-9_]{1,64}$/.test(code) ? { providerCode: code } : {}),
    ...(header('x-should-retry') === 'false' ? { retryAllowed: false } : {}) };
}

function assertBazaarCooldownBudget(record: ModelAttempt): void {
  const remaining = bazaarFreeBlockedUntil - Date.now();
  if (remaining <= 60000) return;
  record.deferred = true;
  throw new OpenAI.RateLimitError(429, {}, 'Previously observed provider cooldown is still active',
    { 'retry-after': String(Math.ceil(remaining / 1000)) });
}

/** A CodeCraft key may intentionally omit models:read while retaining inference. */
function isModelDiscoveryForbidden(error: unknown): boolean {
  return error instanceof OpenAI.APIError && error.status === 403 &&
    (error.code === 'insufficient_scope' || /models:read/.test(error.message)) &&
    !/<!doctype html|<html|just a moment|cf-chl-/i.test(error.message);
}
