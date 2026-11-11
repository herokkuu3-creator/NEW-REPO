import { z } from 'zod';
import type { LLMMessage } from '../ai/provider';
import { getSystemState, setSystemState } from '../database/models';
import { decryptText, encryptText } from '../security/credentialStore';
import { AIModelRouter, ModelAttempt, OutputValidationError, RoutingError } from './router';

const BASE_URL = 'https://coarena.ai/api/v1';
const KEY_STATE = 'solution-post-coarena-key:v1';
export const COARENA_WRITER = 'claude-sonnet-5-5';
export const COARENA_REVIEWER = 'gpt-6-1-sol';
const DAILY_LIMIT = 5;
const limitsSchema = z.object({ data: z.object({ free: z.boolean(), usd_per_day: z.number(), today: z.object({
  used_usd: z.number(), left_usd: z.number(), resets_at: z.number(), requests_left: z.number().nullable(),
}) }) });

export async function loadCoarenaKey(): Promise<string | null> {
  const encrypted = await getSystemState(KEY_STATE);
  return encrypted ? decryptText(encrypted) : null;
}

async function readLimits(key: string) {
  const response = await fetch(`${BASE_URL}/limits`, { headers: { Authorization: `Bearer ${key}` },
    redirect: 'error', signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new RoutingError([], `COARENA_LIMITS_HTTP_${response.status}`);
  return limitsSchema.parse(await response.json()).data;
}

export async function coarenaStatus() {
  const key = await loadCoarenaKey();
  if (!key) return { enabled: false };
  const limits = await readLimits(key);
  return { enabled: true, writer: COARENA_WRITER, reviewer: COARENA_REVIEWER, dailyLimitUsd: limits.usd_per_day, ...limits.today };
}

// Coarena enforces the daily account cap, including costs held by in-flight calls.
// Serialize this process's starts to stay under its request and concurrency limits.
let lane: Promise<unknown> = Promise.resolve();
let nextStart = 0;

export class CoarenaRouter extends AIModelRouter {
  private fallbackRouter?: Promise<AIModelRouter>;
  private primaryUnavailable = false;

  constructor(private readonly key: string, private readonly createFallback: () => Promise<AIModelRouter>,
    onAttempt?: (attempt: ModelAttempt) => void) {
    super({ apiKey: key, baseUrl: BASE_URL, models: [COARENA_WRITER, COARENA_REVIEWER], reviewModels: [COARENA_REVIEWER],
      timeoutMs: 55_000, retries: 0, maxTokens: 4096, oneModelPerStage: true }, undefined, undefined,
      attempt => { attempt.provider = 'coarena'; onAttempt?.(attempt); });
  }

  get canUsePrimary(): boolean { return !this.primaryUnavailable; }

  fallback(): Promise<AIModelRouter> {
    this.primaryUnavailable = true;
    this.fallbackRouter ??= this.createFallback();
    return this.fallbackRouter;
  }

  async generatePrimary<T>(messages: LLMMessage[], validate: (text: string) => T, maxTokens?: number, jsonMode?: boolean, stage?: string) {
    const request = lane.then(async () => {
      const limits = await readLimits(this.key);
      if (!limits.free || limits.usd_per_day > DAILY_LIMIT) throw new RoutingError([], 'COARENA_FREE_LIMIT_REQUIRED');
      if (limits.today.left_usd <= 0 || limits.today.requests_left === 0) throw new RoutingError([], 'COARENA_DAILY_LIMIT');
      const delay = nextStart - Date.now();
      if (delay > 0) await new Promise<void>(resolve => setTimeout(resolve, delay));
      nextStart = Date.now() + 2100;
      return super.generate(messages, validate, maxTokens, jsonMode, stage);
    });
    lane = request.catch(() => undefined);
    try { return await request; }
    catch (error) {
      this.primaryUnavailable = true;
      if (error instanceof RoutingError) throw error;
      throw new RoutingError([], 'COARENA_UNAVAILABLE');
    }
  }

  override async generate<T>(messages: LLMMessage[], validate: (text: string) => T, maxTokens?: number, jsonMode?: boolean, stage?: string) {
    let primaryAttempts: ModelAttempt[] = [];
    if (this.canUsePrimary) {
      try { return await this.generatePrimary(messages, validate, maxTokens, jsonMode, stage); }
      catch (error) {
        if (!(error instanceof RoutingError)) throw error;
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
  const probe = await router.generatePrimary([{ role: 'user', content: 'Return only the JSON object {"ready":true}.' }], text => {
    if (JSON.parse(text).ready !== true) throw new OutputValidationError('COARENA_PROBE_INVALID');
    return true;
  }, 64, true, 'coarena probe');
  await setSystemState(KEY_STATE, encryptText(key));
  return { enabled: true, model: probe.model, usage: probe.attempts.at(-1)?.usage,
    executionHost: process.env.RENDER_INSTANCE_ID ? 'render' : 'local', revision: process.env.RENDER_GIT_COMMIT ?? null };
}
