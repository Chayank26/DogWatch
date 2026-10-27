import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { repositoryPolicySchema } from '@dogwatch/contracts';
import {
  createDatabase,
  acceptDelivery,
  createIdentityStore,
  createUsageStore,
  settleRunUsage,
  QuotaExceededError,
  dispatchNext,
} from './index.js';
const db = createDatabase(
  'postgresql://dogwatch:dogwatch_local_only@127.0.0.1:5433/dogwatch',
);
const tenantId = randomUUID(),
  foreign = randomUUID(),
  id = BigInt('0x' + randomBytes(6).toString('hex')),
  session = randomBytes(32).toString('hex');
const identity = createIdentityStore(db),
  usage = createUsageStore(db);
const actual = {
  runSeconds: 10,
  browserSeconds: 5,
  apiRequests: 3,
  browserSteps: 2,
  modelCalls: 1,
  modelTokens: 20,
  modelCostCents: 30,
  artifactBytes: 100,
};
function input(repo: bigint, sha = 'a') {
  const policy = repositoryPolicySchema.parse({
    tenantId,
    repositoryId: Number(repo),
    installationId: Number(id),
    authorizedActorIds: [42],
  });
  return {
    policy,
    eventName: 'pull_request',
    payloadSha256: randomBytes(32).toString('hex'),
    event: {
      tenantId,
      repositoryId: Number(repo),
      installationId: Number(id),
      actorId: 42,
      deliveryId: randomUUID(),
      pullRequestNumber: 42,
      headSha: sha.repeat(40),
      kind: 'pr_labeled' as const,
      addedLabel: 'dogwatch',
    },
  };
}
try {
  await db.tenant.createMany({
    data: [
      { id: tenantId, name: 'Usage fixture' },
      { id: foreign, name: 'Other tenant' },
    ],
  });
  await db.tenantQuota.create({
    data: {
      tenantId,
      maxConcurrent: 1,
      maxDailyRuns: 2,
      maxDailyModelCostCents: 200,
    },
  });
  await db.installation.create({ data: { id, tenantId } });
  await db.repository.createMany({
    data: [id, id + 1n].map((repositoryId) => ({
      id: repositoryId,
      tenantId,
      installationId: id,
      fullName: 'fixture/usage',
    })),
  });
  await identity.issue(
    String(id),
    'usage-fixture',
    session,
    new Date(Date.now() + 60000),
  );
  const user = (await identity.resolve(session, new Date()))!;
  await db.membership.create({
    data: { tenantId, userId: user.id, role: 'member' },
  });
  const inputs = [input(id), input(id + 1n)];
  const race = await Promise.allSettled(
    inputs.map((value) => acceptDelivery(db, value)),
  );
  const winner = race.findIndex((r) => r.status === 'fulfilled'),
    success = race[winner];
  assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(
    race.filter(
      (r) => r.status === 'rejected' && r.reason instanceof QuotaExceededError,
    ).length,
    1,
  );
  if (success.status !== 'fulfilled') throw Error('no winner');
  const firstId = success.value.runId;
  assert.equal((await acceptDelivery(db, inputs[winner])).status, 'duplicate');
  await assert.rejects(
    acceptDelivery(db, input(BigInt(inputs[winner].policy.repositoryId), 'b')),
    (e: unknown) => e instanceof QuotaExceededError,
  );
  assert.equal(
    (await db.run.findUniqueOrThrow({ where: { id: firstId } })).state,
    'received',
  );
  assert.equal(await db.run.count({ where: { tenantId } }), 1);
  assert.equal(await db.outboxEvent.count({ where: { tenantId } }), 1);
  await assert.rejects(settleRunUsage(db, tenantId, firstId, actual), /active/);
  await assert.rejects(settleRunUsage(db, foreign, firstId, actual), /scope/);
  await db.run.update({ where: { id: firstId }, data: { state: 'completed' } });
  assert.equal(await settleRunUsage(db, tenantId, firstId, actual), 'settled');
  assert.equal(
    await settleRunUsage(db, tenantId, firstId, actual),
    'unchanged',
  );
  await assert.rejects(
    settleRunUsage(db, tenantId, firstId, { ...actual, modelCostCents: 31 }),
    /conflict/,
  );
  const second = await acceptDelivery(db, inputs[1 - winner]);
  let summary = await usage.summary(session, tenantId);
  assert.equal(summary.acceptedRuns, 2);
  assert.equal(summary.committedModelCostCents, 130);
  assert.equal(summary.pendingReservations, 1);
  await db.run.update({
    where: { id: second.runId },
    data: { state: 'failed' },
  });
  await settleRunUsage(db, tenantId, second.runId, {
    ...actual,
    modelCostCents: 500,
  });
  await assert.rejects(
    acceptDelivery(db, input(id)),
    (e: unknown) =>
      e instanceof QuotaExceededError && e.reason === 'daily_runs',
  );
  await db.tenantQuota.update({
    where: { tenantId },
    data: { maxDailyRuns: 3 },
  });
  await assert.rejects(
    acceptDelivery(db, input(id)),
    (e: unknown) =>
      e instanceof QuotaExceededError && e.reason === 'daily_model_cost',
  );
  summary = await usage.summary(session, tenantId);
  assert.equal(summary.committedModelCostCents, 530);
  await db.tenantQuota.update({
    where: { tenantId },
    data: { maxDailyModelCostCents: 10000 },
  });
  const third = await acceptDelivery(db, input(id));
  await db.usageReservation.updateMany({
    where: { tenantId },
    data: { reservedAt: new Date('2020-01-01T00:00:00Z') },
  });
  summary = await usage.summary(session, tenantId);
  assert.equal(summary.acceptedRuns, 0);
  assert.equal(summary.pendingReservations, 1);
  await assert.rejects(
    acceptDelivery(db, input(id + 1n)),
    (e: unknown) =>
      e instanceof QuotaExceededError && e.reason === 'concurrent',
  );
  assert.ok(
    summary.recent.some((r) => r.runId === third.runId && r.actual === null),
  );
  await db.run.update({
    where: { id: third.runId },
    data: { state: 'running' },
  });
  const legacy = await db.run.create({
    data: {
      tenantId,
      repositoryId: id,
      deliveryId: randomUUID(),
      pullRequestNumber: 99,
      headSha: 'c'.repeat(40),
      policySnapshot: {},
      budgetSnapshot: {},
    },
  });
  await db.outboxEvent.create({ data: { tenantId, runId: legacy.id } });
  assert.equal(
    await dispatchNext(
      db,
      async () => {
        assert.fail('quota must block handoff');
      },
      tenantId,
    ),
    'retry',
  );
  assert.equal(
    await db.usageReservation.count({ where: { runId: legacy.id } }),
    0,
  );
  const deferred = await db.outboxEvent.findFirstOrThrow({
    where: { runId: legacy.id },
  });
  assert.equal(deferred.attempts, 0);
  assert.equal(deferred.lastErrorCode, 'quota_concurrent');
  await db.run.update({
    where: { id: third.runId },
    data: { state: 'completed' },
  });
  await settleRunUsage(db, tenantId, third.runId, actual);
  await db.outboxEvent.update({
    where: { id: deferred.id },
    data: { nextAttemptAt: new Date(0) },
  });
  assert.equal(
    await dispatchNext(
      db,
      async (job) => {
        assert.equal(job.runId, legacy.id);
      },
      tenantId,
    ),
    'published',
  );
  assert.equal(
    await db.usageReservation.count({ where: { runId: legacy.id } }),
    1,
  );
  await assert.rejects(usage.summary(session, foreign), /not_found/);
  await identity.revoke(session);
  await assert.rejects(usage.summary(session, tenantId), /not_found/);
  process.stdout.write(
    'Usage verified: cross-repository quota race, duplicate acceptance at capacity, rollback, measured settlement/retry/conflict, overruns, UTC cohorts, pending holds and tenant isolation.\n',
  );
} finally {
  await db.webhookDelivery.deleteMany({ where: { tenantId } });
  await db.outboxEvent.deleteMany({ where: { tenantId } });
  await db.run.deleteMany({ where: { tenantId } });
  await db.repository.deleteMany({ where: { tenantId } });
  await db.installation.deleteMany({ where: { tenantId } });
  await db.user.deleteMany({ where: { githubId: id } });
  await db.tenant.deleteMany({ where: { id: { in: [tenantId, foreign] } } });
  await db.$disconnect();
}
