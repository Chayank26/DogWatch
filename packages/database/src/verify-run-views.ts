import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  createDatabase,
  createIdentityStore,
  createRunViewStore,
} from './index.js';
const db = createDatabase(
  'postgresql://dogwatch:dogwatch_local_only@127.0.0.1:5433/dogwatch',
);
const identities = createIdentityStore(db),
  views = createRunViewStore(db);
const tenants = [randomUUID(), randomUUID()],
  ids = [0, 1].map(() => BigInt('0x' + randomBytes(6).toString('hex')));
const token = randomBytes(32).toString('hex');
const runs: string[][] = [[], []];
try {
  await identities.issue(
    String(ids[0]),
    'run-view-fixture',
    token,
    new Date(Date.now() + 60000),
  );
  const userId = (await identities.resolve(token, new Date()))!.id;
  for (let i = 0; i < 2; i++) {
    await db.tenant.create({ data: { id: tenants[i], name: 'Run views' } });
    await db.installation.create({
      data: { id: ids[i], tenantId: tenants[i] },
    });
    await db.repository.create({
      data: {
        id: ids[i],
        tenantId: tenants[i],
        installationId: ids[i],
        fullName: 'fixture/runs',
      },
    });
    for (let n = 0; n < (i === 0 ? 51 : 1); n++) runs[i].push(randomUUID());
    await db.run.createMany({
      data: runs[i].map((id) => ({
        id,
        tenantId: tenants[i],
        repositoryId: ids[i],
        deliveryId: randomUUID(),
        pullRequestNumber: 1,
        headSha: 'a'.repeat(40),
        state: 'completed',
        policySnapshot: { secret: 'must-not-leak' },
        budgetSnapshot: {},
        previewSnapshot: { url: 'https://private.example' },
        createdAt: new Date(0),
      })),
    });
  }
  await db.membership.create({
    data: { tenantId: tenants[0], userId, role: 'member' },
  });
  const first = await views.list(token, tenants[0]);
  assert.equal(first.runs.length, 50);
  assert.ok(first.nextCursor);
  const second = await views.list(token, tenants[0], first.nextCursor);
  assert.equal(second.runs.length, 1);
  assert.equal(second.nextCursor, null);
  assert.equal(
    new Set([...first.runs, ...second.runs].map((r) => r.id)).size,
    51,
  );
  await assert.rejects(views.list(token, tenants[1]), /not_found/);
  await assert.rejects(views.list(token, tenants[0], runs[1][0]), /not_found/);
  await assert.rejects(
    views.detail(token, tenants[0], runs[1][0]),
    /not_found/,
  );
  const detail = await views.detail(token, tenants[0], runs[0][0]);
  assert.equal(detail.evidence.status, 'not_cataloged');
  assert.ok(!JSON.stringify(detail).includes('must-not-leak'));
  assert.ok(!JSON.stringify(detail).includes('private.example'));
  await db.membership.delete({
    where: { tenantId_userId: { tenantId: tenants[0], userId } },
  });
  await assert.rejects(
    views.detail(token, tenants[0], runs[0][0]),
    /not_found/,
  );
  await identities.revoke(token);
  await assert.rejects(views.list(token, tenants[0]), /not_found/);
  process.stdout.write(
    'Run views verified: member access, stable bounded pagination, foreign tenant/run/cursor refusal, safe fields and revocation.\n',
  );
} finally {
  await db.run.deleteMany({ where: { tenantId: { in: tenants } } });
  await db.repository.deleteMany({ where: { id: { in: ids } } });
  await db.installation.deleteMany({ where: { id: { in: ids } } });
  await db.user.deleteMany({ where: { githubId: ids[0] } });
  await db.tenant.deleteMany({ where: { id: { in: tenants } } });
  await db.$disconnect();
}
