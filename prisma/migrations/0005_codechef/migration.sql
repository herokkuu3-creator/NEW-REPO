CREATE TYPE "CodeChefSourceKind" AS ENUM ('CODECHEF', 'UNRESOLVED');
CREATE TYPE "CodeChefAccountStatus" AS ENUM ('UNKNOWN', 'ACTIVE', 'EXPIRED', 'REJECTED', 'DISABLED');
CREATE TABLE "CodeChefAccount" (
    "id" TEXT NOT NULL, "label" TEXT NOT NULL, "storageState" TEXT NOT NULL,
    "username" TEXT, "status" "CodeChefAccountStatus" NOT NULL DEFAULT 'UNKNOWN',
    "lastCheckedAt" TIMESTAMP(3), "lastSubmissionDate" TEXT, "lastSubmissionId" TEXT,
    "lastVerdict" TEXT, "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CodeChefAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CodeChefAccount_label_key" ON "CodeChefAccount"("label");
CREATE INDEX "CodeChefAccount_status_idx" ON "CodeChefAccount"("status");
CREATE TABLE "CodeChefProgress" (
    "accountId" TEXT NOT NULL, "nextKey" TEXT, "lastCompletedKey" TEXT,
    "lastCompletedAt" TIMESTAMP(3), "lastAttemptDate" TEXT, "lastAttemptKey" TEXT,
    "lastSubmissionId" TEXT, "lastVerdict" TEXT, "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CodeChefProgress_pkey" PRIMARY KEY ("accountId")
);
ALTER TABLE "CodeChefProgress" ADD CONSTRAINT "CodeChefProgress_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "CodeChefAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "CodeChefSourceAudit" (
    "path" TEXT NOT NULL, "fileName" TEXT NOT NULL, "language" TEXT NOT NULL,
    "kind" "CodeChefSourceKind" NOT NULL, "problemCode" TEXT, "problemUrl" TEXT, "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CodeChefSourceAudit_pkey" PRIMARY KEY ("path")
);
CREATE INDEX "CodeChefSourceAudit_kind_idx" ON "CodeChefSourceAudit"("kind");
