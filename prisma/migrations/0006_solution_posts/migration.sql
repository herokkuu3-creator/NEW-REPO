CREATE TABLE "SolutionPost" (
  "id" TEXT NOT NULL, "accountId" TEXT NOT NULL, "problemSlug" TEXT NOT NULL,
  "submissionId" TEXT NOT NULL, "intent" TEXT NOT NULL DEFAULT 'community-solution',
  "context" TEXT NOT NULL, "codeHash" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'PENDING',
  "title" TEXT, "markdown" TEXT, "style" TEXT, "model" TEXT, "reviewModel" TEXT,
  "attempts" TEXT, "contentHash" TEXT, "approvedHash" TEXT, "publishedUrl" TEXT,
  "lastError" TEXT, "retryCount" INTEGER NOT NULL DEFAULT 0, "leaseUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, "publishedAt" TIMESTAMP(3),
  CONSTRAINT "SolutionPost_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SolutionPost_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SolutionPost_status_check" CHECK ("status" IN ('PENDING','CHECKING_ELIGIBILITY','GENERATING','VALIDATING','DRAFT_READY','AWAITING_APPROVAL','PUBLISHING','PUBLISHED','FAILED','SKIPPED','RETRY_PENDING'))
);
CREATE UNIQUE INDEX "SolutionPost_accountId_problemSlug_intent_key" ON "SolutionPost"("accountId", "problemSlug", "intent");
CREATE INDEX "SolutionPost_status_updatedAt_idx" ON "SolutionPost"("status", "updatedAt");
CREATE TABLE "SolutionPostPreference" (
  "accountId" TEXT NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT false,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SolutionPostPreference_pkey" PRIMARY KEY ("accountId"),
  CONSTRAINT "SolutionPostPreference_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
