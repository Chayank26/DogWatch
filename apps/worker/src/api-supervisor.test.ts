import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { createDatabase } from '@dogwatch/database';
import { runApiExecution } from './api-supervisor.js';
import type { ApiExecutionInput } from './api-execution.js';
const scope = {
  tenantId: randomUUID(),
  runId: randomUUID(),
  repositoryId: 1,
  pullRequestNumber: 2,
  headSha: 'a'.repeat(40),
};
function configuration(): ApiExecutionInput {
  return {
    scope: { ...scope },
    binding: {
      tenantId: scope.tenantId,
      repositoryId: 1,
      pullRequestNumber: 2,
      headSha: scope.headSha,
      deploymentId: 'approved',
      url: 'https://preview.example/health',
      allowedOrigins: ['https://preview.example'],
      maxWaitSeconds: 5,
      maxRequests: 3,
      pollIntervalMs: 50,
    },
    grant: {
      ...scope,
      deploymentId: 'approved',
      origin: 'https://preview.example',
      disposableData: false,
      operations: [{ method: 'GET', path: '/check' }],
    },
    contractText: '{}',
  };
}
// Any access would fail: these inputs must be rejected before persistence/authority/transport.
const unused = {} as ReturnType<typeof createDatabase>;
const noAuthority = async () => {
  throw Error('authority must not be called');
};
test('API supervisor refuses mutations before any capability is acquired', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    const input = configuration();
    input.grant.operations = [{ method, path: '/check', allowMutation: true }];
    await assert.rejects(
      runApiExecution(unused, input, noAuthority),
      /execution_read_only/,
    );
  }
});
test('API supervisor rejects cross-run, tenant, SHA and deployment grants before touching DB', async () => {
  for (const key of ['tenantId', 'runId', 'headSha'] as const) {
    const input = configuration();
    input.grant[key] = key === 'headSha' ? 'b'.repeat(40) : randomUUID();
    await assert.rejects(
      runApiExecution(unused, input, noAuthority),
      /execution_grant_scope/,
    );
  }
  const input = configuration();
  input.binding.headSha = 'b'.repeat(40);
  await assert.rejects(
    runApiExecution(unused, input, noAuthority),
    /execution_binding_scope/,
  );
  const mismatch = configuration();
  mismatch.grant.origin = 'https://other.example';
  await assert.rejects(
    runApiExecution(unused, mismatch, noAuthority),
    /execution_deployment/,
  );
});
