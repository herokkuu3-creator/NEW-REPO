import { logger } from '../logger';

// Firecrawl Free permits two Agent starts/minute. All code, article and
// diagnostic routers in this process share this queue, including different keys
// (Firecrawl applies rate limits per team). Polling has a separate allowance.
export const FIRECRAWL_START_INTERVAL_MS = 31000;
export const FIRECRAWL_QUEUE_WAIT_MS = 600000;
export const FIRECRAWL_JOB_TIMEOUT_MS = 180000;
export const FIRECRAWL_STAGE_BUDGET_MS = FIRECRAWL_QUEUE_WAIT_MS + FIRECRAWL_JOB_TIMEOUT_MS + 30000;

export class FirecrawlRateGate {
  private tail: Promise<void> = Promise.resolve();
  private nextStartAt = 0;
  private blockedUntil = 0;
  constructor(private readonly intervalMs = FIRECRAWL_START_INTERVAL_MS,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {}

  defer(delayMs: number): void { this.blockedUntil = Math.max(this.blockedUntil, this.now() + delayMs); }

  async acquire(deadline: number, stage: string): Promise<void> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      for (;;) {
        const now = this.now();
        const delay = Math.max(0, this.nextStartAt - now, this.blockedUntil - now);
        if (now + delay >= deadline) throw new Error('FIRECRAWL_QUEUE_TIMEOUT');
        if (!delay) break;
        logger.info({ stage, waitMs: delay }, 'Firecrawl Agent start queued for rate limit');
        await this.sleep(delay);
      }
      this.nextStartAt = this.now() + this.intervalMs;
    } finally { release(); }
  }
}

export const firecrawlRateGate = new FirecrawlRateGate();
