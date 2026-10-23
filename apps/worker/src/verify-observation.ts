/** Real browser verification against a disposable, synthetic loopback fixture. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createBrowserObserver } from './browser-observation.js';
import { fixtureObservationSource } from './browser-observation-playwright.js';
import { createFixtureSmokeDriver } from './smoke-fixture.js';
const server = createServer((request, response) => {
  if (request.url === '/missing' || request.url === '/broken') {
    response.writeHead(request.url === '/missing' ? 404 : 500);
    response.end();
    return;
  }
  response.setHeader('content-type', 'text/html');
  response.end(`<h1>Synthetic checkout</h1><label>Address<input value="synthetic-only"></label><button id="checkout">Checkout</button><p id="done"></p>
<script>document.querySelector('button').onclick=async()=>{console.error('private diagnostic');setTimeout(()=>{throw Error('private exception')},0);await fetch('/missing');await fetch('/broken');try{await fetch('http://127.0.0.1:1/blocked')}catch{}document.querySelector('#done').textContent='Observed';}</script>`);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
let observer: ReturnType<typeof createBrowserObserver> | undefined;
let driver: Awaited<ReturnType<typeof createFixtureSmokeDriver>> | undefined;
try {
  driver = await createFixtureSmokeDriver(
    `http://127.0.0.1:${address.port}`,
    {},
    (page) => {
      observer = createBrowserObserver(
        {
          tenantId: randomUUID(),
          runId: randomUUID(),
          repositoryId: 20,
          pullRequestNumber: 42,
          headSha: 'a'.repeat(40),
        },
        fixtureObservationSource(page),
        { isCurrent: async () => true },
      );
    },
  );
  assert.ok(observer);
  observer.markAction('navigate');
  await driver.execute({ kind: 'navigate', path: '/' }, 3000);
  const before = await observer.observe();
  assert.equal(before.status, 'captured');
  assert.match(before.snapshot!, /Synthetic checkout/);
  assert.match(before.snapshot!, /button "Checkout"/);
  assert.ok(before.screenshot!.length > 100);
  observer.markAction('checkout');
  await driver.execute({ kind: 'click', selector: '#checkout' }, 3000);
  await driver.execute(
    { kind: 'text', selector: '#done', expected: 'Observed' },
    3000,
  );
  const after = await observer.observe();
  for (const kind of [
    'console_error',
    'page_exception',
    'request_failed',
    'http_error',
  ])
    assert.ok(
      after.events.some(
        (event) => event.kind === kind && event.actionId === 'checkout',
      ),
      kind,
    );
  for (const status of [404, 500])
    assert.ok(
      after.events.some(
        (event) => event.kind === 'http_error' && event.status === status,
      ),
    );
  assert.ok(!JSON.stringify(after.events).includes('private'));
  assert.match(after.snapshot!, /Observed/);
  console.log(
    'Browser observation verified: snapshots, PNG, action diagnostics, 404/500 and blocked requests.',
  );
} finally {
  observer?.close();
  await driver?.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
