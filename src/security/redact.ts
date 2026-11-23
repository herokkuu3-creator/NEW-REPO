/**
 * Scrubs sensitive credential patterns (Capzy keys, proxy passwords, Telegram bot tokens,
 * Bearer tokens, and LeetCode session cookies) from arbitrary strings before logging or display.
 */
export function redactSecrets(input: string): string {
  if (!input) return input;
  return input
    .replace(/\bcapzy_[A-Za-z0-9_-]{8,}\b/gi, 'capzy_[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, 'sk-[REDACTED]')
    .replace(/\bcc_[A-Za-z0-9_-]{12,}/gi, 'cc_[REDACTED]')
    .replace(/\bfc-[A-Za-z0-9_-]{12,}/gi, 'fc_[REDACTED]')
    .replace(/\bcfut_[A-Za-z0-9_-]{12,}/gi, 'cfut_[REDACTED]')
    .replace(/\bbot\d+:[A-Za-z0-9_-]{20,}/g, 'bot[REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/@"'<>]+:)[^@\s"'<>]+(@)/gi, '$1****$2')
    .replace(/(^|[\s=,(["'])(?![a-z][a-z0-9+.-]*:\/\/)([^:\s/@"'<>]+:)[^@/\s"'<>]+(@[a-z0-9.-]+:\d+)/gi, '$1$2****$3')
    .replace(/\b(LEETCODE_SESSION|csrftoken)=([^;\s"'<>]+)/gi, '$1=[REDACTED]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, '$1[REDACTED]');
}
