import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { executeApiAuthorization } from './api-authorization.js';
import type { ScopedIdentityCredential } from './api-authorization.js';
import type { ApiExecutionInput } from './api-execution.js';
const { createFixtureApp } = await import(
  new URL('../../fixture/dist/app.js', import.meta.url).href
);
const contract = await readFile(
  new URL('../../fixture/public/authorization-openapi.yaml', import.meta.url),
  'utf8',
);
const scope = {
  tenantId: randomUUID(),
  runId: randomUUID(),
  repositoryId: 20,
  pullRequestNumber: 42,
  headSha: 'a'.repeat(40),
};
const alice = { ref: 'alice-account', subjectId: 'alice', role: 'customer' };
const bob = { ref: 'bob-account', subjectId: 'bob', role: 'customer' };
const admin = { ref: 'admin-account', subjectId: 'admin', role: 'admin' };
function input(origin: string): ApiExecutionInput {
  return {
    scope,
    binding: {
      tenantId: scope.tenantId,
      repositoryId: 20,
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
      deploymentId: 'fixture',
      origin,
      operations: [
        { method: 'GET', path: '/api/identity' },
        { method: 'GET', path: '/api/orders/{id}' },
        { method: 'GET', path: '/api/admin/report' },
      ],
      authorization: {
        identityCheck: {
          path: '/api/identity',
          subjectField: ['subjectId'],
          roleField: ['role'],
        },
        scenarios: [
          {
            kind: 'ownership',
            id: 'order-ownership',
            path: '/api/orders/{id}',
            allowed: alice,
            denied: bob,
            resourceParameter: 'id',
            ownerResource: 'order-alice',
            actorResource: 'order-bob',
            resourceIdField: ['id'],
            ownerField: ['owner'],
          },
          {
            kind: 'role',
            id: 'admin-report',
            path: '/api/admin/report',
            allowed: admin,
            denied: alice,
            evidence: [
              { field: ['report'], value: 'synthetic-admin-report' },
              { field: ['scope'], value: 'admin' },
            ],
          },
        ],
      },
    },
    contractText: contract,
    generation: { seed: 42 },
    limits: { minIntervalMs: 50, maxExecutionMs: 10000 },
  };
}
type Options = Parameters<typeof executeApiAuthorization>[1];
const options: Options = {
  fixture: true,
  isCurrent: async () => true,
  getIdentity: async (context, who, scheme) => {
    assert.equal(scheme, 'fixtureBearer');
    return {
      ...context,
      identityRef: who.ref,
      subjectId: who.subjectId,
      role: who.role,
      bearerToken: `fixture-${who.subjectId}`,
    };
  },
};
async function withTarget(
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
function ownershipOnly(origin: string) {
  const value = input(origin);
  value.grant.authorization!.scenarios =
    value.grant.authorization!.scenarios.slice(0, 1);
  return value;
}
function json(
  response: Parameters<RequestListener>[1],
  body: unknown,
  status = 200,
) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

test('real PawMart role and ownership controls distinguish healthy enforcement and seeded bypasses', async () => {
  for (const mode of ['healthy', 'ownership-bypass', 'role-bypass'])
    await withTarget(createFixtureApp(mode), async (origin) => {
      const output = await executeApiAuthorization(input(origin), options);
      assert.equal(output.requests, 9);
      assert.equal(output.results.length, 9);
      assert.equal(output.status, 'completed');
      const failures = output.results.filter((row) => row.status === 'failed');
      assert.deepEqual(
        failures.map((row) => row.code),
        mode === 'healthy'
          ? []
          : [
              mode === 'ownership-bypass'
                ? 'ownership_access_observed'
                : 'role_access_observed',
            ],
      );
      assert.ok(
        failures.every(
          (row) =>
            row.evidenceMatched === true && row.step === 'forbidden_access',
        ),
      );
      assert.equal(
        output.results.filter((row) => row.code === 'identity_verified').length,
        4,
      );
      const serialized = JSON.stringify(output);
      for (const secret of [
        'fixture-alice',
        'fixture-bob',
        'fixture-admin',
        '1 Test Lane',
        'order-alice',
        'order-bob',
        'synthetic-admin-report',
      ])
        assert.ok(!serialized.includes(secret), secret);
    });
});
test('probe IDs bind scope, scenario, baseline and policy while replay remains deterministic', async () => {
  await withTarget(createFixtureApp(), async (origin) => {
    const first = await executeApiAuthorization(ownershipOnly(origin), options);
    const replay = await executeApiAuthorization(
      ownershipOnly(origin),
      options,
    );
    assert.deepEqual(first.results, replay.results);
    assert.equal(new Set(first.results.map((row) => row.caseId)).size, 5);
    const changed = ownershipOnly(origin);
    changed.grant.authorization!.scenarios[0]!.rejectionStatus = 404;
    const other = await executeApiAuthorization(changed, options);
    assert.notEqual(first.results[0]!.caseId, other.results[0]!.caseId);
    assert.ok(
      other.results.some(
        (row) => row.code === 'authorization_rejection_mismatch',
      ),
    );
  });
});
test('2xx without the exact known resource and owner is inconclusive, not an ownership finding', async () => {
  for (const payload of [
    {},
    { id: 'order-alice', owner: 'bob', address: 'synthetic', quantity: 1 },
    { id: 'other', owner: 'alice', address: 'synthetic', quantity: 1 },
  ]) {
    const app = createFixtureApp();
    await withTarget(
      (req, res) => {
        if (
          req.url === '/api/orders/order-alice' &&
          req.headers.authorization === 'Bearer fixture-bob'
        )
          json(res, payload);
        else app(req, res);
      },
      async (origin) => {
        const output = await executeApiAuthorization(
          ownershipOnly(origin),
          options,
        );
        assert.equal(
          output.results.at(-1)?.code,
          'authorization_access_unproven',
        );
        assert.equal(output.results.at(-1)?.status, 'inconclusive');
        assert.ok(
          !output.results.some(
            (row) => row.code === 'ownership_access_observed',
          ),
        );
      },
    );
  }
});
test('wrong identity claims, roles or owner controls suppress forbidden requests', async () => {
  for (const broken of ['subject', 'role', 'owner', 'own-resource']) {
    const app = createFixtureApp();
    let forbidden = 0;
    await withTarget(
      (req, res) => {
        if (
          req.url === '/api/orders/order-alice' &&
          req.headers.authorization === 'Bearer fixture-bob'
        )
          forbidden++;
        if (
          req.url === '/api/identity' &&
          req.headers.authorization === 'Bearer fixture-bob' &&
          ['subject', 'role'].includes(broken)
        )
          json(res, {
            subjectId: broken === 'subject' ? 'alice' : 'bob',
            role: broken === 'role' ? 'admin' : 'customer',
          });
        else if (req.url === '/api/orders/order-alice' && broken === 'owner')
          json(res, {
            id: 'order-alice',
            owner: 'bob',
            address: 'synthetic',
            quantity: 1,
          });
        else if (
          req.url === '/api/orders/order-bob' &&
          broken === 'own-resource'
        )
          json(res, { error: 'missing' }, 404);
        else app(req, res);
      },
      async (origin) => {
        const result = await executeApiAuthorization(
          ownershipOnly(origin),
          options,
        );
        assert.equal(forbidden, 0);
        assert.equal(result.status, 'inconclusive');
        assert.equal(
          result.results.at(-1)?.code,
          'authorization_control_unavailable',
        );
      },
    );
  }
});
test('credential broker responses must match every run, deployment and identity field', async () => {
  await withTarget(createFixtureApp(), async (origin) => {
    for (const key of [
      'tenantId',
      'runId',
      'repositoryId',
      'pullRequestNumber',
      'headSha',
      'deploymentId',
      'origin',
      'identityRef',
      'subjectId',
      'role',
    ] as const) {
      const result = await executeApiAuthorization(ownershipOnly(origin), {
        ...options,
        getIdentity: async (context, who, scheme) => {
          const credentials = (await options.getIdentity(
            context,
            who,
            scheme,
          ))!;
          const changed =
            key === 'repositoryId' || key === 'pullRequestNumber'
              ? 99
              : key === 'tenantId' || key === 'runId'
                ? randomUUID()
                : key === 'headSha'
                  ? 'b'.repeat(40)
                  : key === 'origin'
                    ? 'http://127.0.0.1:1'
                    : 'other';
          return { ...credentials, [key]: changed } as ScopedIdentityCredential;
        },
      });
      assert.equal(result.requests, 0, key);
      assert.equal(result.results[0]?.code, 'identity_credentials_unavailable');
    }
    for (const token of ['same-token', 'unsafe\r\nheader']) {
      const result = await executeApiAuthorization(ownershipOnly(origin), {
        ...options,
        getIdentity: async (context, who, scheme) => ({
          ...(await options.getIdentity(context, who, scheme))!,
          bearerToken: token,
        }),
      });
      assert.equal(result.requests, 0);
      assert.equal(result.status, 'inconclusive');
    }
  });
});
test('invalid identity/resource declarations and duplicate scenario IDs fail validation before transport', async () => {
  await withTarget(createFixtureApp(), async (origin) => {
    for (const kind of [
      'subject',
      'reference',
      'role',
      'resource',
      'duplicate',
    ]) {
      const value = ownershipOnly(origin),
        scenario = value.grant.authorization!.scenarios[0]!;
      scenario.allowed = { ...scenario.allowed };
      scenario.denied = { ...scenario.denied };
      if (kind === 'subject')
        scenario.denied.subjectId = scenario.allowed.subjectId;
      if (kind === 'reference') scenario.denied.ref = scenario.allowed.ref;
      if (kind === 'role') scenario.denied.role = 'admin';
      if (kind === 'resource' && scenario.kind === 'ownership')
        scenario.actorResource = scenario.ownerResource;
      if (kind === 'duplicate')
        value.grant.authorization!.scenarios.push({ ...scenario });
      await assert.rejects(
        executeApiAuthorization(value, {
          ...options,
          getIdentity: async () => {
            assert.fail('must not request credentials');
          },
        }),
      );
    }
  });
});
test('all identity and resource requests need exact grants; generation allowlists only narrow access', async () => {
  let credentials = 0;
  await withTarget(createFixtureApp(), async (origin) => {
    for (const path of ['/api/identity', '/api/orders/{id}']) {
      const value = ownershipOnly(origin);
      value.grant.operations = value.grant.operations.filter(
        (op) => op.path !== path,
      );
      const result = await executeApiAuthorization(value, {
        ...options,
        getIdentity: async () => {
          credentials++;
          return undefined;
        },
      });
      assert.equal(result.requests, 0);
      assert.equal(result.results[0]?.code, 'operation_forbidden');
    }
    const narrowed = ownershipOnly(origin);
    narrowed.generation = {
      operationAllowlist: [{ method: 'GET', path: '/api/orders/{id}' }],
    };
    assert.equal(
      (await executeApiAuthorization(narrowed, options)).requests,
      0,
    );
    const ungranted = input(origin);
    delete ungranted.grant.authorization;
    assert.equal(
      (await executeApiAuthorization(ungranted, options)).code,
      'authorization_not_granted',
    );
    assert.equal(credentials, 0);
  });
});
test('mutations and unsafe resource paths cannot execute even with mutation permission', async () => {
  await withTarget(createFixtureApp(), async (origin) => {
    const mutation = ownershipOnly(origin);
    mutation.grant.authorization!.scenarios[0]!.method = 'DELETE';
    mutation.grant.disposableData = true;
    const result = await executeApiAuthorization(mutation, options);
    assert.equal(result.requests, 0);
    assert.equal(result.results[0]?.code, 'authorization_mutation_unsupported');
    for (const resource of ['..', 'other/path', '%2fsecret']) {
      const value = ownershipOnly(origin),
        scenario = value.grant.authorization!.scenarios[0]!;
      assert.equal(scenario.kind, 'ownership');
      if (scenario.kind === 'ownership') scenario.ownerResource = resource;
      assert.equal((await executeApiAuthorization(value, options)).requests, 0);
    }
  });
});
test('controls and cross-access consume one shared request and byte budget', async () => {
  await withTarget(createFixtureApp(), async (origin) => {
    for (const cap of [0, 1, 4]) {
      const value = ownershipOnly(origin);
      value.limits = { maxRequests: cap, minIntervalMs: 50 };
      const result = await executeApiAuthorization(value, options);
      assert.equal(result.requests, cap);
      assert.equal(result.code, 'request_budget');
      assert.ok(
        !result.results.some(
          (row) => row.step === 'forbidden_access' && row.status === 'passed',
        ),
      );
    }
    const complete = await executeApiAuthorization(
      ownershipOnly(origin),
      options,
    );
    const value = ownershipOnly(origin);
    value.limits = {
      maxTotalRequestBytes: complete.requestBytes - 1,
      minIntervalMs: 50,
    };
    const limited = await executeApiAuthorization(value, options);
    assert.equal(limited.requests, 4);
    assert.equal(limited.code, 'total_request_bytes');
  });
});
test('stale authority after forbidden response prevents an access finding', async () => {
  let stale = false;
  const app = createFixtureApp('ownership-bypass');
  await withTarget(
    (req, res) => {
      if (
        req.url === '/api/orders/order-alice' &&
        req.headers.authorization === 'Bearer fixture-bob'
      )
        stale = true;
      app(req, res);
    },
    async (origin) => {
      const result = await executeApiAuthorization(ownershipOnly(origin), {
        ...options,
        isCurrent: async () => !stale,
      });
      assert.equal(result.requests, 5);
      assert.equal(result.code, 'stopped');
      assert.ok(!result.results.some((row) => row.status === 'failed'));
    },
  );
});
test('credential stalls, socket stalls and cancellation are bounded and inconclusive', async () => {
  await withTarget(createFixtureApp(), async (origin) => {
    const value = ownershipOnly(origin);
    value.limits = { maxRequestMs: 20, maxExecutionMs: 100 };
    const result = await executeApiAuthorization(value, {
      ...options,
      getIdentity: () => new Promise(() => {}),
    });
    assert.equal(result.requests, 0);
    assert.equal(result.status, 'inconclusive');
  });
  await withTarget(
    () => {},
    async (origin) => {
      const value = ownershipOnly(origin);
      value.limits = { maxRequestMs: 20 };
      assert.equal(
        (await executeApiAuthorization(value, options)).code,
        'transport_unavailable',
      );
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20);
      try {
        assert.equal(
          (
            await executeApiAuthorization(ownershipOnly(origin), {
              ...options,
              signal: controller.signal,
            })
          ).code,
          'stopped',
        );
      } finally {
        clearTimeout(timer);
      }
    },
  );
});
test('redirect, rate limit and streamed response overflow stop all remaining scenarios', async () => {
  for (const kind of ['redirect', 'rate', 'large'])
    await withTarget(
      (_req, res) => {
        if (kind === 'large') res.end('x'.repeat(20000));
        else {
          res.writeHead(kind === 'redirect' ? 302 : 429, {
            location: '/secret',
          });
          res.end();
        }
      },
      async (origin) => {
        const result = await executeApiAuthorization(input(origin), options);
        assert.equal(result.requests, 1);
        assert.equal(
          result.code,
          kind === 'redirect'
            ? 'redirect_forbidden'
            : kind === 'rate'
              ? 'rate_limited'
              : 'response_bytes',
        );
        assert.ok(
          result.results.slice(1).every((row) => row.status === 'skipped'),
        );
      },
    );
});
test('configured concealment 404 can pass; other 4xx and server errors retain distinct outcomes', async () => {
  for (const [status, code] of [
    [404, 'authorization_rejected'],
    [400, 'authorization_rejection_unproven'],
    [401, 'identity_credentials_unavailable'],
    [500, 'server_error'],
  ] as const) {
    const app = createFixtureApp();
    await withTarget(
      (req, res) => {
        if (
          req.url === '/api/orders/order-alice' &&
          req.headers.authorization === 'Bearer fixture-bob'
        )
          json(res, { error: 'synthetic' }, status);
        else app(req, res);
      },
      async (origin) => {
        const value = ownershipOnly(origin);
        value.grant.authorization!.scenarios[0]!.rejectionStatus = 404;
        assert.equal(
          (await executeApiAuthorization(value, options)).results.at(-1)?.code,
          code,
        );
      },
    );
  }
});
test('scope and target mismatches are rejected before identity credentials are requested', async () => {
  await withTarget(createFixtureApp(), async (origin) => {
    for (const dimension of [
      'runId',
      'tenantId',
      'headSha',
      'deploymentId',
      'origin',
    ]) {
      const value = ownershipOnly(origin);
      Object.assign(value.grant, {
        [dimension]:
          dimension === 'origin'
            ? 'http://127.0.0.1:1'
            : dimension === 'headSha'
              ? 'b'.repeat(40)
              : dimension === 'deploymentId'
                ? 'other'
                : randomUUID(),
      });
      const result = await executeApiAuthorization(value, {
        ...options,
        getIdentity: async () => {
          assert.fail('must not request credentials');
        },
      });
      assert.equal(result.requests, 0);
      assert.equal(result.status, 'inconclusive');
    }
  });
});

