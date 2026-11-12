import { z } from 'zod';
import type OpenAI from 'openai';
import { createDecipheriv, createHash } from 'node:crypto';
import type { LLMMessage } from '../ai/provider';
import { config } from '../config';
import { getSystemState, setSystemState } from '../database/models';
import { decryptText, encryptText } from '../security/credentialStore';
import { CoarenaPause, coarenaPauseForAttempt, isCoarenaSharedLimit, retryAfterMs } from './coarenaLimits';
import { AIModelRouter, ModelAttempt, OutputValidationError, RoutingError } from './router';

const BASE_URL = 'https://coarena.ai/api/v1';
const KEY_STATE = 'solution-post-coarena-key:v1';
// Sealed to the service's existing SETUP_TOKEN. The repository contains only ciphertext.
const BOOTSTRAP_KEY = 'jeYQeXLvzbbbmZpa:XOWp1wC4OfzANW5McLJPTw:wtaRTks1XsSn_04OQkxyJmswqrylZlhDio6BIP2gum0zF03p';
export const COARENA_WRITER = 'claude-sonnet-5-5';
export const COARENA_REVIEWER = 'gemini-4-argon';
export const COARENA_WRITERS = [COARENA_WRITER, 'gemini-3-8-flash', 'kimi-k3-1-pro'] as const;
export const COARENA_REVIEWERS = [COARENA_REVIEWER, 'claude-opus-5-5', 'qwen3-8-2-4t-a95b'] as const;
const MODEL_STATE = 'solution-post-coarena-models:v1';
const modelPreference = z.object({ writer: z.enum(COARENA_WRITERS), reviewer: z.enum(COARENA_REVIEWERS) }).strict();
type ModelPreference = z.infer<typeof modelPreference>;

export async function loadCoarenaModelOrder() {
  const saved = await getSystemState(MODEL_STATE).catch(() => null);
  let preferred: ModelPreference | undefined;
  if (saved) {
    try {
      const parsed = modelPreference.safeParse(JSON.parse(saved));
      if (parsed.success) preferred = parsed.data;
    } catch { /* recover with the built-in order */ }
  }
  const writers = preferred ? [preferred.writer, ...COARENA_WRITERS.filter(model => model !== preferred.writer)] : [...COARENA_WRITERS];
  const reviewers = preferred ? [preferred.reviewer, ...COARENA_REVIEWERS.filter(model => model !== preferred.reviewer)] : [...COARENA_REVIEWERS];
  return { writers, reviewers, mode: preferred ? 'preferred' as const : 'auto' as const };
}

export async function setCoarenaModelPreference(input: unknown) {
  const selected = input === 'auto' ? null : modelPreference.parse(input);
  await setSystemState(MODEL_STATE, JSON.stringify(selected));
  return loadCoarenaModelOrder();
}
const DAILY_LIMIT = 5;
const limitsSchema = z.object({ data: z.object({ free: z.boolean(), usd_per_day: z.number(), today: z.object({
  used_usd: z.number(), left_usd: z.number(), held_usd: z.number().optional(), resets_at: z.number(), requests_left: z.number().nullable(),
}) }) });

export async function loadCoarenaKey(): Promise<string | null> {
  const environment = process.env.COARENA_API_KEY?.trim();
  if (environment) return environment;
  const encrypted = await getSystemState(KEY_STATE).catch(() => null);
  const stored = encrypted && decryptText(encrypted);
  if (stored) return stored;
  try {
    const [iv, tag, ciphertext] = BOOTSTRAP_KEY.split(':').map(part => Buffer.from(part, 'base64url'));
    const key = createHash('sha256').update(`coarena-render-bootstrap:v1\0${config.api.setupToken}`).digest();
    const decipher = createDecipheriv('aes-256-gcm', key, iv!);
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(ciphertext!), decipher.final()]).toString('utf8');
  } catch { return null; }
}

export function maskCoarenaKey(key: string): string { return `coa_…${key.slice(-4)}`; }

async function readLimits(key: string) {
  const response = await fetch(`${BASE_URL}/limits`, { headers: { Authorization: `Bearer ${key}` },
    redirect: 'error', signal: AbortSignal.timeout(8_000) });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const pause = coarenaPauseForAttempt({
      provider: 'coarena', model: 'limits', attempt: 0, elapsedMs: 0, outcome: 'LIMITS_UNAVAILABLE',
      httpStatus: response.status, providerCode: body?.error?.code ?? body?.code,
      retryAllowed: response.headers.get('x-should-retry') !== 'false',
      retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
    });
    if (pause) throw pause;
    throw new RoutingError([], 'COARENA_LIMITS_HTTP_' + response.status);
  }
  return limitsSchema.parse(await response.json()).data;
}

