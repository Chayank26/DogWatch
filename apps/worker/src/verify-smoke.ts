/** Real Chromium on disposable local targets only; no customer execution. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { createFixtureSmokeDriver } from './smoke-fixture.js';
import { runSmoke } from './smoke.js';
import type { SmokePlan } from './smoke.js';
const fixtureUrl = new URL('../../fixture/dist/app.js', import.meta.url);
const { createFixtureApp } = (await import(fixtureUrl.href)) as {
  createFixtureApp(mode: string): Express;
};
const scope = {
  tenantId: randomUUID(),
  runId: randomUUID(),
  repositoryId: 20,
  headSha: 'a'.repeat(40),
};
const plan = (expected: string): SmokePlan => ({
  ...scope,
  maxExecutionMs: 20000,
  maxSteps: 30,
  journeys: [
    {
      id: 'navigation',
      dependsOn: [],
      steps: [
        { kind: 'navigate', path: '/' },
        { kind: 'visible', selector: '#checkout' },
      ],
    },
    {
      id: 'synthetic-identity-checkout',
      dependsOn: ['navigation'],
      steps: [
        { kind: 'select', selector: '#user', valueRef: 'user' },
        { kind: 'fill', selector: '#address', valueRef: 'address' },
        { kind: 'click', selector: 'button[type=submit]' },
        { kind: 'text', selector: '#status', expected },
      ],
    },
    {
      id: 'dependent',
      dependsOn: ['synthetic-identity-checkout'],
      steps: [{ kind: 'visible', selector: '#status' }],
    },
  ],
});
for (const mode of ['healthy', 'missing-address-500', 'checkout-stuck']) {
  const app = createFixtureApp(mode);
  app.get('/redirect', (_request, response) => response.redirect('/health'));
  app.get('/diagnostic', (_request, response) =>
    response
      .type('html')
      .send(
        '<script>console.error("synthetic");setTimeout(()=>{throw Error("synthetic")},0)</script><p id="ready">Ready</p>',
      ),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const browser = await createFixtureSmokeDriver(origin, {
      user: 'alice',
      address: mode === 'healthy' ? '1 Test Lane' : '',
    });
    const result = await runSmoke(
      plan(mode === 'healthy' ? 'Order placed:' : 'Address is required'),
      browser,
      { isCurrent: async () => true },
    );
    assert.equal(result.outcome, mode === 'healthy' ? 'passed' : 'failed');
    assert.ok(result.executionMs < 20000);
    assert.equal(result.baseline, 'unavailable');
    if (mode !== 'healthy') assert.equal(result.journeys[2].outcome, 'skipped');
    if (mode === 'missing-address-500')
      assert.ok(result.journeys[1].events.serverErrors > 0);
    if (mode === 'checkout-stuck')
      assert.equal(result.journeys[1].code, 'assertion_failed');
    if (mode === 'healthy') {
      const diagnostic = plan('Ready');
      diagnostic.journeys = [
        {
          id: 'errors',
          dependsOn: [],
          steps: [
            { kind: 'navigate', path: '/diagnostic' },
            { kind: 'text', selector: '#ready', expected: 'Ready' },
          ],
        },
      ];
      const observed = await runSmoke(
        diagnostic,
        await createFixtureSmokeDriver(origin, {}),
        { isCurrent: async () => true },
      );
      assert.equal(observed.outcome, 'failed');
      assert.ok(observed.journeys[0].events.consoleErrors > 0);
      assert.ok(observed.journeys[0].events.pageErrors > 0);
      const missing = plan('unused');
      missing.journeys[0].steps = [{ kind: 'navigate', path: '/absent' }];
      const blocked = await runSmoke(
        missing,
        await createFixtureSmokeDriver(origin, {}),
        { isCurrent: async () => true },
      );
      assert.equal(blocked.journeys[0].code, 'navigation_failed');
      assert.equal(blocked.journeys[1].outcome, 'skipped');
      const redirect = plan('unused');
      redirect.journeys[0].steps = [{ kind: 'navigate', path: '/redirect' }];
      const denied = await runSmoke(
        redirect,
        await createFixtureSmokeDriver(origin, {}),
        { isCurrent: async () => true },
      );
      assert.equal(denied.outcome, 'inconclusive');
      assert.equal(denied.code, 'smoke_destination_blocked');
    }
    process.stdout.write(`Smoke fixture verified: ${mode}\n`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
