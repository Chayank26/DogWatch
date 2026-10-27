import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { manualSettingsSchema } from '@dogwatch/database';
import type { IdentityStore, RunControlStore } from '@dogwatch/database';
import { createApiApp } from './app.js';
import { createIdentityRouter } from './identity.js';
test('owner control HTTP routes enforce cookie, Origin, schema and scoped denial', async () => {
  const tenantId = randomUUID(),
    runId = randomUUID();
  let writes = 0;
  const settings = {
    revision: 0,
    enabled: false,
    budget: manualSettingsSchema.parse({
      expectedRevision: 0,
      enabled: false,
      budget: {},
    }).budget,
  };
  const store = {
    async get(scope) {
      if (scope.tenantId !== tenantId) throw Error('control_not_found');
      return settings;
    },
    async save(scope, input) {
      if (scope.tenantId !== tenantId) throw Error('control_not_found');
      const value = manualSettingsSchema.parse(input);
      writes++;
      return { ...settings, revision: 1, enabled: value.enabled };
    },
  } as RunControlStore;
  const router = createIdentityRouter(
    {
      clientId: 'fixture',
      clientSecret: 'fixture',
      origin: 'http://localhost:4000',
    },
    {} as IdentityStore,
    fetch,
    () => new Date(),
    undefined,
    undefined,
    {
      store,
      rerun: async (_scope, requestId) => {
        assert.ok(requestId);
        writes++;
        return { status: 'accepted', runId, queued: false };
      },
    },
  );
  const server = createApiApp(
    undefined,
    undefined,
    undefined,
    undefined,
    router,
  ).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const path = `/auth/tenants/${tenantId}/runs/${runId}`;
  const cookie = 'dogwatch-session=' + 'a'.repeat(43);
  try {
    assert.equal((await fetch(base + path + '/configuration')).status, 401);
    assert.equal(
      (
        await fetch(
          base + path.replace(tenantId, randomUUID()) + '/configuration',
          { headers: { cookie } },
        )
      ).status,
      404,
    );
    const post = (
      suffix: string,
      data: unknown,
      origin = 'http://localhost:4000',
    ) =>
      fetch(base + path + suffix, {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify(data),
      });
    assert.equal(
      (await post('/configuration', {}, 'https://attacker.example')).status,
      403,
    );
    assert.equal(
      (
        await post('/configuration', {
          expectedRevision: 0,
          enabled: true,
          budget: { maxRunSeconds: 9999 },
        })
      ).status,
      400,
    );
    assert.equal(
      (await post('/rerun', { requestId: randomUUID(), headSha: 'forged' }))
        .status,
      400,
    );
    assert.equal(writes, 0);
    assert.equal(
      (
        await post('/configuration', {
          expectedRevision: 0,
          enabled: true,
          budget: {},
        })
      ).status,
      200,
    );
    const response = await post('/rerun', { requestId: randomUUID() });
    assert.equal(response.status, 202);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      status: 'accepted',
      runId,
      queued: false,
    });
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});
