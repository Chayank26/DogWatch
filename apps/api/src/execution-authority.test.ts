import assert from 'node:assert/strict';
import test from 'node:test';
import { repositoryPolicySchema } from '@dogwatch/contracts';
import { createExecutionAuthority } from './execution-authority.js';
const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  installationId: 10,
  repositoryId: 20,
  pullRequestNumber: 1,
  headSha: 'a'.repeat(40),
};
const policy = repositoryPolicySchema.parse({
  ...Object.fromEntries(
    ['tenantId', 'installationId', 'repositoryId'].map((k) => [
      k,
      scope[k as keyof typeof scope],
    ]),
  ),
  authorizedActorIds: [30],
});
test('execution rechecks actor, policy, durable scope and current GitHub authority', async () => {
  let currentPolicy = structuredClone(policy);
  let snapshot: unknown = { ...policy, actorId: 30, trigger: 'label' };
  let state = 'queued';
  let remote = {
    installationActive: true,
    repositoryId: 20,
    number: 1,
    state: 'open' as 'open' | 'closed',
    headSha: scope.headSha,
    headRepositoryId: 20,
    baseRepositoryId: 20,
    labels: ['dogwatch'],
  };
  let calls = 0;
  const db = {
    run: {
      findFirst: async () => ({
        ...scope,
        repositoryId: 20n,
        state,
        policySnapshot: snapshot,
        repository: { installationId: 10n },
      }),
    },
  } as unknown as Parameters<typeof createExecutionAuthority>[0];
  const resolve = createExecutionAuthority(
    db,
    async () => [currentPolicy],
    async () => {
      calls++;
      return remote;
    },
  );
  assert.equal((await resolve(scope)).authorized, true);
  currentPolicy = { ...policy, authorizedActorIds: [31] };
  assert.equal((await resolve(scope)).authorized, false);
  assert.equal(calls, 1);
  currentPolicy = policy;
  for (const change of [
    { labels: [] },
    { headSha: 'b'.repeat(40) },
    { headRepositoryId: 21 },
    { installationActive: false },
    { state: 'closed' as const },
    { number: 2 },
    { baseRepositoryId: 21 },
  ]) {
    const previous = remote;
    remote = { ...remote, ...change };
    assert.equal((await resolve(scope)).authorized, false);
    remote = previous;
  }
  state = 'cancelled';
  assert.equal((await resolve(scope)).authorized, false);
  state = 'queued';
  snapshot = { ...policy, trigger: 'label' };
  assert.equal((await resolve(scope)).authorized, false);
  snapshot = { ...policy, actorId: 30, trigger: 'command' };
  remote.labels = [];
  assert.equal((await resolve(scope)).authorized, true);
  const unavailable = createExecutionAuthority(
    db,
    async () => {
      throw Error('unavailable');
    },
    async () => remote,
  );
  assert.equal((await unavailable(scope)).authorized, false);
});
