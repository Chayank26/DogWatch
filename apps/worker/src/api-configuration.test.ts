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
  contractText: JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Fixture', version: '1' },
    paths: {
      '/check': { get: { responses: { '200': { description: 'OK' } } } },
    },
  }),
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

test('startup rejects malformed contracts, missing and duplicate grants and required credentials', () => {
  assert.throws(
    () => createApiConfiguration([{ ...entry, contractText: '{}' }]),
    /execution_contract_invalid/,
  );
  assert.throws(
    () =>
      createApiConfiguration([
        { ...entry, operations: [{ method: 'GET', path: '/absent' }] },
      ]),
    /execution_operation_missing/,
  );
  assert.throws(
    () =>
      createApiConfiguration([
        { ...entry, operations: [...entry.operations, ...entry.operations] },
      ]),
    /execution_operation_duplicate/,
  );
  const secured = JSON.parse(entry.contractText);
  secured.components = {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
  };
  secured.security = [{ bearer: [] }];
  assert.throws(
    () =>
      createApiConfiguration([
        { ...entry, contractText: JSON.stringify(secured) },
      ]),
    /execution_credentials_unsupported/,
  );
  secured.security.push({});
  assert.ok(
    createApiConfiguration([
      { ...entry, contractText: JSON.stringify(secured) },
    ])(scope),
  );
});
