import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deduplicateFindings } from './finding-deduplication.js';
const scope = {
  tenantId: randomUUID(),
  runId: randomUUID(),
  repositoryId: 20,
  pullRequestNumber: 42,
  headSha: 'a'.repeat(40),
};
const now = new Date('2026-10-24T12:00:00Z');
function record(id = 'one') {
  const artifact = {
    artifactId: randomUUID(),
    tenantId: scope.tenantId,
    runId: scope.runId,
    repositoryId: scope.repositoryId,
    sha: scope.headSha,
    role: 'head',
    kind: 'browser_observation',
    sha256: 'c'.repeat(64),
    bytes: 100,
    expiresAt: '2026-10-25T12:00:00Z',
  };
  return {
    ...scope,
    version: 2,
    findingId: id,
    tier: 'tier2',
    environment: { deploymentId: 'fixture', role: 'head' },
    contentPolicy: 'reviewed_redacted',
    createdAt: '2026-10-24T11:00:00Z',
    target: { kind: 'journey', journeyId: 'checkout' },
    title: 'Checkout remains pending',
    expected: 'Validation error',
    actual: 'Pending message',
    reproductionSteps: ['Submit an empty synthetic address'],
    evidence: [artifact],
    baseline: { status: 'unavailable' },
    category: 'confirmed_failure',
    severity: 'medium',
    confidence: 'confirmed',
    basis: { kind: 'validated_observation', artifactId: artifact.artifactId },
  };
}
test('exact retries collapse while distinct records and all evidence remain in a stable group', () => {
  const a = record('a'),
    b = record('b');
  const result = deduplicateFindings([a, b, a], scope, now);
  assert.equal(result.duplicateInputCount, 1);
  assert.equal(result.uniqueRecordCount, 2);
  assert.equal(result.groupCount, 1);
  assert.equal(result.groups[0].records.length, 2);
  assert.equal(result.groups[0].evidenceArtifactIds.length, 2);
  assert.equal(result.groups[0].representativeFindingId, 'a');
  assert.deepEqual(result, deduplicateFindings([a, a, b], scope, now));
  assert.equal(result.categoryCounts.confirmed_failure, 1);
});
test('group identifiers ignore reference ordering but retain reproduction ordering', () => {
  const a = record();
  a.evidence.push({
    ...a.evidence[0],
    artifactId: randomUUID(),
    kind: 'screenshot',
  });
  const reversed = { ...a, evidence: [...a.evidence].reverse() };
  assert.equal(
    deduplicateFindings([a, reversed], scope, now).uniqueRecordCount,
    1,
  );
  const first = { ...a, reproductionSteps: ['first', 'second'] },
    second = {
      ...a,
      findingId: 'second',
      reproductionSteps: ['second', 'first'],
    };
  assert.equal(deduplicateFindings([first, second], scope, now).groupCount, 2);
});
test('category, severity, confidence, environment and observation differences do not merge', () => {
  const a = record();
  const { basis: _, ...withoutBasis } = a;
  void _;
  for (const b of [
    { ...a, findingId: 'b', severity: 'high' },
    { ...a, findingId: 'b', actual: 'Different failure' },
    {
      ...a,
      findingId: 'b',
      environment: { deploymentId: 'other', role: 'head' },
    },
    { ...a, findingId: 'b', baseline: { status: 'inconclusive' } },
    {
      ...withoutBasis,
      findingId: 'b',
      category: 'possible_regression',
      confidence: 'probable',
    },
  ])
    assert.equal(deduplicateFindings([a, b], scope, now).groupCount, 2);
});
test('same ID with changed content or reference metadata is rejected atomically', () => {
  const a = record();
  assert.throws(
    () => deduplicateFindings([a, { ...a, actual: 'changed' }], scope, now),
    /finding_id_conflict/,
  );
  assert.throws(
    () =>
      deduplicateFindings(
        [
          a,
          {
            ...a,
            findingId: 'b',
            evidence: [{ ...a.evidence[0], sha256: 'd'.repeat(64) }],
          },
        ],
        scope,
        now,
      ),
    /artifact_reference_conflict/,
  );
});
test('shared evidence relates distinct tiers without merging or inferring cause', () => {
  const a = record('browser'),
    api = record('api');
  api.tier = 'tier1';
  const b = {
    ...api,
    target: { kind: 'api', method: 'POST', path: '/orders' },
    evidence: [{ ...api.evidence[0], kind: 'api_observation' }, ...a.evidence],
  };
  const result = deduplicateFindings([a, b], scope, now);
  assert.equal(result.groupCount, 2);
  assert.equal(result.relationships.length, 1);
  assert.equal(result.relationships[0].kind, 'shared_evidence');
  assert.equal(result.relationships[0].groupIds.length, 2);
});
test('coverage gaps stay separate and metrics are retained rather than summed', () => {
  const a = record();
  const { basis: _, ...base } = a;
  void _;
  const gap = {
    ...base,
    findingId: 'gap',
    category: 'coverage_gap',
    severity: 'info',
    confidence: 'unconfirmed',
    reason: 'budget_exhausted',
    reproductionSteps: [],
    evidence: [],
  };
  const b = {
    ...a,
    findingId: 'b',
    metrics: {
      attemptedActions: 3,
      completedActions: 2,
      failedActions: 1,
      elapsedMs: 100,
    },
  };
  const result = deduplicateFindings([a, b, gap], scope, now);
  assert.equal(result.groupCount, 2);
  assert.equal(result.categoryCounts.coverage_gap, 1);
  assert.ok(
    result.groups.some((group) =>
      group.records.some((item) => item.metrics?.elapsedMs === 100),
    ),
  );
});
test('cross-scope and expired evidence fail before grouping', () => {
  const a = record();
  assert.throws(() =>
    deduplicateFindings([a], { ...scope, runId: randomUUID() }, now),
  );
  assert.throws(() =>
    deduplicateFindings([a], scope, new Date('2026-10-26T00:00:00Z')),
  );
});
test('empty batches are explicit and output mutation never changes input', () => {
  assert.equal(deduplicateFindings([], scope, now).groupCount, 0);
  const a = record();
  const result = deduplicateFindings([a], scope, now);
  result.groups[0].records[0].actual = 'changed';
  assert.equal(a.actual, 'Pending message');
});
test('record and aggregate-byte limits reject excess input without truncation', () => {
  const a = record();
  assert.throws(() => deduplicateFindings(Array(101).fill(a), scope, now));
  const large = { ...a, reproductionSteps: Array(50).fill('x'.repeat(2000)) };
  assert.throws(
    () => deduplicateFindings(Array(25).fill(large), scope, now),
    /finding_batch_size/,
  );
});
