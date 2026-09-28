CREATE TYPE "CodeforcesAccountStatus" AS ENUM ('UNKNOWN', 'ACTIVE', 'EXPIRED', 'REJECTED', 'DISABLED');

CREATE TYPE "CodeforcesSourceKind" AS ENUM ('CODEFORCES', 'NON_CODEFORCES', 'UNRESOLVED');

CREATE TABLE "CodeforcesAccount" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "storageState" TEXT NOT NULL,
    "username" TEXT,
    "status" "CodeforcesAccountStatus" NOT NULL DEFAULT 'UNKNOWN',
    "lastCheckedAt" TIMESTAMP(3),
    "lastSubmissionDate" TEXT,
    "lastSubmissionId" TEXT,
    "lastVerdict" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CodeforcesAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CodeforcesProgress" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "nextKey" TEXT,
    "lastCompletedKey" TEXT,
    "lastCompletedAt" TIMESTAMP(3),
    "lastAttemptDate" TEXT,
    "lastAttemptKey" TEXT,
    "lastSubmissionId" TEXT,
    "lastVerdict" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CodeforcesProgress_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CodeforcesSourceAudit" (
    "id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "kind" "CodeforcesSourceKind" NOT NULL,
    "contestId" INTEGER,
    "problemIndex" TEXT,
    "problemUrl" TEXT,
    "externalUrl" TEXT,
    "interactive" BOOLEAN NOT NULL DEFAULT false,
    "gym" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CodeforcesSourceAudit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CodeforcesAccount_label_key" ON "CodeforcesAccount"("label");
CREATE INDEX "CodeforcesAccount_status_idx" ON "CodeforcesAccount"("status");

CREATE UNIQUE INDEX "CodeforcesProgress_accountId_key" ON "CodeforcesProgress"("accountId");
CREATE INDEX "CodeforcesProgress_lastAttemptDate_idx" ON "CodeforcesProgress"("lastAttemptDate");

CREATE UNIQUE INDEX "CodeforcesSourceAudit_path_key" ON "CodeforcesSourceAudit"("path");
CREATE INDEX "CodeforcesSourceAudit_kind_idx" ON "CodeforcesSourceAudit"("kind");
CREATE INDEX "CodeforcesSourceAudit_contestId_idx" ON "CodeforcesSourceAudit"("contestId");

ALTER TABLE "CodeforcesProgress"
ADD CONSTRAINT "CodeforcesProgress_accountId_fkey"
FOREIGN KEY ("accountId") REFERENCES "CodeforcesAccount"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
