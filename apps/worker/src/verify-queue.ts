/**
 * Real Postgres/Redis integration with an isolated random queue and tenant.
 * This command never drains the production queue or dispatches another tenant's
 * pending work. Fixture records and this queue's keys alone are cleaned afterward.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import {
  createDatabase,
  dispatchNext,
  dispatchAttemptLimit,
} from '@dogwatch/database';
import { createRunQueue, enqueueRun, createRunWorker } from '@dogwatch/queue';
import type { RunJob } from '@dogwatch/queue';
import type { Job } from '@dogwatch/queue';

const db = createDatabase(
  process.env.DATABASE_URL ??
    'postgresql://dogwatch:dogwatch_local_only@127.0.0.1:5433/dogwatch',
);
const redis = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';
const tenantId = randomUUID();
const installationId = BigInt(
  `0x${randomUUID().replaceAll('-', '').slice(0, 12)}`,
);
const repositoryId = installationId + 1n;
const name = `dogwatch-verification-${randomUUID()}`;
const queue = createRunQueue(redis, name);
let worker: ReturnType<typeof createRunWorker> | undefined;

/** Bounded polling checks Redis's actual lifecycle, rather than guessing with a sleep. */
async function waitFor(job: Job, expected: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if ((await job.getState()) === expected) return;
    await pause(50);
  }
  throw new Error(`Job did not reach ${expected}`);
}
async function createPending() {
  const run = await db.run.create({
    data: {
      tenantId,
      repositoryId,
      deliveryId: randomUUID(),
      pullRequestNumber: 42,
      headSha: 'a'.repeat(40),
      policySnapshot: { fixture: true },
      budgetSnapshot: { fixture: true },
    },
  });
  await db.outboxEvent.create({ data: { tenantId, runId: run.id } });
  return { runId: run.id, tenantId };
}
try {
  await queue.waitUntilReady();
  await db.tenant.create({
    data: { id: tenantId, name: 'Queue verification fixture' },
  });
  await db.installation.create({ data: { id: installationId, tenantId } });
  await db.repository.create({
    data: {
      id: repositoryId,
      tenantId,
      installationId,
      fullName: 'fixture/queue',
    },
  });
  const original = await createPending();
  // Simulate crash after Redis add, before Postgres marks the outbox published.
  await enqueueRun(queue, original);
  const handoffs = await Promise.all([
    dispatchNext(db, (data) => enqueueRun(queue, data), tenantId),
    dispatchNext(db, (data) => enqueueRun(queue, data), tenantId),
  ]);
  assert.deepEqual(handoffs.sort(), ['idle', 'published']);
  assert.equal(await queue.getWaitingCount(), 1);
  assert.equal(
    (await db.run.findUniqueOrThrow({ where: { id: original.runId } })).state,
    'queued',
  );
  assert.ok(
    (
      await db.outboxEvent.findFirstOrThrow({
        where: { runId: original.runId },
      })
    ).publishedAt,
  );

  const failure = await createPending();
  for (let attempt = 1; attempt <= dispatchAttemptLimit; attempt++) {
    // Make scheduled retries due immediately in this fixture only; production waits.
    await db.outboxEvent.updateMany({
      where: { tenantId, runId: failure.runId },
      data: { nextAttemptAt: new Date(0) },
    });
    assert.equal(
      await dispatchNext(
        db,
        async () => {
          throw new Error('synthetic transport outage');
        },
        tenantId,
      ),
      attempt === dispatchAttemptLimit ? 'failed' : 'retry',
    );
  }
  assert.equal(
    (await db.run.findUniqueOrThrow({ where: { id: failure.runId } })).state,
    'failed',
  );
  assert.equal(
    await dispatchNext(db, (data) => enqueueRun(queue, data), tenantId),
    'idle',
  );

  const permanent = await createPending();
  assert.equal(
    await dispatchNext(
      db,
      async () => {
        throw Object.assign(new Error('fixture permanent conflict'), {
          retryable: false,
        });
      },
      tenantId,
    ),
    'failed',
  );
  assert.equal(
    (
      await db.outboxEvent.findFirstOrThrow({
        where: { runId: permanent.runId },
      })
    ).attempts,
    1,
  );

  const alwaysFailId = randomUUID();
  let attempts = 0;
  let active = 0,
    peak = 0;
  worker = createRunWorker(
    redis,
    async (data: RunJob) => {
      active++;
      peak = Math.max(peak, active);
      try {
        if (data.runId === alwaysFailId)
          throw new Error('fixture persistent processor outage');
        // Processor deliberately fails twice, then succeeds within the three-attempt budget.
        if (data.runId === original.runId && ++attempts < 3)
          throw new Error('synthetic transient failure');
        await pause(50);
      } finally {
        active--;
      }
    },
    name,
    2,
  );
  const retryJob = await queue.getJob(original.runId);
  assert.ok(retryJob);
  await waitFor(retryJob, 'completed');
  assert.equal(attempts, 3);
  assert.equal(retryJob.opts.attempts, 3);

  const jobs = await Promise.all(
    Array.from({ length: 4 }, () =>
      enqueueRun(queue, { tenantId, runId: randomUUID() }),
    ),
  );
  await Promise.all(jobs.map((job) => waitFor(job, 'completed')));
  assert.ok(peak <= 2);
  // Invalid payload is unrecoverable: it must not burn all processor retry attempts.
  const exhaustedJob = await enqueueRun(queue, {
    tenantId,
    runId: alwaysFailId,
  });
  await waitFor(exhaustedJob, 'failed');
  assert.equal((await queue.getJob(alwaysFailId))?.attemptsMade, 3);
  const invalid = await queue.add(
    'run.requested',
    { tenantId, runId: 'invalid' },
    { jobId: randomUUID() },
  );
  await waitFor(invalid, 'failed');
  await assert.rejects(
    enqueueRun(queue, { runId: original.runId, tenantId: randomUUID() }),
  );
  process.stdout.write(
    'Queue verified: crash-window reconciliation, concurrent dispatch, retry exhaustion, processor retries, concurrency, invalid jobs.\n',
  );
} finally {
  await worker?.close();
  // Only the random fixture queue is obliterated; this is not a Redis flush/reset.
  await queue.obliterate({ force: true });
  await queue.close();
  try {
    await db.$transaction(async (tx) => {
      await tx.outboxEvent.deleteMany({ where: { tenantId } });
      await tx.run.deleteMany({ where: { tenantId } });
      await tx.repository.deleteMany({ where: { tenantId } });
      await tx.installation.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  } finally {
    await db.$disconnect();
  }
}
