/** Trusted supervisor primitives: database-clock ownership, fencing and atomic settlement. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { budgetSchema } from '@dogwatch/contracts';
import { actualUsageSchema } from './usage.js';
import type { PrismaClient } from './generated/prisma/client.js';
const identitySchema = z.strictObject({ tenantId: z.uuid(), runId: z.uuid() });
export type ExecutionIdentity = z.infer<typeof identitySchema>;
export const executionResultSchema = z.strictObject({
  status: z.enum(['completed', 'inconclusive']),
  code: z.string().regex(/^[a-z0-9_]{1,100}$/),
  requests: z.number().int().min(0).max(10000),
  results: z
    .array(
      z.strictObject({
        caseId: z.string().min(1).max(100),
        operationKey: z.string().min(1).max(1200),
        status: z.enum(['passed', 'failed', 'inconclusive', 'skipped']),
        code: z.string().regex(/^[a-z0-9_]{1,100}$/),
        httpStatus: z.number().int().min(100).max(599).optional(),
      }),
    )
    .max(1000),
  coverageGaps: z
    .array(
      z.strictObject({
        code: z.string().regex(/^[a-z0-9_]{1,100}$/),
        operationKey: z.string().max(1200).optional(),
      }),
    )
    .max(1000),
});
export async function claimExecution(
  db: PrismaClient,
  input: ExecutionIdentity,
) {
  const { tenantId, runId } = identitySchema.parse(input);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Run" WHERE id=${runId}::uuid AND "tenantId"=${tenantId}::uuid FOR UPDATE`;
    const run = await tx.run.findFirst({
      where: { id: runId, tenantId, state: 'queued' },
    });
    if (!run || (await tx.runExecution.findUnique({ where: { runId } })))
      return null;
    if (
      !(await tx.outboxEvent.findFirst({
        where: { tenantId, runId, publishedAt: { not: null } },
      })) ||
      !(await tx.usageReservation.findFirst({
        where: { tenantId, runId, settledAt: null },
      }))
    )
      return null;
    const budget = budgetSchema.parse(run.budgetSnapshot);
    const token = randomUUID();
    await tx.$executeRaw`INSERT INTO "RunExecution" ("runId","tenantId",token,"expiresAt","deadlineAt") VALUES
      (${runId}::uuid,${tenantId}::uuid,${token}::uuid,
       clock_timestamp()+LEAST(30,${budget.maxRunSeconds}::int)*interval '1 second',
       clock_timestamp()+${budget.maxRunSeconds}::int*interval '1 second')`;
    await tx.run.update({ where: { id: runId }, data: { state: 'running' } });
    return { run, token, budget };
  });
}
/** Renew only a live, unexpired owner; cancellation and fixed deadline always win. */
export async function renewExecution(
  db: PrismaClient,
  input: ExecutionIdentity,
  tokenInput: string,
) {
  const { tenantId, runId } = identitySchema.parse(input),
    token = z.uuid().parse(tokenInput);
  return (
    (await db.$executeRaw`UPDATE "RunExecution" e SET "expiresAt"=LEAST(e."deadlineAt",clock_timestamp()+interval '30 seconds')
    FROM "Run" r WHERE e."runId"=${runId}::uuid AND e."tenantId"=${tenantId}::uuid AND e.token=${token}::uuid
    AND e."finishedAt" IS NULL AND e."expiresAt">clock_timestamp() AND e."deadlineAt">clock_timestamp()
    AND r.id=e."runId" AND r."tenantId"=e."tenantId" AND r.state='running'`) ===
    1
  );
}
export async function finishExecution(
  db: PrismaClient,
  input: ExecutionIdentity,
  tokenInput: string,
  resultInput: unknown,
  usageInput: unknown,
) {
  const { tenantId, runId } = identitySchema.parse(input),
    token = z.uuid().parse(tokenInput);
  const result = executionResultSchema.parse(resultInput),
    usage = actualUsageSchema.parse(usageInput);
  if (result.requests !== usage.apiRequests)
    throw Error('execution_usage_mismatch');
  if (Buffer.byteLength(JSON.stringify(result)) > 262144)
    throw Error('execution_result_limit');
  return db.$transaction(async (tx) => {
    // Same admission/settlement lock order; releasing usage and terminal state is atomic.
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id=${tenantId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Run" WHERE id=${runId}::uuid AND "tenantId"=${tenantId}::uuid FOR UPDATE`;
    const updated =
      await tx.$executeRaw`UPDATE "RunExecution" e SET "finishedAt"=clock_timestamp(),result=${JSON.stringify(result)}::jsonb
      FROM "Run" r WHERE e."runId"=${runId}::uuid AND e."tenantId"=${tenantId}::uuid AND e.token=${token}::uuid
      AND e."finishedAt" IS NULL AND e."expiresAt">clock_timestamp() AND e."deadlineAt">clock_timestamp()
      AND r.id=e."runId" AND r."tenantId"=e."tenantId" AND r.state='running'`;
    if (updated !== 1) return false;
    const settled = await tx.usageReservation.updateMany({
      where: { tenantId, runId, settledAt: null },
      data: {
        actual: usage,
        actualModelCostCents: usage.modelCostCents,
        settledAt: new Date(),
      },
    });
    if (settled.count !== 1) throw Error('execution_usage_missing');
    await tx.run.update({
      where: { id: runId },
      data: { state: result.status === 'completed' ? 'completed' : 'failed' },
    });
    return true;
  });
}
/** Explicit operator/supervisor reconciliation. Unknown usage stays reserved. */
export async function expireExecution(
  db: PrismaClient,
  input: ExecutionIdentity,
) {
  const { tenantId, runId } = identitySchema.parse(input);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Run" WHERE id=${runId}::uuid AND "tenantId"=${tenantId}::uuid FOR UPDATE`;
    const expired =
      await tx.$executeRaw`UPDATE "RunExecution" e SET "finishedAt"=clock_timestamp()
      WHERE e."runId"=${runId}::uuid AND e."tenantId"=${tenantId}::uuid AND e."finishedAt" IS NULL AND e."expiresAt"<=clock_timestamp()`;
    if (!expired) return false;
    await tx.run.updateMany({
      where: { id: runId, tenantId, state: 'running' },
      data: { state: 'failed', setupFailureCode: 'execution_lease_expired' },
    });
    return true;
  });
}