export async function coarenaStatus() {
  const key = await loadCoarenaKey();
  if (!key) return { enabled: false };
  const [limits, order] = await Promise.all([readLimits(key), loadCoarenaModelOrder()]);
  return { enabled: true, keyMasked: maskCoarenaKey(key), writer: order.writers[0], reviewer: order.reviewers[0],
    automaticFailover: true, ...order,
    dailyLimitUsd: limits.usd_per_day, ...limits.today };
}

// Coarena enforces the daily account cap, including costs held by in-flight calls.
// Serialize this process's starts to stay under its request and concurrency limits.
let lane: Promise<unknown> = Promise.resolve();
let nextStart = 0;
const cooldowns = new Map<string, CoarenaPause>();

export interface CoarenaReply {
  raw: string;
  model: string;
  attempts: ModelAttempt[];
}

export interface CoarenaCheckpoint {
  read(id: string): Promise<CoarenaReply | null>;
  save(id: string, reply: CoarenaReply): Promise<void>;
}

export class CoarenaRouter extends AIModelRouter {
  private fallbackRouter?: Promise<AIModelRouter>;
  private primaryUnavailable = false;
  private readonly quotaKey: string;
  private resetAt?: number;

  constructor(private readonly key: string, private readonly createFallback: () => Promise<AIModelRouter>,
    onAttempt?: (attempt: ModelAttempt) => void, private readonly deadlineAt?: number,
    private readonly checkpoint?: CoarenaCheckpoint,
    private readonly modelOrder: { writers: readonly string[]; reviewers: readonly string[] } =
      { writers: COARENA_WRITERS, reviewers: COARENA_REVIEWERS }, client?: OpenAI) {
    super({ apiKey: key, baseUrl: BASE_URL, models: [...modelOrder.writers, ...modelOrder.reviewers],
      writingModels: modelOrder.writers, reviewModels: modelOrder.reviewers,
      timeoutMs: 40_000, retries: 0, maxTokens: 4096, deadlineAt,
      beforeInference: async attempts => {
        // The first inference already has a fresh allowance check. Every physical
        // fallback call rechecks the budget before it spends another token.
        if (attempts.some(attempt => attempt.attempt > 0 && attempt.model !== 'discovery')) {
          try { await this.checkAllowance(); }
          catch (error) {
            if (error instanceof CoarenaPause) throw error.withAttempts(attempts);
            if (error instanceof RoutingError) throw new RoutingError([...attempts, ...error.attempts], error.lastFailure);
            throw error;
          }
        }
        const delay = nextStart - Date.now();
        if (delay > 0) await new Promise<void>(resolve => setTimeout(resolve, delay));
        nextStart = Date.now() + 2100;
      },
      stopAfterAttempt: attempt => isCoarenaSharedLimit(attempt) || attempt.httpStatus === 403 ||
        ['content_filtered', 'model_api_disabled', 'model_api_off'].includes(attempt.providerCode ?? ''),
    }, client, undefined, attempt => { attempt.provider = 'coarena'; onAttempt?.(attempt); });
    this.quotaKey = createHash('sha256').update(key).digest('hex');
  }

  private async checkAllowance(): Promise<void> {
    const limits = await readLimits(this.key);
    if (!limits.free || limits.usd_per_day > DAILY_LIMIT) throw new RoutingError([], 'COARENA_FREE_LIMIT_REQUIRED');
    const { left_usd, requests_left, resets_at, held_usd } = limits.today;
    this.resetAt = resets_at;
    if (requests_left !== 0 && left_usd > 0) return;
    if (requests_left !== 0 && held_usd && held_usd > 0) throw new CoarenaPause('COARENA_CAPACITY', new Date(Date.now() + 60_000));
    const nextDay = (Math.floor(Date.now() / 86_400_000) + 1) * 86_400_000;
    throw new CoarenaPause('COARENA_DAILY_LIMIT', new Date(resets_at > Date.now() ? resets_at : nextDay));
  }

  get canUsePrimary(): boolean { return !this.primaryUnavailable; }

  fallback(): Promise<AIModelRouter> {
    this.fallbackRouter ??= this.createFallback();
    return this.fallbackRouter;
  }

