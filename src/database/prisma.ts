import { PrismaClient } from '@prisma/client';
import { logger } from '../logger';

/**
 * Single shared PrismaClient. PostgreSQL is the source of truth for run
 * state — the filesystem (browser profile) is only used for authentication.
 */
export const prisma = new PrismaClient({
  log: [
    { emit: 'event', level: 'warn' },
    { emit: 'event', level: 'error' },
  ],
});

prisma.$on('warn' as never, (e: unknown) => logger.warn({ e }, 'prisma warning'));
prisma.$on('error' as never, (e: unknown) => logger.error({ e }, 'prisma error'));

export async function connectDatabase(): Promise<void> {
  await prisma.$connect();
  logger.info('database connected');
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  logger.info('database disconnected');
}
