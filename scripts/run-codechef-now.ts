import { runCodeChefNow } from '../src/codechef/worker';
import { connectDatabase, disconnectDatabase } from '../src/database/prisma';
import { logger } from '../src/logger';

async function main(): Promise<void> {
  await connectDatabase();
  logger.info('Starting manual CodeChef run...');
  await runCodeChefNow();
  logger.info('Manual CodeChef run finished.');
  await disconnectDatabase();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