  async generatePrimary<T>(messages: LLMMessage[], validate: (text: string) => T, maxTokens?: number, jsonMode?: boolean, stage?: string) {
    const input: LLMMessage[] = jsonMode ? [...messages, { role: 'user', content: 'Return the result as a JSON object.' }] : messages;
    const tokens = stage === 'technical review implementation' ? Math.max(maxTokens ?? 0, 2400) : maxTokens;
    const checkpointId = createHash('sha256').update(JSON.stringify([this.modelOrder.writers, this.modelOrder.reviewers,
      stage, input, tokens, jsonMode])).digest('hex');
    const saved = await this.checkpoint?.read(checkpointId);
    if (saved) return { value: validate(saved.raw), model: saved.model, attempts: saved.attempts };

    const deadline = this.deadlineAt ?? Infinity;
    const capacityPause = () => new CoarenaPause('COARENA_CAPACITY', new Date(Date.now() + 60_000));
    const request = lane.then(async () => {
      if (Date.now() >= deadline) throw capacityPause();
      const cooldown = cooldowns.get(this.quotaKey);
      if (cooldown && cooldown.retryAt.getTime() > Date.now()) {
        throw new CoarenaPause(cooldown.code, cooldown.retryAt);
      }
      cooldowns.delete(this.quotaKey);
      try {
        await this.checkAllowance();
        let raw = '';
        const parse = this.checkpoint ? (output: string) => {
          raw = output;
          return validate(output);
        } : validate;
        const result = await super.generate(input, parse, tokens, jsonMode, stage);
        if (this.checkpoint) await this.checkpoint.save(checkpointId, { raw, model: result.model, attempts: result.attempts });
        return result;
      } catch (error) {
        let pause = error instanceof CoarenaPause ? error : undefined;
        if (!pause && error instanceof RoutingError) {
          const attempt = [...error.attempts].reverse().find(record => record.attempt > 0);
          const limit = attempt && coarenaPauseForAttempt(attempt, this.resetAt);
          if (limit) pause = new CoarenaPause(limit.code, limit.retryAt, error.attempts);
          if (!pause && error.lastFailure === 'ARTICLE_TIME_BUDGET_EXCEEDED') pause = capacityPause().withAttempts(error.attempts);
        }
        if (pause) {
          cooldowns.set(this.quotaKey, pause);
          throw pause;
        }
        throw error;
      }
    });
    lane = request.catch(() => undefined);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!Number.isFinite(deadline)) return await request;
      return await Promise.race([request, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(capacityPause()), Math.max(0, deadline - Date.now()));
      })]);
    } catch (error) {
      if (error instanceof CoarenaPause) throw error;
      if (error instanceof RoutingError) {
        const last = error.attempts.at(-1);
        this.primaryUnavailable = !last || last.model === 'discovery' || [401, 402, 403].includes(last.httpStatus ?? 0) ||
          ['model_api_disabled', 'model_api_off'].includes(last.providerCode ?? '');
        throw error;
      }
      this.primaryUnavailable = true;
      throw new RoutingError([], 'COARENA_UNAVAILABLE');
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  override async generate<T>(messages: LLMMessage[], validate: (text: string) => T, maxTokens?: number, jsonMode?: boolean, stage?: string) {
    let primaryAttempts: ModelAttempt[] = [];
    if (this.canUsePrimary) {
      try { return await this.generatePrimary(messages, validate, maxTokens, jsonMode, stage); }
      catch (error) {
        if (error instanceof CoarenaPause || !(error instanceof RoutingError)) throw error;
        primaryAttempts = error.attempts.length ? error.attempts : [{ model: COARENA_WRITER, provider: 'coarena',
          attempt: 0, elapsedMs: 0, stage, outcome: error.lastFailure ?? 'COARENA_UNAVAILABLE' }];
      }
    }
    try {
      const result = await (await this.fallback()).generate(messages, validate, maxTokens, jsonMode, stage);
      return { ...result, attempts: [...primaryAttempts, ...result.attempts] };
    } catch (error) {
      if (error instanceof RoutingError) throw new RoutingError([...primaryAttempts, ...error.attempts], error.lastFailure);
      throw error;
    }
  }
}

/** Verify from this host before replacing the live key. */
export async function enableCoarena(key: string) {
  const order = await loadCoarenaModelOrder();
  const router = new CoarenaRouter(key, async () => { throw new Error('Discovery unavailable in a Coarena probe'); },
    undefined, undefined, undefined, order);
  const messages: LLMMessage[] = [{ role: 'system', content: 'Return only {"ready":true}.' }, { role: 'user', content: 'Confirm readiness.' }];
  const validate = (text: string) => {
    if (JSON.parse(text).ready !== true) throw new OutputValidationError('COARENA_PROBE_INVALID');
    return true;
  };
  const writer = await router.generatePrimary(messages, validate, 1024, true, 'coarena probe');
  const reviewer = await router.generatePrimary(messages, validate, 1024, true, 'technical review probe');
  await setSystemState(KEY_STATE, encryptText(key));
  return { enabled: true, model: writer.model, reviewModel: reviewer.model,
    usage: [...writer.attempts, ...reviewer.attempts].map(attempt => ({ model: attempt.model, tokens: attempt.usage?.total_tokens })),
    executionHost: process.env.RENDER_INSTANCE_ID ? 'render' : 'local', revision: process.env.RENDER_GIT_COMMIT ?? null };
}
