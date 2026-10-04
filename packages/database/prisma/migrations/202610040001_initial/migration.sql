-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "RunState" AS ENUM ('received', 'queued', 'waiting_for_preview', 'running', 'reporting', 'completed', 'failed', 'cancelled', 'superseded');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Installation" (
    "id" BIGINT NOT NULL,
    "tenantId" UUID NOT NULL,

    CONSTRAINT "Installation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Repository" (
    "id" BIGINT NOT NULL,
    "tenantId" UUID NOT NULL,
    "installationId" BIGINT NOT NULL,
    "fullName" TEXT NOT NULL,

    CONSTRAINT "Repository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Run" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "repositoryId" BIGINT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "pullRequestNumber" INTEGER NOT NULL,
    "headSha" VARCHAR(40) NOT NULL,
    "state" "RunState" NOT NULL DEFAULT 'received',
    "policySnapshot" JSONB NOT NULL,
    "budgetSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'run.requested',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Installation_tenantId_id_key" ON "Installation"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Repository_tenantId_installationId_idx" ON "Repository"("tenantId", "installationId");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_tenantId_id_key" ON "Repository"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Run_deliveryId_key" ON "Run"("deliveryId");

-- CreateIndex
CREATE INDEX "Run_tenantId_repositoryId_createdAt_idx" ON "Run"("tenantId", "repositoryId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Run_tenantId_id_key" ON "Run"("tenantId", "id");

-- CreateIndex
CREATE INDEX "OutboxEvent_publishedAt_createdAt_idx" ON "OutboxEvent"("publishedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_runId_kind_key" ON "OutboxEvent"("runId", "kind");

-- AddForeignKey
ALTER TABLE "Installation" ADD CONSTRAINT "Installation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_tenantId_installationId_fkey" FOREIGN KEY ("tenantId", "installationId") REFERENCES "Installation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_tenantId_repositoryId_fkey" FOREIGN KEY ("tenantId", "repositoryId") REFERENCES "Repository"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_tenantId_runId_fkey" FOREIGN KEY ("tenantId", "runId") REFERENCES "Run"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Prisma declares column types and relationships; these checks add semantic bounds.
-- GitHub numeric IDs and PR numbers must be positive, never synthetic sentinel zero.
ALTER TABLE "Installation" ADD CONSTRAINT "Installation_positive_id" CHECK ("id" > 0);
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_positive_id" CHECK ("id" > 0);
ALTER TABLE "Run" ADD CONSTRAINT "Run_positive_pr" CHECK ("pullRequestNumber" > 0);
-- A moving branch name cannot serve as immutable evidence of the tested revision.
ALTER TABLE "Run" ADD CONSTRAINT "Run_head_sha" CHECK ("headSha" ~ '^[a-fA-F0-9]{40}$');
-- Domain validation will enforce contents; the database requires object snapshots.
ALTER TABLE "Run" ADD CONSTRAINT "Run_policy_object" CHECK (jsonb_typeof("policySnapshot") = 'object');
ALTER TABLE "Run" ADD CONSTRAINT "Run_budget_object" CHECK (jsonb_typeof("budgetSnapshot") = 'object');
