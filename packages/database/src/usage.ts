import { z } from 'zod';
import { budgetSchema } from '@dogwatch/contracts';
import type { Prisma, PrismaClient } from './generated/prisma/client.js';
export class QuotaExceededError extends Error {
  constructor(
    public readonly reason: 'concurrent' | 'daily_runs' | 'daily_model_cost',
  ) {
    super('quota_' + reason);
  }
}
const limitsSchema = z.object({
  maxConcurrent: z.number().int().min(1).max(100),
  maxDailyRuns: z.number().int().min(1).max(10000),
  maxDailyModelCostCents: z.number().int().min(1).max(100000000),
});
const defaults = {
  maxConcurrent: 2,
  maxDailyRuns: 100,
  maxDailyModelCostCents: 10000,
};
export const actualUsageSchema = z.strictObject({
  browserSeconds: z.number().int().min(0).max(100000000),
  runSeconds: z.number().int().min(0).max(100000000),
  apiRequests: z.number().int().min(0).max(100000000),
  browserSteps: z.number().int().min(0).max(100000000),
  modelCalls: z.number().int().min(0).max(100000000),
  modelTokens: z.number().int().min(0).max(100000000),
  modelCostCents: z.number().int().min(0).max(100000000),
  artifactBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
async function lockTenant(tx: Prisma.TransactionClient, tenantId: string) {
  z.uuid().parse(tenantId);
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM "Tenant" WHERE id = ${tenantId}::uuid FOR UPDATE`;
  if (rows.length !== 1) throw Error('usage_scope');
}
async function totals(tx: Prisma.TransactionClient, tenantId: string) {
  const rows = await tx.$queryRaw<
    { day: string; runs: bigint; pending: bigint; committed: bigint }[]
  >`
    SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
      count(*) FILTER (WHERE "reservedAt" >= date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS runs,
      count(*) FILTER (WHERE "settledAt" IS NULL) AS pending,
      COALESCE(sum(CASE WHEN "settledAt" IS NULL THEN "reservedModelCostCents" ELSE "actualModelCostCents" END)
        FILTER (WHERE "reservedAt" >= date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0)::bigint AS committed
    FROM "UsageReservation" WHERE "tenantId" = ${tenantId}::uuid`;
  return {
    day: rows[0].day,
    acceptedRuns: Number(rows[0].runs),
    pendingReservations: Number(rows[0].pending),
    committedModelCostCents: Number(rows[0].committed),
  };
}
/** Call within the same transaction as run/outbox creation. Never use caller clocks. */
export async function reserveRunUsage(
  tx: Prisma.TransactionClient,
  tenantId: string,
  runId: string,
  budgetInput: unknown,
) {
  await lockTenant(tx, tenantId);
  z.uuid().parse(runId);
  const budget = budgetSchema.parse(budgetInput);
  const existing = await tx.usageReservation.findUnique({ where: { runId } });
  if (existing) {
    if (
      existing.tenantId !== tenantId ||
      JSON.stringify(budgetSchema.parse(existing.budget)) !==
        JSON.stringify(budget)
    )
      throw Error('usage_reservation_conflict');
    return;
  }
  const run = await tx.run.findFirst({
    where: { id: runId, tenantId },
    select: { id: true },
  });
  if (!run) throw Error('usage_scope');
  const limits = limitsSchema.parse(
    (await tx.tenantQuota.findUnique({ where: { tenantId } })) ?? defaults,
  );
  const used = await totals(tx, tenantId);
  if (used.pendingReservations >= limits.maxConcurrent)
    throw new QuotaExceededError('concurrent');
  if (used.acceptedRuns >= limits.maxDailyRuns)
    throw new QuotaExceededError('daily_runs');
  if (
    used.committedModelCostCents + budget.maxModelCostCents >
    limits.maxDailyModelCostCents
  )
    throw new QuotaExceededError('daily_model_cost');
  await tx.usageReservation.create({
    data: {
      tenantId,
      runId,
      budget,
      reservedModelCostCents: budget.maxModelCostCents,
    },
  });
}
/** Trusted supervisor only: persist measured usage, including overruns; never infer zero from state. */
export async function settleRunUsage(
  db: PrismaClient,
  tenantId: string,
  runId: string,
  input: unknown,
) {
  const actual = actualUsageSchema.parse(input);
  z.uuid().parse(runId);
  return db.$transaction(
    async (tx) => {
      await lockTenant(tx, tenantId);
      const record = await tx.usageReservation.findFirst({
        where: { tenantId, runId },
        include: { run: { select: { state: true } } },
      });
      if (!record) throw Error('usage_scope');
      if (
        !['completed', 'failed', 'cancelled', 'superseded'].includes(
          record.run.state,
        )
      )
        throw Error('usage_run_active');
      if (record.settledAt) {
        if (
          JSON.stringify(actualUsageSchema.parse(record.actual)) !==
          JSON.stringify(actual)
        )
          throw Error('usage_settlement_conflict');
        return 'unchanged' as const;
      }
      await tx.usageReservation.update({
        where: { runId },
        data: {
          actual,
          actualModelCostCents: actual.modelCostCents,
          settledAt: new Date(),
        },
      });
      return 'settled' as const;
    },
    { timeout: 5000 },
  );
}
export type UsageSummary = {
  limits: typeof defaults;
  day: string;
  acceptedRuns: number;
  pendingReservations: number;
  committedModelCostCents: number;
  recent: {
    runId: string;
    reservedAt: string;
    settledAt: string | null;
    reservedModelCostCents: number;
    actual: z.infer<typeof actualUsageSchema> | null;
  }[];
};
export interface UsageStore {
  summary(sessionHash: string, tenantId: string): Promise<UsageSummary>;
}
export function createUsageStore(db: PrismaClient): UsageStore {
  return {
    async summary(sessionHash, tenantId) {
      z.string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(sessionHash);
      z.uuid().parse(tenantId);
      return db.$transaction(
        async (tx) => {
          const allowed = await tx.$queryRaw<
            { id: string }[]
          >`SELECT u.id FROM "LoginSession" s JOIN "User" u ON u.id = s."userId" JOIN "Membership" m ON m."userId" = u.id WHERE s."tokenHash" = ${sessionHash} AND s."expiresAt" > clock_timestamp() AND u."disabledAt" IS NULL AND m."tenantId" = ${tenantId}::uuid FOR SHARE OF s, u, m`;
          if (allowed.length !== 1) throw Error('usage_not_found');
          await lockTenant(tx, tenantId);
          const limits = limitsSchema.parse(
            (await tx.tenantQuota.findUnique({ where: { tenantId } })) ??
              defaults,
          );
          const used = await totals(tx, tenantId);
          const records = await tx.usageReservation.findMany({
            where: { tenantId },
            orderBy: [{ reservedAt: 'desc' }, { runId: 'desc' }],
            take: 50,
          });
          return {
            limits,
            ...used,
            recent: records.map((r) => ({
              runId: r.runId,
              reservedAt: r.reservedAt.toISOString(),
              settledAt: r.settledAt?.toISOString() ?? null,
              reservedModelCostCents: r.reservedModelCostCents,
              actual:
                r.actual === null ? null : actualUsageSchema.parse(r.actual),
            })),
          };
        },
        { timeout: 5000 },
      );
    },
  };
}
