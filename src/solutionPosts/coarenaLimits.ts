import { ModelAttempt, RoutingError } from './router';

export const COARENA_PAUSE_CODES = ['COARENA_RATE_LIMIT', 'COARENA_DAILY_LIMIT', 'COARENA_CAPACITY'] as const;
type PauseCode = typeof COARENA_PAUSE_CODES[number];
export function isCoarenaPauseCode(code: string | null | undefined): boolean {
  return COARENA_PAUSE_CODES.some(value => value === code);
}

export function isCoarenaPaused(post: { status: string; lastError?: string | null }): boolean {
  return post.status === 'RETRY_PENDING' && isCoarenaPauseCode(post.lastError);
}

export function retryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return;
  const delay = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  if (Number.isFinite(delay)) return Math.max(0, delay);
}

export class CoarenaPause extends RoutingError {
  constructor(public readonly code: PauseCode, public readonly retryAt: Date, attempts: ModelAttempt[] = []) {
    super(attempts, code);
  }
  withAttempts(attempts: ModelAttempt[]): CoarenaPause {
    return new CoarenaPause(this.code, this.retryAt, [...attempts, ...this.attempts]);
  }
}

const capacityCodes = new Set(['quota_unavailable', 'upstream_capacity', 'server_busy', 'server_draining']);

export function isCoarenaSharedLimit(attempt: ModelAttempt): boolean {
  return attempt.httpStatus === 429 ||
    !!attempt.providerCode && attempt.providerCode !== 'upstream_capacity' && capacityCodes.has(attempt.providerCode);
}

export function coarenaPauseForAttempt(attempt: ModelAttempt, resetAt?: number, now = Date.now()): CoarenaPause | undefined {
  const code = attempt.providerCode;
  const rateLimited = attempt.httpStatus === 429;
  const overloaded = (code && capacityCodes.has(code)) || (!code && attempt.httpStatus === 503);
  if (!rateLimited && !overloaded) return;
  const daily = rateLimited && (code === 'insufficient_quota' || attempt.retryAllowed === false);
  const nextDay = (Math.floor(now / 86_400_000) + 1) * 86_400_000;
  const delay = Math.max(1_000, attempt.retryAfterMs ?? (code === 'concurrency_limit_exceeded' ? 5_000 : 60_000));
  const retryAt = daily ? Math.max(now + delay, resetAt && resetAt > now ? resetAt : nextDay) : now + delay;
  return new CoarenaPause(daily ? 'COARENA_DAILY_LIMIT' : overloaded ? 'COARENA_CAPACITY' : 'COARENA_RATE_LIMIT',
    new Date(retryAt), [attempt]);
}
