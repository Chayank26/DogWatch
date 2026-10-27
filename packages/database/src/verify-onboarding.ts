import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  createDatabase,
  createIdentityStore,
  createOnboardingStore,
} from './index.js';
const db = createDatabase(
  'postgresql://dogwatch:dogwatch_local_only@127.0.0.1:5433/dogwatch',
);
const identity = createIdentityStore(db),
  onboarding = createOnboardingStore(db);
const githubId = BigInt('0x' + randomBytes(6).toString('hex'));
const token = randomBytes(32).toString('hex'),
  otherTenant = randomUUID();
let tenantId: string | undefined;
try {
  await identity.issue(
    String(githubId),
    'onboarding-fixture',
    token,
    new Date(Date.now() + 60000),
  );
  assert.deepEqual(await onboarding.status(token), { workspaces: [] });
  const results = await Promise.all([
    onboarding.create(token, 'Fixture team'),
    onboarding.create(token, 'Fixture team'),
  ]);
  tenantId = results[0].tenantId;
  assert.equal(results[1].tenantId, tenantId);
  assert.equal((await onboarding.status(token)).workspaces[0].role, 'owner');
  await assert.rejects(
    onboarding.create(token, 'Another team'),
    /already_member/,
  );
  await db.tenant.create({ data: { id: otherTenant, name: 'Other tenant' } });
  assert.equal((await onboarding.status(token)).workspaces.length, 1);
  const userId = (await identity.resolve(token, new Date()))!.id;
  await db.membership.update({
    where: { tenantId_userId: { tenantId, userId } },
    data: { role: 'member' },
  });
  await assert.rejects(
    onboarding.create(token, 'Fixture team'),
    /already_member/,
  );
  await db.user.update({
    where: { id: userId },
    data: { disabledAt: new Date() },
  });
  await assert.rejects(onboarding.status(token), /unauthorized/);
  await assert.rejects(onboarding.create(token, 'No access'), /unauthorized/);
  await identity.revoke(token);
  await assert.rejects(onboarding.status(token), /unauthorized/);
  process.stdout.write(
    'Onboarding verified: atomic first workspace, concurrent retries, owner assignment, tenant-scoped status, role/disablement/revocation guards.\n',
  );
} finally {
  await db.user.deleteMany({ where: { githubId } });
  await db.tenant.deleteMany({
    where: { id: { in: [otherTenant, ...(tenantId ? [tenantId] : [])] } },
  });
  await db.$disconnect();
}
