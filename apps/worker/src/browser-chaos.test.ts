import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRequestFault,
  chaosScriptSchema,
  requestFaultSchema,
} from './browser-chaos.js';
test('fault selection is exact, ordinal, bounded and detached', () => {
  const original = {
    kind: 'delay',
    path: '/orders',
    method: 'POST',
    startAt: 2,
    count: 2,
    delayMs: 30,
  };
  const fault = createRequestFault(original);
  original.path = '/other';
  assert.equal(fault.next('/orders', 'GET', false), undefined);
  assert.equal(fault.next('/other', 'POST', false), undefined);
  assert.equal(fault.next('/orders', 'POST', false), undefined);
  assert.equal(fault.next('/orders', 'POST', false)?.delayMs, 30);
  assert.ok(fault.next('/orders', 'POST', false));
  assert.equal(fault.next('/orders', 'POST', false), undefined);
  const result = fault.snapshot();
  result.plan.path = '/changed';
  assert.equal(fault.snapshot().plan.path, '/orders');
  assert.equal(result.applied, 2);
});
test('navigation interruption ignores subresource matches', () => {
  const fault = createRequestFault({
    kind: 'interrupt_navigation',
    path: '/',
    method: 'GET',
  });
  assert.equal(fault.next('/', 'GET', false), undefined);
  assert.ok(fault.next('/', 'GET', true));
  assert.equal(fault.snapshot().applied, 1);
});
test('invalid fault routing, excessive injection and inconsistent delay fail validation', () => {
  for (const patch of [
    { path: '//evil' },
    { path: '/x?secret=1' },
    { count: 4 },
    { delayMs: 1001 },
    { kind: 'offline', delayMs: 5 },
    { kind: 'delay', delayMs: undefined },
  ])
    assert.equal(
      requestFaultSchema.safeParse({
        kind: 'delay',
        path: '/',
        method: 'GET',
        delayMs: 5,
        ...patch,
      }).success,
      false,
    );
});
test('scripts require explicit scenario actions and matching fault type', () => {
  assert.equal(
    chaosScriptSchema.safeParse({
      id: 'offline',
      kind: 'offline',
      steps: [{ kind: 'navigate', path: '/' }],
    }).success,
    false,
  );
  for (const kind of ['refresh', 'repeated_submission', 'boundary_input'])
    assert.equal(
      chaosScriptSchema.safeParse({
        id: 'test',
        kind,
        steps: [{ kind: 'stop' }],
      }).success,
      false,
    );
  assert.ok(
    chaosScriptSchema.parse({
      id: 'repeat',
      kind: 'repeated_submission',
      steps: [
        { kind: 'click', target: 'submit' },
        { kind: 'click', target: 'submit' },
      ],
    }),
  );
});
