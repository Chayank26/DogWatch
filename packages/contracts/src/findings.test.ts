import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { findingRecordSchema, validateFindingForContext } from './findings.js';
const scope = {
  tenantId: randomUUID(),
  runId: randomUUID(),
  repositoryId: 20,
  pullRequestNumber: 42,
  headSha: 'a'.repeat(40),
};
const now = new Date('2026-10-24T12:00:00Z');
function sample() {
  const artifact = {
    artifactId: randomUUID(),
    tenantId: scope.tenantId,
    runId: scope.runId,
    repositoryId: scope.repositoryId,
    sha: scope.headSha,
    role: 'head',
    kind: 'replay_result',
    sha256: 'c'.repeat(64),
    bytes: 100,
    expiresAt: '2026-10-25T12:00:00Z',
  };
  return {
    ...scope,
    version: 2,
    findingId: 'checkout-stuck',
    tier: 'tier2',
    environment: { deploymentId: 'fixture', role: 'head' },
    contentPolicy: 'reviewed_redacted',
    createdAt: '2026-10-24T11:00:00Z',
    target: { kind: 'journey', journeyId: 'checkout' },
    title: 'Checkout remains pending',
    expected: 'Validation error appears',
    actual: 'Pending message remains',
    reproductionSteps: ['Submit synthetic checkout with an empty address'],
    evidence: [artifact],
    baseline: { status: 'unavailable' },
    category: 'confirmed_failure',
    severity: 'medium',
    confidence: 'confirmed',
    basis: { kind: 'reproduced', artifactId: artifact.artifactId },
    metrics: {
      attemptedActions: 3,
      completedActions: 3,
      failedActions: 0,
      elapsedMs: 500,
    },
  };
}
test('versioned fixture finding validates and detaches nested values', () => {
  const record = sample();
  const parsed = validateFindingForContext(record, scope, now);
  record.evidence[0].bytes = 999;
  assert.equal(parsed.evidence[0].bytes, 100);
  assert.equal(parsed.category, 'confirmed_failure');
});
test('categories prevent confidence, severity and basis contradictions', () => {
  const record = sample();
  for (const patch of [
    { confidence: 'probable' },
    { category: 'coverage_gap', severity: 'high', reason: 'unavailable' },
    { category: 'advisory', severity: 'critical' },
    {
      basis: {
        kind: 'validated_observation',
        artifactId: record.evidence[0].artifactId,
      },
    },
  ])
    assert.equal(
      findingRecordSchema.safeParse({ ...record, ...patch }).success,
      false,
    );
});
test('coverage gaps may lack evidence but cannot become confirmed failures', () => {
  const { basis: _, ...record } = sample();
  void _;
  const gap = {
    ...record,
    category: 'coverage_gap',
    severity: 'info',
    confidence: 'unconfirmed',
    reason: 'budget_exhausted',
    reproductionSteps: [],
    evidence: [],
  };
  assert.ok(findingRecordSchema.parse(gap));
  assert.equal(
    findingRecordSchema.safeParse({ ...gap, category: 'confirmed_failure' })
      .success,
    false,
  );
});
test('unconfirmed regressions and advisory observations have explicit shapes', () => {
  const { basis: _, ...record } = sample();
  void _;
  assert.ok(
    findingRecordSchema.parse({
      ...record,
      category: 'possible_regression',
      confidence: 'probable',
    }),
  );
  assert.ok(
    findingRecordSchema.parse({
      ...record,
      category: 'advisory',
      confidence: 'unconfirmed',
      severity: 'info',
    }),
  );
});
test('evidence must match head tenant/run/repository/SHA/role without duplicates', () => {
  for (const patch of [
    { tenantId: randomUUID() },
    { runId: randomUUID() },
    { repositoryId: 99 },
    { sha: 'b'.repeat(40) },
    { role: 'base' },
  ]) {
    const record = sample();
    assert.equal(
      findingRecordSchema.safeParse({
        ...record,
        evidence: [{ ...record.evidence[0], ...patch }],
      }).success,
      false,
    );
  }
  const record = sample();
  assert.equal(
    findingRecordSchema.safeParse({
      ...record,
      evidence: [...record.evidence, ...record.evidence],
    }).success,
    false,
  );
});
test('context validation rejects stale scope, expired evidence and future records', () => {
  assert.throws(() =>
    validateFindingForContext(
      sample(),
      { ...scope, headSha: 'b'.repeat(40) },
      now,
    ),
  );
  assert.throws(() =>
    validateFindingForContext(
      sample(),
      scope,
      new Date('2026-10-26T12:00:00Z'),
    ),
  );
  assert.throws(() =>
    validateFindingForContext(
      sample(),
      scope,
      new Date('2026-10-23T12:00:00Z'),
    ),
  );
  assert.throws(() =>
    validateFindingForContext(sample(), scope, new Date('invalid')),
  );
});
test('baseline claims require independent scoped base evidence and a comparison artifact', () => {
  const record = sample();
  const baseRunId = randomUUID();
  const baseSha = 'b'.repeat(40);
  const base = {
    ...record.evidence[0],
    artifactId: randomUUID(),
    runId: baseRunId,
    sha: baseSha,
    role: 'base',
  };
  const comparison = {
    ...record.evidence[0],
    artifactId: randomUUID(),
    kind: 'baseline_comparison',
  };
  const candidate = {
    ...record,
    evidence: [...record.evidence, comparison],
    baseline: {
      status: 'new_regression',
      baseRunId,
      baseSha,
      comparisonArtifactId: comparison.artifactId,
      evidence: [base],
    },
  };
  assert.ok(findingRecordSchema.parse(candidate));
  for (const patch of [
    { baseSha: scope.headSha },
    { baseRunId: scope.runId },
    { comparisonArtifactId: randomUUID() },
    { evidence: [{ ...base, tenantId: randomUUID() }] },
  ])
    assert.equal(
      findingRecordSchema.safeParse({
        ...candidate,
        baseline: { ...candidate.baseline, ...patch },
      }).success,
      false,
    );
});
test('strict record shape excludes URLs, payload attachments, impossible metrics and tier mixes', () => {
  const record = sample();
  for (const patch of [
    { publicUrl: 'https://example.com' },
    { payload: { token: 'secret' } },
    { version: 1 },
    { tier: 'tier1' },
    {
      metrics: {
        attemptedActions: 1,
        completedActions: 1,
        failedActions: 1,
        elapsedMs: 1,
      },
    },
    { reproductionSteps: [] },
    { evidence: [] },
  ])
    assert.equal(
      findingRecordSchema.safeParse({ ...record, ...patch }).success,
      false,
    );
});

test('validated observations bind their evidence kind to the producing tier', () => {
  const record = sample();
  const basis = {
    kind: 'validated_observation',
    artifactId: record.evidence[0].artifactId,
  };
  assert.equal(
    findingRecordSchema.safeParse({
      ...record,
      basis,
      evidence: [{ ...record.evidence[0], kind: 'api_observation' }],
    }).success,
    false,
  );
  assert.ok(
    findingRecordSchema.parse({
      ...record,
      basis,
      evidence: [{ ...record.evidence[0], kind: 'browser_observation' }],
    }),
  );
});
