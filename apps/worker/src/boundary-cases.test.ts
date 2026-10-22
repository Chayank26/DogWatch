import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import AjvDraft04Module from 'ajv-draft-04';
import { generateBoundaryCases } from './boundary-cases.js';
import type { BoundaryOptions } from './boundary-cases.js';
import { validateApiContract } from './openapi.js';
import { adjacent, checkValue, sample, stable } from './boundary-values.js';
import type { JsonValue } from './boundary-values.js';
const context = {
  tenantId: randomUUID(),
  repositoryId: 20,
  headSha: 'a'.repeat(40),
};
const fixture = await readFile(
  new URL('../../fixture/public/openapi.yaml', import.meta.url),
  'utf8',
);
const settings: BoundaryOptions = {
  seed: 42,
  maxCases: 200,
  maxCasesPerOperation: 100,
  fixtures: [
    {
      method: 'POST',
      path: '/api/orders',
      bodyJson: JSON.stringify({ address: '1 Test Lane', quantity: 2 }),
    },
    {
      method: 'GET',
      path: '/api/orders/{id}',
      parameters: [{ in: 'path', name: 'id', value: 'order-alice' }],
    },
  ],
};
const document = (schema: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Synthetic', version: '1' },
    paths: {
      '/check': {
        post: {
          requestBody: {
            required: true,
            content: { 'application/json': { schema } },
          },
          responses: { '200': { description: 'ok' } },
        },
      },
    },
    ...extra,
  });
const jsonBody = (
  value: ReturnType<typeof generateBoundaryCases>['cases'][number],
) =>
  value.request.body.kind === 'json' ? value.request.body.value : undefined;
