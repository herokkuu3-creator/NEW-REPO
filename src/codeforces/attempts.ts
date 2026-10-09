export const CODEFORCES_ATTEMPT_MS = 8 * 60_000;
export const CODEFORCES_MAX_ATTEMPTS = 3;

export type AttemptState = 'attempt' | 'retry' | 'queued' | 'running' | 'verdict';
export type AttemptProgress = (state: AttemptState, attempt: number) => Promise<void> | void;

/** A site verification requirement is not a transient delivery failure. */
export function isCodeforcesVerificationRequired(error: string | null | undefined): boolean {
  return /turnstile|captcha|cloudflare|anti[- ]bot|verification|challenge|\b403\b|just a moment/i.test(error ?? '');
}

/** Retry only an explicit confirmation that no submission was sent. */
export async function runSubmissionAttempts<T extends {
  ok: boolean; safeToRetry?: boolean; submissionId?: string | null; verdict?: string | null; error?: string | null;
}>(submit: (deadline: number, attempt: number) => Promise<T>, progress?: AttemptProgress): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    await progress?.('attempt', attempt);
    const result = await submit(Date.now() + CODEFORCES_ATTEMPT_MS, attempt);
    if (result.ok || !result.safeToRetry || result.submissionId || result.verdict ||
      isCodeforcesVerificationRequired(result.error) || attempt >= CODEFORCES_MAX_ATTEMPTS) return result;
    await progress?.('retry', attempt + 1);
  }
}

/** Reads may time out without leaving a background submission running. */
export async function readBeforeDeadline<T>(read: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Codeforces attempt reached its eight-minute limit')), Math.max(1, deadline - Date.now()));
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
