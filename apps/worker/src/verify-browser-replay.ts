/** Replay actual PawMart UI behavior with fresh browser and backend state each time. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFixtureApiLifecycle } from './fixture-api-lifecycle.js';
import { replayFixtureFailure } from './browser-replay.js';
const scope = {
  tenantId: randomUUID(),
  runId: randomUUID(),
  repositoryId: 20,
  pullRequestNumber: 42,
  headSha: 'a'.repeat(40),
};
const authority = {
  tenantId: scope.tenantId,
  repositoryId: scope.repositoryId,
  pullRequestNumber: scope.pullRequestNumber,
  headSha: scope.headSha,
  deploymentId: 'fixture',
};
for (const mode of ['healthy', 'checkout-stuck']) {
  const fixture = await createFixtureApiLifecycle(authority, mode);
  const input = {
    scope,
    deploymentId: 'fixture',
    policy: {
      ...scope,
      origin: fixture.origin,
      disposableData: true,
      navigationPaths: ['/'],
      requests: [
        ...['/', '/style.css', '/browser.js', '/fixture-config'].map(
          (path) => ({ path, method: 'GET' }),
        ),
        { path: '/api/orders', method: 'POST', allowMutation: true },
      ],
      targets: [
        {
          id: 'address',
          locator: { kind: 'label', name: 'Delivery address' },
          actions: ['fill'],
          valueRefs: ['empty'],
        },
        {
          id: 'submit',
          locator: { kind: 'role', role: 'button', name: 'Place order' },
          actions: ['click'],
        },
      ],
      values: { empty: '' },
    },
    script: {
      id: 'empty-address',
      kind: 'boundary_input',
      steps: [
        { kind: 'navigate', path: '/' },
        { kind: 'fill', target: 'address', valueRef: 'empty' },
        { kind: 'click', target: 'submit' },
      ],
    },
    assertion: {
      failureText: 'Processing…',
      successText: 'Address is required',
    },
  };
  try {
    const result = await replayFixtureFailure(input, {
      lifecycle: fixture.lifecycle,
      isCurrent: async () => true,
    });
    assert.equal(
      result.classification,
      mode === 'healthy' ? 'not_reproduced' : 'reproduced',
    );
    assert.equal(result.attribution, 'unavailable');
    assert.equal(
      new Set(result.attempts.map((row) => row.namespaceId)).size,
      2,
    );
    assert.ok(
      result.attempts.every(
        (row) => row.cleanup === 'verified' && row.screenshotDigest,
      ),
    );
    assert.equal((await fetch(fixture.origin + '/health')).status, 503);
    if (mode === 'healthy') {
      let preparations = 0;
      const changed = {
        ...fixture.lifecycle,
        async prepare(...args: Parameters<typeof fixture.lifecycle.prepare>) {
          const receipt = await fixture.lifecycle.prepare(...args);
          return {
            ...receipt,
            datasetDigest:
              ++preparations === 1 ? receipt.datasetDigest : 'f'.repeat(64),
          };
        },
      };
      const drift = await replayFixtureFailure(input, {
        lifecycle: changed,
        isCurrent: async () => true,
      });
      assert.equal(drift.classification, 'inconclusive');
      assert.equal(drift.attempts[1].code, 'replay_incompatible');
      assert.equal(drift.attempts[1].cleanup, 'verified');
    }
  } finally {
    await fixture.close();
  }
}
console.log(
  'Browser failure replay verified: healthy control, repeated seeded UI failure, fresh namespaces, verified cleanup and incompatible-state refusal.',
);
