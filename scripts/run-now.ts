/**
 * Manual one-shot run (local debugging / smoke test on the worker):
 *
 *   npm run run:now
 *
 * Executes the full multi-account daily pipeline immediately, prints the
 * per-account report, then exits 0 when every account ended solved (or
 * skipped = already done today) and 1 when anything failed or a cookie was
 * expired. Does NOT start the scheduler or the API.
 */
import { executeDailyRun } from '../src/scheduler/dailyWorker';
import { connectDatabase, disconnectDatabase } from '../src/database/prisma';
import { logger } from '../src/logger';

async function main(): Promise<void> {
  await connectDatabase();
  const report = await executeDailyRun('manual-cli');
  logger.info(
    {
      summary: `${report.totals.accounts} account(s)`,
      totals: report.totals,
      accounts: report.accounts,
    },
    'manual run finished',
  );
  await disconnectDatabase();
  const ok = report.totals.accounts > 0 && report.totals.failed === 0 && report.totals.expired === 0;
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
