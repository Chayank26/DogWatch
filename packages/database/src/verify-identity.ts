/** Local Compose only. Random fixture records are removed in finally. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createDatabase, createIdentityStore } from './index.js';
const db = createDatabase(
  'postgresql://dogwatch:dogwatch_local_only@127.0.0.1:5433/dogwatch',
);
const store = createIdentityStore(db);
const githubId = BigInt('0x' + randomBytes(6).toString('hex'));
const tenantId = randomUUID(),
  otherTenantId = randomUUID();
const state = randomBytes(32).toString('hex'),
  browser = randomBytes(32).toString('hex');
const first = randomBytes(32).toString('hex'),
  second = randomBytes(32).toString('hex');
const now = new Date(),
  future = new Date(now.getTime() + 60000);
try {
  await store.begin(state, browser, future);
  assert.equal(await store.consume(state, '0'.repeat(64), now), false);
  const attempts = await Promise.all([
    store.consume(state, browser, now),
    store.consume(state, browser, now),
  ]);
  assert.deepEqual(attempts.sort(), [false, true]);
  await store.begin(state, browser, now);
  assert.equal(await store.consume(state, browser, now), false);
  await store.issue(String(githubId), 'identity-fixture', first, future);
  let identity = await store.resolve(first, now);
  assert.ok(identity);
  assert.equal(identity.memberships.length, 0);
  const userId = identity.id;
  await db.tenant.createMany({
    data: [
      { id: tenantId, name: 'Identity verification' },
      { id: otherTenantId, name: 'Unrelated verification tenant' },
    ],
  });
  await db.membership.create({ data: { tenantId, userId, role: 'owner' } });
  identity = await store.resolve(first, now);
  assert.deepEqual(identity?.memberships, [
    { tenantId, name: 'Identity verification', role: 'owner' },
  ]);
  await db.membership.update({
    where: { tenantId_userId: { tenantId, userId } },
    data: { role: 'member' },
  });
  assert.equal(
    (await store.resolve(first, now))?.memberships[0].role,
    'member',
  );
  await db.membership.delete({
    where: { tenantId_userId: { tenantId, userId } },
  });
  assert.equal((await store.resolve(first, now))?.memberships.length, 0);
  await store.issue(String(githubId), 'renamed-fixture', second, future, first);
  assert.equal(await store.resolve(first, now), null);
  assert.equal((await store.resolve(second, now))?.id, userId);
  assert.equal((await store.resolve(second, now))?.login, 'renamed-fixture');
  assert.equal(await store.resolve(second, future), null);
  await db.user.update({ where: { id: userId }, data: { disabledAt: now } });
  assert.equal(await store.resolve(second, now), null);
  await assert.rejects(
    store.issue(String(githubId), 'blocked', first, future),
    /identity_disabled/,
  );
  assert.equal(await db.loginSession.count({ where: { tokenHash: first } }), 0);
  await store.revoke(second);
  assert.equal(await db.loginSession.count({ where: { userId } }), 0);
  process.stdout.write(
    'Identity persistence verified: single-use state, expiry, membership revocation, tenant scoping, role changes, stable identity, session rotation and disabled users.\n',
  );
} finally {
  await db.loginAttempt.deleteMany({ where: { stateHash: state } });
  await db.user.deleteMany({ where: { githubId } });
  await db.tenant.deleteMany({
    where: { id: { in: [tenantId, otherTenantId] } },
  });
  await db.$disconnect();
}
