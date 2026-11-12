import { z } from 'zod';
import { createDecipheriv, createHash } from 'node:crypto';
import type { LLMMessage } from '../ai/provider';
import { config } from '../config';
import { getSystemState, setSystemState } from '../database/models';
import { decryptText, encryptText } from '../security/credentialStore';
import { CoarenaPause, coarenaPauseForAttempt, retryAfterMs } from './coarenaLimits';
import { AIModelRouter, ModelAttempt, OutputValidationError, RoutingError } from './router';

const BASE_URL = 'https://coarena.ai/api/v1';
const KEY_STATE = 'solution-post-coarena-key:v1';
// Sealed to the service's existing SETUP_TOKEN. The repository contains only ciphertext.
const BOOTSTRAP_KEY = 'jeYQeXLvzbbbmZpa:XOWp1wC4OfzANW5McLJPTw:wtaRTks1XsSn_04OQkxyJmswqrylZlhDio6BIP2gum0zF03p';
export const COARENA_WRITER = 'claude-sonnet-5-5';
export const COARENA_REVIEWER = 'gemini-4-argon';
const REVIEW_MODELS = [COARENA_REVIEWER, 'claude-opus-5-5'];
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
  const limits = await readLimits(key);
  return { enabled: true, keyMasked: maskCoarenaKey(key), writer: COARENA_WRITER, reviewer: COARENA_REVIEWER,
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

  constructor(private readonly key: string, private readonly createFallback: () => Promise<AIModelRouter>,
    onAttempt?: (attempt: ModelAttempt) => void, private readonly deadlineAt?: number,
    private readonly checkpoint?: CoarenaCheckpoint) {
    super({ apiKey: key, baseUrl: BASE_URL, models: [COARENA_WRITER, ...REVIEW_MODELS], reviewModels: REVIEW_MODELS,
      timeoutMs: 55_000, retries: 0, maxTokens: 4096, oneModelPerStage: true, deadlineAt }, undefined, undefined,
      attempt => { attempt.provider = 'coarena'; onAttempt?.(attempt); });
    this.quotaKey = createHash('sha256').update(key).digest('hex');
  }

  get canUsePrimary(): boolean { return !this.primaryUnavailable; }

  fallback(): Promise<AIModelRouter> {
    this.fallbackRouter ??= this.createFallback();
    return this.fallbackRouter;
  }

  async generatePrimary<T>(messages: LLMMessage[], validate: (text: string) => T, maxTokens?: number, jsonMode?: boolean, stage?: string) {
    const input: LLMMessage[] = jsonMode ? [...messages, { role: 'user', content: 'Return the result as a JSON object.' }] : messages;
    const tokens = stage === 'technical review implementation' ? Math.max(maxTokens ?? 0, 2400) : maxTokens;
    const checkpointId = createHash('sha256').update(JSON.stringify([COARENA_WRITER, REVIEW_MODELS,
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
      let resetAt: number | undefined;
      try {
        const limits = await readLimits(this.key);
        if (!limits.free || limits.usd_per_day > DAILY_LIMIT) throw new RoutingError([], 'COARENA_FREE_LIMIT_REQUIRED');
        const { left_usd, requests_left, resets_at, held_usd } = limits.today;
        resetAt = resets_at;
        if (requests_left === 0 || left_usd <= 0) {
          if (requests_left !== 0 && held_usd && held_usd > 0) throw capacityPause();
          const nextDay = (Math.floor(Date.now() / 86_400_000) + 1) * 86_400_000;
          throw new CoarenaPause('COARENA_DAILY_LIMIT', new Date(resetAt > Date.now() ? resetAt : nextDay));
        }
        const delay = nextStart - Date.now();
        if (delay > 0) await new Promise<void>(resolve => setTimeout(resolve, delay));
        nextStart = Date.now() + 2100;

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
          const attempt = error.attempts.at(-1);
          pause = attempt && coarenaPauseForAttempt(attempt, resetAt);
          if (!pause && error.lastFailure === 'ARTICLE_TIME_BUDGET_EXCEEDED') pause = capacityPause();
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
      this.primaryUnavailable = true;
      if (error instanceof RoutingError) throw error;
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
  const router = new CoarenaRouter(key, async () => { throw new Error('Discovery unavailable in a Coarena probe'); });
  const messages: LLMMessage[] = [{ role: 'system', content: 'Return only {"ready":true}.' }, { role: 'user', content: 'Confirm readiness.' }];
  const validate = (text: string) => {
    if (JSON.parse(text).ready !== true) throw new OutputValidationError('COARENA_PROBE_INVALID');
    return true;
  };
  const writer = await router.generatePrimary(messages, validate, 128, true, 'coarena probe');
  const reviewer = await router.generatePrimary(messages, validate, 128, true, 'technical review probe');
  await setSystemState(KEY_STATE, encryptText(key));
  return { enabled: true, model: writer.model, reviewModel: reviewer.model,
    usage: [...writer.attempts, ...reviewer.attempts].map(attempt => ({ model: attempt.model, tokens: attempt.usage?.total_tokens })),
    executionHost: process.env.RENDER_INSTANCE_ID ? 'render' : 'local', revision: process.env.RENDER_GIT_COMMIT ?? null };
}
