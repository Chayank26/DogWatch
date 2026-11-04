import assert from 'node:assert/strict';
import test from 'node:test';
import { consumerSettings, createApiProcessor } from './api-consumer.js';
import { createApiConfiguration } from './api-configuration.js';
const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  repositoryId: 20,
  pullRequestNumber: 1,
  headSha: 'a'.repeat(40),
};
const configuration = createApiConfiguration([
  {
    binding: {
      tenantId: scope.tenantId,
      repositoryId: 20,
      pullRequestNumber: 1,
      headSha: scope.headSha,
      deploymentId: 'one',
      url: 'https://example.com/health',
      allowedOrigins: ['https://example.com'],
    },
    contractText: JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Fixture', version: '1' },
      paths: {
        '/check': { get: { responses: { '200': { description: 'OK' } } } },
      },
    }),
    operations: [{ method: 'GET', path: '/check' }],
  },
]);
test('consumer is opt-in and rejects partial startup configuration', () => {
  assert.equal(consumerSettings({}), null);
  assert.equal(consumerSettings({ API_CONSUMER_ENABLED: 'false' }), null);
  for (const flag of ['1', 'yes', 'true'])
    assert.throws(() => consumerSettings({ API_CONSUMER_ENABLED: flag }));
  assert.equal(
    consumerSettings({
      API_CONSUMER_ENABLED: 'true',
      DATABASE_URL: 'db',
      REDIS_URL: 'redis',
      GITHUB_APP_ID: '1',
      GITHUB_PRIVATE_KEY_FILE: 'key',
      GITHUB_POLICIES_FILE: 'policy',
      API_EXECUTION_CONFIG_FILE: 'config',
    })?.appId,
    1,
  );
});
test('processor fences dispatch race, terminal runs, missing bindings and shutdown', async () => {
  let state = 'received';
  let calls = 0;
  let sha = scope.headSha;
  const db = {
    run: {
      findFirst: async ({ where }: { where: unknown }) => {
        assert.deepEqual(where, { id: scope.runId, tenantId: scope.tenantId });
        return {
          ...scope,
          id: scope.runId,
          repositoryId: 20n,
          state,
          headSha: sha,
        };
      },
    },
  } as unknown as Parameters<typeof createApiProcessor>[0];
  const controller = new AbortController();
  const processor = createApiProcessor(
    db,
    configuration,
    async () => ({ authorized: true, headSha: scope.headSha }),
    controller.signal,
    async (_db, input, _authority, options) => {
      calls++;
      assert.equal(input.scope.runId, scope.runId);
      assert.equal(options?.signal, controller.signal);
      assert.equal(options?.fixture, undefined);
      return { status: 'recorded' as const };
    },
  );
  const job = { tenantId: scope.tenantId, runId: scope.runId };
  await assert.rejects(processor(job), /api_execution_unavailable/);
  assert.equal(calls, 0);
  state = 'queued';
  assert.equal((await processor(job)).status, 'recorded');
  state = 'cancelled';
  assert.equal((await processor(job)).status, 'inactive');
  state = 'queued';
  sha = 'b'.repeat(40);
  await assert.rejects(processor(job), /api_execution_unavailable/);
  sha = scope.headSha;
  controller.abort();
  await assert.rejects(processor(job), /api_execution_unavailable/);
  assert.equal(calls, 1);
});
