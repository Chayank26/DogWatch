/** Isolated fixtures against local Compose only; no GitHub requests. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  createDatabase,
  createIdentityStore,
  createInstallationLinkStore,
} from './index.js';
const db = createDatabase(
  'postgresql://dogwatch:dogwatch_local_only@127.0.0.1:5433/dogwatch',
);
const identity = createIdentityStore(db),
  links = createInstallationLinkStore(db);
const tenants = [randomUUID(), randomUUID()];
const githubIds = [0, 1].map(() =>
  BigInt('0x' + randomBytes(6).toString('hex')),
);
const sessions = [0, 1].map(() => randomBytes(32).toString('hex'));
const installationIds = [0, 1].map(() =>
  Number(BigInt('0x' + randomBytes(6).toString('hex'))),
);
try {
  await db.tenant.createMany({
    data: tenants.map((id) => ({ id, name: 'Link verification' })),
  });
  const users: string[] = [];
  for (let i = 0; i < 2; i++) {
    await identity.issue(
      String(githubIds[i]),
      'link-fixture',
      sessions[i],
      new Date(Date.now() + 60000),
    );
    users.push((await identity.resolve(sessions[i], new Date()))!.id);
    await db.membership.create({
      data: { tenantId: tenants[i], userId: users[i], role: 'owner' },
    });
  }
  const scope = { tenantId: tenants[0], sessionHash: sessions[0] };
  const input = {
    ...scope,
    githubId: String(githubIds[0]),
    installationId: installationIds[0],
  };
  assert.equal(await links.owner(scope), String(githubIds[0]));
  const same = await Promise.all([links.link(input), links.link(input)]);
  assert.deepEqual(same.sort(), ['linked', 'unchanged']);
  const other = {
    tenantId: tenants[1],
    sessionHash: sessions[1],
    githubId: String(githubIds[1]),
    installationId: installationIds[0],
  };
  await assert.rejects(links.link(other), /conflict/);
  const competing = await Promise.allSettled([
    links.link({ ...input, installationId: installationIds[1] }),
    links.link({ ...other, installationId: installationIds[1] }),
  ]);
  assert.equal(competing.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(
    await db.installation.count({
      where: { id: { in: installationIds.map(BigInt) } },
    }),
    2,
  );
  await assert.rejects(
    links.link({ ...input, githubId: String(githubIds[1]) }),
    /denied/,
  );
  await assert.rejects(
    links.owner({ ...scope, tenantId: tenants[1] }),
    /denied/,
  );
  await db.membership.update({
    where: { tenantId_userId: { tenantId: tenants[0], userId: users[0] } },
    data: { role: 'member' },
  });
  await assert.rejects(links.owner(scope), /denied/);
  await assert.rejects(links.link(input), /denied/);
  await db.membership.update({
    where: { tenantId_userId: { tenantId: tenants[0], userId: users[0] } },
    data: { role: 'owner' },
  });
  await db.user.update({
    where: { id: users[0] },
    data: { disabledAt: new Date() },
  });
  await assert.rejects(links.link(input), /denied/);
  await db.user.update({ where: { id: users[0] }, data: { disabledAt: null } });
  await db.loginSession.update({
    where: { tokenHash: sessions[0] },
    data: { expiresAt: new Date(0) },
  });
  await assert.rejects(links.link(input), /denied/);
  await identity.revoke(sessions[1]);
  await assert.rejects(links.link(other), /denied/);
  process.stdout.write(
    'Installation links verified: concurrent idempotence, cross-tenant races, actor binding, demotion, disablement, expiry and logout.\n',
  );
} finally {
  await db.installation.deleteMany({
    where: { id: { in: installationIds.map(BigInt) } },
  });
  await db.user.deleteMany({ where: { githubId: { in: githubIds } } });
  await db.tenant.deleteMany({ where: { id: { in: tenants } } });
  await db.$disconnect();
}