test('protected object disclosure is detected with alternate success or denial status codes', async () => {
  for (const status of [201, 403, 404, 500]) {
    const app = createFixtureApp();
    await withTarget(
      (req, res) => {
        if (
          req.url === '/api/orders/order-alice' &&
          req.headers.authorization === 'Bearer fixture-bob'
        )
          json(
            res,
            {
              id: 'order-alice',
              owner: 'alice',
              address: 'synthetic secret',
              quantity: 1,
            },
            status,
          );
        else app(req, res);
      },
      async (origin) => {
        const result = await executeApiAuthorization(
          ownershipOnly(origin),
          options,
        );
        assert.equal(result.results.at(-1)?.code, 'ownership_access_observed');
        assert.equal(result.results.at(-1)?.httpStatus, status);
        assert.ok(!JSON.stringify(result).includes('synthetic secret'));
      },
    );
  }
});
test('anonymous security and incompatible identity schemas cannot produce authorization controls', async () => {
  await withTarget(createFixtureApp(), async (origin) => {
    for (const contractText of [
      contract.replace('security:\n  - fixtureBearer: []', 'security: []'),
      contract.replace('type: object', 'type: string'),
    ]) {
      const value = ownershipOnly(origin);
      value.contractText = contractText;
      const result = await executeApiAuthorization(value, options);
      assert.equal(result.status, 'inconclusive');
      assert.ok(
        !result.results.some(
          (row) => row.step === 'forbidden_access' && row.status === 'passed',
        ),
      );
    }
  });
});

