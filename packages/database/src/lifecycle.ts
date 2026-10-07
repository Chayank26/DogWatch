/** Durable stop operations. Caller identity must come from trusted authorization. */
import { z } from 'zod';
import { repositoryPolicySchema } from '@dogwatch/contracts';
import type { RepositoryPolicy } from '@dogwatch/contracts';
import type { PrismaClient } from './generated/prisma/client.js';
import { OwnershipMismatchError } from './acceptance.js';

// Terminal states are excluded: historical outcomes never turn into new work.
const active = [
  'received',
  'queued',
  'waiting_for_preview',
  'running',
  'reporting',
] as const;
export interface StopInput {
  policy: RepositoryPolicy;
  actorId: number;
  pullRequestNumber: number;
  headSha: string;
  operation: 'cancel' | 'supersede';
}
/** Cancellation targets the resolved current SHA; supersession stops other SHAs. */
export async function stopRuns(database: PrismaClient, input: StopInput) {
  const policy = repositoryPolicySchema.parse(input.policy);
  const actorId = z.number().int().positive().parse(input.actorId);
  const number = z.number().int().positive().parse(input.pullRequestNumber);
  const sha = z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(input.headSha);
  const operation = z.enum(['cancel', 'supersede']).parse(input.operation);
  if (!policy.enabled || !policy.authorizedActorIds.includes(actorId))
    throw new OwnershipMismatchError('Unauthorized stop operation');
  return database.$transaction(
    async (tx) => {
      // Use the same repository lock as acceptance. It serializes stop/create races
      // while dispatcher row locks protect a run already being handed off to Redis.
      const owned = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT "id" FROM "Repository" WHERE "id" = ${BigInt(policy.repositoryId)}
      AND "tenantId" = ${policy.tenantId}::uuid
      AND "installationId" = ${BigInt(policy.installationId)} FOR UPDATE
    `;
      if (!owned.length)
        throw new OwnershipMismatchError('Repository ownership mismatch');
      const result = await tx.run.updateMany({
        where: {
          tenantId: policy.tenantId,
          repositoryId: BigInt(policy.repositoryId),
          pullRequestNumber: number,
          state: { in: [...active] },
          headSha: operation === 'cancel' ? sha : { not: sha },
        },
        data: { state: operation === 'cancel' ? 'cancelled' : 'superseded' },
      });
      // State is the durable stop signal. Pending outbox rows cannot be dispatched;
      // already queued jobs remain as evidence and must check this state before work.
      return result.count;
    },
    { timeout: 5000, maxWait: 2000 },
  );
}

/** A future executor must use this check before stages and during long operations. */
export async function canExecuteRun(
  database: PrismaClient,
  tenantId: string,
  runId: string,
) {
  const run = await database.run.findFirst({
    where: {
      id: z.uuid().parse(runId),
      tenantId: z.uuid().parse(tenantId),
      state: { in: ['queued', 'waiting_for_preview', 'running', 'reporting'] },
    },
  });
  return run !== null;
}
