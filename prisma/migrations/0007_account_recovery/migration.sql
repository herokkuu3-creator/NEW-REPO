-- CreateEnum
CREATE TYPE "RecoveryStatus" AS ENUM ('RECOVERY_PENDING', 'AWAITING_VERIFICATION', 'VERIFYING', 'RECOVERY_FAILED', 'RECOVERED', 'CANCELLED');

-- CreateTable
CREATE TABLE "AccountRecovery" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "status" "RecoveryStatus" NOT NULL DEFAULT 'RECOVERY_PENDING',
    "reason" TEXT NOT NULL,
    "telegramChatId" TEXT NOT NULL,
    "tokenHash" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "tokenUsedAt" TIMESTAMP(3),
    "lastNotifiedAt" TIMESTAMP(3),
    "nextReminderAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCategory" TEXT,
    "lastError" TEXT,
    "recoveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountRecovery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountRecovery_tokenHash_key" ON "AccountRecovery"("tokenHash");

-- CreateIndex
CREATE INDEX "AccountRecovery_status_nextReminderAt_idx" ON "AccountRecovery"("status", "nextReminderAt");

-- CreateIndex
CREATE INDEX "AccountRecovery_accountId_idx" ON "AccountRecovery"("accountId");

-- AddForeignKey
ALTER TABLE "AccountRecovery" ADD CONSTRAINT "AccountRecovery_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Strict per-account isolation: at most ONE open recovery state machine per account.
-- Prisma cannot express partial unique indexes in schema.prisma, so it lives only here.
CREATE UNIQUE INDEX "AccountRecovery_one_open_per_account"
  ON "AccountRecovery"("accountId")
  WHERE "status" IN ('RECOVERY_PENDING', 'AWAITING_VERIFICATION', 'VERIFYING', 'RECOVERY_FAILED');
