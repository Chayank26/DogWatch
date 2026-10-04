/**
 * Behavior tests for the policy boundary. Node's built-in test runner supplies
 * `test`; strict assertions fail the test when a decision differs from policy.
 * Fixtures use invented IDs and commit hashes, not credentials or real users.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  budgetSchema,
  evaluateOptIn,
  findingSchema,
  optInEventSchema,
  repositoryPolicySchema,
  runRequestSchema,
  runStateSchema,
} from './index.js';

/** A valid connected repository with one explicitly approved GitHub actor. */
const policy = repositoryPolicySchema.parse({
  tenantId: 'tenant-pawmart',
  installationId: 10,
  repositoryId: 20,
  authorizedActorIds: [30],
});
/** Shared identity context; each test supplies the event-specific fields. */
const context = {
  tenantId: policy.tenantId,
  installationId: 10,
  repositoryId: 20,
  actorId: 30,
  deliveryId: 'delivery-example',
  pullRequestNumber: 42,
  headSha: 'a'.repeat(40),
};

test('ordinary PRs do not opt in; opened and newly labeled PRs can opt in', () => {
  assert.deepEqual(
    evaluateOptIn(policy, { ...context, kind: 'pr_opened', labels: [] }),
    { accepted: false, reason: 'no_opt_in' },
  );
  assert.deepEqual(
    evaluateOptIn(policy, {
      ...context,
      kind: 'pr_opened',
      labels: ['dogwatch'],
    }),
    { accepted: true, trigger: 'label' },
  );
  assert.deepEqual(
    evaluateOptIn(policy, {
      ...context,
      kind: 'pr_labeled',
      addedLabel: 'dogwatch',
    }),
    { accepted: true, trigger: 'label' },
  );
  assert.equal(
    evaluateOptIn(policy, { ...context, kind: 'pr_labeled', addedLabel: 'bug' })
      .accepted,
    false,
  );
});

test('commands match a complete trimmed comment, not mentions or quoted commands', () => {
  for (const body of ['/dogwatch run', '  /dogwatch run\n']) {
    assert.deepEqual(
      evaluateOptIn(policy, { ...context, kind: 'pr_comment', body }),
      { accepted: true, trigger: 'command' },
    );
  }
  for (const body of [
    'Please /dogwatch run',
    '```\n/dogwatch run\n```',
    '/dogwatch run extra',
    '/DOGWATCH run',
  ]) {
    assert.equal(
      evaluateOptIn(policy, { ...context, kind: 'pr_comment', body }).accepted,
      false,
    );
  }
});

test('disabled repositories and unapproved actors are rejected for every trigger', () => {
  for (const event of [
    { ...context, kind: 'pr_opened', labels: ['dogwatch'] },
    { ...context, kind: 'pr_labeled', addedLabel: 'dogwatch' },
    { ...context, kind: 'pr_comment', body: '/dogwatch run' },
  ]) {
    assert.deepEqual(evaluateOptIn({ ...policy, enabled: false }, event), {
      accepted: false,
      reason: 'disabled',
    });
    assert.deepEqual(evaluateOptIn(policy, { ...event, actorId: 999 }), {
      accepted: false,
      reason: 'unauthorized_actor',
    });
  }
});

test('tenant, installation, and repository must each match the selected policy', () => {
  for (const changedScope of [
    { tenantId: 'another-tenant' },
    { installationId: 999 },
    { repositoryId: 999 },
  ]) {
    assert.deepEqual(
      evaluateOptIn(policy, {
        ...context,
        ...changedScope,
        kind: 'pr_comment',
        body: '/dogwatch run',
      }),
      { accepted: false, reason: 'scope_mismatch' },
    );
  }
});

test('custom triggers replace defaults rather than adding hidden triggers', () => {
  const custom = { ...policy, label: 'qa-ready', command: '/qa run' };
  assert.equal(
    evaluateOptIn(custom, {
      ...context,
      kind: 'pr_labeled',
      addedLabel: 'dogwatch',
    }).accepted,
    false,
  );
  assert.equal(
    evaluateOptIn(custom, {
      ...context,
      kind: 'pr_labeled',
      addedLabel: 'qa-ready',
    }).accepted,
    true,
  );
  assert.equal(
    evaluateOptIn(custom, { ...context, kind: 'pr_comment', body: '/qa run' })
      .accepted,
    true,
  );
});

test('invalid identity, malformed events, unknown fields, and unsupported languages fail validation', () => {
  assert.equal(
    optInEventSchema.safeParse({
      ...context,
      headSha: 'main',
      kind: 'pr_opened',
      labels: [],
    }).success,
    false,
  );
  assert.equal(
    optInEventSchema.safeParse({
      ...context,
      kind: 'issue_comment',
      body: '/dogwatch run',
    }).success,
    false,
  );
  assert.equal(
    repositoryPolicySchema.safeParse({ ...policy, authorizedActorIds: [] })
      .success,
    false,
  );
  assert.equal(
    repositoryPolicySchema.safeParse({ ...policy, languages: ['python'] })
      .success,
    false,
  );
  assert.equal(
    repositoryPolicySchema.safeParse({ ...policy, secret: 'unexpected' })
      .success,
    false,
  );
});

test('budgets are bounded integers and run requests require an immutable code version', () => {
  const budget = budgetSchema.parse({});
  assert.equal(budget.maxRunSeconds, 300);
  for (const maxApiRequests of [0, -1, 1.5, 1001]) {
    assert.equal(budgetSchema.safeParse({ maxApiRequests }).success, false);
  }
  const run = {
    runId: 'run-example',
    deliveryId: context.deliveryId,
    tenantId: context.tenantId,
    installationId: 10,
    repositoryId: 20,
    pullRequestNumber: 42,
    headSha: context.headSha,
    trigger: 'label',
    budget,
  };
  assert.equal(runRequestSchema.safeParse(run).success, true);
  assert.equal(
    runRequestSchema.safeParse({ ...run, headSha: 'latest' }).success,
    false,
  );
  assert.equal(runStateSchema.safeParse('completed').success, true);
  assert.equal(runStateSchema.safeParse('passed').success, false);
});

test('findings require reproduction steps and evidence references', () => {
  const finding = {
    findingId: 'finding-example',
    runId: 'run-example',
    tier: 'tier1',
    severity: 'high',
    confidence: 'confirmed',
    title: 'Missing address crashes checkout',
    expected: 'Validation error',
    actual: 'Server returns 500',
    reproductionSteps: ['Submit a synthetic order without an address'],
    evidenceArtifactIds: ['redacted-http-exchange'],
    baseline: 'unavailable',
  };
  assert.equal(findingSchema.safeParse(finding).success, true);
  assert.equal(
    findingSchema.safeParse({ ...finding, reproductionSteps: [] }).success,
    false,
  );
  assert.equal(
    findingSchema.safeParse({ ...finding, evidenceArtifactIds: [] }).success,
    false,
  );
});
