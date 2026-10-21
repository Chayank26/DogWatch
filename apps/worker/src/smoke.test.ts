import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runSmoke, SmokeStepError } from './smoke.js';
import type { SmokeDriver, SmokePlan } from './smoke.js';
const plan = (): SmokePlan => ({
  tenantId: randomUUID(),
  runId: randomUUID(),
  repositoryId: 1,
  headSha: 'a'.repeat(40),
  maxExecutionMs: 20000,
  maxSteps: 30,
  journeys: [
    { id: 'login', dependsOn: [], steps: [{ kind: 'navigate', path: '/' }] },
    {
      id: 'checkout',
      dependsOn: ['login'],
      steps: [{ kind: 'visible', selector: '#checkout' }],
    },
  ],
});
const driver = (
  execute: SmokeDriver['execute'] = async () => {},
): SmokeDriver => ({
  execute,
  events: () => ({
    consoleErrors: 0,
    pageErrors: 0,
    serverErrors: 0,
    networkErrors: 0,
    blockedRequests: 0,
  }),
  close: async () => {},
});
test('successful journeys retain immutable context and unavailable baseline', async () => {
  const input = plan();
  let closed = false;
  const browser = driver();
  browser.close = async () => {
    closed = true;
  };
  const result = await runSmoke(input, browser, {
    isCurrent: async () => true,
  });
  assert.equal(result.outcome, 'passed');
  assert.equal(result.headSha, input.headSha);
  assert.equal(result.baseline, 'unavailable');
  assert.equal(result.stepsAttempted, 2);
  assert.ok(closed);
});
test('application failures skip dependents and retain sanitized evidence', async () => {
  const result = await runSmoke(
    plan(),
    driver(async () => {
      throw new SmokeStepError('navigation_failed');
    }),
    { isCurrent: async () => true },
  );
  assert.equal(result.outcome, 'failed');
  assert.equal(result.journeys[1].code, 'dependency_failed');
});
test('budget, deadline, cancellation and stale authority cannot produce success', async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  for (const kind of ['budget', 'timeout', 'cancel', 'stale', 'context']) {
    const input = plan();
    input.maxSteps = kind === 'budget' ? 1 : 30;
    input.maxExecutionMs = kind === 'timeout' ? 20 : 20000;
    let closed = false;
    const browser = driver(
      kind === 'timeout' ? () => new Promise(() => {}) : async () => {},
    );
    browser.close = async () => {
      closed = true;
    };
    const result = await runSmoke(input, browser, {
      signal: kind === 'cancel' ? cancelled.signal : undefined,
      isCurrent: async () => {
        if (kind === 'context') throw new Error('secret');
        return kind !== 'stale';
      },
    });
    assert.equal(result.outcome, 'inconclusive', kind);
    assert.ok(closed);
    assert.ok(!JSON.stringify(result).includes('secret'));
  }
});
test('browser diagnostics fail checks; blocked destinations are inconclusive', async () => {
  for (const key of [
    'pageErrors',
    'consoleErrors',
    'serverErrors',
    'networkErrors',
    'blockedRequests',
  ] as const) {
    const browser = driver();
    let count = 0;
    browser.execute = async () => {
      count++;
    };
    browser.events = () => ({
      consoleErrors: 0,
      pageErrors: 0,
      serverErrors: 0,
      networkErrors: 0,
      blockedRequests: 0,
      [key]: count,
    });
    const result = await runSmoke(plan(), browser, {
      isCurrent: async () => true,
    });
    assert.equal(
      result.outcome,
      key === 'blockedRequests' ? 'inconclusive' : 'failed',
    );
  }
});
test('cleanup failure prevents a passing verdict', async () => {
  const browser = driver();
  browser.close = async () => {
    throw new Error('private');
  };
  const result = await runSmoke(plan(), browser, {
    isCurrent: async () => true,
  });
  assert.equal(result.code, 'smoke_cleanup_failed');
  assert.equal(result.outcome, 'inconclusive');
});
test('unsafe navigation and invalid dependencies are rejected before execution', async () => {
  for (const path of [
    'https://example.com',
    '//example.com',
    '/../secret',
    '/x?token=1',
  ]) {
    const input = plan();
    input.journeys[0].steps = [{ kind: 'navigate', path }];
    await assert.rejects(
      runSmoke(input, driver(), { isCurrent: async () => true }),
    );
  }
  const input = plan();
  input.journeys[0].dependsOn = ['checkout'];
  await assert.rejects(
    runSmoke(input, driver(), { isCurrent: async () => true }),
  );
});
