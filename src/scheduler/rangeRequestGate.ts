import { LeetCodeHttpError, leetCodeRequestFailure } from '../leetcode/apiClient';

/** One gate across range accounts. Rate limits slow the shared server, not
 * just one account while its parallel neighbours keep sending requests. */
export class RangeRequestGate {
  private nextRequest = 0;
  private nextSubmit = 0;
  private blockedUntil = 0;
  constructor(private readonly now = Date.now, private readonly requestGap = 1000, private readonly submitGap = 30000) {}
  observe(error: unknown): void {
    const category = leetCodeRequestFailure(error).category;
    if (!['rate-limit', 'challenge', 'access-denied'].includes(category)) return;
    const delay = error instanceof LeetCodeHttpError ? error.retryAfterMs : undefined;
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + Math.max(delay ?? 60000, 1000));
  }
  async wait(submit: boolean, sleep: (ms: number, signal: AbortSignal) => Promise<void>, signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) throw Error('Range request cancelled before sending');
      const now = this.now();
      const next = Math.max(this.nextRequest, this.blockedUntil, submit ? this.nextSubmit : 0);
      if (next > now) { await sleep(Math.min(next - now, 30000), signal); continue; }
      // No await between admission and reservation; concurrent accounts cannot
      // claim the same slot. Recheck newly reported cooldowns after each sleep.
      this.nextRequest = now + this.requestGap;
      if (submit) this.nextSubmit = now + this.submitGap;
      return;
    }
  }
}
