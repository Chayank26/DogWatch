import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { validateApiContract } from './openapi.js';
import { object } from './openapi-profile.js';
const context = {
  tenantId: randomUUID(),
  repositoryId: 20,
  headSha: 'a'.repeat(40),
};
const document = (): Record<string, unknown> => ({
  openapi: '3.0.3',
  info: { title: 'Synthetic', version: '1' },
  paths: {
    '/items': {
      post: {
        operationId: 'createItem',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['quantity'],
                properties: {
                  quantity: { type: 'integer', minimum: 1, maximum: 10 },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Created',
            content: { 'application/json': { schema: { type: 'string' } } },
          },
        },
      },
    },
  },
});
const operation = (doc: Record<string, unknown>) =>
  object(object(object(doc.paths)['/items']).post);
const body = (doc: Record<string, unknown>) =>
  object(
    object(object(operation(doc).requestBody).content)['application/json'],
  );
const validate = (doc: Record<string, unknown>) =>
  validateApiContract(context, JSON.stringify(doc));
function expectCode(
  doc: Record<string, unknown>,
  status: string,
  code: string,
) {
  const result = validate(doc);
  assert.equal(result.status, status);
  assert.equal(result.diagnostics[0].code, code);
  assert.deepEqual(result.operations, []);
}
test('PawMart YAML normalizes both operations, local response refs and auth without a request', async () => {
  const text = await readFile(
    new URL('../../fixture/public/openapi.yaml', import.meta.url),
    'utf8',
  );
  const result = validateApiContract(context, text);
  assert.equal(result.status, 'supported');
  assert.equal(result.operations.length, 2);
  assert.equal(
    result.contractDigest,
    createHash('sha256').update(text).digest('hex'),
  );
  assert.equal(result.headSha, context.headSha);
  assert.deepEqual(result.securitySchemes, {
    fixtureBearer: { type: 'http', scheme: 'bearer' },
  });
  assert.deepEqual(result.operations[0].security, [{ fixtureBearer: [] }]);
  assert.equal(
    result.operations[0].requestBody?.schema.properties?.address.pattern,
    '\\S',
  );
  assert.equal(
    result.operations[0].responses['201'].schema?.properties?.quantity.maximum,
    10,
  );
  assert.equal(result.operations[1].parameters[0].name, 'id');
  assert.ok(!JSON.stringify(result).includes('127.0.0.1'));
  assert.deepEqual(validateApiContract(context, text), result);
});
test('supported JSON constraints preserve nullable, arrays, enums, exclusivity and defaults', () => {
  const doc = document();
  body(doc).schema = {
    type: 'object',
    properties: {
      list: {
        type: 'array',
        items: { type: 'string', nullable: true, enum: ['ok', null] },
        minItems: 1,
        maxItems: 3,
        uniqueItems: true,
      },
      price: {
        type: 'number',
        minimum: 0,
        exclusiveMinimum: true,
        maximum: 10,
        multipleOf: 0.5,
      },
    },
    additionalProperties: { type: 'boolean' },
    minProperties: 1,
    maxProperties: 3,
  };
  const result = validate(doc);
  assert.equal(result.status, 'supported');
  const schema = result.operations[0].requestBody!.schema;
  assert.equal(schema.properties?.list.items?.nullable, true);
  assert.deepEqual(schema.additionalProperties, {
    type: 'boolean',
    nullable: false,
  });
  assert.equal(schema.properties?.price.exclusiveMinimum, true);
});
test('local component refs preserve repeated acyclic definitions and component kinds', () => {
  const doc = document();
  doc.components = {
    schemas: { Part: { type: 'string' } },
    requestBodies: {
      Input: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                a: { $ref: '#/components/schemas/Part' },
                b: { $ref: '#/components/schemas/Part' },
              },
            },
          },
        },
      },
    },
    responses: { Created: { description: 'Created' } },
    parameters: {
      Limit: {
        in: 'query',
        name: 'limit',
        schema: { type: 'integer', minimum: 1 },
      },
    },
  };
  operation(doc).requestBody = { $ref: '#/components/requestBodies/Input' };
  operation(doc).responses = {
    '201': { $ref: '#/components/responses/Created' },
  };
  operation(doc).parameters = [{ $ref: '#/components/parameters/Limit' }];
  const result = validate(doc);
  assert.equal(result.status, 'supported');
  assert.equal(result.operations[0].parameters[0].style, 'form');
  assert.equal(
    result.operations[0].requestBody?.schema.properties?.b.type,
    'string',
  );
});
test('path parameters inherit and operation overrides replace matching definitions', () => {
  const doc = document();
  const item = object(object(doc.paths)['/items']);
  item.parameters = [
    { in: 'path', name: 'id', required: true, schema: { type: 'string' } },
    { in: 'query', name: 'limit', schema: { type: 'integer', maximum: 100 } },
  ];
  object(doc.paths)['/items/{id}'] = item;
  delete object(doc.paths)['/items'];
  object(item.post).parameters = [
    { in: 'query', name: 'limit', schema: { type: 'integer', maximum: 10 } },
  ];
  const result = validate(doc);
  assert.equal(result.status, 'supported');
  assert.equal(result.operations[0].parameters.length, 2);
  assert.equal(result.operations[0].parameters[1].schema.maximum, 10);
});
test('security inheritance preserves OR, AND, anonymous alternatives and explicit opt-out', () => {
  const doc = document();
  doc.components = {
    securitySchemes: {
      Bearer: { type: 'http', scheme: 'bearer' },
      Key: { type: 'apiKey', in: 'header', name: 'X-Test-Key' },
    },
  };
  doc.security = [{ Bearer: [], Key: [] }, {}];
  assert.deepEqual(validate(doc).operations[0].security, [
    { Bearer: [], Key: [] },
    {},
  ]);
  operation(doc).security = [];
  assert.deepEqual(validate(doc).operations[0].security, []);
  operation(doc).security = [{ Missing: [] }];
  expectCode(doc, 'invalid', 'contract_security_undefined');
  operation(doc).security = [{ Bearer: ['scope'] }];
  expectCode(doc, 'invalid', 'contract_security_scopes');
});
test('malformed syntax, duplicate YAML/JSON keys, multiple documents and custom tags fail closed', () => {
  for (const text of [
    '{',
    'openapi: 3.0.3\nopenapi: 3.0.2',
    '{"openapi":"3.0.3","openapi":"3.0.2"}',
    '---\na: 1\n---\nb: 2',
    'x: !exec command',
  ]) {
    const result = validateApiContract(context, text);
    assert.equal(result.status, 'invalid');
    assert.equal(result.diagnostics[0].code, 'contract_syntax');
  }
});
test('YAML anchors, aliases, unsafe keys, non-finite values and depth/size budgets are bounded', () => {
  for (const [text, code] of [
    ['a: &value 1\nb: *value', 'contract_yaml_alias'],
    ['a: &value 1', 'contract_yaml_tag_or_anchor'],
    ['a: *missing', 'contract_yaml_alias'],
    ['__proto__: {}', 'contract_unsafe_key'],
    ['a: .inf', 'contract_number_budget'],
    ['a: 9007199254740993', 'contract_number_budget'],
    [' '.repeat(262145), 'contract_byte_budget'],
    ['#' + 'x'.repeat(262144), 'contract_byte_budget'],
    ['a: ' + '['.repeat(42) + '0' + ']'.repeat(42), 'contract_document_budget'],
    ['a: ' + 'x'.repeat(32769), 'contract_scalar_budget'],
  ]) {
    const result = validateApiContract(context, text);
    assert.equal(result.diagnostics[0].code, code);
    assert.deepEqual(result.operations, []);
  }
});
test('missing required document fields and unsupported spec versions remain distinct', () => {
  const doc = document();
  delete doc.info;
  expectCode(doc, 'invalid', 'contract_structure');
  for (const version of ['2.0', '3.1.0', '3.2.0']) {
    const other = document();
    other.openapi = version;
    expectCode(other, 'unsupported', 'contract_openapi_version');
  }
  assert.throws(() =>
    validateApiContract({ ...context, repositoryId: 0 }, '{}'),
  );
});
test('HTTP and file refs are never retrieved, including unused component definitions', () => {
  for (const ref of [
    'https://example.invalid/schema',
    'file:///etc/passwd',
    '../schema.json',
  ]) {
    const doc = document();
    body(doc).schema = { $ref: ref };
    expectCode(doc, 'unsupported', 'contract_external_reference');
    const unused = document();
    unused.components = { responses: { Unused: { $ref: ref } } };
    expectCode(unused, 'unsupported', 'contract_external_reference');
  }
});
test('missing, wrong-category and recursive local refs cannot yield partial operations', () => {
  const doc = document();
  body(doc).schema = { $ref: '#/components/schemas/Absent' };
  expectCode(doc, 'invalid', 'contract_reference_missing');
  body(doc).schema = { $ref: '#/components/responses/Wrong' };
  expectCode(doc, 'invalid', 'contract_reference_target');
  doc.components = {
    schemas: {
      Loop: {
        type: 'object',
        properties: { next: { $ref: '#/components/schemas/Loop' } },
      },
    },
  };
  body(doc).schema = { $ref: '#/components/schemas/Loop' };
  expectCode(doc, 'unsupported', 'contract_recursive_reference');
});
test('compositions, formats, directional fields and unsupported media are not silently weakened', () => {
  for (const schema of [
    { oneOf: [{ type: 'string' }, { type: 'integer' }] },
    { type: 'string', format: 'email' },
    { type: 'string', readOnly: true },
  ]) {
    const doc = document();
    body(doc).schema = schema;
    assert.equal(validate(doc).status, 'unsupported');
  }
  const doc = document();
  object(operation(doc).requestBody).content = {
    'text/plain': { schema: { type: 'string' } },
  };
  expectCode(doc, 'unsupported', 'contract_media_type');
});
test('schema contradictions, invalid regex syntax and missing array items are rejected', () => {
  for (const [schema, code] of [
    [
      { type: 'integer', minimum: 2, maximum: 1 },
      'contract_contradictory_bounds',
    ],
    [
      { type: 'number', minimum: 1, maximum: 1, exclusiveMinimum: true },
      'contract_contradictory_bounds',
    ],
    [
      { type: 'number', exclusiveMinimum: true },
      'contract_exclusive_bound_missing',
    ],
    [{ type: 'string', pattern: '[' }, 'contract_pattern_invalid'],
    [{ type: 'array' }, 'contract_array_items_missing'],
  ] as const) {
    const doc = document();
    body(doc).schema = schema;
    expectCode(doc, 'invalid', code);
  }
});
test('duplicate operation IDs, path templates and parameter declarations are rejected', () => {
  const duplicate = document();
  object(object(duplicate.paths)['/items']).get = {
    operationId: 'createItem',
    responses: { '200': { description: 'ok' } },
  };
  expectCode(duplicate, 'invalid', 'contract_operation_duplicate');
  const ambiguous = document();
  ambiguous.paths = { '/items/{id}': {}, '/items/{other}': {} };
  expectCode(ambiguous, 'invalid', 'contract_path_ambiguous');
  const doc = document();
  operation(doc).parameters = [
    { in: 'query', name: 'limit', schema: { type: 'integer' } },
    { in: 'query', name: 'limit', schema: { type: 'integer', maximum: 10 } },
  ];
  expectCode(doc, 'invalid', 'contract_parameter_duplicate');
});
test('missing path bindings, unsafe paths and unsupported serialization fail closed', () => {
  const doc = document();
  const item = object(doc.paths)['/items'];
  doc.paths = { '/items/{id}': item };
  expectCode(doc, 'invalid', 'contract_path_parameter_mismatch');
  for (const path of ['//external', '/x?token=1', '/../x', '/%2e%2e/x']) {
    const other = document();
    other.paths = { [path]: object(other.paths)['/items'] };
    expectCode(other, 'unsupported', 'contract_path');
  }
  const serialization = document();
  operation(serialization).parameters = [
    {
      in: 'query',
      name: 'filter',
      style: 'deepObject',
      schema: { type: 'object' },
    },
  ];
  expectCode(serialization, 'unsupported', 'contract_parameter_structure');
});
test('servers, examples, defaults, descriptions and vendor extensions never enter normalized metadata', () => {
  const doc = document();
  doc.servers = [{ url: 'http://169.254.169.254' }];
  doc['x-command'] = 'secret-must-not-leak';
  object(body(doc).schema).description = 'secret-must-not-leak';
  object(body(doc).schema).example = {
    quantity: 2,
    token: 'secret-must-not-leak',
  };
  object(object(object(body(doc).schema).properties).quantity).default = 2;
  const result = validate(doc);
  assert.equal(result.status, 'supported');
  assert.ok(!JSON.stringify(result).includes('secret-must-not-leak'));
  assert.ok(!JSON.stringify(result).includes('169.254'));
  const invalidDoc = document();
  operation(invalidDoc).responses = 'secret-must-not-leak';
  assert.ok(
    !JSON.stringify(validate(invalidDoc)).includes('secret-must-not-leak'),
  );
});
test('parameter, path, schema-expansion and normalized-output ceilings are enforced', () => {
  const doc = document();
  operation(doc).parameters = Array.from({ length: 51 }, (_, index) => ({
    in: 'query',
    name: `q${index}`,
    schema: { type: 'string' },
  }));
  expectCode(doc, 'unsupported', 'contract_parameter_budget');
  const paths = document();
  paths.paths = Object.fromEntries(
    Array.from({ length: 101 }, (_, index) => [`/p${index}`, {}]),
  );
  expectCode(paths, 'unsupported', 'contract_path_budget');
  const recursiveExpansion = document();
  const schemas: Record<string, unknown> = {
    Leaf: { type: 'string', enum: ['x'.repeat(20000)] },
  };
  for (let index = 0; index < 7; index++)
    schemas[`L${index}`] = {
      type: 'object',
      properties: {
        a: { $ref: `#/components/schemas/${index ? `L${index - 1}` : 'Leaf'}` },
        b: { $ref: `#/components/schemas/${index ? `L${index - 1}` : 'Leaf'}` },
      },
    };
  recursiveExpansion.components = { schemas };
  body(recursiveExpansion).schema = { $ref: '#/components/schemas/L6' };
  expectCode(recursiveExpansion, 'unsupported', 'contract_normalized_budget');
});

