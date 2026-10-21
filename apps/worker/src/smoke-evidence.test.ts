import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  runSmokeWithEvidence,
  compareSmokeEvidence,
  smokeEvidenceSchema,
} from './smoke-evidence.js';
import type { SmokeEvidence } from './smoke-evidence.js';
import { SmokeStepError } from './smoke.js';
import type { SmokePlan } from './smoke.js';
const scope = { tenantId: randomUUID(), runId: randomUUID(), repositoryId: 20 };
const context = { ...scope, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };
const plan = (sha: string): SmokePlan => ({
  ...scope,
  headSha: sha,
  maxExecutionMs: 20000,
  maxSteps: 30,
  journeys: [
    { id: 'checkout', dependsOn: [], steps: [{ kind: 'navigate', path: '/' }] },
  ],
});
async function evidence(
  role: 'base' | 'head',
  failure?: 'navigation_failed' | 'assertion_failed',
) {
  return runSmokeWithEvidence(
    plan(role === 'base' ? context.baseSha : context.headSha),
    {
      execute: async () => {
        if (failure) throw new SmokeStepError(failure);
      },
      events: () => ({
        consoleErrors: 0,
        pageErrors: 0,
        serverErrors: 0,
        networkErrors: 0,
        blockedRequests: 0,
      }),
      close: async () => {},
    },
    { role, scenarioId: 'pawmart-v1', isCurrent: async () => true },
  );
}
test('compatible passing base and failing head identify a new observed regression', async () => {
  const result = compareSmokeEvidence(
    context,
    await evidence('head', 'assertion_failed'),
    await evidence('base'),
  );
  assert.equal(result.journeys[0].baseline, 'new_regression');
  assert.equal(result.baselineAvailable, true);
});
test('matching failure is pre-existing; a different failure stays inconclusive', async () => {
  const head = await evidence('head', 'assertion_failed');
  assert.equal(
    compareSmokeEvidence(
      context,
      head,
      await evidence('base', 'assertion_failed'),
    ).journeys[0].baseline,
    'pre_existing',
  );
  assert.equal(
    compareSmokeEvidence(
      context,
      head,
      await evidence('base', 'navigation_failed'),
    ).journeys[0].baseline,
    'inconclusive',
  );
  assert.equal(
    compareSmokeEvidence(
      context,
      await evidence('head'),
      await evidence('base'),
    ).journeys[0].baseline,
    'no_failure',
  );
});
test('missing, changed scenario, changed plan and expired evidence never attribute a new regression', async () => {
  const head = await evidence('head', 'assertion_failed'),
    base = await evidence('base');
  assert.equal(
    compareSmokeEvidence(context, head).journeys[0].baseline,
    'unavailable',
  );
  for (const patch of [
    { scenarioId: 'other-data' },
    { compatibilityDigest: 'f'.repeat(64) },
    {
      createdAt: new Date(Date.now() - 20000).toISOString(),
      expiresAt: new Date(Date.now() - 10000).toISOString(),
    },
    { outcome: 'inconclusive', code: 'smoke_cleanup_failed' },
  ])
    assert.equal(
      compareSmokeEvidence(context, head, {
        ...base,
        ...patch,
      } as SmokeEvidence).journeys[0].baseline,
      'inconclusive',
    );
  const changed = plan(context.baseSha);
  changed.maxSteps = 20;
  const changedEvidence = await runSmokeWithEvidence(
    changed,
    {
      execute: async () => {},
      events: () => base.trace[0].events,
      close: async () => {},
    },
    { role: 'base', scenarioId: 'pawmart-v1', isCurrent: async () => true },
  );
  assert.notEqual(
    changedEvidence.compatibilityDigest,
    base.compatibilityDigest,
  );
});
test('cross-tenant, repository, run, SHA and snapshot-role mixes fail closed', async () => {
  const head = await evidence('head', 'assertion_failed'),
    base = await evidence('base');
  for (const patch of [
    { tenantId: randomUUID() },
    { runId: randomUUID() },
    { repositoryId: 30 },
    { sha: 'c'.repeat(40) },
    { role: 'head' },
  ])
    assert.throws(() =>
      compareSmokeEvidence(context, head, {
        ...base,
        ...patch,
      } as SmokeEvidence),
    );
});
test('stopped/cleanup-failed head cannot yield regression attribution', async () => {
  const base = await evidence('base'),
    head = await evidence('head', 'assertion_failed');
  for (const code of ['smoke_cleanup_failed', 'smoke_timeout'] as const)
    assert.equal(
      compareSmokeEvidence(
        context,
        { ...head, code, outcome: 'inconclusive' },
        base,
      ).journeys[0].baseline,
      'inconclusive',
    );
});
test('capture failure is explicit and secret/raw diagnostics are absent', async () => {
  const output = await runSmokeWithEvidence(
    plan(context.headSha),
    {
      execute: async () => {
        throw new Error('credential-super-secret');
      },
      events: () => ({
        consoleErrors: 0,
        pageErrors: 0,
        serverErrors: 0,
        networkErrors: 0,
        blockedRequests: 0,
      }),
      captureScreenshot: async () => {
        throw new Error('credential-super-secret');
      },
      close: async () => {},
    },
    { role: 'head', scenarioId: 'pawmart-v1', isCurrent: async () => true },
  );
  assert.equal(output.screenshot.status, 'unavailable');
  assert.ok(!JSON.stringify(output).includes('credential-super-secret'));
  assert.equal(output.outcome, 'inconclusive');
});
test('malformed diagnostic rows and oversized/invalid screenshot evidence are rejected', async () => {
  const good = await evidence('head');
  assert.throws(() =>
    smokeEvidenceSchema.parse({
      ...good,
      trace: [
        {
          ...good.trace[0],
          events: { ...good.trace[0].events, serverErrors: 1 },
        },
      ],
    }),
  );
  assert.throws(() =>
    smokeEvidenceSchema.parse({
      ...good,
      trace: [good.trace[0], good.trace[0]],
    }),
  );
  assert.throws(() =>
    smokeEvidenceSchema.parse({
      ...good,
      screenshot: {
        status: 'captured',
        policy: 'synthetic_fixture_masked',
        pngBase64: 'secret',
        sha256: 'a'.repeat(64),
      },
    }),
  );
});

test('matching aggregate browser-error counters alone cannot establish a pre-existing defect', async () => {
  const head = await evidence('head'),
    base = await evidence('base');
  for (const record of [head, base]) {
    record.outcome = 'failed';
    record.trace[0].outcome = 'failed';
    record.trace[0].code = 'browser_errors';
    record.trace[0].events.pageErrors = 1;
  }
  assert.equal(
    compareSmokeEvidence(context, head, base).journeys[0].baseline,
    'inconclusive',
  );
});
