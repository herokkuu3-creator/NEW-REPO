import { config } from './config';
import { logger } from './logger';
import { connectDatabase, disconnectDatabase } from './database/prisma';
import { isRunInProgress, startScheduler, triggerRun } from './scheduler/dailyWorker';
import { startHealthServer } from './api/health';

/**
 * Entry point. The process is a long-lived Background Worker:
 *   connect DB → start health API → arm the cron → idle forever.
 * Restart-safe: all durable state lives in PostgreSQL and /var/data.
 */

async function main(): Promise<void> {
  logger.info(
    {
      schedule: `${config.schedule.hour}:${String(config.schedule.minute).padStart(2, '0')}`,
      timezone: config.schedule.timezone,
      autoSubmit: config.submission.autoSubmit,
      solutionSource: config.solution.source,
      llmProvider: config.llm.provider,
      llmModel: config.llm.model,
      language: config.llm.language,
      headless: config.browser.headless,
    },
    'leetcode-daily-agent starting',
  );

  // The LLM key is only required when the LLM solution source is selected.
  // With the default walkccc source, no LLM key is needed at all.
  if (config.solution.source === 'llm' && !config.llm.apiKey) {
    logger.warn(
      { provider: config.llm.provider },
      'SOLUTION_SOURCE=llm but no LLM API key configured (LLM_API_KEY / GEMINI_API_KEY) — runs will fail with LLM_ERROR until it is set',
    );
  }

  await connectDatabase();

  const app = await startHealthServer({ triggerRun, isRunInProgress });
  const stopScheduler = startScheduler();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    stopScheduler();
    await app.close().catch(() => undefined);
    await disconnectDatabase().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.message : String(err) }, 'fatal startup error');
  process.exit(1);
});
