/**
 * Real-database smoke verification, invoked explicitly with npm run db:verify.
 * All sample writes occur in transactions intentionally rolled back, so this
 * command cannot leave test tenants/runs behind or delete existing customer data.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { createDatabase } from './index.js';

config({
  path: fileURLToPath(new URL('../../../.env', import.meta.url)),
  quiet: true,
});
const database = createDatabase(
  process.env.DATABASE_URL ??
    'postgresql://dogwatch:dogwatch_local_only@127.0.0.1:5433/dogwatch',
);
// A distinct sentinel distinguishes our successful rollback from genuine failures.
const rollback = new Error('verification complete: roll back fixtures');
const tenantId = randomUUID();
const runId = randomUUID();
// Random positive IDs avoid colliding with any previously created local records.
const installationId = BigInt(
  `0x${randomUUID().replaceAll('-', '').slice(0, 12)}`,
);
const repositoryId = installationId + 1n;
try {
  try {
    await database.$transaction(async (transaction) => {
      await transaction.tenant.create({
        data: { id: tenantId, name: 'Verification only' },
      });
      await transaction.installation.create({
        data: { id: installationId, tenantId },
      });
      await transaction.repository.create({
        data: {
          id: repositoryId,
          tenantId,
          installationId,
          fullName: 'fixture/pawmart',
        },
      });
      await transaction.run.create({
        data: {
          id: runId,
          tenantId,
          repositoryId,
          deliveryId: randomUUID(),
          pullRequestNumber: 42,
          headSha: 'a'.repeat(40),
          policySnapshot: { fixture: true },
          budgetSnapshot: { maxRunSeconds: 300 },
        },
      });
      await transaction.outboxEvent.create({ data: { tenantId, runId } });
      assert.equal(
        await transaction.outboxEvent.count({ where: { tenantId, runId } }),
        1,
      );
      assert.equal(
        (await transaction.run.findUniqueOrThrow({ where: { id: runId } }))
          .state,
        'received',
      );
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  assert.equal(await database.tenant.count({ where: { id: tenantId } }), 0);
  assert.equal(await database.run.count({ where: { id: runId } }), 0);

  // A repository may not claim another tenant's installation, even with valid IDs.
  await assert.rejects(
    database.$transaction(async (transaction) => {
      const ownerId = randomUUID();
      const outsiderId = randomUUID();
      await transaction.tenant.createMany({
        data: [
          { id: ownerId, name: 'Owner fixture' },
          { id: outsiderId, name: 'Outsider fixture' },
        ],
      });
      await transaction.installation.create({
        data: { id: installationId, tenantId: ownerId },
      });
      await transaction.repository.create({
        data: {
          id: repositoryId,
          tenantId: outsiderId,
          installationId,
          fullName: 'fixture/forbidden',
        },
      });
    }),
    (error: unknown) => {
      // Prisma's P2003 identifies a database foreign-key violation, not a timeout.
      return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2003'
      );
    },
  );
  process.stdout.write(
    'Database verified: run/outbox writes, rollback, tenant foreign keys.\n',
  );
} finally {
  // Always release the pool, including when a real assertion/database error occurs.
  await database.$disconnect();
}
