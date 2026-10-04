/** Synthetic GitHub payloads exercise policy decisions; no real credentials/network. */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { authorizeDelivery, parsePolicies } from './authorization.js';
import type {
  AuthorizationDependencies,
  PullRequestContext,
} from './authorization.js';
import { createApiApp } from './app.js';

const policies = parsePolicies([
  {
    tenantId: 'tenant-pawmart',
    installationId: 10,
    repositoryId: 20,
    authorizedActorIds: [30],
  },
]);
const base = {
  installation: { id: 10 },
  repository: { id: 20 },
  sender: { id: 30, type: 'User' },
};
const opened = {
  ...base,
  action: 'opened',
  number: 42,
  pull_request: { number: 42, labels: [{ name: 'dogwatch' }] },
};
const comment = {
  ...base,
  action: 'created',
  issue: { number: 42, pull_request: {} },
  comment: { body: '/dogwatch run', user: { id: 30 } },
};
const current: PullRequestContext = {
  installationActive: true,
  repositoryId: 20,
  number: 42,
  state: 'open',
  headSha: 'b'.repeat(40),
  headRepositoryId: 20,
  baseRepositoryId: 20,
  labels: ['dogwatch'],
};
const dependencies: AuthorizationDependencies = {
  policies,
  resolvePullRequest: async () => current,
};

// Result narrowing proves callers cannot use a denied decision as a normalized run.
test('opened/labeled/comment triggers resolve trusted tenant and current SHA', async () => {
  for (const [name, payload] of [
    [
      'pull_request',
      {
        ...opened,
        tenantId: 'attacker-tenant',
        pull_request: { ...opened.pull_request, head: { sha: 'a'.repeat(40) } },
      },
    ],
    [
      'pull_request',
      { ...opened, action: 'labeled', label: { name: 'dogwatch' } },
    ],
    ['issue_comment', comment],
  ] as const) {
    const result = await authorizeDelivery(
      name,
      'delivery-42',
      payload,
      dependencies,
    );
    assert.equal(result.status, 'eligible_only');
    if (result.status === 'eligible_only') {
      assert.equal(result.event.tenantId, 'tenant-pawmart');
      assert.equal(result.event.headSha, current.headSha);
      assert.equal(result.queued, false);
    }
  }
});

test('ordinary, unsupported, unknown, disabled and unauthorized requests do not call GitHub', async () => {
  let calls = 0;
  const resolver = async () => {
    calls++;
    return current;
  };
  const cases = [
    ['push', opened],
    ['pull_request', { ...opened, action: 'synchronize' }],
    ['pull_request', { ...opened, pull_request: { number: 42, labels: [] } }],
    ['pull_request', { ...opened, sender: { id: 999, type: 'User' } }],
    ['pull_request', { ...opened, installation: { id: 999 } }],
    ['issue_comment', { ...comment, issue: { number: 42 } }],
    [
      'issue_comment',
      {
        ...comment,
        comment: { ...comment.comment, body: 'Please /dogwatch run' },
      },
    ],
    ['issue_comment', { ...comment, action: 'edited' }],
    [
      'issue_comment',
      { ...comment, comment: { ...comment.comment, user: { id: 999 } } },
    ],
  ] as const;
  for (const [name, payload] of cases) {
    assert.equal(
      (
        await authorizeDelivery(name, 'delivery-42', payload, {
          policies,
          resolvePullRequest: resolver,
        })
      ).status,
      'ignored',
    );
  }
  assert.equal(
    (
      await authorizeDelivery('pull_request', 'delivery-42', opened, {
        policies: [{ ...policies[0], enabled: false }],
        resolvePullRequest: resolver,
      })
    ).status,
    'ignored',
  );
  assert.equal(calls, 0);
});

test('inactive installations, forks, closed PRs, removed labels and remote scope mismatch fail closed', async () => {
  for (const patch of [
    { installationActive: false },
    { headRepositoryId: 999 },
    { headRepositoryId: null },
    { state: 'closed' as const },
    { labels: [] },
    { repositoryId: 999 },
    { baseRepositoryId: 999 },
    { number: 43 },
  ]) {
    const result = await authorizeDelivery(
      'pull_request',
      'delivery-42',
      opened,
      { policies, resolvePullRequest: async () => ({ ...current, ...patch }) },
    );
    assert.equal(result.status, 'ignored');
  }
});

test('malformed supported payloads, invalid SHA, ambiguous policies, and lookup failures are not accepted', async () => {
  await assert.rejects(
    authorizeDelivery(
      'pull_request',
      'delivery-42',
      { action: 'opened' },
      dependencies,
    ),
  );
  await assert.rejects(
    authorizeDelivery('issue_comment', undefined, comment, dependencies),
  );
  await assert.rejects(
    authorizeDelivery('pull_request', 'delivery-42', opened, {
      policies,
      resolvePullRequest: async () => ({ ...current, headSha: 'main' }),
    }),
  );
  await assert.rejects(
    authorizeDelivery('issue_comment', 'delivery-42', comment, {
      policies,
      resolvePullRequest: async () => {
        throw new Error('upstream unavailable');
      },
    }),
  );
  assert.throws(() => parsePolicies([policies[0], policies[0]]), /Duplicate/);
  assert.throws(
    () =>
      parsePolicies([
        policies[0],
        { ...policies[0], tenantId: 'another-tenant', repositoryId: 21 },
      ]),
    /multiple tenants/,
  );
});

test('signed HTTP requests report eligibility only; lookup failures return 503 without leaking scope', async () => {
  const secret = 'synthetic-webhook-secret-for-tests-only';
  let fail = false;
  const server = createApiApp(secret, {
    policies,
    resolvePullRequest: async () => {
      if (fail) throw new Error('private upstream details');
      return current;
    },
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/webhooks/github`;
  try {
    const post = (payload: unknown) => {
      const body = JSON.stringify(payload);
      return fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': 'delivery-42',
          'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
        },
        body,
      });
    };
    const result = await post(opened);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), {
      status: 'eligible_only',
      queued: false,
      trigger: 'label',
    });
    assert.equal((await post({ action: 'opened' })).status, 400);
    fail = true;
    const failed = await post(opened);
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), {
      error: 'Authorization unavailable',
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
