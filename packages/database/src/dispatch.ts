/**
 * Transactional outbox handoff. Row locks divide work between dispatchers without
 * an in-memory leader. A crash after enqueue but before commit leaves the receipt
 * pending; retry uses the same stable Redis identity. No execution starts here.
 */
import type { PrismaClient } from './generated/prisma/client.js';

export const dispatchAttemptLimit = 5;
export async function dispatchNext(
  database: PrismaClient,
  enqueue: (data: { runId: string; tenantId: string }) => Promise<unknown>,
  onlyTenantId?: string,
): Promise<'idle' | 'published' | 'retry' | 'failed'> {
  return database.$transaction(
    async (tx) => {
      // Lock both instruction and run. SKIP LOCKED lets another process handle a
      // different row instead of waiting on the current dispatcher's network call.
      const rows = await tx.$queryRaw<
        { id: string; runId: string; tenantId: string; attempts: number }[]
      >`
      SELECT o."id", o."runId", o."tenantId", o."attempts"
      FROM "OutboxEvent" o JOIN "Run" r ON r."id" = o."runId" AND r."tenantId" = o."tenantId"
      WHERE o."publishedAt" IS NULL AND o."failedAt" IS NULL
        AND o."nextAttemptAt" <= NOW() AND o."kind" = 'run.requested'
        AND (${onlyTenantId ?? null}::uuid IS NULL OR o."tenantId" = ${onlyTenantId ?? null}::uuid)
        AND r."state" = 'received'
      ORDER BY o."createdAt", o."id" LIMIT 1 FOR UPDATE OF o, r SKIP LOCKED
    `;
      const row = rows[0];
      if (!row) return 'idle';
      const attempts = row.attempts + 1;
      try {
        await enqueue({ runId: row.runId, tenantId: row.tenantId });
      } catch (error) {
        const permanent =
          typeof error === 'object' &&
          error !== null &&
          'retryable' in error &&
          error.retryable === false;
        const exhausted = permanent || attempts >= dispatchAttemptLimit;
        // Persist only a fixed error code, not Redis exceptions containing credentials.
        await tx.outboxEvent.update({
          where: { id: row.id },
          data: {
            attempts,
            lastErrorCode: permanent
              ? 'queue_identity_conflict'
              : 'queue_handoff_failed',
            nextAttemptAt: new Date(
              Date.now() + Math.min(60000, 1000 * 2 ** (attempts - 1)),
            ),
            failedAt: exhausted ? new Date() : null,
          },
        });
        if (exhausted)
          await tx.run.update({
            where: { id: row.runId },
            data: { state: 'failed' },
          });
        return exhausted ? 'failed' : 'retry';
      }
      // Queue add succeeded; record handoff and progress in the same DB transaction.
      await tx.outboxEvent.update({
        where: { id: row.id },
        data: { attempts, publishedAt: new Date(), lastErrorCode: null },
      });
      await tx.run.update({
        where: { id: row.runId },
        data: { state: 'queued' },
      });
      return 'published';
    },
    { timeout: 5000, maxWait: 2000 },
  );
}
