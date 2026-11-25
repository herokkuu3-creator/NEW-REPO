import type OpenAI from 'openai';
import type { LLMMessage } from '../ai/provider';
import { logger } from '../logger';
import { redactSecrets } from '../security/redact';
import { AIModelRouter, ModelAttempt, parseJSON, RoutingError } from './router';

export const DEFAULT_CLOUDFLARE_ACCOUNT_ID = '68c3dd9664c8d0ea78405d66417f9fb0';

export const CLOUDFLARE_WRITERS = [
  '@cf/openai/gpt-oss-120b',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/qwen/qwen2.5-coder-32b-instruct',
  '@cf/openai/gpt-oss-20b',
  '@cf/qwen/qwen3.8-27b',
  '@cf/google/gemma-4-26b-a4b-it',
] as const;

export const CLOUDFLARE_REVIEWERS = [
  '@cf/openai/gpt-oss-20b',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/qwen/qwen3.8-27b',
  '@cf/openai/gpt-oss-120b',
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/qwen/qwen2.5-coder-32b-instruct',
] as const;

export interface CloudflareAiConfig {
  accountId: string;
  apiToken: string;
  baseUrl: string;
  source: 'environment';
}

export function cloudflareAiBaseUrl(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
}

export function maskCloudflareToken(token: string): string {
  return `cfut_…${token.slice(-4)}`;
}

export function maskCloudflareAccountId(accountId: string): string {
  return `${accountId.slice(0, 6)}…${accountId.slice(-4)}`;
}

export function loadCloudflareAiConfig(): CloudflareAiConfig | null {
  if (process.env.CLOUDFLARE_AI_DISABLED === 'true') return null;
  const envToken = process.env.CLOUDFLARE_AI_API_TOKEN?.trim();
  if (!envToken) return null;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || DEFAULT_CLOUDFLARE_ACCOUNT_ID;
  return {
    accountId,
    apiToken: envToken,
    baseUrl: cloudflareAiBaseUrl(accountId),
    source: 'environment',
  };
}

export class CloudflareAiRouter extends AIModelRouter {
  private fallbackRouter?: Promise<AIModelRouter>;
  private primaryUnavailable = false;
  private lastPrimaryFailure?: string;

  constructor(
    cfConfig: CloudflareAiConfig,
    private readonly createFallback?: (reason?: string) => Promise<AIModelRouter>,
    onAttempt?: (attempt: ModelAttempt) => void,
    deadlineAt?: number,
    client?: OpenAI,
  ) {
    super(
      {
        apiKey: cfConfig.apiToken,
        baseUrl: cfConfig.baseUrl,
        models: [...new Set([...CLOUDFLARE_WRITERS, ...CLOUDFLARE_REVIEWERS])],
        writingModels: CLOUDFLARE_WRITERS,
        reviewModels: CLOUDFLARE_REVIEWERS,
        timeoutMs: 60_000,
        retries: 0,
        maxTokens: 4096,
        deadlineAt,
      },
      client,
      undefined,
      attempt => {
        attempt.provider = 'cloudflare';
        onAttempt?.(attempt);
      },
    );
  }

  get canUsePrimary(): boolean {
    return !this.primaryUnavailable;
  }

  fallback(): Promise<AIModelRouter> {
    if (!this.createFallback) {
      return Promise.reject(new RoutingError([], this.lastPrimaryFailure ?? 'CLOUDFLARE_UNAVAILABLE'));
    }
    this.fallbackRouter ??= this.createFallback(this.lastPrimaryFailure);
    return this.fallbackRouter;
  }

  override async generate<T>(
    messages: LLMMessage[],
    validate: (text: string) => T,
    maxTokens?: number,
    jsonMode?: boolean,
    stage?: string,
  ) {
    let primaryAttempts: ModelAttempt[] = [];
    if (this.canUsePrimary) {
      try {
        return await super.generate(messages, validate, maxTokens, jsonMode, stage);
      } catch (error) {
        if (!(error instanceof RoutingError)) throw error;
        primaryAttempts = error.attempts;
        const last = error.attempts.at(-1);
        this.lastPrimaryFailure = error.lastFailure ?? last?.outcome ?? 'CLOUDFLARE_UNAVAILABLE';
        this.primaryUnavailable = [401, 402].includes(last?.httpStatus ?? 0);
        logger.warn(
          {
            outcome: this.lastPrimaryFailure,
            httpStatus: last?.httpStatus,
            model: last?.model,
            primaryUnavailable: this.primaryUnavailable,
          },
          'Cloudflare Workers AI inference failed',
        );
        if (!this.createFallback) throw error;
      }
    }
    if (!this.createFallback) {
      throw new RoutingError(primaryAttempts, this.lastPrimaryFailure ?? 'CLOUDFLARE_UNAVAILABLE');
    }
    try {
      const result = await (await this.fallback()).generate(messages, validate, maxTokens, jsonMode, stage);
      return { ...result, attempts: [...primaryAttempts, ...result.attempts] };
    } catch (fallbackError) {
      if (fallbackError instanceof RoutingError) {
        if (fallbackError.lastFailure === 'ARTICLE_TIME_BUDGET_EXCEEDED') {
          throw new RoutingError([...primaryAttempts, ...fallbackError.attempts], 'ARTICLE_TIME_BUDGET_EXCEEDED');
        }
        throw new RoutingError([...primaryAttempts, ...fallbackError.attempts], fallbackError.lastFailure);
      }
      throw fallbackError;
    }
  }
}

