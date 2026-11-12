/**
 * Scrubs sensitive credential patterns (Capzy keys, proxy passwords, Telegram bot tokens,
 * Bearer tokens, and LeetCode session cookies) from arbitrary strings before logging or display.
 */
export function redactSecrets(input: string): string {
  if (!input) return input;
  return input
    .replace(/\bcapzy_[A-Za-z0-9_-]{8,}\b/gi, 'capzy_[REDACTED]')
    .replace(/\bbot\d+:[A-Za-z0-9_-]{20,}/g, 'bot[REDACTED]')
    .replace(/((?:https?|socks[45]h?):\/\/[^:\s/@"'<>]+:)[^@\s"'<>]+(@)/gi, '$1****$2')
    .replace(/\b(LEETCODE_SESSION|csrftoken)=([^;\s"'<>]+)/gi, '$1=[REDACTED]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, '$1[REDACTED]');
}
