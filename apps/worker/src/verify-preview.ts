/** Real PostgreSQL + HTTP integration with an ephemeral, disposable health fixture. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createDatabase, stopRuns } from '@dogwatch/database';
import { repositoryPolicySchema } from '@dogwatch/contracts';
import { preparePreview } from './prepare-preview.js';
import { previewBindingSchema } from './preview.js';

const database = createDatabase(
  process.env.DATABASE_URL ??
    'postgresql://dogwatch:dogwatch_local_only@127.0.0.1:5433/dogwatch',
);
const tenantId = randomUUID();
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
let hits = 0;
const server = createServer((request, response) => {
  if (request.url === '/redirect') {
    response.writeHead(302, { location: 'http://169.254.169.254/' });
    response.end();
    return;
  }
  // The first health request mimics a preview still deploying, then becomes ready.
  response.writeHead(++hits === 1 ? 503 : 200);
  response.end('synthetic readiness fixture');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const binding = previewBindingSchema.parse({
  tenantId,
  repositoryId,
  pullRequestNumber: 42,
  headSha: 'a'.repeat(40),
  deploymentId: randomUUID(),
  url: `${origin}/health`,
  allowedOrigins: [origin],
  maxWaitSeconds: 2,
  maxRequests: 3,
  pollIntervalMs: 50,
});
const seed = async (headSha = binding.headSha) =>
  database.run.create({
    data: {
      tenantId,
      repositoryId: BigInt(repositoryId),
      deliveryId: randomUUID(),
      pullRequestNumber: 42,
      headSha,
      state: 'queued',
      policySnapshot: policy,
      budgetSnapshot: policy.budget,
    },
  });
try {
  await database.tenant.create({
    data: { id: tenantId, name: 'Readiness fixture' },
  });
  await database.installation.create({
    data: { id: BigInt(installationId), tenantId },
  });
  await database.repository.create({
    data: {
      id: BigInt(repositoryId),
      tenantId,
      installationId: BigInt(installationId),
      fullName: 'fixture/readiness',
    },
  });
  const run = await seed();
  const outcome = await preparePreview(
    database,
    { tenantId, runId: run.id },
    [binding],
    { currentHead: async () => binding.headSha, fixture: true },
  );
  assert.deepEqual(outcome, { status: 'ready', requests: 2 });
  const ready = await database.run.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(ready.state, 'waiting_for_preview');
  assert.ok(ready.previewReadyAt);
  assert.equal(ready.headSha, binding.headSha);
  // Completed setup cannot be double-claimed or moved into running by this phase.
  assert.deepEqual(
    await preparePreview(database, { tenantId, runId: run.id }, [binding], {
      currentHead: async () => binding.headSha,
      fixture: true,
    }),
    { status: 'not_claimed' },
  );
  const missing = await seed('b'.repeat(40));
  await preparePreview(database, { tenantId, runId: missing.id }, [binding], {
    currentHead: async () => 'b'.repeat(40),
    fixture: true,
  });
  assert.equal(
    (await database.run.findUniqueOrThrow({ where: { id: missing.id } }))
      .setupFailureCode,
    'preview_missing',
  );
  const redirected = await seed();
  const redirect = await preparePreview(
    database,
    { tenantId, runId: redirected.id },
    [{ ...binding, url: `${origin}/redirect` }],
    { currentHead: async () => binding.headSha, fixture: true },
  );
  assert.equal(
    redirect.status === 'failed' && redirect.code,
    'preview_forbidden',
  );
  const stale = await seed();
  await preparePreview(database, { tenantId, runId: stale.id }, [binding], {
    currentHead: async () => 'c'.repeat(40),
    fixture: true,
  });
  assert.equal(
    (await database.run.findUniqueOrThrow({ where: { id: stale.id } })).state,
    'superseded',
  );
  const cancelled = await seed();
  const cancelledResult = await preparePreview(
    database,
    { tenantId, runId: cancelled.id },
    [binding],
    {
      fixture: true,
      currentHead: async () => binding.headSha,
      probe: async () => {
        await stopRuns(database, {
          policy,
          actorId: 30,
          pullRequestNumber: 42,
          headSha: binding.headSha,
          operation: 'cancel',
        });
        return 200;
      },
    },
  );
  assert.equal(
    cancelledResult.status === 'failed' && cancelledResult.code,
    'preview_stopped',
  );
  assert.equal(
    (await database.run.findUniqueOrThrow({ where: { id: cancelled.id } }))
      .state,
    'cancelled',
  );
  process.stdout.write(
    'Preview verified: real polling, exact SHA binding, ready evidence, redirects, stale heads, cancellation without resurrection.\n',
  );
} finally {
  // Only this ephemeral server and random tenant are removed; no database reset.
  server.close();
  server.closeAllConnections();
  await database.$transaction(async (tx) => {
    await tx.run.deleteMany({ where: { tenantId } });
    await tx.repository.deleteMany({ where: { tenantId } });
    await tx.installation.deleteMany({ where: { tenantId } });
    await tx.tenant.deleteMany({ where: { id: tenantId } });
  });
  await database.$disconnect();
}