test('the new fixture administrator can create an order satisfying the original API response contract', async () => {
  const { executeApiCases } = await import('./api-execution.js');
  const original = await readFile(
    new URL('../../fixture/public/openapi.yaml', import.meta.url),
    'utf8',
  );
  await withTarget(createFixtureApp(), async (origin) => {
    const value = input(origin);
    value.contractText = original;
    value.grant = {
      ...value.grant,
      authorization: undefined,
      disposableData: true,
      operations: [
        { method: 'POST', path: '/api/orders', allowMutation: true },
      ],
    };
    value.generation = {
      baselineOnly: true,
      operationAllowlist: [{ method: 'POST', path: '/api/orders' }],
      fixtures: [
        {
          method: 'POST',
          path: '/api/orders',
          bodyJson: '{"address":"Synthetic lane","quantity":1}',
        },
      ],
    };
    const result = await executeApiCases(value, {
      fixture: true,
      isCurrent: async () => true,
      getBearerToken: async () => 'fixture-admin',
    });
    assert.equal(result.requests, 1);
    assert.equal(result.results[0]?.status, 'passed');
    assert.equal(result.results[0]?.httpStatus, 201);
  });
});

test('caller mutation during credential lookup cannot replace the immutable contract or generation policy', async () => {
  await withTarget(createFixtureApp(), async (origin) => {
    const value = input(origin);
    let mutated = false;
    const result = await executeApiAuthorization(value, {
      ...options,
      getIdentity: async (context, who, scheme) => {
        if (!mutated) {
          mutated = true;
          value.contractText = '{}';
          value.generation!.seed = 99;
          value.generation!.operationAllowlist = [];
          value.grant.operations = [];
        }
        return options.getIdentity(context, who, scheme);
      },
    });
    assert.equal(result.requests, 9);
    assert.equal(result.status, 'completed');
    assert.equal(result.seed, 42);
  });
});
