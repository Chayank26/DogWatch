/** Local-only recovery drill. Never accepts customer database/queue targets. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDatabase,
  dispatchNext,
  dispatchAttemptLimit,
} from '@dogwatch/database';
import { createRunQueue, enqueueRun } from '@dogwatch/queue';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const redis = 'redis://127.0.0.1:6380';
const databaseUrl = (name: string) => {
  assert.match(name, /^dogwatch_recovery_[a-f0-9]{32}_(source|restore)$/);
  return `postgresql://dogwatch:dogwatch_local_only@127.0.0.1:5433/${name}`;
};
function docker(args: string[], input?: Buffer) {
  return execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', ...args],
    {
      cwd: root,
      input,
      timeout: 60000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
}
function sql(command: string) {
  docker([
    'psql',
    '-X',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'dogwatch',
    '-d',
    'postgres',
    '-c',
    command,
  ]);
}

// This child dies after Redis acknowledges the job, while PostgreSQL's transaction
// remains open. Its disconnected DB session rolls back; no fake transaction proxy.
if (process.argv[2] === '--terminate-after-enqueue') {
  const [, , , name, queueName, tenantId] = process.argv;
  assert.match(queueName, /^dogwatch-recovery-[a-f0-9]{32}$/);
  assert.match(tenantId, /^[a-f0-9-]{36}$/);
  const db = createDatabase(databaseUrl(name));
  const queue = createRunQueue(redis, queueName);
  await dispatchNext(
    db,
    async (data) => {
      await enqueueRun(queue, data);
      process.exit(73);
    },
    tenantId,
  );
  throw Error('Crash fixture did not reach the handoff boundary');
} else {
  assert.equal(process.argv.length, 2, 'This drill takes no target arguments');
  const suffix = randomUUID().replaceAll('-', '');
  const sourceName = `dogwatch_recovery_${suffix}_source`;
  const restoreName = `dogwatch_recovery_${suffix}_restore`;
  const queueName = `dogwatch-recovery-${suffix}`;
  const tenantId = randomUUID();
  const source = createDatabase(databaseUrl(sourceName));
  const restored = createDatabase(databaseUrl(restoreName));
  const queue = createRunQueue(redis, queueName);
  const directory = mkdtempSync(join(tmpdir(), 'dogwatch-recovery-'));
  const created: string[] = [];
  const started = performance.now();
  try {
    for (const name of [sourceName, restoreName]) {
      sql(`CREATE DATABASE "${name}"`);
      created.push(name);
    }
    execFileSync('npm', ['run', 'migrate', '-w', '@dogwatch/database'], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl(sourceName) },
      timeout: 60000,
      stdio: 'pipe',
    });
    await queue.waitUntilReady();
    await source.tenant.create({
      data: { id: tenantId, name: 'Disposable recovery drill' },
    });
    await source.tenantQuota.create({ data: { tenantId, maxConcurrent: 10 } });
    await source.installation.create({ data: { id: 1n, tenantId } });
    await source.repository.create({
      data: {
        id: 1n,
        tenantId,
        installationId: 1n,
        fullName: 'fixture/recovery',
      },
    });
    async function pending(db: typeof source) {
      const run = await db.run.create({
        data: {
          tenantId,
          repositoryId: 1n,
          deliveryId: randomUUID(),
          pullRequestNumber: 42,
          headSha: 'a'.repeat(40),
          policySnapshot: {},
          budgetSnapshot: {},
        },
      });
      await db.outboxEvent.create({ data: { tenantId, runId: run.id } });
      return run;
    }
    const original = await pending(source);
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(import.meta.url),
        '--terminate-after-enqueue',
        sourceName,
        queueName,
        tenantId,
      ],
      { cwd: root, stdio: 'ignore' },
    );
    const exit = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(Error('Crash drill timed out'));
      }, 20000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.equal(exit, 73);
    // Acquiring the run lock also waits for the disconnected transaction rollback.
    await source.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Run" WHERE "id" = ${original.id}::uuid FOR UPDATE`;
      assert.equal(
        (await tx.run.findUniqueOrThrow({ where: { id: original.id } })).state,
        'received',
      );
      assert.equal(await tx.usageReservation.count(), 0);
      const outbox = await tx.outboxEvent.findFirstOrThrow();
      assert.equal(outbox.publishedAt, null);
      assert.equal(outbox.attempts, 0);
    });
    assert.ok(await queue.getJob(original.id));

    async function snapshot(db: typeof source) {
      return {
        tenants: await db.tenant.findMany(),
        installations: await db.installation.findMany(),
        repositories: await db.repository.findMany(),
        runs: await db.run.findMany({ orderBy: { id: 'asc' } }),
        outbox: await db.outboxEvent.findMany({ orderBy: { id: 'asc' } }),
        quotas: await db.tenantQuota.findMany(),
        usage: await db.usageReservation.findMany(),
      };
    }
    // Seed a committed reservation too, so backup verification covers quota state.
    const reserved = await pending(source);
    await source.outboxEvent.updateMany({
      where: { runId: original.id },
      data: { nextAttemptAt: new Date('2100-01-01') },
    });
    assert.equal(
      await dispatchNext(source, (data) => enqueueRun(queue, data), tenantId),
      'published',
    );
    assert.equal(
      (await source.run.findUniqueOrThrow({ where: { id: reserved.id } }))
        .state,
      'queued',
    );
    await source.outboxEvent.updateMany({
      where: { runId: original.id },
      data: { nextAttemptAt: new Date(0) },
    });
    const expected = await snapshot(source);
    const backup = join(directory, 'fixture.dump');
    writeFileSync(
      backup,
      docker([
        'pg_dump',
        '-U',
        'dogwatch',
        '-d',
        sourceName,
        '-Fc',
        '--no-owner',
        '--no-acl',
      ]),
      { mode: 0o600 },
    );
    const restoreStarted = performance.now();
    docker(
      [
        'pg_restore',
        '-U',
        'dogwatch',
        '-d',
        restoreName,
        '--exit-on-error',
        '--single-transaction',
        '--no-owner',
        '--no-acl',
      ],
      readFileSync(backup),
    );
    assert.deepEqual(await snapshot(restored), expected);
    const inspectionSql = readFileSync(join(root, 'ops/recovery/inspect.sql'));
    for (const scope of [tenantId, randomUUID()]) {
      const inspection = docker(
        [
          'psql',
          '-X',
          '-v',
          'ON_ERROR_STOP=1',
          '-U',
          'dogwatch',
          '-d',
          restoreName,
          '-v',
          `tenant_id=${scope}`,
          '-v',
          `run_id=${original.id}`,
          '-f',
          '-',
        ],
        inspectionSql,
      ).toString();
      assert.equal(inspection.includes(original.id), scope === tenantId);
    }
    const restoreMs = Math.round(performance.now() - restoreStarted);
    const outcomes = await Promise.all([
      dispatchNext(restored, (data) => enqueueRun(queue, data), tenantId),
      dispatchNext(restored, (data) => enqueueRun(queue, data), tenantId),
    ]);
    assert.deepEqual(outcomes.sort(), ['idle', 'published']);
    assert.equal(await queue.getWaitingCount(), 2);
    assert.equal(await restored.usageReservation.count(), 2);
    assert.equal(
      (await restored.run.findUniqueOrThrow({ where: { id: original.id } }))
        .state,
      'queued',
    );

    const transient = await pending(restored);
    assert.equal(
      await dispatchNext(
        restored,
        async () => {
          throw Error('synthetic transport interruption');
        },
        tenantId,
      ),
      'retry',
    );
    assert.equal(
      (await restored.run.findUniqueOrThrow({ where: { id: transient.id } }))
        .state,
      'received',
    );
    assert.equal(await restored.usageReservation.count(), 3);
    await restored.outboxEvent.updateMany({
      where: { runId: transient.id },
      data: { nextAttemptAt: new Date(0) },
    });
    assert.equal(
      await dispatchNext(restored, (data) => enqueueRun(queue, data), tenantId),
      'published',
    );
    assert.equal(await restored.usageReservation.count(), 3);

    const exhausted = await pending(restored);
    for (let attempt = 1; attempt <= dispatchAttemptLimit; attempt++) {
      await restored.outboxEvent.updateMany({
        where: { runId: exhausted.id },
        data: { nextAttemptAt: new Date(0) },
      });
      assert.equal(
        await dispatchNext(
          restored,
          async () => {
            throw Error('synthetic persistent outage');
          },
          tenantId,
        ),
        attempt === dispatchAttemptLimit ? 'failed' : 'retry',
      );
    }
    assert.equal(
      (await restored.run.findUniqueOrThrow({ where: { id: exhausted.id } }))
        .state,
      'failed',
    );
    assert.equal(
      await restored.usageReservation.count(),
      4,
      'Unknown usage must remain reserved',
    );
    // Redis loss after publication is a reconciliation gap, never permission to replay.
    await (await queue.getJob(original.id))!.remove();
    assert.equal(
      await dispatchNext(restored, (data) => enqueueRun(queue, data), tenantId),
      'idle',
    );
    assert.equal(await queue.getJob(original.id), undefined);
    assert.equal(
      (await restored.run.findUniqueOrThrow({ where: { id: original.id } }))
        .state,
      'queued',
    );
    console.log(
      JSON.stringify({
        drill: 'recovery',
        status: 'passed',
        restoreMs,
        totalMs: Math.round(performance.now() - started),
        checks: [
          'process-termination-rollback',
          'postgres-backup-restore',
          'tenant-scoped-read-only-inspection',
          'stable-job-reconciliation',
          'transient-retry',
          'retry-exhaustion',
          'quota-retention',
          'published-job-loss-no-replay',
        ],
      }),
    );
  } finally {
    // All names are generated here; never drop the application DB or flush Redis.
    const cleanup = await Promise.allSettled([
      queue.obliterate({ force: true }).finally(() => queue.close()),
      source.$disconnect(),
      restored.$disconnect(),
    ]);
    const failures = cleanup.filter((result) => result.status === 'rejected');
    for (const name of created) {
      try {
        sql(`DROP DATABASE "${name}" WITH (FORCE)`);
      } catch (error) {
        failures.push({ status: 'rejected', reason: error });
      }
    }
    rmSync(directory, { recursive: true, force: true });
    assert.equal(
      failures.length,
      0,
      `Recovery fixture cleanup failed (${failures.length}); inspect generated fixture resources`,
    );
  }
}
