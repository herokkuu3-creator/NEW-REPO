import { getAttemptContext } from './attemptContext';

interface LogEntry { level: number; time: string; service: string; msg: string; [key: string]: unknown }
export const logRingBuffer: LogEntry[] = [];

function safeValue(value: unknown, key = ''): unknown {
  if (/^(authorization|password|proxyPassword|proxyLogin|cookies|updatedCookies|token|cfClearance|clientKey|apiKey|capzyApiKeys|telegramBotToken)$/i.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map(item => safeValue(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, safeValue(item, name)]));
  if (typeof value === 'string') {
    return value.replace(/(?:https?|socks[45]):\/\/[^\s"'<>]+/g, raw => {
      try {
        const url = new URL(raw);
        if (url.username || url.password) { url.username = 'redacted'; url.password = 'redacted'; }
        url.search = ''; url.hash = '';
        return url.toString();
      } catch { return raw; }
    });
  }
  return value;
}

/** One bounded diagnostic stream for the submitter and its imported helpers. */
export function diagnosticLog(service: string, level: number, fields: Record<string, unknown>, msg: string): void {
  const entry: LogEntry = {
    ...(safeValue(fields) as Record<string, unknown>),
    requestId: getAttemptContext()?.requestId ?? fields.requestId,
    level, time: new Date().toISOString(), service, msg,
  };
  logRingBuffer.push(entry);
  if (logRingBuffer.length > 1000) logRingBuffer.shift();
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}
