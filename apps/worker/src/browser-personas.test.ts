import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BrowserBudget } from './browser-budget.js';
import { runPersonaSuite } from './browser-personas.js';
import { createJsonBrowserModel } from './browser-model.js';
const scope = {
  tenantId: randomUUID(),
  runId: randomUUID(),
  repositoryId: 1,
  pullRequestNumber: 2,
  headSha: 'a'.repeat(40),
};
const budget = {
  maxCalls: 4,
  maxTokens: 16800,
  maxActions: 8,
  maxRequests: 10,
  maxCostMicros: 400,
  costPerCallMicros: 100,
};
const loop = {
  syntheticModelInput: true,
  initialPath: '/',
  goal: 'Synthetic task',
  actions: [{ kind: 'click', target: 'checkout' }],
};
function factory() {
  let opened = 0,
    closed = 0;
  const actions: unknown[] = [];
  return {
    get opened() {
      return opened;
    },
    get closed() {
      return closed;
    },
    actions,
    async create() {
      opened++;
      return {
        async execute(action: unknown) {
          actions.push(action);
          return {
            ...scope,
            code:
              (action as { kind: string }).kind === 'stop'
                ? 'stopped'
                : 'executed',
          };
        },
        async observe() {
          return {
            ...scope,
            audience: 'private_synthetic_fixture',
            untrusted: true,
            status: 'captured',
            snapshot: 'Fixture',
            screenshot: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
          };
        },
        async close() {
          closed++;
        },
      };
    },
  };
}
const stop = createJsonBrowserModel(async () =>
  JSON.stringify({
    action: { kind: 'stop' },
    usage: { inputTokens: 1, outputTokens: 1 },
  }),
);
test('shared reservations are atomic, scope-bound, nonrefundable and snapshots are detached', () => {
  const ledger = new BrowserBudget(scope, { ...budget, maxCalls: 1 });
  ledger.reserve(scope, 'call', 4200);
  assert.throws(() => ledger.reserve(scope, 'call', 4200));
  assert.equal(ledger.snapshot().calls, 1);
  assert.throws(() =>
    ledger.reserve({ ...scope, runId: randomUUID() }, 'action'),
  );
  const view = ledger.snapshot();
  view.tokens = 0;
  assert.equal(ledger.snapshot().tokens, 4200);
});
for (const [dimension, limit, kind, tokens] of [
  ['maxTokens', 1, 'call', 2],
  ['maxCostMicros', 99, 'call', 1],
  ['maxActions', 0, 'action', 0],
  ['maxRequests', 0, 'request', 0],
] as const) {
  test(`${dimension} prevents reservation before side effects`, () => {
    const ledger = new BrowserBudget(scope, { ...budget, [dimension]: limit });
    assert.throws(() => ledger.reserve(scope, kind, tokens));
    assert.equal(ledger.snapshot().calls, 0);
    assert.equal(ledger.snapshot().actions, 0);
    assert.equal(ledger.snapshot().requests, 0);
  });
}
test('deadline is shared and cannot be renewed by another reservation', () => {
  let now = 0;
  const ledger = new BrowserBudget(
    scope,
    { ...budget, maxExecutionMs: 10 },
    () => now,
  );
  now = 10;
  assert.throws(() => ledger.reserve(scope, 'action'));
  assert.equal(ledger.remainingMs(), 0);
});
test('personas share one budget, receive distinct profiles, and keyboard coverage is explicit', async () => {
  const f = factory();
  const instructions: string[] = [];
  const result = await runPersonaSuite(
    {
      ...scope,
      personas: ['novice', 'keyboard_only', 'impatient', 'unusual_input'],
      budget,
    },
    loop,
    {
      createExecutor: async () => f.create(),
      model: createJsonBrowserModel(async (request) => {
        instructions.push(request.instruction);
        return JSON.stringify({
          action: { kind: 'stop' },
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      }),
      isCurrent: async () => true,
    },
  );
  assert.equal(f.opened, 3);
  assert.equal(f.closed, 3);
  assert.equal(result.results[1].code, 'persona_unsupported');
  assert.equal(result.budget.calls, 3);
  assert.equal(result.budget.costMicros, 300);
  assert.equal(new Set(instructions).size, 3);
});
test('later personas cannot reset exhausted model token/cost capacity', async () => {
  const f = factory();
  const result = await runPersonaSuite(
    {
      ...scope,
      personas: ['novice', 'unusual_input'],
      budget: { ...budget, maxCalls: 1 },
    },
    loop,
    {
      createExecutor: async () => f.create(),
      model: stop,
      isCurrent: async () => true,
    },
  );
  assert.equal(result.budget.calls, 1);
  assert.equal(result.results[1].code, 'shared_budget');
  assert.equal(f.closed, 2);
});
test('impatient profile narrows repeated submissions without broadening action menu', async () => {
  const f = factory();
  const result = await runPersonaSuite(
    { ...scope, personas: ['impatient'], budget },
    loop,
    {
      createExecutor: async () => f.create(),
      model: createJsonBrowserModel(async () =>
        JSON.stringify({
          action: { kind: 'click', target: 'checkout' },
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      ),
      isCurrent: async () => true,
    },
  );
  assert.equal(result.results[0].code, 'repetition_budget');
  assert.equal(f.actions.length, 2);
  assert.equal(f.closed, 1);
});
test('cancelled suites create no executors; invalid and duplicate personas fail before setup', async () => {
  const f = factory();
  const controller = new AbortController();
  controller.abort();
  const options = {
    createExecutor: async () => f.create(),
    model: stop,
    isCurrent: async () => true,
    signal: controller.signal,
  };
  const result = await runPersonaSuite(
    { ...scope, personas: ['novice'], budget },
    loop,
    options,
  );
  assert.equal(result.results[0].code, 'suite_stopped');
  assert.equal(f.opened, 0);
  await assert.rejects(
    runPersonaSuite(
      { ...scope, personas: ['novice', 'novice'], budget },
      loop,
      options,
    ),
  );
});
