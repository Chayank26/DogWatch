-- psql -X -v ON_ERROR_STOP=1 -v tenant_id=UUID -v run_id=UUID -f inspect.sql
-- Use an operator read-only connection. No payloads, credentials or raw errors.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SELECT r."id", r."tenantId", r."state", r."createdAt",
       o."id" AS "outboxId", o."attempts", o."nextAttemptAt",
       o."publishedAt", o."failedAt", o."lastErrorCode",
       u."reservedAt", u."settledAt", u."reservedModelCostCents",
       u."actualModelCostCents"
FROM "Run" r
LEFT JOIN "OutboxEvent" o ON o."runId" = r."id" AND o."tenantId" = r."tenantId"
LEFT JOIN "UsageReservation" u ON u."runId" = r."id" AND u."tenantId" = r."tenantId"
WHERE r."tenantId" = :'tenant_id'::uuid AND r."id" = :'run_id'::uuid;
COMMIT;
