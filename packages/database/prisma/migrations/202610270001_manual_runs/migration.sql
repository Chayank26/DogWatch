CREATE TABLE "ManualRunSettings" (
 "repositoryId" BIGINT PRIMARY KEY, "tenantId" UUID NOT NULL, "revision" INTEGER NOT NULL,
 "enabled" BOOLEAN NOT NULL, "budget" JSONB NOT NULL,
 CONSTRAINT "ManualRunSettings_tenantId_repositoryId_fkey" FOREIGN KEY ("tenantId", "repositoryId") REFERENCES "Repository"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "RunControlEvent" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "repositoryId" BIGINT NOT NULL,
 "actorId" BIGINT NOT NULL, "kind" TEXT NOT NULL, "revision" INTEGER NOT NULL,
 "sourceRunId" UUID NOT NULL, "resultRunId" UUID,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "RunControlEvent_tenantId_repositoryId_fkey" FOREIGN KEY ("tenantId", "repositoryId") REFERENCES "Repository"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "RunControlEvent_tenantId_repositoryId_createdAt_idx" ON "RunControlEvent"("tenantId", "repositoryId", "createdAt");

CREATE UNIQUE INDEX "ManualRunSettings_tenantId_repositoryId_key" ON "ManualRunSettings"("tenantId", "repositoryId");
