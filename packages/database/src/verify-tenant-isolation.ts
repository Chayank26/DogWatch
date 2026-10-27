/** Local Compose only: two real tenants, positive controls and swapped identifiers. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createDatabase, canExecuteRun } from './index.js';
const db = createDatabase(
  'postgresql://dogwatch:dogwatch_local_only@127.0.0.1:5433/dogwatch',
);
const tenants = [randomUUID(), randomUUID()],
  runs = [randomUUID(), randomUUID()];
const ids = [0, 1].map(() => BigInt('0x' + randomBytes(6).toString('hex')));
const fk = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 'P2003';
try {
  for (let i = 0; i < 2; i++) {
    await db.tenant.create({
      data: { id: tenants[i], name: 'Tenant isolation fixture' },
    });
    await db.installation.create({
      data: { id: ids[i], tenantId: tenants[i] },
    });
    await db.repository.create({
      data: {
        id: ids[i],
        tenantId: tenants[i],
        installationId: ids[i],
        fullName: 'fixture/isolation',
      },
    });
    await db.run.create({
      data: {
        id: runs[i],
        tenantId: tenants[i],
        repositoryId: ids[i],
        deliveryId: randomUUID(),
        pullRequestNumber: 1,
        headSha: 'a'.repeat(40),
        state: 'queued',
        policySnapshot: {},
        budgetSnapshot: {},
      },
    });
    await db.outboxEvent.create({
      data: { tenantId: tenants[i], runId: runs[i] },
    });
  }
  for (let i = 0; i < 2; i++) {
    const other = 1 - i;
    assert.equal(await canExecuteRun(db, tenants[i], runs[i]), true);
    assert.equal(await canExecuteRun(db, tenants[i], runs[other]), false);
    await assert.rejects(
      db.repository.update({
        where: { id: ids[i] },
        data: { installationId: ids[other] },
      }),
      fk,
    );
    await assert.rejects(
      db.run.update({
        where: { id: runs[i] },
        data: { repositoryId: ids[other] },
      }),
      fk,
    );
    await assert.rejects(
      db.outboxEvent.create({
        data: {
          tenantId: tenants[i],
          runId: runs[other],
          kind: 'isolation.forbidden',
        },
      }),
      fk,
    );
    await assert.rejects(
      db.webhookDelivery.create({
        data: {
          deliveryId: randomUUID(),
          payloadSha256: randomBytes(32).toString('hex'),
          eventName: 'pull_request',
          tenantId: tenants[i],
          runId: runs[other],
        },
      }),
      fk,
    );
    assert.equal(
      (await db.run.findUniqueOrThrow({ where: { id: runs[i] } })).repositoryId,
      ids[i],
    );
  }
  await db.run.update({ where: { id: runs[0] }, data: { state: 'cancelled' } });
  assert.equal(await canExecuteRun(db, tenants[0], runs[0]), false);
  assert.equal(await canExecuteRun(db, tenants[1], runs[1]), true);
  // Explicitly report the boundary: the service DB role is privileged, not tenant-RLS scoped.
  assert.equal(await db.run.count({ where: { id: { in: runs } } }), 2);
  process.stdout.write(
    'Tenant isolation verified: composite foreign keys, swapped worker tenant/run pairs and scoped cancellation state. Service-role reads remain privileged; no RLS claim.\n',
  );
} finally {
  await db.webhookDelivery.deleteMany({ where: { tenantId: { in: tenants } } });
  await db.outboxEvent.deleteMany({ where: { tenantId: { in: tenants } } });
  await db.run.deleteMany({ where: { id: { in: runs } } });
  await db.repository.deleteMany({ where: { id: { in: ids } } });
  await db.installation.deleteMany({ where: { id: { in: ids } } });
  await db.tenant.deleteMany({ where: { id: { in: tenants } } });
  await db.$disconnect();
}