test('PawMart plans are deterministic, scope-bound and include a valid baseline for each operation', () => {
  const first = generateBoundaryCases(context, fixture, settings);
  assert.deepEqual(generateBoundaryCases(context, fixture, settings), first);
  assert.ok(first.cases.length > 10);
  assert.equal(first.executionAuthorized, false);
  assert.equal(first.cases[0].kind, 'baseline');
  assert.equal(first.cases[1].kind, 'baseline');
  assert.equal(first.cases[0].inputValidity, 'valid');
  assert.equal(first.cases[1].inputValidity, 'valid');
  assert.deepEqual(
    first.cases.slice(0, 2).map((item) => item.operationKey),
    ['GET /api/orders/{id}', 'POST /api/orders'],
  );
  assert.notEqual(
    generateBoundaryCases(context, fixture, { ...settings, seed: 43 }).cases[0]
      .id,
    first.cases[0].id,
  );
  assert.notEqual(
    generateBoundaryCases(
      { ...context, tenantId: randomUUID() },
      fixture,
      settings,
    ).cases[0].id,
    first.cases[0].id,
  );
});
test('known fixture body labels agree with an independent trusted-fixture Ajv validator', () => {
  const contract = validateApiContract(context, fixture);
  const validator = new AjvDraft04Module.default({ strict: false }).compile(
    contract.operations.find((operation) => operation.method === 'POST')!
      .requestBody!.schema,
  );
  const plan = generateBoundaryCases(context, fixture, settings);
  for (const item of plan.cases.filter((item) => item.method === 'POST')) {
    if (item.request.body.kind === 'json')
      assert.equal(
        validator(item.request.body.value),
        item.inputValidity === 'valid',
        item.kind + ' ' + item.location,
      );
    else assert.equal(item.inputValidity, 'invalid');
  }
});
test('cases cover required omissions, wrong types, null, malformed JSON and both numeric bounds', () => {
  const plan = generateBoundaryCases(context, fixture, settings);
  for (const kind of [
    'missing_required',
    'wrong_type',
    'null',
    'malformed_json',
    'missing_parameter',
  ])
    assert.ok(
      plan.cases.some((item) => item.kind === kind),
      kind,
    );
  for (const [quantity, validity] of [
    [0, 'invalid'],
    [1, 'valid'],
    [10, 'valid'],
    [11, 'invalid'],
    [0.5, 'invalid'],
  ] as const)
    assert.ok(
      plan.cases.some((item) => {
        const body = jsonBody(item);
        return (
          item.method === 'POST' &&
          body !== null &&
          typeof body === 'object' &&
          !Array.isArray(body) &&
          body?.quantity === quantity &&
          item.inputValidity === validity
        );
      }),
      String(quantity),
    );
  assert.ok(
    plan.cases.some(
      (item) =>
        item.kind === 'malformed_json' &&
        item.request.body.kind === 'malformed_json' &&
        (() => {
          try {
            JSON.parse(item.request.body.text);
            return false;
          } catch {
            return true;
          }
        })(),
    ),
  );
});
test('string boundary lengths and permitted unexpected properties remain correctly classified', () => {
  const plan = generateBoundaryCases(context, fixture, settings);
  for (const [length, validity] of [
    [0, 'invalid'],
    [1, 'valid'],
    [200, 'valid'],
    [201, 'invalid'],
  ] as const)
    assert.ok(
      plan.cases.some((item) => {
        const body = jsonBody(item);
        return (
          item.location === 'body/address' &&
          body !== null &&
          typeof body === 'object' &&
          !Array.isArray(body) &&
          typeof body.address === 'string' &&
          body.address.length === length &&
          item.inputValidity === validity
        );
      }),
      String(length),
    );
  assert.ok(
    plan.cases.some(
      (item) =>
        item.kind === 'unexpected_property' && item.inputValidity === 'valid',
    ),
  );
  const strict = generateBoundaryCases(
    context,
    document({ type: 'object', additionalProperties: false }),
    { maxCasesPerOperation: 100 },
  );
  assert.ok(
    strict.cases.some(
      (item) =>
        item.kind === 'unexpected_property' && item.inputValidity === 'invalid',
    ),
  );
});
test('cases are deduplicated and independent instead of sharing mutable baselines', () => {
  const plan = generateBoundaryCases(context, fixture, settings);
  assert.equal(
    new Set(plan.cases.map((item) => item.id)).size,
    plan.cases.length,
  );
  assert.equal(
    new Set(plan.cases.map((item) => item.operationKey + stable(item.request)))
      .size,
    plan.cases.length,
  );
  const before = stable(plan.cases[2].request);
  plan.cases[0].request.parameters[0].value = 'changed';
  assert.equal(stable(plan.cases[2].request), before);
});
test('global, per-operation and aggregate payload ceilings report partial coverage', () => {
  for (const options of [
    { maxCases: 4 },
    { maxCasesPerOperation: 1 },
    { maxTotalPayloadBytes: 300 },
  ]) {
    const plan = generateBoundaryCases(context, fixture, {
      ...settings,
      ...options,
    });
    assert.equal(plan.status, 'partial');
    assert.ok(plan.coverageGaps.length);
    assert.ok(plan.cases.length <= (options.maxCases ?? 200));
    if (options.maxCasesPerOperation)
      for (const key of new Set(plan.cases.map((item) => item.operationKey)))
        assert.ok(
          plan.cases.filter((item) => item.operationKey === key).length <=
            options.maxCasesPerOperation,
        );
    assert.ok(
      plan.totalPayloadBytes <= (options.maxTotalPayloadBytes ?? 262144),
    );
    assert.equal(
      plan.totalPayloadBytes,
      plan.cases.reduce((sum, item) => sum + item.payloadBytes, 0),
    );
  }
});
test('per-case payload caps skip oversized boundaries without truncating them', () => {
  const plan = generateBoundaryCases(context, fixture, {
    ...settings,
    maxPayloadBytes: 180,
  });
  assert.ok(plan.cases.length);
  assert.ok(plan.cases.every((item) => item.payloadBytes <= 180));
  assert.ok(
    plan.coverageGaps.some(
      (item) =>
        item.code === 'case_payload_budget' ||
        item.code === 'string_boundary_budget',
    ),
  );
  const none = generateBoundaryCases(context, fixture, {
    ...settings,
    maxPayloadBytes: 1,
  });
  assert.equal(none.status, 'unavailable');
  assert.equal(none.cases.length, 0);
});
test('impact priority and repository allowlists choose known exact operations within scope', () => {
  const priority = {
    ...context,
    operations: [{ method: 'POST' as const, path: '/api/orders' }],
  };
  const plan = generateBoundaryCases(context, fixture, {
    ...settings,
    maxCases: 1,
    priority,
  });
  assert.equal(plan.cases[0].operationKey, 'POST /api/orders');
  const allowed = generateBoundaryCases(context, fixture, {
    ...settings,
    operationAllowlist: priority.operations,
  });
  assert.ok(
    allowed.cases.every((item) => item.operationKey === 'POST /api/orders'),
  );
  assert.throws(
    () =>
      generateBoundaryCases(context, fixture, {
        priority: { ...priority, headSha: 'b'.repeat(40) },
      }),
    /scope_mismatch/,
  );
  assert.throws(
    () =>
      generateBoundaryCases(context, fixture, {
        operationAllowlist: [{ method: 'GET', path: '/unknown' }],
      }),
    /unknown_operation/,
  );
  assert.equal(
    generateBoundaryCases(context, fixture, { operationAllowlist: [] }).cases
      .length,
    0,
  );
});
test('unmodeled patterns never execute or produce a falsely valid baseline', () => {
  const plan = generateBoundaryCases(
    context,
    document({ type: 'string', pattern: '^(a+)+$' }),
  );
  assert.equal(plan.status, 'unavailable');
  assert.ok(
    plan.coverageGaps.some(
      (item) => item.code === 'baseline_semantics_unmodeled',
    ),
  );
  assert.equal(
    checkValue(
      { type: 'string', nullable: false, pattern: '^(a+)+$' },
      'aaaa!',
    ),
    'unknown',
  );
});
test('decimal multiples and adjacent floating boundaries use exact JSON-number semantics', () => {
  const schema = { type: 'number' as const, nullable: false, multipleOf: 0.1 };
  assert.equal(checkValue(schema, 0.3), 'valid');
  assert.equal(checkValue(schema, 0.30000000000000004), 'invalid');
  assert.equal(checkValue({ ...schema, multipleOf: 1 }, 1e-10), 'invalid');
  assert.equal(checkValue({ ...schema, multipleOf: 1e-10 }, 3e-10), 'valid');
  assert.ok(adjacent(1, 1) > 1);
  assert.ok(adjacent(1, -1) < 1);
  assert.ok(adjacent(-1, 1) > -1);
  const plan = generateBoundaryCases(
    context,
    document({
      type: 'number',
      minimum: 0,
      exclusiveMinimum: true,
      maximum: 1,
    }),
    { maxCasesPerOperation: 100 },
  );
  assert.ok(
    plan.cases.some(
      (item) => jsonBody(item) === 0 && item.inputValidity === 'invalid',
    ),
  );
  assert.ok(
    plan.cases.some(
      (item) =>
        jsonBody(item) === Number.MIN_VALUE && item.inputValidity === 'valid',
    ),
  );
});
test('arrays preserve nullable items and classify duplicate and length violations', () => {
  const text = document({
    type: 'array',
    minItems: 1,
    maxItems: 2,
    uniqueItems: true,
    items: { type: 'string', nullable: true },
  });
  const plan = generateBoundaryCases(context, text, {
    maxCasesPerOperation: 100,
    fixtures: [{ method: 'POST', path: '/check', bodyJson: '[null]' }],
  });
  assert.ok(
    plan.cases.some(
      (item) =>
        item.kind === 'duplicate_item' && item.inputValidity === 'invalid',
    ),
  );
  assert.ok(
    plan.cases.some(
      (item) =>
        Array.isArray(jsonBody(item)) &&
        (jsonBody(item) as JsonValue[]).length === 2 &&
        (jsonBody(item) as JsonValue[])[0] === null,
    ),
  );
  assert.ok(
    plan.cases.some(
      (item) =>
        Array.isArray(jsonBody(item)) &&
        (jsonBody(item) as JsonValue[]).length === 0 &&
        item.inputValidity === 'invalid',
    ),
  );
});
test('nullable enum constraints do not automatically allow null, and nested omissions retain their location', () => {
  assert.equal(
    checkValue({ type: 'string', nullable: true, enum: ['yes'] }, null),
    'invalid',
  );
  const text = document({
    type: 'object',
    required: ['nested'],
    properties: {
      nested: {
        type: 'object',
        required: ['value'],
        properties: { value: { type: 'boolean', enum: [true] } },
      },
    },
  });
  const plan = generateBoundaryCases(context, text, {
    maxCasesPerOperation: 100,
  });
  assert.ok(
    plan.cases.some(
      (item) =>
        item.kind === 'missing_required' &&
        item.location === 'body/nested/value' &&
        item.inputValidity === 'invalid',
    ),
  );
  assert.ok(
    plan.cases.some(
      (item) =>
        item.kind === 'outside_enum' && item.inputValidity === 'invalid',
    ),
  );
});
test('bad synthetic fixtures, unsupported contracts and credential-parameter overlap cannot create cases', () => {
  const bad = generateBoundaryCases(context, fixture, {
    operationAllowlist: [{ method: 'POST', path: '/api/orders' }],
    fixtures: [
      { method: 'POST', path: '/api/orders', bodyJson: '{"quantity":1}' },
    ],
  });
  assert.equal(bad.cases.length, 0);
  assert.ok(
    bad.coverageGaps.some((item) => item.code === 'baseline_not_schema_valid'),
  );
  for (const bodyJson of ['{', '{"__proto__":{}}'])
    assert.equal(
      generateBoundaryCases(context, fixture, {
        operationAllowlist: [{ method: 'POST', path: '/api/orders' }],
        fixtures: [{ method: 'POST', path: '/api/orders', bodyJson }],
      }).cases.length,
      0,
    );
  assert.equal(generateBoundaryCases(context, '{}').cases.length, 0);
  const overlap = JSON.parse(document({ type: 'string' }));
  overlap.components = {
    securitySchemes: { Key: { type: 'apiKey', in: 'query', name: 'key' } },
  };
  overlap.security = [{ Key: [] }];
  overlap.paths['/check'].post.parameters = [
    { in: 'query', name: 'key', schema: { type: 'string' } },
  ];
  const plan = generateBoundaryCases(context, JSON.stringify(overlap));
  assert.equal(plan.cases.length, 0);
  assert.ok(
    plan.coverageGaps.some(
      (item) => item.code === 'credential_parameter_overlap',
    ),
  );
});
test('oversized synthesis and unbounded option values fail safely', () => {
  assert.throws(
    () =>
      sample(
        { type: 'string', nullable: false, minLength: 1000000000 },
        'seed',
        100,
      ),
    /baseline_unavailable/,
  );
  assert.throws(() => generateBoundaryCases(context, fixture, { maxCases: 0 }));
  assert.throws(() => generateBoundaryCases(context, fixture, { seed: -1 }));
  assert.throws(() =>
    generateBoundaryCases(context, fixture, {
      fixtures: [{ method: 'GET', path: '/unknown' }],
    }),
  );
  const plan = generateBoundaryCases(
    context,
    document({ type: 'array', minItems: 33, items: { type: 'integer' } }),
  );
  assert.equal(plan.cases.length, 0);
  assert.ok(
    plan.coverageGaps.some(
      (item) => item.code === 'array_baseline_unavailable',
    ),
  );
});

