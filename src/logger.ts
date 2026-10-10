import pino from 'pino';
import { config } from './config';
import { isoLocal } from './time';
import { Writable } from 'node:stream';

/**
 * Patterns whose values must never appear in logs. The redaction is
 * path-based (pino `redact`) plus a runtime serializer guard for cookies.
 */
const REDACT_PATHS = [
  'password',
  'cookie',
  'cookies',
  'headers.cookie',
  'headers.authorization',
  'headers["x-csrftoken"]',
  'config.llm.apiKey',
  'config.telegram.botToken',
  'config.api.setupToken',
  'env.LLM_API_KEY',
  'env.TELEGRAM_BOT_TOKEN',
  'env.SETUP_TOKEN',
  '*.cookie',
  '*.cookies',
  '*.apiKey',
  '*.botToken',
  '*.token',
  '*.password',
  '*.secret',
];

export interface LogEntry {
  time?: string;
  level?: number | string;
  msg?: string;
  [key: string]: unknown;
}

export const logRingBuffer: LogEntry[] = [];
const RING_BUFFER_MAX = 1000;

const ringStream = new Writable({
  write(chunk: Buffer, encoding, callback) {
    process.stdout.write(chunk);
    try {
      const line = chunk.toString('utf8');
      const obj = JSON.parse(line);
      logRingBuffer.push(obj);
      if (logRingBuffer.length > RING_BUFFER_MAX) {
        logRingBuffer.shift();
      }
    } catch {}
    callback();
  },
});

export const logger = pino(
  {
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    base: { service: 'leetcode-daily-agent' },
    // Local (TIMEZONE, default IST) ISO time with offset, e.g. 2026-09-27T13:05:10.123+05:30
    timestamp: () => `,"time":"${isoLocal()}"`,
  },
  ringStream,
);

export type Logger = typeof logger;
