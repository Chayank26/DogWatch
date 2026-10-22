/** Real local targets only. Authentication probes reuse the existing execution budgets. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { executeApiAuthentication } from './api-execution.js';
import type {
  ApiExecutionInput,
  ApiExecutionOptions,
} from './api-execution.js';
const scope = {
  tenantId: randomUUID(),
  runId: randomUUID(),
  repositoryId: 10,
  pullRequestNumber: 42,
  headSha: 'a'.repeat(40),
};
const document = (
  operation: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) =>
  JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Synthetic', version: '1' },
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    },
    paths: {
      '/check': {
        get: {
          responses: {
            '200': { description: 'ok' },
            '401': { description: 'missing' },
            '403': { description: 'forbidden' },
          },
          ...operation,
        },
      },
    },
    ...extra,
  });
function input(origin: string, contractText = document()): ApiExecutionInput {
  return {
    scope,
    binding: {
      tenantId: scope.tenantId,
      repositoryId: scope.repositoryId,
      pullRequestNumber: 42,
      headSha: scope.headSha,
      deploymentId: 'fixture',
      url: origin,
      allowedOrigins: [origin],
      maxWaitSeconds: 60,
      maxRequests: 20,
      pollIntervalMs: 1000,
    },
    grant: {
      ...scope,
      origin,
      deploymentId: 'fixture',
      disposableData: true,
      operations: [
        {
          method: 'GET',
          path: '/check',
          authentication: { successStatuses: [200], invalidBearer: true },
        },
      ],
    },
    contractText,
    limits: { minIntervalMs: 50 },
  };
}
const options: ApiExecutionOptions = {
  fixture: true,
  isCurrent: async () => true,
  getBearerToken: async () => 'fixture-valid',
  getInvalidBearerToken: async () => 'fixture-invalid',
};
async function withServer(
  handler: RequestListener,
  run: (origin: string) => Promise<void>,
) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
const healthy: RequestListener = (req, res) => {
  res.writeHead(
    req.headers.authorization === 'Bearer fixture-valid' ? 200 : 401,
  );
  res.end();
};
test('authenticated control, missing and attested-invalid bearer are separate deterministic observations', async () => {
  const seen: (string | undefined)[] = [];
  await withServer(
    (req, res) => {
      seen.push(req.headers.authorization);
      res.setHeader('set-cookie', 'session=must-not-be-replayed');
      assert.equal(req.headers.cookie, undefined);
      healthy(req, res);
    },
    async (origin) => {
      const first = await executeApiAuthentication(input(origin), options);
      const replay = await executeApiAuthentication(input(origin), options);
      assert.equal(first.status, 'completed');
      assert.equal(first.requests, 3);
      assert.deepEqual(
        first.results.map((row) => [row.probe, row.code]),
        [
          ['control', 'authentication_control_passed'],
          ['missing', 'authentication_rejected'],
          ['invalid_bearer', 'authentication_rejected'],
        ],
      );
      assert.deepEqual(first.results, replay.results);
      assert.equal(new Set(first.results.map((row) => row.caseId)).size, 3);
      assert.equal(
        new Set(first.results.map((row) => row.baselineCaseId)).size,
        1,
      );
      assert.ok(!JSON.stringify(first).includes('fixture-valid'));
      assert.ok(!JSON.stringify(first).includes('fixture-invalid'));
      assert.deepEqual(seen.slice(0, 3), [
        'Bearer fixture-valid',
        undefined,
        'Bearer fixture-invalid',
      ]);
    },
  );
});
test('missing or invalid credentials accepted after a passing control are observed failures', async () => {
  await withServer(
    (_req, res) => res.end(),
    async (origin) => {
      const result = await executeApiAuthentication(input(origin), options);
      assert.equal(result.status, 'completed');
      assert.deepEqual(
        result.results.slice(1).map((row) => [row.status, row.code]),
        [
          ['failed', 'authentication_accepted'],
          ['failed', 'authentication_accepted'],
        ],
      );
    },
  );
});
test('unsuccessful authenticated controls suppress negative requests and claims', async () => {
  for (const status of [400, 401, 403, 404, 500]) {
    let calls = 0;
    await withServer(
      (_req, res) => {
        calls++;
        res.writeHead(status);
        res.end();
      },
      async (origin) => {
        const result = await executeApiAuthentication(input(origin), options);
        assert.equal(calls, 1);
        assert.equal(result.status, 'inconclusive');
        assert.ok(
          result.results.every(
            (row) => row.code === 'authentication_control_unavailable',
          ),
        );
      },
    );
  }
});
test('a control response must satisfy the declared response schema', async () => {
  await withServer(
    (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":"bad"}');
    },
    async (origin) => {
      const value = input(
        origin,
        document({
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
            '401': { description: 'missing' },
          },
        }),
      );
      const result = await executeApiAuthentication(value, options);
      assert.equal(result.requests, 1);
      assert.ok(result.results.every((row) => row.status === 'inconclusive'));
    },
  );
});
test('exact configured rejection is required; other rejections never prove authentication enforcement', async () => {
  for (const [status, code, outcome] of [
    [403, 'authentication_rejection_mismatch', 'failed'],
    [400, 'authentication_rejection_unproven', 'inconclusive'],
    [404, 'authentication_rejection_unproven', 'inconclusive'],
    [500, 'server_error', 'failed'],
  ] as const) {
    await withServer(
      (req, res) => {
        res.writeHead(
          req.headers.authorization === 'Bearer fixture-valid' ? 200 : status,
        );
        res.end();
      },
      async (origin) => {
        const result = await executeApiAuthentication(input(origin), options);
        assert.equal(result.results[1]?.code, code);
        assert.equal(result.results[1]?.status, outcome);
      },
    );
  }
  await withServer(
    (req, res) => {
      res.writeHead(
        req.headers.authorization === 'Bearer fixture-valid' ? 200 : 403,
      );
      res.end();
    },
    async (origin) => {
      const value = input(origin);
      value.grant.operations[0]!.authentication!.rejectionStatus = 403;
      assert.equal(
        (await executeApiAuthentication(value, options)).results[1]?.code,
        'authentication_rejected',
      );
    },
  );
});
test('configured rejection response schema is checked instead of accepting status alone', async () => {
  const response = {
    description: 'missing',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'string' } },
        },
      },
    },
  };
  await withServer(
    (req, res) => {
      res.writeHead(
        req.headers.authorization === 'Bearer fixture-valid' ? 200 : 401,
        { 'content-type': 'application/json' },
      );
      res.end('{}');
    },
    async (origin) => {
      const result = await executeApiAuthentication(
        input(
          origin,
          document({
            responses: { '200': { description: 'ok' }, '401': response },
          }),
        ),
        options,
      );
      assert.equal(result.results[1]?.code, 'response_schema');
      assert.equal(result.results[1]?.status, 'failed');
    },
  );
});
test('anonymous, unsupported or ungranted auth metadata sends no probe requests', async () => {
  let calls = 0;
  await withServer(
    (_req, res) => {
      calls++;
      res.end();
    },
    async (origin) => {
      for (const contract of [
        document({ security: [] }),
        document({ security: [{}, { bearer: [] }] }),
        document(
          {},
          {
            components: {
              securitySchemes: { bearer: { type: 'http', scheme: 'basic' } },
            },
          },
        ),
        document({
          responses: {
            '200': { description: 'ok' },
            default: { description: 'generic' },
          },
        }),
        document({
          parameters: [{ in: 'query', name: 'q', schema: { type: 'string' } }],
        }),
      ]) {
        const result = await executeApiAuthentication(
          input(origin, contract),
          options,
        );
        assert.equal(result.requests, 0);
        assert.equal(result.status, 'inconclusive');
      }
      const value = input(origin);
      delete value.grant.operations[0]!.authentication;
      assert.equal(
        (await executeApiAuthentication(value, options)).requests,
        0,
      );
      assert.equal(calls, 0);
    },
  );
});
test('missing providers, identical control token and unsafe invalid tokens are coverage gaps', async () => {
  await withServer(healthy, async (origin) => {
    const missing = await executeApiAuthentication(input(origin), {
      ...options,
      getBearerToken: undefined,
    });
    assert.equal(missing.requests, 0);
    for (const provider of [
      undefined,
      async () => undefined,
      async () => 'fixture-valid',
      async () => 'bad\r\nheader',
    ]) {
      const result = await executeApiAuthentication(input(origin), {
        ...options,
        getInvalidBearerToken: provider,
      });
      assert.equal(result.requests, 2);
      assert.equal(result.results[2]?.status, 'inconclusive');
      assert.ok(!result.results.some((row) => row.status === 'failed'));
    }
    const value = input(origin);
    value.grant.operations[0]!.authentication!.invalidBearer = false;
    assert.equal(
      (
        await executeApiAuthentication(value, {
          ...options,
          getInvalidBearerToken: async () => {
            throw Error('must not call');
          },
        })
      ).requests,
      2,
    );
  });
});
test('control and negatives share attempt and aggregate wire budgets', async () => {
  await withServer(healthy, async (origin) => {
    for (const cap of [0, 1, 2]) {
      const value = input(origin);
      value.limits = { maxRequests: cap, minIntervalMs: 50 };
      const result = await executeApiAuthentication(value, options);
      assert.equal(result.requests, cap);
      assert.equal(result.code, 'request_budget');
      assert.equal(result.status, 'inconclusive');
    }
    const base = await executeApiAuthentication(input(origin), options);
    const value = input(origin);
    value.limits = {
      minIntervalMs: 50,
      maxTotalRequestBytes: base.requestBytes - 1,
    };
    const limited = await executeApiAuthentication(value, options);
    assert.equal(limited.requests, 2);
    assert.equal(limited.code, 'total_request_bytes');
  });
});
test('authority changes, in-flight cancellation and callback deadlines cannot produce auth success', async () => {
  await withServer(healthy, async (origin) => {
    let checks = 0;
    const stale = await executeApiAuthentication(input(origin), {
      ...options,
      isCurrent: async () => ++checks < 4,
    });
    assert.equal(stale.requests, 1);
    assert.equal(stale.code, 'stopped');
    const value = input(origin);
    value.limits = { maxRequestMs: 20 };
    const stalled = await executeApiAuthentication(value, {
      ...options,
      getBearerToken: () => new Promise(() => {}),
    });
    assert.equal(stalled.requests, 0);
    assert.equal(stalled.status, 'inconclusive');
  });
  const controller = new AbortController();
  await withServer(
    () => {
      controller.abort();
    },
    async (origin) => {
      const cancelled = await executeApiAuthentication(input(origin), {
        ...options,
        signal: controller.signal,
      });
      assert.equal(cancelled.code, 'stopped');
      assert.equal(cancelled.results[0]?.status, 'inconclusive');
    },
  );
});
test('control redirects and rate limits stop the entire auth stage', async () => {
  for (const status of [302, 429]) {
    await withServer(
      (_req, res) => {
        res.writeHead(status, { location: '/other' });
        res.end();
      },
      async (origin) => {
        const result = await executeApiAuthentication(input(origin), options);
        assert.equal(result.requests, 1);
        assert.equal(
          result.code,
          status === 302 ? 'redirect_forbidden' : 'rate_limited',
        );
      },
    );
  }
});
test('auth mutations retain exact disposable operation authority and never retry', async () => {
  const contract = JSON.parse(document());
  contract.paths['/check'].post = contract.paths['/check'].get;
  delete contract.paths['/check'].get;
  let calls = 0;
  await withServer(
    (req) => {
      calls++;
      req.socket.destroy();
    },
    async (origin) => {
      for (const [allowMutation, disposableData] of [
        [false, true],
        [true, false],
        [true, true],
      ]) {
        const value = input(origin, JSON.stringify(contract));
        value.grant.disposableData = disposableData;
        value.grant.operations[0]!.method = 'POST';
        value.grant.operations[0]!.allowMutation = allowMutation;
        value.limits = { maxRetries: 2 };
        const result = await executeApiAuthentication(value, options);
        assert.equal(result.requests, allowMutation && disposableData ? 1 : 0);
      }
      assert.equal(calls, 1);
    },
  );
});
test('run, PR, SHA, deployment and origin mismatches prevent authentication requests', async () => {
  await withServer(healthy, async (origin) => {
    for (const change of [
      'tenantId',
      'runId',
      'pullRequestNumber',
      'repositoryId',
      'headSha',
      'deploymentId',
      'origin',
    ] as const) {
      const value = input(origin);
      const grant = value.grant as unknown as Record<string, unknown>;
      grant[change] =
        change === 'pullRequestNumber' || change === 'repositoryId'
          ? 99
          : change === 'headSha'
            ? 'b'.repeat(40)
            : change === 'deploymentId'
              ? 'other'
              : change === 'origin'
                ? 'http://127.0.0.1:1'
                : randomUUID();
      assert.equal(
        (await executeApiAuthentication(value, options)).requests,
        0,
      );
    }
  });
});
test('PawMart healthy rejects missing/invalid authentication and seeded bypass is detected', async () => {
  const { createFixtureApp } = await import(
    new URL('../../fixture/dist/app.js', import.meta.url).href
  );
  const contract = await readFile(
    new URL('../../fixture/public/openapi.yaml', import.meta.url),
    'utf8',
  );
  for (const mode of ['healthy', 'authentication-bypass']) {
    await withServer(createFixtureApp(mode), async (origin) => {
      const value = input(origin, contract);
      value.grant.operations = [
        {
          method: 'GET',
          path: '/api/orders/{id}',
          authentication: { successStatuses: [200], invalidBearer: true },
        },
        {
          method: 'POST',
          path: '/api/orders',
          allowMutation: true,
          authentication: { successStatuses: [201], invalidBearer: true },
        },
      ];
      value.generation = {
        seed: 42,
        fixtures: [
          {
            method: 'GET',
            path: '/api/orders/{id}',
            parameters: [{ in: 'path', name: 'id', value: 'order-alice' }],
          },
          {
            method: 'POST',
            path: '/api/orders',
            bodyJson: '{"address":"1 Test Lane","quantity":2}',
          },
        ],
      };
      const result = await executeApiAuthentication(value, {
        ...options,
        getBearerToken: async () => 'fixture-alice',
        getInvalidBearerToken: async () => 'fixture-invalid',
      });
      assert.equal(result.requests, 6);
      assert.equal(result.status, 'completed');
      const failures = result.results.filter((row) => row.status === 'failed');
      assert.equal(failures.length, mode === 'healthy' ? 0 : 4);
      assert.ok(
        failures.every((row) => row.code === 'authentication_accepted'),
      );
    });
  }
});
