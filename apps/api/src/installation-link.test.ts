import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createInstallationLinker } from './installation-link.js';
const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
function fixture() {
  const input = {
    tenantId: randomUUID(),
    installationId: 10,
    sessionToken: 'a'.repeat(43),
  };
  let commits = 0,
    reads = 0,
    pages = 0,
    owner = true;
  const installation = {
    id: 10,
    app_id: 1,
    suspended_at: null as string | null,
    account: { id: 42, type: 'User', login: 'fixture' },
  };
  const config = {
    actor: 42,
    access: true,
    role: 'admin',
    state: 'active',
    memberId: 42,
    orgId: 100,
    revoke: false,
    changeAccount: false,
    fullPages: false,
  };
  const calls: string[] = [];
  const transport: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    assert.equal(init?.method, 'GET');
    calls.push(path);
    if (path === '/user')
      return Response.json({ id: config.actor, type: 'User' });
    if (path === '/app/installations/10') {
      reads++;
      if (reads === 2 && config.changeAccount) installation.account.id++;
      return Response.json(installation);
    }
    if (path === '/user/installations') {
      pages++;
      const entries = config.access
        ? [installation]
        : config.fullPages
          ? Array.from({ length: 100 }, (_, i) => ({
              ...installation,
              id: 1000 + i,
            }))
          : [];
      return Response.json({ installations: entries });
    }
    if (path === '/user/memberships/orgs/fixture')
      return Response.json({
        state: config.state,
        role: config.role,
        organization: { id: config.orgId },
        user: { id: config.memberId },
      });
    throw Error('Unexpected request');
  };
  const link = createInstallationLinker(
    1,
    key,
    {
      async owner() {
        if (!owner) throw Error('installation_link_denied');
        return '42';
      },
      async link(value) {
        if (config.revoke) throw Error('installation_link_denied');
        assert.equal(value.githubId, '42');
        assert.ok(!JSON.stringify(value).includes(input.sessionToken));
        commits++;
        return commits === 1 ? 'linked' : 'unchanged';
      },
    },
    transport,
  );
  return {
    input,
    installation,
    config,
    calls,
    link: () => link(input, 'synthetic-user-token'),
    counts: () => ({ commits, pages }),
    deny: () => {
      owner = false;
    },
  };
}
test('personal installation links only for its verified owner and retries are idempotent', async () => {
  const f = fixture();
  assert.equal((await f.link()).status, 'linked');
  assert.equal((await f.link()).status, 'unchanged');
  assert.ok(!JSON.stringify(await f.link()).includes('token'));
});
test('active organization admin may link; members and pending admins cannot', async () => {
  for (const role of ['admin', 'member']) {
    const f = fixture();
    f.installation.account = {
      id: 100,
      type: 'Organization',
      login: 'fixture',
    };
    f.config.role = role;
    if (role === 'admin') assert.equal((await f.link()).status, 'linked');
    else {
      await assert.rejects(f.link());
      assert.equal(f.counts().commits, 0);
    }
  }
  const f = fixture();
  f.installation.account = { id: 100, type: 'Organization', login: 'fixture' };
  f.config.state = 'pending';
  await assert.rejects(f.link());
});
test('local owner authority is required before GitHub calls and again at commit', async () => {
  const f = fixture();
  f.deny();
  await assert.rejects(f.link(), /denied/);
  assert.equal(f.calls.length, 0);
  const revoked = fixture();
  revoked.config.revoke = true;
  await assert.rejects(revoked.link(), /denied/);
  assert.equal(revoked.counts().commits, 0);
});
test('wrong token identity, foreign App, suspension and absent user access prevent links', async () => {
  for (const kind of ['actor', 'app', 'suspended', 'access', 'personal']) {
    const f = fixture();
    if (kind === 'actor') f.config.actor = 43;
    if (kind === 'app') f.installation.app_id = 2;
    if (kind === 'suspended')
      f.installation.suspended_at = '2026-10-25T00:00:00Z';
    if (kind === 'access') f.config.access = false;
    if (kind === 'personal') f.installation.account.id = 99;
    await assert.rejects(f.link());
    assert.equal(f.counts().commits, 0);
  }
});
test('organization and member numeric identities must match, regardless of names', async () => {
  for (const kind of ['org', 'member']) {
    const f = fixture();
    f.installation.account = {
      id: 100,
      type: 'Organization',
      login: 'fixture',
    };
    if (kind === 'org') f.config.orgId = 101;
    else f.config.memberId = 43;
    await assert.rejects(f.link(), /owner_required/);
    assert.equal(f.counts().commits, 0);
  }
});
test('installation account changes before commit fail closed', async () => {
  const f = fixture();
  f.config.changeAccount = true;
  await assert.rejects(f.link(), /account_changed/);
  assert.equal(f.counts().commits, 0);
});
test('user installation enumeration is bounded and never falls back to public visibility', async () => {
  const f = fixture();
  f.config.access = false;
  f.config.fullPages = true;
  await assert.rejects(f.link(), /scan_limit/);
  assert.deepEqual(f.counts(), { commits: 0, pages: 5 });
});
