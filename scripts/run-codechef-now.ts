import { runCodeChefNow } from '../src/codechef/worker';
import { connectDatabase, disconnectDatabase } from '../src/database/prisma';
import { logger } from '../src/logger';

async function main(): Promise<void> {
  await connectDatabase();
  try {
    logger.info('Starting manual CodeChef run...');
    await runCodeChefNow('manual');
    logger.info('Manual CodeChef run finished.');
  } finally { await disconnectDatabase(); }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
