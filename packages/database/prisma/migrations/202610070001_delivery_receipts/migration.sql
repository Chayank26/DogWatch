-- Atomic additive migration: keep existing runs and outbox history intact.
BEGIN;
-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "deliveryId" TEXT NOT NULL,
    "payloadSha256" VARCHAR(64) NOT NULL,
    "eventName" TEXT NOT NULL,
    "tenantId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("deliveryId")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_payloadSha256_key" ON "WebhookDelivery"("payloadSha256");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_runId_key" ON "WebhookDelivery"("runId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_tenantId_createdAt_idx" ON "WebhookDelivery"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_tenantId_runId_key" ON "WebhookDelivery"("tenantId", "runId");

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_tenantId_runId_fkey" FOREIGN KEY ("tenantId", "runId") REFERENCES "Run"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Fingerprints contain only lower-case hexadecimal SHA-256 digests.
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_digest" CHECK ("payloadSha256" ~ '^[a-f0-9]{64}$');
COMMIT;
