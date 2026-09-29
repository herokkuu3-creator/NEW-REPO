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

CREATE UNIQUE INDEX "CodeforcesAccount_label_key" ON "CodeforcesAccount"("label");
CREATE INDEX "CodeforcesAccount_status_idx" ON "CodeforcesAccount"("status");

CREATE TABLE "CodeforcesProgress" (
    "accountId" TEXT NOT NULL,
    "nextKey" TEXT,
    "lastCompletedKey" TEXT,
    "lastCompletedAt" TIMESTAMP(3),
    "lastAttemptDate" TEXT,
    "lastAttemptKey" TEXT,
    "lastSubmissionId" TEXT,
    "lastVerdict" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodeforcesProgress_pkey" PRIMARY KEY ("accountId")
);

CREATE TABLE "CodeforcesSourceAudit" (
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
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodeforcesSourceAudit_pkey" PRIMARY KEY ("path")
);

CREATE INDEX "CodeforcesSourceAudit_kind_idx" ON "CodeforcesSourceAudit"("kind");
CREATE INDEX "CodeforcesSourceAudit_contestId_idx" ON "CodeforcesSourceAudit"("contestId");

ALTER TABLE "CodeforcesProgress"
  ADD CONSTRAINT "CodeforcesProgress_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "CodeforcesAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
