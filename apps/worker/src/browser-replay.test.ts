import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { classifyReplay, replayFixtureFailure } from './browser-replay.js';
import type { ApiLifecycleProvider } from './api-lifecycle.js';
const scope = {
  tenantId: randomUUID(),
  runId: randomUUID(),
  repositoryId: 1,
  pullRequestNumber: 2,
  headSha: 'a'.repeat(40),
};
const input = {
  scope,
  policy: {
    ...scope,
    origin: 'http://127.0.0.1:1234',
    disposableData: true,
    navigationPaths: ['/'],
    requests: [{ path: '/', method: 'GET' }],
    targets: [],
    values: {},
  },
  script: {
    id: 'refresh',
    kind: 'refresh',
    steps: [
      { kind: 'navigate', path: '/' },
      { kind: 'navigate', path: '/' },
    ],
  },
  deploymentId: 'fixture',
  assertion: { failureText: 'Failure marker', successText: 'Success marker' },
};
test('repeatability requires complete independent results and distinguishes mixed observations', () => {
  assert.equal(classifyReplay(['failure', 'failure']), 'reproduced');
  assert.equal(classifyReplay(['success', 'success']), 'not_reproduced');
  assert.equal(classifyReplay(['failure', 'success']), 'unstable');
  for (const rows of [
    [],
    ['failure'],
    ['failure', 'inconclusive'],
    ['failure', 'failure', 'inconclusive'],
  ] as const)
    assert.equal(classifyReplay(rows), 'inconclusive');
});
for (const scenario of [
  'setup_failure',
  'wrong_scope',
  'cleanup_denied',
  'cleanup_nonempty',
  'cleanup_wrong_scope',
  'unsettled',
] as const) {
  test(`replay preserves inconclusive outcome after ${scenario}`, async () => {
    let cleanup = 0;
    const lifecycle: ApiLifecycleProvider = {
      async prepare(context) {
        if (scenario === 'unsettled') return new Promise(() => {});
        if (scenario === 'setup_failure') throw Error('private error');
        return {
          ...context,
          runId: randomUUID(),
          fixtureDigest: 'a'.repeat(64),
          datasetDigest: 'b'.repeat(64),
          identityDigest: 'c'.repeat(64),
        };
      },
      async canCleanup() {
        return scenario !== 'cleanup_denied';
      },
      async cleanup() {
        cleanup++;
      },
      async verifyEmpty(context) {
        return {
          ...context,
          namespaceId:
            scenario === 'cleanup_wrong_scope'
              ? randomUUID()
              : context.namespaceId,
          empty: scenario !== 'cleanup_nonempty',
        };
      },
    };
    const result = await replayFixtureFailure(
      { ...input, executionMs: 30 },
      { lifecycle, isCurrent: async () => true },
    );
    assert.equal(result.classification, 'inconclusive');
    assert.equal(result.attempts.length, 1);
    assert.equal(cleanup, scenario === 'cleanup_denied' ? 0 : 1);
    assert.ok(!JSON.stringify(result).includes('private error'));
    if (scenario.startsWith('cleanup') || scenario === 'unsettled')
      assert.equal(result.attempts[0].cleanup, 'unverified');
  });
}
test('invalid assertions or cross-scope policy never prepare state', async () => {
  let called = false;
  const lifecycle = {} as ApiLifecycleProvider;
  lifecycle.prepare = async () => {
    called = true;
    throw Error();
  };
  await assert.rejects(
    replayFixtureFailure(
      { ...input, assertion: { failureText: 'same', successText: 'same' } },
      { lifecycle, isCurrent: async () => true },
    ),
  );
  await assert.rejects(
    replayFixtureFailure(
      { ...input, policy: { ...input.policy, runId: randomUUID() } },
      { lifecycle, isCurrent: async () => true },
    ),
  );
  assert.equal(called, false);
});
