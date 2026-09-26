import pino from 'pino';
import { config } from './config';

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

export const logger = pino({
  level: config.logLevel,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  base: { service: 'leetcode-daily-agent' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
