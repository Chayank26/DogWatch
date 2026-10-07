-- Durable dispatcher retries; existing pending outbox records become due now.
BEGIN;
-- AlterTable
ALTER TABLE "OutboxEvent" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "failedAt" TIMESTAMPTZ(3),
ADD COLUMN     "lastErrorCode" TEXT,
ADD COLUMN     "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Attempts cannot be negative, and stored error codes contain no raw exceptions.
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_nonnegative_attempts" CHECK ("attempts" >= 0);
COMMIT;
