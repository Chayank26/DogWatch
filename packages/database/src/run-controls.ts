import { z } from 'zod';
import { budgetSchema, repositoryPolicySchema } from '@dogwatch/contracts';
import type { PrismaClient, Prisma } from './generated/prisma/client.js';
export const controlScopeSchema = z.strictObject({
  sessionHash: z.string().regex(/^[a-f0-9]{64}$/),
  tenantId: z.uuid(),
  runId: z.uuid(),
});
export const manualSettingsSchema = z.strictObject({
  expectedRevision: z.number().int().min(0).max(1000000),
  enabled: z.boolean(),
  budget: budgetSchema,
});
export type ControlScope = z.infer<typeof controlScopeSchema>;
export type ManualSettings = {
  revision: number;
  enabled: boolean;
  budget: z.infer<typeof budgetSchema>;
};
export type RerunContext = {
  installationId: number;
  repositoryId: number;
  pullRequestNumber: number;
  revision: number;
};
export interface RunControlStore {
  get(scope: ControlScope): Promise<ManualSettings>;
  save(scope: ControlScope, input: unknown): Promise<ManualSettings>;
  prepare(scope: ControlScope): Promise<RerunContext>;
  commit(
    scope: ControlScope,
    requestId: string,
    context: RerunContext,
    headSha: string,
  ): Promise<{
    status: 'accepted' | 'duplicate';
    runId: string;
    queued: false;
  }>;
}
export function createRunControlStore(db: PrismaClient): RunControlStore {
  async function authorized<T>(
    input: ControlScope,
    work: (
      tx: Prisma.TransactionClient,
      source: {
        id: string;
        repositoryId: bigint;
        pullRequestNumber: number;
        installationId: bigint;
      },
      actor: bigint,
    ) => Promise<T>,
  ) {
    const scope = controlScopeSchema.parse(input);
    return db.$transaction(
      async (tx) => {
        const actors = await tx.$queryRaw<
          { githubId: bigint }[]
        >`SELECT u."githubId" FROM "LoginSession" s JOIN "User" u ON u.id = s."userId" JOIN "Membership" m ON m."userId" = u.id WHERE s."tokenHash" = ${scope.sessionHash} AND s."expiresAt" > clock_timestamp() AND u."disabledAt" IS NULL AND m."tenantId" = ${scope.tenantId}::uuid AND m.role = 'owner' FOR UPDATE OF s, u, m`;
        if (actors.length !== 1) throw Error('control_not_found');
        const run = await tx.run.findFirst({
          where: { id: scope.runId, tenantId: scope.tenantId },
          select: { id: true, repositoryId: true, pullRequestNumber: true },
        });
        if (!run) throw Error('control_not_found');
        const repos = await tx.$queryRaw<
          { installationId: bigint }[]
        >`SELECT "installationId" FROM "Repository" WHERE id = ${run.repositoryId} AND "tenantId" = ${scope.tenantId}::uuid FOR UPDATE`;
        if (repos.length !== 1) throw Error('control_not_found');
        return work(
          tx,
          { ...run, installationId: repos[0].installationId },
          actors[0].githubId,
        );
      },
      { timeout: 5000 },
    );
  }
  async function settings(
    tx: Prisma.TransactionClient,
    repositoryId: bigint,
  ): Promise<ManualSettings> {
    const saved = await tx.manualRunSettings.findUnique({
      where: { repositoryId },
    });
    return saved
      ? {
          revision: saved.revision,
          enabled: saved.enabled,
          budget: budgetSchema.parse(saved.budget),
        }
      : { revision: 0, enabled: false, budget: budgetSchema.parse({}) };
  }
  return {
    get: (scope) =>
      authorized(scope, (tx, run) => settings(tx, run.repositoryId)),
    async save(scope, input) {
      const value = manualSettingsSchema.parse(input);
      return authorized(scope, async (tx, run, actor) => {
        const current = await settings(tx, run.repositoryId);
        if (current.revision !== value.expectedRevision)
          throw Error('control_revision_conflict');
        const next = {
          revision: current.revision + 1,
          enabled: value.enabled,
          budget: value.budget,
        };
        await tx.manualRunSettings.upsert({
          where: { repositoryId: run.repositoryId },
          create: {
            repositoryId: run.repositoryId,
            tenantId: scope.tenantId,
            ...next,
          },
          update: next,
        });
        await tx.runControlEvent.create({
          data: {
            tenantId: scope.tenantId,
            repositoryId: run.repositoryId,
            actorId: actor,
            kind: 'settings.updated',
            revision: next.revision,
            sourceRunId: run.id,
          },
        });
        return next;
      });
    },
    prepare: (scope) =>
      authorized(scope, async (tx, run) => {
        const config = await settings(tx, run.repositoryId);
        if (!config.enabled) throw Error('control_disabled');
        return {
          installationId: z
            .number()
            .int()
            .positive()
            .safe()
            .parse(Number(run.installationId)),
          repositoryId: z
            .number()
            .int()
            .positive()
            .safe()
            .parse(Number(run.repositoryId)),
          pullRequestNumber: run.pullRequestNumber,
          revision: config.revision,
        };
      }),
    async commit(scope, requestId, context, headSha) {
      z.uuid().parse(requestId);
      z.string()
        .regex(/^[a-f0-9]{40}$/)
        .parse(headSha);
      return authorized(scope, async (tx, source, actor) => {
        if (
          BigInt(context.repositoryId) !== source.repositoryId ||
          BigInt(context.installationId) !== source.installationId ||
          context.pullRequestNumber !== source.pullRequestNumber
        )
          throw Error('control_context_conflict');
        const config = await settings(tx, source.repositoryId);
        if (!config.enabled || config.revision !== context.revision)
          throw Error('control_revision_conflict');
        const existing = await tx.runControlEvent.findUnique({
          where: { id: requestId },
        });
        if (existing) {
          if (
            existing.tenantId !== scope.tenantId ||
            existing.sourceRunId !== source.id ||
            existing.actorId !== actor ||
            existing.kind !== 'run.requested' ||
            !existing.resultRunId
          )
            throw Error('control_request_conflict');
          return {
            status: 'duplicate',
            runId: existing.resultRunId,
            queued: false,
          };
        }
        const active = await tx.run.count({
          where: {
            tenantId: scope.tenantId,
            repositoryId: source.repositoryId,
            pullRequestNumber: source.pullRequestNumber,
            state: {
              in: [
                'received',
                'queued',
                'waiting_for_preview',
                'running',
                'reporting',
              ],
            },
          },
        });
        if (active) throw Error('control_run_active');
        const actorId = z.number().int().positive().safe().parse(Number(actor));
        const policy = repositoryPolicySchema.parse({
          tenantId: scope.tenantId,
          installationId: context.installationId,
          repositoryId: context.repositoryId,
          authorizedActorIds: [actorId],
          budget: config.budget,
        });
        const run = await tx.run.create({
          data: {
            tenantId: scope.tenantId,
            repositoryId: source.repositoryId,
            pullRequestNumber: source.pullRequestNumber,
            headSha,
            deliveryId: 'manual:' + requestId,
            policySnapshot: {
              ...policy,
              trigger: 'manual_owner_request',
              settingsRevision: config.revision,
              sourceRunId: source.id,
            },
            budgetSnapshot: config.budget,
          },
        });
        await tx.outboxEvent.create({
          data: { tenantId: scope.tenantId, runId: run.id },
        });
        await tx.runControlEvent.create({
          data: {
            id: requestId,
            tenantId: scope.tenantId,
            repositoryId: source.repositoryId,
            actorId: actor,
            kind: 'run.requested',
            revision: config.revision,
            sourceRunId: source.id,
            resultRunId: run.id,
          },
        });
        return { status: 'accepted', runId: run.id, queued: false };
      });
    },
  };
}
