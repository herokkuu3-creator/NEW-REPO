/**
 * Manual one-shot run (local debugging / smoke test on the worker):
 *
 *   npm run run:now
 *
 * Executes the full daily pipeline immediately, then exits with 0 on
 * SUCCESS and 1 otherwise. Does NOT start the scheduler or the API.
 */
import { executeDailyRun } from '../src/scheduler/dailyWorker';
import { connectDatabase, disconnectDatabase } from '../src/database/prisma';
import { logger } from '../src/logger';

async function main(): Promise<void> {
  await connectDatabase();
  const state = await executeDailyRun('manual-cli');
  logger.info({ state }, 'manual run finished');
  await disconnectDatabase();
  process.exit(state === 'SUCCESS' ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
