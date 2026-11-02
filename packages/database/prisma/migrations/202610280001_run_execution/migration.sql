CREATE TABLE "RunExecution" (
  "runId" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "token" UUID NOT NULL,
  "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "deadlineAt" TIMESTAMPTZ(3) NOT NULL,
  "finishedAt" TIMESTAMPTZ(3),
  "result" JSONB,
  CONSTRAINT "RunExecution_tenant_run_fkey" FOREIGN KEY ("tenantId", "runId") REFERENCES "Run"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "RunExecution_expiry_idx" ON "RunExecution"("finishedAt", "expiresAt");
CREATE UNIQUE INDEX "RunExecution_tenantId_runId_key" ON "RunExecution"("tenantId", "runId");
