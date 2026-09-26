-- Multi-account support: one row per cookie-set ("account"). DailyRun rows
-- become per-account ((accountId, date) unique). The pre-multi-account
-- single-account rows are dropped — daily state, not durable history; the
-- pipeline recreates it on the next run.
CREATE TYPE "AccountStatus" AS ENUM ('UNKNOWN', 'ACTIVE', 'EXPIRED', 'DISABLED');

-- CreateTable
CREATE TABLE "Account" (
  "id"            TEXT NOT NULL,
  "label"         TEXT NOT NULL,
  "storageState"  TEXT NOT NULL,
  "username"      TEXT,
  "status"        "AccountStatus" NOT NULL DEFAULT 'UNKNOWN',
  "lastCheckedAt" TIMESTAMP(3),
  "lastRunAt"     TIMESTAMP(3),
  "lastResult"    TEXT,
  "lastError"     TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- DailyRun becomes per-account: legacy rows (single-account era) are
-- removed first so the NOT NULL column can be added to the empty table.
DELETE FROM "DailyRun";
ALTER TABLE "DailyRun" ADD COLUMN "accountId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Account_label_key" ON "Account"("label");
CREATE INDEX "Account_status_idx" ON "Account"("status");
DROP INDEX "DailyRun_date_key";
CREATE UNIQUE INDEX "DailyRun_accountId_date_key" ON "DailyRun"("accountId", "date");
CREATE INDEX "DailyRun_date_idx" ON "DailyRun"("date");

-- AddForeignKey
ALTER TABLE "DailyRun" ADD CONSTRAINT "DailyRun_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
