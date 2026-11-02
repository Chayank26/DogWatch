import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiConfiguration } from './api-configuration.js';
const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  repositoryId: 20,
  pullRequestNumber: 1,
  headSha: 'a'.repeat(40),
};
const { runId: _runId, ...bindingScope } = scope;
void _runId;
const entry = {
  binding: {
    ...bindingScope,
    deploymentId: 'immutable-1',
    url: 'https://preview.example.com/health',
    allowedOrigins: ['https://preview.example.com'],
  },
  contractText: '{}',
  operations: [{ method: 'GET', path: '/check' }],
};
test('configuration requires exact deployment scope and returns independent inputs', () => {
  const resolve = createApiConfiguration([entry]);
  assert.equal(resolve({ ...scope, headSha: 'b'.repeat(40) }), null);
  assert.equal(resolve({ ...scope, repositoryId: 21 }), null);
  const first = resolve(scope)!;
  first.binding.url = 'https://other.example.com';
  assert.equal(resolve(scope)!.binding.url, entry.binding.url);
  assert.equal(resolve(scope)!.grant.origin, 'https://preview.example.com');
});
test('ambiguous, private, mutable and fixture configurations are refused', () => {
  assert.throws(() => createApiConfiguration([entry, entry]));
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
    assert.throws(() =>
      createApiConfiguration([
        { ...entry, operations: [{ method, path: '/check' }] },
      ]),
    );
  assert.throws(() => createApiConfiguration([{ ...entry, fixture: true }]));
  assert.throws(() =>
    createApiConfiguration([
      {
        ...entry,
        binding: {
          ...entry.binding,
          url: 'http://127.0.0.1/health',
          allowedOrigins: ['http://127.0.0.1'],
        },
      },
    ]),
  );
});
