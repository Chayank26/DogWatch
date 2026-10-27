CREATE TABLE "TenantQuota" (
 "tenantId" UUID PRIMARY KEY REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "maxConcurrent" INTEGER NOT NULL DEFAULT 2 CHECK ("maxConcurrent" BETWEEN 1 AND 100),
 "maxDailyRuns" INTEGER NOT NULL DEFAULT 100 CHECK ("maxDailyRuns" BETWEEN 1 AND 10000),
 "maxDailyModelCostCents" INTEGER NOT NULL DEFAULT 10000 CHECK ("maxDailyModelCostCents" BETWEEN 1 AND 100000000)
);
CREATE TABLE "UsageReservation" (
 "runId" UUID PRIMARY KEY, "tenantId" UUID NOT NULL,
 "reservedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "budget" JSONB NOT NULL, "reservedModelCostCents" INTEGER NOT NULL CHECK ("reservedModelCostCents" >= 0),
 "actual" JSONB, "actualModelCostCents" INTEGER CHECK ("actualModelCostCents" >= 0),
 "settledAt" TIMESTAMPTZ(3),
 CONSTRAINT "UsageReservation_tenantId_runId_fkey" FOREIGN KEY ("tenantId", "runId") REFERENCES "Run"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "UsageReservation_tenantId_runId_key" ON "UsageReservation"("tenantId", "runId");
CREATE INDEX "UsageReservation_tenantId_reservedAt_idx" ON "UsageReservation"("tenantId", "reservedAt");
CREATE INDEX "UsageReservation_tenantId_settledAt_idx" ON "UsageReservation"("tenantId", "settledAt");
