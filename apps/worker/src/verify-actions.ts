/** Real browser action gates, using only synthetic disposable loopback state. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createFixtureActionExecutor } from './browser-actions-fixture.js';
let writes = 0;
const server = createServer((request, response) => {
  if (request.url === '/orders') {
    writes++;
    response.end('ok');
    return;
  }
  if (request.url === '/redirect') {
    response.writeHead(302, { location: '/' });
    response.end();
    return;
  }
  response.setHeader('content-type', 'text/html');
  response.end(
    `<h1>Checkout</h1><label>Address<input></label><label for="quantity">Quantity</label><select id="quantity"><option>1</option><option>2</option></select><button onclick="fetch('/orders',{method:'POST'}).then(()=>document.querySelector('h1').textContent='Created')">Create</button><button onclick="fetch('/forbidden',{method:'POST'})">Forbidden</button><button>Delete</button><label>Upload<input type="file"></label>`,
  );
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
const scope = {
  tenantId: randomUUID(),
  runId: randomUUID(),
  repositoryId: 20,
  pullRequestNumber: 42,
  headSha: 'a'.repeat(40),
};
const policy = {
  ...scope,
  origin: `http://127.0.0.1:${address.port}`,
  disposableData: true,
  navigationPaths: ['/', '/redirect'],
  requests: [
    { path: '/', method: 'GET' },
    { path: '/redirect', method: 'GET' },
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
      id: 'quantity',
      locator: { kind: 'label', name: 'Quantity' },
      actions: ['select'],
      valueRefs: ['quantity'],
    },
    {
      id: 'create',
      locator: { kind: 'role', role: 'button', name: 'Create' },
      actions: ['click'],
    },
    {
      id: 'forbidden',
      locator: { kind: 'role', role: 'button', name: 'Forbidden' },
      actions: ['click'],
    },
    {
      id: 'delete',
      locator: { kind: 'role', role: 'button', name: 'Delete' },
      actions: ['click'],
      destructive: true,
    },
    {
      id: 'upload',
      locator: { kind: 'label', name: 'Upload' },
      actions: ['click'],
    },
  ],
  values: { address: 'Test Lane', quantity: '2' },
  allowScroll: true,
};
let executor:
  Awaited<ReturnType<typeof createFixtureActionExecutor>> | undefined;
try {
  executor = await createFixtureActionExecutor(scope, policy, {
    isCurrent: async () => true,
  });
  assert.equal(
    (await executor.execute({ kind: 'click', selector: 'body' })).code,
    'action_invalid',
  );
  assert.equal(
    (await executor.execute({ kind: 'click', target: 'delete' })).code,
    'action_forbidden',
  );
  for (const action of [
    { kind: 'navigate', path: '/' },
    { kind: 'fill', target: 'address', valueRef: 'address' },
    { kind: 'select', target: 'quantity', valueRef: 'quantity' },
    { kind: 'scroll', deltaY: 200 },
    { kind: 'click', target: 'create' },
  ])
    assert.equal(
      (await executor.execute(action)).code,
      'executed',
      action.kind,
    );
  // Poll observation rather than treating click completion as application success.
  let observed = false;
  for (let i = 0; i < 5; i++) {
    if ((await executor.observe()).snapshot?.includes('Created')) {
      observed = true;
      break;
    }
  }
  assert.equal(observed, true);
  assert.equal(writes, 1);
  assert.equal((await executor.execute({ kind: 'stop' })).code, 'stopped');
  await executor.close();
  for (const action of [
    { kind: 'navigate', path: '/redirect' },
    { kind: 'click', target: 'forbidden' },
    { kind: 'click', target: 'upload' },
  ]) {
    executor = await createFixtureActionExecutor(scope, policy, {
      isCurrent: async () => true,
    });
    await executor.execute({ kind: 'navigate', path: '/' });
    const result = await executor.execute(action);
    // Async fetch may be rejected after click; scope must still close before further work.
    if (result.code === 'executed')
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.notEqual(
      (await executor.execute({ kind: 'scroll', deltaY: 1 })).code,
      'executed',
    );
    await executor.close();
  }
  executor = await createFixtureActionExecutor(
    scope,
    { ...policy, maxActions: 1 },
    { isCurrent: async () => true },
  );
  await executor.execute({ kind: 'navigate', path: '/' });
  assert.equal(
    (await executor.execute({ kind: 'scroll', deltaY: 1 })).code,
    'action_budget',
  );
  await executor.close();
  executor = await createFixtureActionExecutor(scope, policy, {
    isCurrent: async () => false,
  });
  assert.equal(
    (await executor.execute({ kind: 'navigate', path: '/' })).code,
    'action_inconclusive',
  );
  await executor.close();
  const cancellation = new AbortController();
  executor = await createFixtureActionExecutor(scope, policy, {
    isCurrent: async () => true,
    signal: cancellation.signal,
  });
  cancellation.abort();
  assert.notEqual(
    (await executor.execute({ kind: 'navigate', path: '/' })).code,
    'executed',
  );
  await executor.close();
  executor = await createFixtureActionExecutor(
    scope,
    { ...policy, actionMs: 50 },
    { isCurrent: () => new Promise(() => {}) },
  );
  assert.equal(
    (await executor.execute({ kind: 'navigate', path: '/' })).code,
    'action_inconclusive',
  );
  await executor.close();
  await assert.rejects(
    createFixtureActionExecutor({ ...scope, runId: randomUUID() }, policy, {
      isCurrent: async () => true,
    }),
    /action_scope/,
  );
  console.log(
    'Browser actions verified: accessible interactions, request grants, denied actions, redirects, uploads, budgets and stale scope.',
  );
} finally {
  await executor?.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