export function cloudflareAiStatus() {
  if (process.env.CLOUDFLARE_AI_DISABLED === 'true') {
    return { enabled: false, reason: 'CLOUDFLARE_AI_DISABLED' as const };
  }
  const cfg = loadCloudflareAiConfig();
  if (!cfg) {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || DEFAULT_CLOUDFLARE_ACCOUNT_ID;
    return {
      enabled: false,
      reason: 'CLOUDFLARE_TOKEN_MISSING' as const,
      accountIdMasked: maskCloudflareAccountId(accountId),
    };
  }
  return {
    enabled: true,
    source: cfg.source,
    accountIdMasked: maskCloudflareAccountId(cfg.accountId),
    tokenMasked: maskCloudflareToken(cfg.apiToken),
    baseUrl: cfg.baseUrl,
    writer: CLOUDFLARE_WRITERS[0],
    reviewer: CLOUDFLARE_REVIEWERS[0],
    writers: [...CLOUDFLARE_WRITERS],
    reviewers: [...CLOUDFLARE_REVIEWERS],
  };
}

export interface CloudflareModelProbeResult {
  ok: boolean;
  model: string;
  status: number;
  elapsedMs: number;
  usage?: Record<string, unknown>;
  error?: string;
}

export async function probeCloudflareAi(options?: {
  accountId?: string;
  apiToken?: string;
  model?: string;
}) {
  const envCfg = loadCloudflareAiConfig();
  const accountId = options?.accountId?.trim() || envCfg?.accountId || process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || DEFAULT_CLOUDFLARE_ACCOUNT_ID;
  const apiToken = options?.apiToken?.trim() || envCfg?.apiToken || '';
  const baseUrl = cloudflareAiBaseUrl(accountId);
  const executionHost = process.env.RENDER_INSTANCE_ID ? 'render' : 'local';
  const revision = process.env.RENDER_GIT_COMMIT ?? null;
  if (!apiToken) {
    return {
      ok: false,
      executionHost,
      revision,
      error: 'CLOUDFLARE_TOKEN_MISSING',
      accountIdMasked: maskCloudflareAccountId(accountId),
    };
  }
  const safeText = (value: string) =>
    redactSecrets(
      value
        .split(apiToken).join('cfut_[REDACTED]')
        .split(accountId).join(maskCloudflareAccountId(accountId)),
    ).slice(0, 300);

  let catalogStatus = 0;
  let catalogCount = 0;
  try {
    const searchUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/models/search?task=Text%20Generation&per_page=100`;
    const catalogRes = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${apiToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    catalogStatus = catalogRes.status;
    if (catalogRes.ok) {
      const data = await catalogRes.json().catch(() => null) as { result?: unknown[] } | null;
      if (Array.isArray(data?.result)) catalogCount = data.result.length;
    }
  } catch {
    catalogStatus = 0;
  }

  const probeModel = async (model: string): Promise<CloudflareModelProbeResult> => {
    const started = Date.now();
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'Return only {"ready":true}.' },
            { role: 'user', content: 'Confirm readiness.' },
          ],
          max_tokens: 4096,
          response_format: { type: 'json_object' },
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      const elapsedMs = Date.now() - started;
      const bodyText = await res.text().catch(() => '');
      if (!res.ok) {
        return { ok: false, model, status: res.status, elapsedMs, error: safeText(bodyText || `HTTP_${res.status}`) };
      }
      const data = JSON.parse(bodyText) as {
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: Record<string, unknown>;
      };
      const rawContent = data.choices?.[0]?.message?.content;
      const content = typeof rawContent === 'string'
        ? rawContent
        : rawContent && typeof rawContent === 'object'
          ? JSON.stringify(rawContent)
          : '';
      const parsed = content ? (parseJSON(content) as { ready?: unknown } | null) : null;
      const ok = parsed?.ready === true;
      return {
        ok,
        model,
        status: res.status,
        elapsedMs,
        ...(data.usage ? { usage: data.usage } : {}),
        ...(ok ? {} : { error: 'CLOUDFLARE_PROBE_INVALID' }),
      };
    } catch (error) {
      return {
        ok: false,
        model,
        status: 0,
        elapsedMs: Date.now() - started,
        error: safeText(error instanceof Error ? error.message : String(error)),
      };
    }
  };

  const writer = await probeModel(options?.model ?? CLOUDFLARE_WRITERS[0]);
  const reviewer = options?.model ? undefined : await probeModel(CLOUDFLARE_REVIEWERS[0]);
  return {
    ok: writer.ok && (!reviewer || reviewer.ok),
    executionHost,
    revision,
    source: options?.apiToken?.trim() ? 'override' : 'environment',
    accountIdMasked: maskCloudflareAccountId(accountId),
    tokenMasked: maskCloudflareToken(apiToken),
    catalogStatus,
    catalogCount,
    writer,
    ...(reviewer ? { reviewer } : {}),
  };
}
