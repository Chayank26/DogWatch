import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createLogger, runTrace } from '@dogwatch/telemetry';
import { createDatabase, dispatchNext } from './index.js';
const db = createDatabase(
  'postgresql://dogwatch:dogwatch_local_only@127.0.0.1:5433/dogwatch',
);
const tenantId = randomUUID(),
  id = BigInt('0x' + randomBytes(6).toString('hex'));
const records: Record<string, unknown>[] = [];
const log = createLogger('dispatcher', (line) =>
  records.push(JSON.parse(line)),
);
async function fixture() {
  const run = await db.run.create({
    data: {
      tenantId,
      repositoryId: id,
      deliveryId: randomUUID(),
      pullRequestNumber: 42,
      headSha: 'a'.repeat(40),
      policySnapshot: {},
      budgetSnapshot: {},
    },
  });
  const outbox = await db.outboxEvent.create({
    data: { tenantId, runId: run.id },
  });
  return { run, outbox };
}
try {
  await db.tenant.create({
    data: { id: tenantId, name: 'Telemetry verification' },
  });
  await db.tenantQuota.create({ data: { tenantId, maxConcurrent: 10 } });
  await db.installation.create({ data: { id, tenantId } });
  await db.repository.create({
    data: { id, tenantId, installationId: id, fullName: 'fixture/logging' },
  });
  const first = await fixture();
  assert.equal(
    await dispatchNext(
      db,
      async (job) => {
        assert.equal(job.runId, first.run.id);
      },
      tenantId,
      log,
    ),
    'published',
  );
  assert.equal(
    (await db.run.findUniqueOrThrow({ where: { id: first.run.id } })).state,
    'queued',
  );
  assert.equal(records[0].outcome, 'published');
  assert.equal(records[0].outboxId, first.outbox.id);
  assert.equal(records[0].traceId, runTrace(first.run.id).traceId);
  const second = await fixture();
  assert.equal(
    await dispatchNext(
      db,
      async () => {
        throw Object.assign(new Error('SECRET redis://password'), {
          retryable: false,
        });
      },
      tenantId,
      log,
    ),
    'failed',
  );
  assert.equal(
    (await db.run.findUniqueOrThrow({ where: { id: second.run.id } })).state,
    'failed',
  );
  assert.equal(records[1].outcome, 'failed');
  assert.ok(!JSON.stringify(records).includes('SECRET'));
  const third = await fixture();
  assert.equal(
    await dispatchNext(
      db,
      async () => undefined,
      tenantId,
      () => {
        throw Error('broken sink');
      },
    ),
    'published',
  );
  assert.equal(
    (await db.run.findUniqueOrThrow({ where: { id: third.run.id } })).state,
    'queued',
  );
  const count = records.length;
  assert.equal(
    await dispatchNext(db, async () => undefined, tenantId, log),
    'idle',
  );
  assert.equal(records.length, count);
  process.stdout.write(
    'Telemetry verified: durable dispatch outcomes, stable run correlation, secret omission, idle suppression and sink failure isolation.\n',
  );
} finally {
  await db.outboxEvent.deleteMany({ where: { tenantId } });
  await db.run.deleteMany({ where: { tenantId } });
  await db.repository.deleteMany({ where: { tenantId } });
  await db.installation.deleteMany({ where: { tenantId } });
  await db.tenant.deleteMany({ where: { id: tenantId } });
  await db.$disconnect();
}
