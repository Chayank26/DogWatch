import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runApiLifecycle } from './api-lifecycle.js';
import type { ApiLifecycleProvider } from './api-lifecycle.js';
import { createFixtureApiLifecycle } from './fixture-api-lifecycle.js';

const scope = {
  tenantId: randomUUID(),
  runId: randomUUID(),
  repositoryId: 20,
  pullRequestNumber: 42,
  headSha: 'a'.repeat(40),
};
const authority = {
  tenantId: scope.tenantId,
  repositoryId: 20,
  pullRequestNumber: 42,
  headSha: scope.headSha,
  deploymentId: 'fixture',
};
function input(origin: string) {
  return {
    scope,
    binding: {
      ...authority,
      url: origin,
      allowedOrigins: [origin],
      maxWaitSeconds: 60,
      maxRequests: 20,
      pollIntervalMs: 1000,
    },
    grant: {
      ...scope,
      deploymentId: 'fixture',
      origin,
      disposableData: true,
      operations: [{ method: 'GET' as const, path: '/health' }],
    },
    generation: { baselineOnly: true },
    contractText: JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Fixture', version: '1' },
      paths: {
        '/health': {
          get: { responses: { '200': { description: 'healthy' } } },
        },
      },
    }),
  };
}
const options = {
  stage: 'boundary' as const,
  fixture: true,
  isCurrent: async () => true,
};

test('real fixture cleanup, fresh namespace replay and configuration incompatibility', async () => {
  const fixture = await createFixtureApiLifecycle(authority);
  try {
    const first = await runApiLifecycle(input(fixture.origin), {
      ...options,
      lifecycle: fixture.lifecycle,
    });
    assert.equal(first.cleanup.status, 'verified');
    assert.equal(first.status, 'completed');
    assert.ok(first.capsule);
    assert.equal((await fetch(fixture.origin + '/health')).status, 503);
    const next = input(fixture.origin);
    next.scope = { ...scope, runId: randomUUID() };
    next.grant = { ...next.grant, ...next.scope };
    const replay = await runApiLifecycle(next, {
      ...options,
      lifecycle: fixture.lifecycle,
      replay: first.capsule,
    });
    assert.equal(replay.replay.status, 'matched');
    assert.notEqual(replay.namespace.namespaceId, first.namespace.namespaceId);
    const changed = await runApiLifecycle(
      { ...next, generation: { baselineOnly: false } },
      { ...options, lifecycle: fixture.lifecycle, replay: first.capsule },
    );
    assert.equal(changed.replay.status, 'incompatible');
    assert.equal(changed.cleanup.status, 'not_needed');
    const drift = await runApiLifecycle(next, {
      ...options,
      lifecycle: fixture.lifecycle,
      replay: { ...first.capsule, outcomeDigest: 'f'.repeat(64) },
    });
    assert.equal(drift.replay.status, 'different');
    const incompatible = await runApiLifecycle(next, {
      ...options,
      lifecycle: fixture.lifecycle,
      replay: { ...first.capsule, datasetDigest: 'f'.repeat(64) },
    });
    assert.equal(incompatible.replay.status, 'incompatible');
    assert.equal(incompatible.execution, undefined);
    assert.equal(incompatible.cleanup.status, 'verified');
    assert.ok(!JSON.stringify(first.capsule).includes('fixture-alice'));
  } finally {
    await fixture.close();
  }
});

test('cleanup discards created orders, is idempotent, and cannot erase another namespace', async () => {
  const fixture = await createFixtureApiLifecycle(authority);
  const signal = new AbortController().signal;
  const one = {
    ...scope,
    deploymentId: 'fixture',
    origin: fixture.origin,
    namespaceId: randomUUID(),
  };
  const two = { ...one, namespaceId: randomUUID() };
  const headers = {
    authorization: 'Bearer fixture-alice',
    'content-type': 'application/json',
  };
  try {
    await fixture.lifecycle.prepare(one, signal);
    assert.equal(
      (
        await fetch(fixture.origin + '/api/orders', {
          method: 'POST',
          headers,
          body: JSON.stringify({ address: 'Test', quantity: 1 }),
        })
      ).status,
      201,
    );
    await fixture.lifecycle.cleanup(one, signal);
    await fixture.lifecycle.cleanup(one, signal);
    await fixture.lifecycle.prepare(two, signal);
    await fixture.lifecycle.cleanup(one, signal);
    assert.equal(
      (await fetch(fixture.origin + '/api/orders/order-created-1', { headers }))
        .status,
      404,
    );
    assert.equal(
      (await fetch(fixture.origin + '/api/orders/order-alice', { headers }))
        .status,
      200,
    );
    assert.equal(
      await fixture.lifecycle.canCleanup(
        { ...two, tenantId: randomUUID() },
        signal,
      ),
      false,
    );
    await fixture.lifecycle.cleanup(two, signal);
  } finally {
    await fixture.close();
  }
});

