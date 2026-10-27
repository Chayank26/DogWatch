/**
 * Transactional outbox handoff. Row locks divide work between dispatchers without
 * an in-memory leader. A crash after enqueue but before commit leaves the receipt
 * pending; retry uses the same stable Redis identity. No execution starts here.
 */
import {
  createLogger,
  protectLogger,
  runTrace,
  withTrace,
} from '@dogwatch/telemetry';
import type { Logger, Fields } from '@dogwatch/telemetry';
import { reserveRunUsage, QuotaExceededError } from './usage.js';
import type { PrismaClient } from './generated/prisma/client.js';

export const dispatchAttemptLimit = 5;
export async function dispatchNext(
  database: PrismaClient,
  enqueue: (data: { runId: string; tenantId: string }) => Promise<unknown>,
  onlyTenantId?: string,
  log: Logger = createLogger('dispatcher'),
): Promise<'idle' | 'published' | 'retry' | 'failed'> {
  log = protectLogger(log);
  let observed: Fields | undefined;
  const started = performance.now();
  try {
    const result = await database.$transaction(
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
        observed = {
          tenantId: row.tenantId,
          runId: row.runId,
          outboxId: row.id,
          attempt: row.attempts + 1,
        };
        const run = await tx.run.findUniqueOrThrow({
          where: { id: row.runId },
          select: { budgetSnapshot: true },
        });
        try {
          await reserveRunUsage(
            tx,
            row.tenantId,
            row.runId,
            run.budgetSnapshot,
          );
        } catch (error) {
          if (!(error instanceof QuotaExceededError)) throw error;
          await tx.outboxEvent.update({
            where: { id: row.id },
            data: {
              nextAttemptAt: new Date(Date.now() + 30000),
              lastErrorCode: error.message,
            },
          });
          return 'retry';
        }
        const attempts = row.attempts + 1;
        try {
          await withTrace(runTrace(row.runId), () =>
            enqueue({ runId: row.runId, tenantId: row.tenantId }),
          );
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
    if (result !== 'idle')
      withTrace(runTrace(observed!.runId!), () =>
        log('outbox.dispatch', result, {
          ...observed,
          durationMs: performance.now() - started,
        }),
      );
    return result;
  } catch (error) {
    if (observed?.runId)
      withTrace(runTrace(observed.runId), () =>
        log('outbox.dispatch', 'failed', {
          ...observed,
          durationMs: performance.now() - started,
        }),
      );
    else
      log('outbox.dispatch', 'failed', {
        durationMs: performance.now() - started,
      });
    throw error;
  }
}
