-- Add setup evidence without rewriting existing immutable run snapshots.
BEGIN;
ALTER TABLE "Run" ADD COLUMN "previewSnapshot" JSONB,
  ADD COLUMN "previewReadyAt" TIMESTAMPTZ(3),
  ADD COLUMN "setupFailureCode" TEXT;
COMMIT;