test('automatic baselines satisfy the fixture without using examples or configured seed bodies', () => {
  const plan = generateBoundaryCases(context, fixture, { seed: 7 });
  const body = plan.cases.find(
    (item) => item.method === 'POST' && item.kind === 'baseline',
  )!;
  assert.equal(body.inputValidity, 'valid');
  assert.ok(jsonBody(body) && typeof jsonBody(body) === 'object');
  const validator = new AjvDraft04Module.default({ strict: false }).compile(
    validateApiContract(context, fixture).operations[0].requestBody!.schema,
  );
  assert.equal(validator(jsonBody(body)), true);
});
test('Unicode lengths use characters while payload limits count UTF-8 bytes, including ordinary prototype-named fields', () => {
  const plan = generateBoundaryCases(
    context,
    document({ type: 'string', minLength: 1, maxLength: 1 }),
    {
      fixtures: [{ method: 'POST', path: '/check', bodyJson: '"😀"' }],
      maxCasesPerOperation: 100,
    },
  );
  assert.equal(plan.cases[0].inputValidity, 'valid');
  for (const item of plan.cases)
    assert.equal(item.payloadBytes, Buffer.byteLength(stable(item.request)));
  assert.equal(
    checkValue(
      {
        type: 'object',
        nullable: false,
        properties: {},
        additionalProperties: true,
      },
      { toString: 'synthetic' },
    ),
    'valid',
  );
  assert.equal(
    checkValue(
      {
        type: 'object',
        nullable: false,
        properties: {},
        additionalProperties: false,
      },
      { toString: 'synthetic' },
    ),
    'invalid',
  );
});
test('omitting optional parameters is valid and parameter cases retain independent body snapshots', () => {
  const doc = JSON.parse(
    document({ type: 'object', properties: { value: { type: 'string' } } }),
  );
  doc.paths['/check'].post.parameters = [
    { in: 'query', name: 'limit', schema: { type: 'integer' } },
  ];
  const plan = generateBoundaryCases(context, JSON.stringify(doc), {
    maxCasesPerOperation: 100,
  });
  const omission = plan.cases.find(
    (item) => item.kind === 'missing_parameter',
  )!;
  assert.equal(omission.inputValidity, 'valid');
  const before = stable(omission.request);
  const baseline = plan.cases[0].request.body;
  if (baseline.kind === 'json')
    (baseline.value as Record<string, JsonValue>).value = 'changed';
  assert.equal(stable(omission.request), before);
});
