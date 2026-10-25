CREATE TYPE "MembershipRole" AS ENUM ('owner', 'member');
CREATE TABLE "User" (
  "id" UUID NOT NULL, "githubId" BIGINT NOT NULL, "login" TEXT NOT NULL,
  "disabledAt" TIMESTAMPTZ(3), "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "User_githubId_key" ON "User"("githubId");
CREATE TABLE "Membership" (
  "tenantId" UUID NOT NULL, "userId" UUID NOT NULL, "role" "MembershipRole" NOT NULL,
  CONSTRAINT "Membership_pkey" PRIMARY KEY ("tenantId", "userId"),
  CONSTRAINT "Membership_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Membership_userId_idx" ON "Membership"("userId");
CREATE TABLE "LoginSession" (
  "tokenHash" VARCHAR(64) NOT NULL, "userId" UUID NOT NULL, "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "LoginSession_pkey" PRIMARY KEY ("tokenHash"),
  CONSTRAINT "LoginSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "LoginSession_expiresAt_idx" ON "LoginSession"("expiresAt");
CREATE INDEX "LoginSession_userId_idx" ON "LoginSession"("userId");
CREATE TABLE "LoginAttempt" (
  "stateHash" VARCHAR(64) NOT NULL, "browserHash" VARCHAR(64) NOT NULL, "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("stateHash")
);
CREATE INDEX "LoginAttempt_expiresAt_idx" ON "LoginAttempt"("expiresAt");
