/** Real local fault injection; no model, customer endpoint or confirmed bug verdict. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { runFixtureChaos } from './browser-chaos-runner.js';
const scope = {
  tenantId: randomUUID(),
  runId: randomUUID(),
  repositoryId: 20,
  pullRequestNumber: 42,
  headSha: 'a'.repeat(40),
};
let writes = 0,
  navigations = 0;
const server = createServer((request, response) => {
  if (request.url === '/orders') {
    writes++;
    response.end('ok');
    return;
  }
  navigations++;
  response.setHeader('content-type', 'text/html');
  response.end(
    "<label>Address<input></label><button onclick=\"fetch('/orders',{method:'POST'}).then(()=>document.querySelector('p').textContent='Created').catch(()=>document.querySelector('p').textContent='Offline')\">Submit</button><p>Ready</p>",
  );
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
const policy = {
  ...scope,
  origin: `http://127.0.0.1:${address.port}`,
  disposableData: true,
  navigationPaths: ['/'],
  requests: [
    { path: '/', method: 'GET' },
    { path: '/orders', method: 'POST', allowMutation: true },
  ],
  targets: [
    {
      id: 'submit',
      locator: { kind: 'role', role: 'button', name: 'Submit' },
      actions: ['click'],
    },
    {
      id: 'address',
      locator: { kind: 'label', name: 'Address' },
      actions: ['fill'],
      valueRefs: ['empty'],
    },
  ],
  values: { empty: '' },
};
const nav = { kind: 'navigate', path: '/' };
const click = { kind: 'click', target: 'submit' };
try {
  for (const kind of [
    'slow_network',
    'offline',
    'navigation_interruption',
    'refresh',
    'repeated_submission',
    'boundary_input',
  ] as const) {
    writes = 0;
    navigations = 0;
    const script = {
      id: kind,
      kind,
      steps:
        kind === 'refresh'
          ? [nav, nav]
          : kind === 'repeated_submission'
            ? [nav, click, click]
            : kind === 'boundary_input'
              ? [nav, { kind: 'fill', target: 'address', valueRef: 'empty' }]
              : [nav, click],
      ...(kind === 'slow_network'
        ? {
            fault: {
              kind: 'delay',
              path: '/orders',
              method: 'POST',
              delayMs: 30,
            },
          }
        : kind === 'offline'
          ? { fault: { kind: 'offline', path: '/orders', method: 'POST' } }
          : kind === 'navigation_interruption'
            ? {
                fault: {
                  kind: 'interrupt_navigation',
                  path: '/',
                  method: 'GET',
                },
              }
            : {}),
    };
    const result = await runFixtureChaos(scope, policy, script, {
      isCurrent: async () => true,
    });
    assert.equal(result.cleanup, 'closed');
    assert.equal(result.confirmation, 'unconfirmed');
    if ('fault' in script) assert.equal(result.fault?.applied, 1);
    if (kind === 'offline') assert.equal(writes, 0);
    if (kind === 'navigation_interruption') {
      assert.equal(navigations, 0);
      assert.equal(result.code, 'chaos_inconclusive');
    } else {
      assert.equal(result.code, 'chaos_unconfirmed');
      assert.ok(result.capture?.screenshot);
    }
    if (kind === 'refresh') assert.equal(navigations, 2);
    if (kind === 'repeated_submission') assert.equal(writes, 2);
  }
  // Faults cannot convert a forbidden request into a permitted one.
  const refused = await runFixtureChaos(
    scope,
    { ...policy, requests: [{ path: '/', method: 'GET' }] },
    {
      id: 'denied',
      kind: 'offline',
      steps: [nav, click],
      fault: { kind: 'offline', path: '/orders', method: 'POST' },
    },
    { isCurrent: async () => true },
  );
  assert.equal(refused.fault?.applied, 0);
  assert.notEqual(refused.code, 'chaos_unconfirmed');
  console.log(
    'Controlled chaos verified: bounded delay/offline/interruption, refresh, repeat submission, boundary values and unchanged request authority.',
  );
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
