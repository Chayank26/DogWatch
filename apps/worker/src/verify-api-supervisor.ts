/** Real local DB/queue -> bounded HTTP -> atomic result/usage verification. */
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import {
  createDatabase,
  dispatchNext,
  claimExecution,
  renewExecution,
  finishExecution,
  expireExecution,
} from '@dogwatch/database';
import { createRunQueue, enqueueRun, createRunWorker } from '@dogwatch/queue';
import { runApiExecution } from './api-supervisor.js';
import type { ApiExecutionInput } from './api-execution.js';
const db = createDatabase(
  'postgresql://dogwatch:dogwatch_local_only@127.0.0.1:5433/dogwatch',
);
const tenantId = randomUUID(),
  repoId = BigInt('0x' + randomBytes(6).toString('hex'));
const queueName = 'dogwatch-api-supervisor-' + randomUUID();
const queue = createRunQueue('redis://127.0.0.1:6380', queueName);
let worker: ReturnType<typeof createRunWorker> | undefined;
let requests = 0;
const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200).end();
    return;
  }
  requests++;
  response
    .writeHead(request.url === '/broken' ? 500 : 200, {
      'Content-Type': 'application/json',
    })
    .end('{"ready":true}');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
const authority = async () => ({ authorized: true, headSha: 'a'.repeat(40) });
const zero = {
  browserSeconds: 0,
  runSeconds: 1,
  apiRequests: 0,
  browserSteps: 0,
  modelCalls: 0,
  modelTokens: 0,
  modelCostCents: 0,
  artifactBytes: 0,
};
const summary = {
  status: 'completed',
  code: 'completed',
  requests: 0,
  results: [],
  coverageGaps: [],
};
async function pending(path = '/check') {
  const run = await db.run.create({
    data: {
      tenantId,
      repositoryId: repoId,
      deliveryId: randomUUID(),
      pullRequestNumber: 42,
      headSha: 'a'.repeat(40),
      policySnapshot: {},
      budgetSnapshot: {},
    },
  });
  await db.outboxEvent.create({
    data: { tenantId, runId: run.id, nextAttemptAt: new Date(0) },
  });
  assert.equal(
    await dispatchNext(db, (data) => enqueueRun(queue, data), tenantId),
    'published',
  );
  const scope = {
    tenantId,
    runId: run.id,
    repositoryId: Number(repoId),
    pullRequestNumber: 42,
    headSha: run.headSha,
  };
  const input: ApiExecutionInput = {
    scope,
    binding: {
      tenantId,
      repositoryId: Number(repoId),
      pullRequestNumber: 42,
      headSha: run.headSha,
      deploymentId: 'fixture',
      url: origin + '/health',
      allowedOrigins: [origin],
      maxWaitSeconds: 5,
      maxRequests: 3,
      pollIntervalMs: 50,
    },
    grant: {
      ...scope,
      deploymentId: 'fixture',
      origin,
      disposableData: false,
      operations: [{ method: 'GET', path }],
    },
    contractText: JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Synthetic staging', version: '1' },
      paths: {
        [path]: { get: { responses: { '200': { description: 'ok' } } } },
      },
    }),
    generation: { maxCases: 20 },
    limits: { maxRequests: 20 },
  };
  return input;
}
try {
  await db.tenant.create({
    data: { id: tenantId, name: 'API supervisor verification' },
  });
  await db.tenantQuota.create({ data: { tenantId, maxConcurrent: 20 } });
  await db.installation.create({ data: { id: repoId, tenantId } });
  await db.repository.create({
    data: {
      id: repoId,
      tenantId,
      installationId: repoId,
      fullName: 'fixture/supervisor',
    },
  });
  const first = await pending();
  let deliveries = 0;
  worker = createRunWorker(
    'redis://127.0.0.1:6380',
    async (job) => {
      if (job.runId !== first.scope.runId) return;
      deliveries++;
      assert.equal(
        (await runApiExecution(db, first, authority, { fixture: true })).status,
        'recorded',
      );
    },
    queueName,
    1,
  );
  const deadline = Date.now() + 15000;
  while (
    Date.now() < deadline &&
    (await db.run.findUniqueOrThrow({ where: { id: first.scope.runId } }))
      .state !== 'completed'
  )
    await pause(50);
  await worker.close();
  worker = undefined;
  assert.equal(deliveries, 1);
  const diagnostic = await db.runExecution.findUniqueOrThrow({
    where: { runId: first.scope.runId },
  });
  assert.equal(
    (diagnostic.result as { status: string }).status,
    'completed',
    JSON.stringify(diagnostic.result),
  );
  assert.equal(
    (await db.run.findUniqueOrThrow({ where: { id: first.scope.runId } }))
      .state,
    'completed',
  );
  const stored = await db.runExecution.findUniqueOrThrow({
    where: { runId: first.scope.runId },
  });
  assert.equal(
    (stored.result as { results: { status: string }[] }).results[0].status,
    'passed',
  );
  const usage = await db.usageReservation.findUniqueOrThrow({
    where: { runId: first.scope.runId },
  });
  assert.ok(usage.settledAt);
  assert.equal((usage.actual as { apiRequests: number }).apiRequests, 2);
  const count = requests;
  assert.equal(
    (await runApiExecution(db, first, authority, { fixture: true })).status,
    'not_claimed',
  );
  assert.equal(requests, count);
  const race = await pending('/broken');
  const results = await Promise.all([
    runApiExecution(db, race, authority, { fixture: true }),
    runApiExecution(db, race, authority, { fixture: true }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [
    'not_claimed',
    'recorded',
  ]);
  assert.equal(
    (await db.run.findUniqueOrThrow({ where: { id: race.scope.runId } })).state,
    'completed',
  );
  assert.equal(
    (
      (
        await db.runExecution.findUniqueOrThrow({
          where: { runId: race.scope.runId },
        })
      ).result as { results: { status: string }[] }
    ).results[0].status,
    'failed',
  );
  const denied = await pending();
  assert.equal(
    (
      await runApiExecution(
        db,
        denied,
        async () => ({ authorized: false, headSha: 'a'.repeat(40) }),
        { fixture: true },
      )
    ).status,
    'not_authorized',
  );
  assert.equal(
    await db.runExecution.findUnique({ where: { runId: denied.scope.runId } }),
    null,
  );
  assert.equal(
    await claimExecution(db, {
      tenantId: randomUUID(),
      runId: denied.scope.runId,
    }),
    null,
  );
  const cancelled = await pending();
  let checks = 0;
  assert.equal(
    (
      await runApiExecution(
        db,
        cancelled,
        async () => {
          if (++checks === 2)
            await db.run.update({
              where: { id: cancelled.scope.runId },
              data: { state: 'cancelled' },
            });
          return authority();
        },
        { fixture: true },
      )
    ).status,
    'interrupted',
  );
  assert.equal(
    (await db.run.findUniqueOrThrow({ where: { id: cancelled.scope.runId } }))
      .state,
    'cancelled',
  );
  assert.equal(
    (
      await db.usageReservation.findUniqueOrThrow({
        where: { runId: cancelled.scope.runId },
      })
    ).settledAt,
    null,
  );
  const expired = await pending();
  const identity = { tenantId, runId: expired.scope.runId };
  const claim = await claimExecution(db, identity);
  assert.ok(claim);
  assert.equal(await renewExecution(db, identity, randomUUID()), false);
  assert.equal(
    await finishExecution(db, identity, randomUUID(), summary, zero),
    false,
  );
  // Force expiry in this random fixture only; production uses the database clock.
  await db.runExecution.update({
    where: { runId: identity.runId },
    data: { expiresAt: new Date(0) },
  });
  assert.equal(await renewExecution(db, identity, claim.token), false);
  assert.equal(
    await finishExecution(db, identity, claim.token, summary, zero),
    false,
  );
  assert.equal(await expireExecution(db, identity), true);
  assert.equal(await expireExecution(db, identity), false);
  assert.equal(await claimExecution(db, identity), null);
  assert.equal(
    (await db.run.findUniqueOrThrow({ where: { id: identity.runId } })).state,
    'failed',
  );
  assert.equal(
    (
      await db.usageReservation.findUniqueOrThrow({
        where: { runId: identity.runId },
      })
    ).settledAt,
    null,
  );
  const atomic = await pending();
  const atomicIdentity = { tenantId, runId: atomic.scope.runId };
  const atomicClaim = await claimExecution(db, atomicIdentity);
  assert.ok(atomicClaim);
  await db.usageReservation.delete({ where: { runId: atomic.scope.runId } });
  await assert.rejects(
    finishExecution(db, atomicIdentity, atomicClaim.token, summary, zero),
    /execution_usage_missing/,
  );
  assert.equal(
    (
      await db.runExecution.findUniqueOrThrow({
        where: { runId: atomic.scope.runId },
      })
    ).finishedAt,
    null,
  );
  assert.equal(
    (await db.run.findUniqueOrThrow({ where: { id: atomic.scope.runId } }))
      .state,
    'running',
  );
  console.log(
    'API supervisor verified: real queue consumption, HTTP execution, stored results, atomic measured usage, duplicate fencing, cancellation, authority/scope refusal and expiry without replay.',
  );
} finally {
  await worker?.close();
  await queue.obliterate({ force: true });
  await queue.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    await db.outboxEvent.deleteMany({ where: { tenantId } });
    await db.run.deleteMany({ where: { tenantId } });
    await db.repository.deleteMany({ where: { tenantId } });
    await db.installation.deleteMany({ where: { tenantId } });
    await db.tenant.deleteMany({ where: { id: tenantId } });
  } finally {
    await db.$disconnect();
  }
}
