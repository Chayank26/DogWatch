import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRerunService } from './run-controls.js';
import type { RunControlStore } from '@dogwatch/database';
const scope = {
  tenantId: randomUUID(),
  runId: randomUUID(),
  sessionHash: 'a'.repeat(64),
};
const context = {
  installationId: 10,
  repositoryId: 20,
  pullRequestNumber: 42,
  revision: 1,
};
const pr = {
  installationActive: true,
  repositoryId: 20,
  number: 42,
  state: 'open' as const,
  headSha: 'b'.repeat(40),
  headRepositoryId: 20,
  baseRepositoryId: 20,
  labels: [],
};
test('manual rerun resolves current SHA and delegates a bound context without trusting old run SHA', async () => {
  let commits = 0;
  const store = {
    prepare: async () => context,
    commit: async (value, id, snapshot, sha) => {
      assert.deepEqual(value, scope);
      assert.equal(id, requestId);
      assert.deepEqual(snapshot, context);
      assert.equal(sha, pr.headSha);
      commits++;
      return { status: 'accepted', runId: randomUUID(), queued: false };
    },
  } as RunControlStore;
  const requestId = randomUUID();
  await createRerunService(store, async (installation, repo, number) => {
    assert.deepEqual([installation, repo, number], [10, 20, 42]);
    return pr;
  })(scope, requestId);
  assert.equal(commits, 1);
});
test('closed, suspended, forked or mismatched PR contexts cannot create reruns', async () => {
  for (const patch of [
    { state: 'closed' as const },
    { installationActive: false },
    { headRepositoryId: 99 },
    { baseRepositoryId: 99 },
    { repositoryId: 99 },
    { number: 43 },
    { headSha: 'invalid' },
  ]) {
    const store = {
      prepare: async () => context,
      commit: async () => {
        assert.fail('must not commit');
      },
    } as unknown as RunControlStore;
    await assert.rejects(
      createRerunService(store, async () => ({ ...pr, ...patch }))(
        scope,
        randomUUID(),
      ),
    );
  }
});
test('revoked local authority and provider failures fail closed', async () => {
  const denied = {
    prepare: async () => {
      throw Error('control_not_found');
    },
  } as unknown as RunControlStore;
  await assert.rejects(
    createRerunService(denied, async () => {
      assert.fail('must not call provider');
    })(scope, randomUUID()),
    /not_found/,
  );
  const store = { prepare: async () => context } as RunControlStore;
  await assert.rejects(
    createRerunService(store, async () => {
      throw Error('provider unavailable');
    })(scope, randomUUID()),
    /provider unavailable/,
  );
});
