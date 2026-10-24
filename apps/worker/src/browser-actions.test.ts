import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  browserActionSchema,
  browserPolicySchema,
  actionAllowed,
  requestAllowed,
} from './browser-actions.js';
const scope = {
  tenantId: randomUUID(),
  runId: randomUUID(),
  repositoryId: 1,
  pullRequestNumber: 2,
  headSha: 'a'.repeat(40),
};
const policy = () =>
  browserPolicySchema.parse({
    ...scope,
    origin: 'http://127.0.0.1:1234',
    disposableData: true,
    navigationPaths: ['/'],
    requests: [
      { path: '/', method: 'GET' },
      { path: '/orders', method: 'POST', allowMutation: true },
    ],
    targets: [
      {
        id: 'address',
        locator: { kind: 'label', name: 'Address' },
        actions: ['fill'],
        valueRefs: ['address'],
      },
      {
        id: 'remove',
        locator: { kind: 'role', role: 'button', name: 'Delete' },
        actions: ['click'],
        destructive: true,
      },
    ],
    values: { address: 'synthetic' },
  });
test('strict action vocabulary rejects scripts, selectors, coordinates, uploads and unsafe navigation', () => {
  for (const value of [
    { kind: 'evaluate', script: 'bad' },
    { kind: 'click', selector: 'body' },
    { kind: 'click', x: 1, y: 1 },
    { kind: 'upload' },
    { kind: 'navigate', path: '//evil' },
    { kind: 'navigate', path: '/../admin' },
    { kind: 'navigate', path: '/%2e' },
    { kind: 'fill', target: 'address', value: 'secret' },
    { kind: 'scroll', deltaY: 1001 },
    { kind: 'stop', extra: true },
  ])
    assert.equal(browserActionSchema.safeParse(value).success, false);
});
test('exact targets, action kind and synthetic value references narrow authority', () => {
  const p = policy();
  assert.equal(
    actionAllowed({ kind: 'fill', target: 'address', valueRef: 'address' }, p),
    true,
  );
  assert.equal(
    actionAllowed({ kind: 'fill', target: 'address', valueRef: 'missing' }, p),
    false,
  );
  assert.equal(actionAllowed({ kind: 'click', target: 'address' }, p), false);
  assert.equal(actionAllowed({ kind: 'navigate', path: '/other' }, p), false);
  assert.equal(actionAllowed({ kind: 'scroll', deltaY: 100 }, p), false);
});
test('destructive targets require both explicit permission and disposable data', () => {
  const p = policy(),
    action = { kind: 'click' as const, target: 'remove' };
  assert.equal(actionAllowed(action, p), false);
  p.targets[1].allowDestructive = true;
  assert.equal(actionAllowed(action, p), true);
  p.disposableData = false;
  assert.equal(actionAllowed(action, p), false);
});
test('request grants bind exact origin, path, method and disposable mutation authority', () => {
  const p = policy();
  assert.equal(requestAllowed(p.origin + '/orders', 'POST', p), true);
  for (const url of [
    'http://localhost:1234/orders',
    p.origin + '/orders?token=x',
    p.origin + '/orders#x',
    'http://user@127.0.0.1:1234/orders',
    p.origin + '/other',
  ])
    assert.equal(requestAllowed(url, 'POST', p), false);
  assert.equal(requestAllowed(p.origin + '/orders', 'DELETE', p), false);
  p.disposableData = false;
  assert.equal(requestAllowed(p.origin + '/orders', 'POST', p), false);
});
test('policy snapshots detach mutable input and reject ambiguous target IDs', () => {
  const p = policy(),
    copy = browserPolicySchema.parse(p);
  p.targets[0].actions.push('click');
  assert.deepEqual(copy.targets[0].actions, ['fill']);
  assert.throws(() =>
    browserPolicySchema.parse({ ...p, targets: [p.targets[0], p.targets[0]] }),
  );
});