test('response ranges/defaults and header overrides preserve explicit operation semantics', () => {
  const doc = document();
  const item = object(object(doc.paths)['/items']);
  item.parameters = [
    { in: 'header', name: 'X-Mode', schema: { type: 'string' } },
  ];
  operation(doc).parameters = [
    {
      in: 'header',
      name: 'x-mode',
      required: true,
      schema: { type: 'string', enum: ['test'] },
    },
  ];
  operation(doc).responses = {
    '2XX': { description: 'Success' },
    default: { description: 'Other' },
  };
  const result = validate(doc);
  assert.equal(result.status, 'supported');
  assert.equal(result.operations[0].parameters.length, 1);
  assert.equal(result.operations[0].parameters[0].required, true);
  assert.deepEqual(Object.keys(result.operations[0].responses), [
    '2XX',
    'default',
  ]);
});
test('unmodeled auth, ignored auth header parameters and callbacks stay unsupported', () => {
  const oauth = document();
  oauth.components = {
    securitySchemes: {
      Login: {
        type: 'openIdConnect',
        openIdConnectUrl: 'https://example.invalid/auth',
      },
    },
  };
  expectCode(oauth, 'unsupported', 'contract_security_scheme');
  const header = document();
  operation(header).parameters = [
    { in: 'header', name: 'Authorization', schema: { type: 'string' } },
  ];
  expectCode(header, 'unsupported', 'contract_ignored_header_parameter');
  const callback = document();
  operation(callback).callbacks = {};
  expectCode(callback, 'unsupported', 'contract_callbacks');
  const response = document();
  operation(response).responses = {
    '200': {
      description: 'ok',
      headers: { 'X-Result': { schema: { type: 'string' } } },
    },
  };
  expectCode(response, 'unsupported', 'contract_response_metadata');
});

test('component names follow OpenAPI rules and the supported patch range is explicit', () => {
  const doc = document();
  doc.components = { schemas: { 'invalid/name': { type: 'string' } } };
  expectCode(doc, 'invalid', 'contract_component_name');
  for (const patch of [0, 1, 2, 3, 4]) {
    const other = document();
    other.openapi = `3.0.${patch}`;
    assert.equal(validate(other).status, 'supported');
  }
});
