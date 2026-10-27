import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  createDatabase,
  createIdentityStore,
  createRunControlStore,
} from './index.js';
const db = createDatabase(
  'postgresql://dogwatch:dogwatch_local_only@127.0.0.1:5433/dogwatch',
);
const identity = createIdentityStore(db),
  controls = createRunControlStore(db);
const tenantId = randomUUID(),
  runId = randomUUID(),
  id = BigInt('0x' + randomBytes(6).toString('hex')),
  sessionHash = randomBytes(32).toString('hex');
const scope = { tenantId, runId, sessionHash };
try {
  await identity.issue(
    String(id),
    'controls-fixture',
    sessionHash,
    new Date(Date.now() + 60000),
  );
  const userId = (await identity.resolve(sessionHash, new Date()))!.id;
  await db.tenant.create({ data: { id: tenantId, name: 'Controls fixture' } });
  await db.membership.create({ data: { tenantId, userId, role: 'owner' } });
  await db.installation.create({ data: { id, tenantId } });
  await db.repository.create({
    data: { id, tenantId, installationId: id, fullName: 'fixture/controls' },
  });
  await db.run.create({
    data: {
      id: runId,
      tenantId,
      repositoryId: id,
      deliveryId: randomUUID(),
      pullRequestNumber: 42,
      headSha: 'a'.repeat(40),
      state: 'completed',
      policySnapshot: {},
      budgetSnapshot: {},
    },
  });
  const initial = await controls.get(scope);
  assert.equal(initial.enabled, false);
  await assert.rejects(controls.prepare(scope), /disabled/);
  const config = { expectedRevision: 0, enabled: true, budget: initial.budget };
  const saves = await Promise.allSettled([
    controls.save(scope, config),
    controls.save(scope, config),
  ]);
  assert.equal(saves.filter((r) => r.status === 'fulfilled').length, 1);
  const context = await controls.prepare(scope),
    requestId = randomUUID();
  const results = await Promise.all([
    controls.commit(scope, requestId, context, 'b'.repeat(40)),
    controls.commit(scope, requestId, context, 'b'.repeat(40)),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [
    'accepted',
    'duplicate',
  ]);
  assert.equal(results[0].runId, results[1].runId);
  assert.equal(await db.outboxEvent.count({ where: { tenantId } }), 1);
  assert.equal(await db.runControlEvent.count({ where: { tenantId } }), 2);
  const rerun = await db.run.findUniqueOrThrow({
    where: { id: results[0].runId },
  });
  assert.equal(rerun.headSha, 'b'.repeat(40));
  assert.equal(rerun.state, 'received');
  assert.equal(rerun.previewSnapshot, null);
  await assert.rejects(
    controls.commit(scope, randomUUID(), context, 'c'.repeat(40)),
    /run_active/,
  );
  await controls.save(scope, {
    ...config,
    expectedRevision: 1,
    enabled: false,
  });
  await assert.rejects(
    controls.commit(scope, randomUUID(), context, 'b'.repeat(40)),
    /revision_conflict/,
  );
  await assert.rejects(
    controls.get({ ...scope, tenantId: randomUUID() }),
    /not_found/,
  );
  await db.membership.update({
    where: { tenantId_userId: { tenantId, userId } },
    data: { role: 'member' },
  });
  await assert.rejects(controls.get(scope), /not_found/);
  await assert.rejects(
    controls.save(scope, { ...config, expectedRevision: 2 }),
    /not_found/,
  );
  await identity.revoke(sessionHash);
  await assert.rejects(controls.get(scope), /not_found/);
  process.stdout.write(
    'Run controls verified: owner scope, revision races, disabled settings, duplicate reruns, outbox/audit atomicity, current SHA, active-run refusal and revocation.\n',
  );
} finally {
  await db.runControlEvent.deleteMany({ where: { tenantId } });
  await db.manualRunSettings.deleteMany({ where: { tenantId } });
  await db.outboxEvent.deleteMany({ where: { tenantId } });
  await db.run.deleteMany({ where: { tenantId } });
  await db.repository.deleteMany({ where: { id } });
  await db.installation.deleteMany({ where: { id } });
  await db.user.deleteMany({ where: { githubId: id } });
  await db.tenant.deleteMany({ where: { id: tenantId } });
  await db.$disconnect();
}