for (const failure of [
  'prepare',
  'scope',
  'cancel',
  'budget',
  'denied',
  'nonempty',
  'timeout',
  'unsettled',
] as const) {
  test(`lifecycle compensates and reports ${failure}`, async () => {
    const fixture = await createFixtureApiLifecycle(authority);
    const controller = new AbortController();
    let cleaned = false;
    const lifecycle: ApiLifecycleProvider = {
      ...fixture.lifecycle,
      async prepare(context, signal) {
        const receipt = await fixture.lifecycle.prepare(context, signal);
        if (failure === 'prepare') throw Error('private details');
        if (failure === 'scope') return { ...receipt, runId: randomUUID() };
        if (failure === 'cancel') controller.abort();
        if (failure === 'unsettled') return new Promise(() => {});
        return receipt;
      },
      async canCleanup(context, signal) {
        return failure === 'denied'
          ? false
          : fixture.lifecycle.canCleanup(context, signal);
      },
      async cleanup(context, signal) {
        cleaned = true;
        if (failure === 'timeout') return new Promise(() => {});
        await fixture.lifecycle.cleanup(context, signal);
      },
      async verifyEmpty(context, signal) {
        const receipt = await fixture.lifecycle.verifyEmpty(context, signal);
        return { ...receipt, empty: failure !== 'nonempty' };
      },
    };
    try {
      const result = await runApiLifecycle(
        {
          ...input(fixture.origin),
          ...(failure === 'budget' ? { limits: { maxRequests: 0 } } : {}),
        },
        {
          ...options,
          lifecycle,
          signal: controller.signal,
          setupMs: 30,
          cleanupMs: 30,
        },
      );
      assert.equal(result.status, 'inconclusive');
      assert.equal(result.capsule, undefined);
      assert.equal(cleaned, failure !== 'denied');
      assert.equal(
        result.cleanup.status,
        ['denied', 'nonempty', 'timeout', 'unsettled'].includes(failure)
          ? 'unverified'
          : 'verified',
      );
      assert.ok(!JSON.stringify(result).includes('private details'));
    } finally {
      await fixture.close();
    }
  });
}

test('mutating stage replay starts fresh and verifies created state is discarded', async () => {
  const { readFile } = await import('node:fs/promises');
  const fixture = await createFixtureApiLifecycle(authority);
  const contractText = await readFile(
    new URL('../../fixture/public/openapi.yaml', import.meta.url),
    'utf8',
  );
  let cleanups = 0;
  const headers = { authorization: 'Bearer fixture-alice' };
  const lifecycle: ApiLifecycleProvider = {
    ...fixture.lifecycle,
    async prepare(context, signal) {
      const receipt = await fixture.lifecycle.prepare(context, signal);
      assert.equal(
        (
          await fetch(fixture.origin + '/api/orders/order-created-1', {
            headers,
          })
        ).status,
        404,
      );
      return receipt;
    },
    async cleanup(context, signal) {
      assert.equal(
        (
          await fetch(fixture.origin + '/api/orders/order-created-1', {
            headers,
          })
        ).status,
        200,
      );
      await fixture.lifecycle.cleanup(context, signal);
      cleanups++;
    },
  };
  const mutation = {
    ...input(fixture.origin),
    contractText,
    generation: {
      baselineOnly: true,
      operationAllowlist: [{ method: 'POST' as const, path: '/api/orders' }],
    },
    grant: {
      ...input(fixture.origin).grant,
      operations: [
        { method: 'POST' as const, path: '/api/orders', allowMutation: true },
      ],
    },
  };
  try {
    const first = await runApiLifecycle(mutation, {
      ...options,
      lifecycle,
      getBearerToken: async () => 'fixture-alice',
    });
    assert.equal(first.status, 'completed');
    assert.ok(first.capsule);
    const replay = await runApiLifecycle(mutation, {
      ...options,
      lifecycle,
      getBearerToken: async () => 'fixture-alice',
      replay: first.capsule,
    });
    assert.equal(replay.replay.status, 'matched');
    assert.equal(cleanups, 2);
    assert.equal((await fetch(fixture.origin + '/health')).status, 503);
  } finally {
    await fixture.close();
  }
});
