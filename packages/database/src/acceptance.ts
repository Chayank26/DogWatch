/**
 * Durable acceptance boundary. A single transaction commits the delivery receipt,
 * run snapshot, and dispatch instruction together; Redis is deliberately not used.
 * Unique constraints arbitrate concurrent requests rather than an in-memory lock.
 */
import { z } from 'zod';
import {
  evaluateOptIn,
  optInEventSchema,
  repositoryPolicySchema,
} from '@dogwatch/contracts';
import type { OptInEvent, RepositoryPolicy } from '@dogwatch/contracts';
import type { PrismaClient } from './generated/prisma/client.js';

export class DeliveryConflictError extends Error {}
export class OwnershipMismatchError extends Error {}
export interface AcceptanceInput {
  event: OptInEvent;
  policy: RepositoryPolicy;
  eventName: string;
  payloadSha256: string;
}
export interface AcceptanceResult {
  status: 'accepted' | 'duplicate';
  runId: string;
  queued: false;
}

export async function acceptDelivery(
  database: PrismaClient,
  input: AcceptanceInput,
): Promise<AcceptanceResult> {
  // Revalidate the boundary so direct future callers cannot bypass the domain gate.
  const event = optInEventSchema.parse(input.event);
  const policy = repositoryPolicySchema.parse(input.policy);
  const payloadSha256 = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(input.payloadSha256);
  const eventName = z
    .enum(['pull_request', 'issue_comment'])
    .parse(input.eventName);
  if ((event.kind === 'pr_comment') !== (eventName === 'issue_comment'))
    throw new DeliveryConflictError('Event kind mismatch');
  const decision = evaluateOptIn(policy, event);
  if (!decision.accepted)
    throw new OwnershipMismatchError('Event not eligible');

  // Compare all authoritative dimensions; an existing receipt cannot be reassigned.
  const existingResult = async () => {
    const receipts = await database.webhookDelivery.findMany({
      where: { OR: [{ deliveryId: event.deliveryId }, { payloadSha256 }] },
    });
    if (!receipts.length) return null;
    if (receipts.length !== 1)
      throw new DeliveryConflictError('Delivery identities conflict');
    const receipt = receipts[0];
    const run = await database.run.findUniqueOrThrow({
      where: { id: receipt.runId },
    });
    if (
      receipt.payloadSha256 !== payloadSha256 ||
      receipt.eventName !== eventName ||
      receipt.tenantId !== event.tenantId ||
      run.repositoryId !== BigInt(event.repositoryId) ||
      run.pullRequestNumber !== event.pullRequestNumber
    ) {
      throw new DeliveryConflictError('Delivery identity reused');
    }
    // Retain the originally accepted SHA/policy; redelivery must not create a new run.
    return { status: 'duplicate', runId: run.id, queued: false } as const;
  };
  try {
    return await database.$transaction(
      async (transaction) => {
        // Bind file-backed policy to durable ownership. Never auto-create/transfer a
        // tenant or installation because a signed body or local file claims one.
        // Hold a shared row lock so operator reassignment cannot race this check.
        // Tagged query parameters are bound values, never SQL string interpolation.
        const repositories = await transaction.$queryRaw<{ id: bigint }[]>`
          SELECT "id" FROM "Repository"
          WHERE "id" = ${BigInt(event.repositoryId)}
            AND "tenantId" = ${event.tenantId}::uuid
            AND "installationId" = ${BigInt(event.installationId)}
          FOR SHARE
        `;
        if (!repositories.length)
          throw new OwnershipMismatchError('Repository ownership mismatch');
        const run = await transaction.run.create({
          data: {
            tenantId: event.tenantId,
            repositoryId: BigInt(event.repositoryId),
            deliveryId: event.deliveryId,
            pullRequestNumber: event.pullRequestNumber,
            headSha: event.headSha,
            // The policy is operator-controlled and contains references/IDs, not secrets.
            policySnapshot: { ...policy, trigger: decision.trigger },
            budgetSnapshot: policy.budget,
          },
        });
        await transaction.webhookDelivery.create({
          data: {
            deliveryId: event.deliveryId,
            payloadSha256,
            eventName,
            tenantId: event.tenantId,
            runId: run.id,
          },
        });
        await transaction.outboxEvent.create({
          data: { tenantId: event.tenantId, runId: run.id },
        });
        return { status: 'accepted', runId: run.id, queued: false };
      },
      { timeout: 5000, maxWait: 2000 },
    );
  } catch (error) {
    // A unique violation can mean another concurrent delivery committed first.
    // Reconcile only after rollback; unrelated constraint failures must propagate.
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002'
    ) {
      const existing = await existingResult();
      if (existing) return existing;
    }
    throw error;
  }
}
