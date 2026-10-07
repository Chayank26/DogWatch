/**
 * Real PostgreSQL integration verification. Fixtures use random IDs. Each test
 * exercises committed transactions; cleanup deletes only records belonging to
 * these exact random tenant IDs, in child-to-parent order, even after failure.
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { repositoryPolicySchema } from '@dogwatch/contracts';
import {
  createDatabase,
  acceptDelivery,
  DeliveryConflictError,
  OwnershipMismatchError,
  stopRuns,
  canExecuteRun,
  dispatchNext,
} from './index.js';
import type { AcceptanceInput } from './acceptance.js';

config({
  path: fileURLToPath(new URL('../../../.env', import.meta.url)),
  quiet: true,
});
const db = createDatabase(
  process.env.DATABASE_URL ??
    'postgresql://dogwatch:dogwatch_local_only@127.0.0.1:5433/dogwatch',
);
const tenantId = randomUUID();
const outsiderId = randomUUID();
const installationId = Number(
  BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 12)}`),
);
const repositoryId = installationId + 1;
const policy = repositoryPolicySchema.parse({
  tenantId,
  installationId,
  repositoryId,
  authorizedActorIds: [30],
});
const input: AcceptanceInput = {
  policy,
  eventName: 'pull_request',
  payloadSha256: createHash('sha256').update(randomUUID()).digest('hex'),
  event: {
    tenantId,
    installationId,
    repositoryId,
    actorId: 30,
    deliveryId: randomUUID(),
    pullRequestNumber: 42,
    headSha: 'a'.repeat(40),
    kind: 'pr_labeled',
    addedLabel: 'dogwatch',
  },
};
try {
  await db.tenant.createMany({
    data: [
      { id: tenantId, name: 'Acceptance fixture' },
      { id: outsiderId, name: 'Outsider fixture' },
    ],
  });
  await db.installation.create({
    data: { id: BigInt(installationId), tenantId },
  });
  await db.repository.create({
    data: {
      id: BigInt(repositoryId),
      tenantId,
      installationId: BigInt(installationId),
      fullName: 'fixture/acceptance',
    },
  });
  // Two processes may pass auth simultaneously. Exactly one may create a run.
  const results = await Promise.all([
    acceptDelivery(db, input),
    acceptDelivery(db, input),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [
    'accepted',
    'duplicate',
  ]);
  assert.equal(results[0].runId, results[1].runId);
  assert.equal(await db.run.count({ where: { tenantId } }), 1);
  assert.equal(await db.webhookDelivery.count({ where: { tenantId } }), 1);
  assert.equal(await db.outboxEvent.count({ where: { tenantId } }), 1);
  // Changing unsigned delivery headers must not bypass the signed-body fingerprint.
  const replay = await acceptDelivery(db, {
    ...input,
    event: {
      ...input.event,
      deliveryId: randomUUID(),
      headSha: 'b'.repeat(40),
    },
  });
  assert.equal(await db.run.count({ where: { tenantId } }), 1);
  assert.equal(replay.status, 'duplicate');
  assert.equal(
    (await db.run.findUniqueOrThrow({ where: { id: replay.runId } })).headSha,
    input.event.headSha,
  );
  await assert.rejects(
    acceptDelivery(db, { ...input, payloadSha256: 'f'.repeat(64) }),
    DeliveryConflictError,
  );
  await assert.rejects(
    acceptDelivery(db, {
      ...input,
      policy: { ...policy, tenantId: outsiderId },
      event: { ...input.event, tenantId: outsiderId, deliveryId: randomUUID() },
      payloadSha256: 'e'.repeat(64),
    }),
    OwnershipMismatchError,
  );

  // The replay above fails receipt insertion after creating a tentative run, then
  // reconciles the committed original. Counts here prove that tentative run rolled
  // back. A separate out-of-range write tests the operational failure path too.
  const failing = {
    ...input,
    event: {
      ...input.event,
      deliveryId: randomUUID(),
      pullRequestNumber: 2147483648,
    },
    payloadSha256: 'd'.repeat(64),
  };
  await assert.rejects(acceptDelivery(db, failing));
  assert.equal(await db.run.count({ where: { tenantId } }), 1);
  assert.equal(await db.webhookDelivery.count({ where: { tenantId } }), 1);
  assert.equal(await db.outboxEvent.count({ where: { tenantId } }), 1);
  // A new head obsoletes active earlier work while preserving its immutable SHA.
  const newer = await acceptDelivery(db, {
    ...input,
    payloadSha256: createHash('sha256').update(randomUUID()).digest('hex'),
    event: {
      ...input.event,
      deliveryId: randomUUID(),
      headSha: 'b'.repeat(40),
    },
  });
  assert.equal(
    (await db.run.findUniqueOrThrow({ where: { id: replay.runId } })).state,
    'superseded',
  );
  await db.run.update({
    where: { id: newer.runId },
    data: { state: 'queued' },
  });
  assert.equal(await canExecuteRun(db, tenantId, newer.runId), true);
  assert.equal(await canExecuteRun(db, outsiderId, newer.runId), false);
  const stop = {
    policy,
    actorId: 30,
    pullRequestNumber: 42,
    headSha: 'b'.repeat(40),
    operation: 'cancel' as const,
  };
  await assert.rejects(
    stopRuns(db, { ...stop, actorId: 999 }),
    OwnershipMismatchError,
  );
  assert.equal(await stopRuns(db, stop), 1);
  assert.equal(await stopRuns(db, stop), 0);
  assert.equal(await canExecuteRun(db, tenantId, newer.runId), false);
  // No stopped outbox is passed to the queue, even when its due time has arrived.
  assert.equal(
    await dispatchNext(
      db,
      async () => {
        throw new Error('Stopped job dispatched');
      },
      tenantId,
    ),
    'idle',
  );
  // Receipt replay cannot resurrect or supersede a cancelled run.
  assert.equal((await acceptDelivery(db, input)).status, 'duplicate');
  assert.equal(
    (await db.run.findUniqueOrThrow({ where: { id: newer.runId } })).state,
    'cancelled',
  );
  process.stdout.write(
    'Acceptance verified: concurrent deduplication, fingerprint replay, immutable snapshot, conflicts, ownership, rollback, supersession, cancellation, stopped dispatch.\n',
  );
} finally {
  // This is not a database reset: exact random fixture ownership bounds every delete.
  await db.$transaction(async (tx) => {
    await tx.webhookDelivery.deleteMany({ where: { tenantId } });
    await tx.outboxEvent.deleteMany({ where: { tenantId } });
    await tx.run.deleteMany({ where: { tenantId } });
    await tx.repository.deleteMany({ where: { tenantId } });
    await tx.installation.deleteMany({ where: { tenantId } });
    await tx.tenant.deleteMany({
      where: { id: { in: [tenantId, outsiderId] } },
    });
  });
  await db.$disconnect();
}
