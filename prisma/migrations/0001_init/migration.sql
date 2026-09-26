-- CreateEnum
CREATE TYPE "RunState" AS ENUM (
  'PENDING',
  'AUTHENTICATION_REQUIRED',
  'CLOUDFLARE_VERIFICATION_REQUIRED',
  'DAILY_PROBLEM_NOT_FOUND',
  'PROBLEM_PARSE_FAILED',
  'LLM_ERROR',
  'SOLUTION_VALIDATION_FAILED',
  'SUBMISSION_ERROR',
  'SUBMISSION_REJECTED',
  'SUCCESS'
);

-- CreateTable
CREATE TABLE "DailyRun" (
  "id"               TEXT NOT NULL,
  "date"             TEXT NOT NULL,
  "problemSlug"      TEXT NOT NULL,
  "title"            TEXT NOT NULL,
  "difficulty"       TEXT NOT NULL,
  "language"         TEXT NOT NULL,
  "solution"         TEXT,
  "submissionId"     TEXT,
  "submissionStatus" TEXT,
  "runtime"          TEXT,
  "memory"           TEXT,
  "state"            "RunState" NOT NULL,
  "error"            TEXT,
  "attempts"         INTEGER NOT NULL DEFAULT 0,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DailyRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemState" (
  "key"       TEXT NOT NULL,
  "value"     TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SystemState_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "DailyRun_date_key" ON "DailyRun"("date");
CREATE INDEX "DailyRun_state_idx" ON "DailyRun"("state");
CREATE INDEX "DailyRun_createdAt_idx" ON "DailyRun"("createdAt");
