import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { actualUsageSchema } from '@dogwatch/database';
import type { IdentityStore, UsageStore } from '@dogwatch/database';
import { createApiApp } from './app.js';
import { createIdentityRouter } from './identity.js';
test('reported usage requires explicit bounded counters and refuses fabricated partial measurements', () => {
  const complete = {
    runSeconds: 0,
    browserSeconds: 0,
    apiRequests: 0,
    browserSteps: 0,
    modelCalls: 0,
    modelTokens: 0,
    modelCostCents: 0,
    artifactBytes: 0,
  };
  assert.deepEqual(actualUsageSchema.parse(complete), complete);
  for (const field of Object.keys(complete)) {
    const partial = { ...complete } as Record<string, number>;
    delete partial[field];
    assert.equal(actualUsageSchema.safeParse(partial).success, false);
    assert.equal(
      actualUsageSchema.safeParse({ ...complete, [field]: -1 }).success,
      false,
    );
  }
  assert.equal(
    actualUsageSchema.safeParse({ ...complete, token: 'secret' }).success,
    false,
  );
});
test('usage endpoint requires a session and conceals foreign tenant summaries', async () => {
  const tenant = randomUUID();
  const store = {
    async summary(_hash, tenantId) {
      if (tenantId !== tenant) throw Error('usage_not_found');
      return {
        day: '2026-10-27',
        pendingReservations: 1,
        recent: [{ actual: null }],
      };
    },
  } as unknown as UsageStore;
  const app = createApiApp(
    undefined,
    undefined,
    undefined,
    undefined,
    createIdentityRouter(
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
      undefined,
      store,
    ),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  try {
    assert.equal(
      (await fetch(`${base}/auth/tenants/${tenant}/usage`)).status,
      401,
    );
    const headers = { cookie: 'dogwatch-session=' + 'a'.repeat(43) };
    assert.equal(
      (await fetch(`${base}/auth/tenants/${randomUUID()}/usage`, { headers }))
        .status,
      404,
    );
    const response = await fetch(`${base}/auth/tenants/${tenant}/usage`, {
      headers,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).recent[0].actual, null);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});
