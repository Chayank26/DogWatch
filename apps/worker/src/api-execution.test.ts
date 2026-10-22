import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { RequestListener, Server } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { executeApiCases } from './api-execution.js';
import { generateBoundaryCases } from './boundary-cases.js';
import { validateApiContract } from './openapi.js';
import { serializeApiCase } from './api-transport.js';
import type { BoundaryOptions } from './boundary-cases.js';
const scope = {
  tenantId: randomUUID(),
  runId: randomUUID(),
  repositoryId: 20,
  pullRequestNumber: 42,
  headSha: 'a'.repeat(40),
};
const context = {
  tenantId: scope.tenantId,
  repositoryId: scope.repositoryId,
  headSha: scope.headSha,
};
const document = (method = 'get', extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Synthetic', version: '1' },
    paths: {
      '/check': {
        [method]: {
          responses: {
            '200': { description: 'ok' },
            '400': { description: 'bad' },
          },
          ...extra,
        },
      },
    },
  });
async function listen(handler: RequestListener) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
function input(
  origin: string,
  contractText = document(),
  generation: BoundaryOptions = { maxCases: 1 },
) {
  return {
    scope,
    binding: {
      ...context,
      pullRequestNumber: 42,
      deploymentId: 'fixture',
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
      operations: [{ method: 'GET' as const, path: '/check' }],
    },
    contractText,
    generation,
    limits: { minIntervalMs: 50, maxExecutionMs: 10000 },
  };
}
const options = { isCurrent: async () => true, fixture: true };
test('real HTTP status and response schema observations distinguish defects and setup', async () => {
  const contract = document('get', {
    responses: {
      '200': {
        description: 'ok',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['ok'],
              properties: { ok: { type: 'boolean' } },
            },
          },
        },
      },
      '400': { description: 'rejected' },
    },
  });
  for (const [status, body, type, expected] of [
    [200, '{"ok":true}', 'application/json', 'documented_response'],
    [200, '{"ok":"wrong"}', 'application/json', 'response_schema'],
    [200, '{', 'application/json', 'response_json'],
    [200, '{"ok":true}', 'text/plain', 'response_media_type'],
    [400, '', 'text/plain', 'documented_rejection'],
    [418, '', 'text/plain', 'undocumented_status'],
    [500, 'secret-server-error', 'text/plain', 'server_error'],
    [401, 'secret-token', 'text/plain', 'credentials_unavailable'],
    [403, '', 'text/plain', 'credentials_unavailable'],
    [429, '', 'text/plain', 'rate_limited'],
  ] as const) {
    const { server, origin } = await listen((_req, res) => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    });
    try {
      const output = await executeApiCases(input(origin, contract), options);
      assert.equal(output.results[0]?.code, expected);
      assert.equal(output.requests, 1);
      assert.ok(!JSON.stringify(output).includes('secret-'));
    } finally {
      await close(server);
    }
  }
});
test('scope, deployment, origin and missing operation grants fail closed before requests', async () => {
  let calls = 0;
  const { server, origin } = await listen((_req, res) => {
    calls++;
    res.end();
  });
  try {
    for (const change of [
      'tenantId',
      'runId',
      'headSha',
      'repositoryId',
      'pullRequestNumber',
      'deploymentId',
      'origin',
      'operations',
    ]) {
      const value = input(origin);
      const grant: Record<string, unknown> = { ...value.grant };
      grant[change] =
        change === 'operations'
          ? []
          : change === 'origin'
            ? 'http://127.0.0.1:1'
            : change === 'repositoryId' || change === 'pullRequestNumber'
              ? 99
              : change === 'headSha'
                ? 'b'.repeat(40)
                : change === 'deploymentId'
                  ? 'other'
                  : randomUUID();
      const result = await executeApiCases(
        { ...value, grant: grant as typeof value.grant },
        options,
      );
      assert.equal(result.requests, 0, change);
      assert.equal(result.status, 'inconclusive');
    }
    assert.equal(
      (await executeApiCases(input(origin), { isCurrent: async () => true }))
        .requests,
      0,
    );
    assert.equal(calls, 0);
  } finally {
    await close(server);
  }
});
test('mutations require exact permission and disposable data', async () => {
  let calls = 0;
  const { server, origin } = await listen((_req, res) => {
    calls++;
    res.end();
  });
  try {
    for (const [allowMutation, disposableData] of [
      [false, true],
      [true, false],
      [true, true],
    ]) {
      const value = input(origin, document('post'));
      const result = await executeApiCases(
        {
          ...value,
          grant: {
            ...value.grant,
            disposableData,
            operations: [{ method: 'POST', path: '/check', allowMutation }],
          },
        },
        options,
      );
      assert.equal(result.requests, allowMutation && disposableData ? 1 : 0);
    }
    assert.equal(calls, 1);
  } finally {
    await close(server);
  }
});
test('wire byte budgets include encoded query, credentials and headers', async () => {
  const contract = document('get', {
    parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
  });
  const plan = generateBoundaryCases(context, contract, {
    maxCases: 1,
    fixtures: [
      {
        method: 'GET',
        path: '/check',
        parameters: [{ in: 'query', name: 'q', value: 'é &' }],
      },
    ],
  });
  const operation = validateApiContract(context, contract).operations[0]!;
  const wire = serializeApiCase(
    plan.cases[0]!,
    operation,
    'https://example.com',
    'synthetic',
  );
  assert.ok(wire.url.search.includes('%C3%A9'));
  assert.ok(wire.bytes > plan.cases[0]!.payloadBytes);
  assert.equal(
    wire.bytes,
    Buffer.byteLength(
      `GET ${wire.url.pathname}${wire.url.search} HTTP/1.1\r\n${Object.entries(
        wire.headers,
      )
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join('')}\r\n`,
    ) + wire.body.length,
  );
  let calls = 0;
  const { server, origin } = await listen((_req, res) => {
    calls++;
    res.end();
  });
  try {
    for (const limits of [
      { maxRequestBytes: 1 },
      { maxTotalRequestBytes: 1 },
      { maxRequests: 0 },
    ]) {
      const result = await executeApiCases(
        { ...input(origin), limits },
        options,
      );
      assert.equal(result.requests, 0);
    }
    assert.equal(calls, 0);
  } finally {
    await close(server);
  }
});
test('streamed response caps and aggregate caps stop further work', async () => {
  const { server, origin } = await listen((_req, res) => {
    res.write('x'.repeat(100));
    res.end('y'.repeat(100));
  });
  try {
    for (const limits of [
      { maxResponseBytes: 20 },
      { maxTotalResponseBytes: 20 },
    ]) {
      const result = await executeApiCases(
        { ...input(origin), limits },
        options,
      );
      assert.equal(result.results[0]?.code, 'response_bytes');
      assert.equal(result.responseBytes, 20);
      assert.equal(result.requests, 1);
    }
  } finally {
    await close(server);
  }
});
test('redirects are never followed or forwarded with credentials', async () => {
  let target = 0;
  const { server, origin } = await listen((req, res) => {
    if (req.url === '/elsewhere') target++;
    res.writeHead(302, { location: '/elsewhere', 'set-cookie': 'secret=1' });
    res.end();
  });
  try {
    const result = await executeApiCases(input(origin), options);
    assert.equal(result.code, 'redirect_forbidden');
    assert.equal(result.requests, 1);
    assert.equal(target, 0);
  } finally {
    await close(server);
  }
});
test('authority checks fail closed before and after requests; cancellation prevents late success', async () => {
  const { server, origin } = await listen((_req, res) => {
    res.end();
  });
  try {
    assert.equal(
      (
        await executeApiCases(input(origin), {
          ...options,
          isCurrent: async () => false,
        })
      ).requests,
      0,
    );
    assert.equal(
      (
        await executeApiCases(input(origin), {
          ...options,
          isCurrent: async () => {
            throw Error('secret');
          },
        })
      ).code,
      'context_unavailable',
    );
    let checks = 0;
    const stale = await executeApiCases(input(origin), {
      ...options,
      isCurrent: async () => ++checks < 3,
    });
    assert.equal(stale.requests, 1);
    assert.equal(stale.results[0]?.code, 'stopped');
    const controller = new AbortController();
    controller.abort();
    assert.equal(
      (
        await executeApiCases(input(origin), {
          ...options,
          signal: controller.signal,
        })
      ).requests,
      0,
    );
    const stalled = await executeApiCases(
      { ...input(origin), limits: { maxExecutionMs: 20 } },
      { ...options, isCurrent: () => new Promise(() => {}) },
    );
    assert.equal(stalled.code, 'execution_timeout');
  } finally {
    await close(server);
  }
});
test('request and stage timeouts bound slow sockets and cancellation in flight', async () => {
  const { server, origin } = await listen(() => {});
  try {
    const timed = await executeApiCases(
      { ...input(origin), limits: { maxRequestMs: 20 } },
      options,
    );
    assert.equal(timed.results[0]?.code, 'transport_unavailable');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40);
    try {
      const cancelled = await executeApiCases(input(origin), {
        ...options,
        signal: controller.signal,
      });
      assert.equal(cancelled.code, 'stopped');
    } finally {
      clearTimeout(timer);
    }
    const stage = await executeApiCases(
      { ...input(origin), limits: { maxExecutionMs: 30 } },
      options,
    );
    assert.equal(stage.code, 'execution_timeout');
  } finally {
    await close(server);
  }
});
test('only safe transport failures retry and actual attempt starts obey rate limits', async () => {
  const starts: number[] = [];
  const { server, origin } = await listen((req) => {
    starts.push(performance.now());
    req.socket.destroy();
  });
  try {
    const retried = await executeApiCases(
      { ...input(origin), limits: { maxRetries: 2, minIntervalMs: 60 } },
      options,
    );
    assert.equal(retried.requests, 3);
    assert.equal(starts.length, 3);
    assert.ok(starts[1]! - starts[0]! >= 50);
    assert.ok(starts[2]! - starts[1]! >= 50);
    const value = input(origin, document('post'));
    const mutation = await executeApiCases(
      {
        ...value,
        grant: {
          ...value.grant,
          operations: [{ method: 'POST', path: '/check', allowMutation: true }],
        },
        limits: { maxRetries: 2 },
      },
      options,
    );
    assert.equal(mutation.requests, 1);
    const capped = await executeApiCases(
      { ...input(origin), limits: { maxRetries: 2, maxRequests: 1 } },
      options,
    );
    assert.equal(capped.requests, 1);
    assert.equal(capped.code, 'request_budget');
  } finally {
    await close(server);
  }
});
test('reserved headers, path traversal and scalar coercion do not become HTTP requests', () => {
  for (const [where, name, schema, value] of [
    ['header', 'Host', { type: 'string' }, 'attacker.example'],
    ['path', 'id', { type: 'string' }, '..'],
    ['query', 'q', { type: 'string' }, 42],
  ] as const) {
    const path = where === 'path' ? '/check/{id}' : '/check';
    const contract = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Synthetic', version: '1' },
      paths: {
        [path]: {
          get: {
            parameters: [{ in: where, name, required: true, schema }],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    });
    // The baseline for string fixtures must be valid. Mutations include wrong-type scalar cases.
    const plan = generateBoundaryCases(context, contract, {
      fixtures:
        typeof value === 'string'
          ? [{ method: 'GET', path, parameters: [{ in: where, name, value }] }]
          : [],
      maxCases: 100,
    });
    const candidate =
      typeof value === 'string'
        ? plan.cases[0]!
        : plan.cases.find((c) =>
            c.request.parameters.some(
              (p) => p.name === name && typeof p.value === 'number',
            ),
          )!;
    assert.ok(candidate);
    assert.throws(() =>
      serializeApiCase(
        candidate,
        validateApiContract(context, contract).operations[0]!,
        'https://example.com',
      ),
    );
  }
});
test('missing credentials are explicit and scoped bearer context is never included in results', async () => {
  const contract = JSON.parse(document());
  contract.components = {
    securitySchemes: { test: { type: 'http', scheme: 'bearer' } },
  };
  contract.security = [{ test: [] }];
  let received = '';
  const { server, origin } = await listen((req, res) => {
    received = req.headers.authorization ?? '';
    res.end();
  });
  try {
    assert.equal(
      (await executeApiCases(input(origin, JSON.stringify(contract)), options))
        .requests,
      0,
    );
    const output = await executeApiCases(
      input(origin, JSON.stringify(contract)),
      {
        ...options,
        getBearerToken: async (given, deployment, allowed, scheme) => {
          assert.deepEqual(given, scope);
          assert.equal(deployment, 'fixture');
          assert.equal(allowed, origin);
          assert.equal(scheme, 'test');
          return 'synthetic-secret';
        },
      },
    );
    assert.equal(received, 'Bearer synthetic-secret');
    assert.ok(!JSON.stringify(output).includes('synthetic-secret'));
  } finally {
    await close(server);
  }
});

test('PawMart real generated requests distinguish healthy responses and seeded server failures', async () => {
  const { createFixtureApp } = await import(
    new URL('../../fixture/dist/app.js', import.meta.url).href
  );
  const contract = await readFile(
    new URL('../../fixture/public/openapi.yaml', import.meta.url),
    'utf8',
  );
  const generation: BoundaryOptions = {
    seed: 42,
    maxCases: 100,
    fixtures: [
      {
        method: 'POST',
        path: '/api/orders',
        bodyJson: '{"address":"1 Test Lane","quantity":2}',
      },
      {
        method: 'GET',
        path: '/api/orders/{id}',
        parameters: [{ in: 'path', name: 'id', value: 'order-alice' }],
      },
    ],
  };
  for (const mode of ['healthy', 'missing-address-500']) {
    const { server, origin } = await listen(createFixtureApp(mode));
    try {
      const value = input(origin, contract, generation);
      const output = await executeApiCases(
        {
          ...value,
          grant: {
            ...value.grant,
            operations: [
              { method: 'GET', path: '/api/orders/{id}' },
              { method: 'POST', path: '/api/orders', allowMutation: true },
            ],
          },
        },
        { ...options, getBearerToken: async () => 'fixture-alice' },
      );
      assert.ok(output.requests > 10);
      const failures = output.results.filter(
        (result) => result.status === 'failed',
      );
      if (mode === 'healthy') assert.deepEqual(failures, []);
      else
        assert.ok(
          failures.some(
            (result) =>
              result.code === 'server_error' &&
              result.httpStatus === 500 &&
              /^[a-f0-9]{64}$/.test(result.caseId),
          ),
        );
      assert.ok(output.requestBytes <= 262144);
      assert.ok(output.responseBytes <= 1048576);
      assert.ok(!JSON.stringify(output).includes('fixture-alice'));
    } finally {
      await close(server);
    }
  }
});

test('schema-invalid body accepted with 2xx is a violation; documented 4xx remains a valid observation', async () => {
  const contract = document('post', {
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['count'],
            properties: { count: { type: 'integer', minimum: 1, maximum: 3 } },
            additionalProperties: false,
          },
        },
      },
    },
  });
  for (const status of [200, 400]) {
    const { server, origin } = await listen((req, res) => {
      req.resume();
      res.writeHead(status);
      res.end();
    });
    try {
      const value = input(origin, contract, { maxCases: 30 });
      const result = await executeApiCases(
        {
          ...value,
          grant: {
            ...value.grant,
            operations: [
              { method: 'POST', path: '/check', allowMutation: true },
            ],
          },
        },
        options,
      );
      if (status === 200)
        assert.ok(
          result.results.some((row) => row.code === 'invalid_input_accepted'),
        );
      else assert.ok(result.results.every((row) => row.status === 'passed'));
    } finally {
      await close(server);
    }
  }
});
test('special/private resolved addresses are refused independently of the origin grant', async () => {
  const { resolvePreviewAddress, ForbiddenPreviewError } =
    await import('./preview.js');
  for (const host of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '192.168.1.1',
    '0.0.0.0',
    '[::1]',
  ])
    await assert.rejects(
      resolvePreviewAddress(
        new URL(`https://${host}`),
        new AbortController().signal,
      ),
      ForbiddenPreviewError,
    );
});
test('cancellation during rate wait stops queued mutations and preserves completed evidence', async () => {
  const contract = document('post', {
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: { type: 'integer', minimum: 1, maximum: 3 },
        },
      },
    },
  });
  const controller = new AbortController();
  let calls = 0;
  const { server, origin } = await listen((req, res) => {
    calls++;
    req.resume();
    res.end();
    setTimeout(() => controller.abort(), 10);
  });
  try {
    const value = input(origin, contract, { maxCases: 20 });
    const result = await executeApiCases(
      {
        ...value,
        limits: { minIntervalMs: 100 },
        grant: {
          ...value.grant,
          operations: [{ method: 'POST', path: '/check', allowMutation: true }],
        },
      },
      { ...options, signal: controller.signal },
    );
    assert.equal(calls, 1);
    assert.equal(result.requests, 1);
    assert.equal(result.code, 'stopped');
    assert.ok(result.results.some((row) => row.status === 'skipped'));
  } finally {
    await close(server);
  }
});
