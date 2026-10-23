import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createBrowserObserver } from './browser-observation.js';
import type {
  BrowserDiagnostic,
  ObservationSource,
} from './browser-observation.js';
const scope = {
  tenantId: randomUUID(),
  runId: randomUUID(),
  repositoryId: 1,
  pullRequestNumber: 2,
  headSha: 'a'.repeat(40),
};
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function source(overrides: Partial<ObservationSource> = {}) {
  let listener: ((event: BrowserDiagnostic) => void) | undefined;
  let detached = 0;
  const driver: ObservationSource = {
    snapshot: async () => '- button "Checkout"',
    screenshot: async () => png,
    subscribe(callback) {
      listener = callback;
      return () => {
        detached++;
        listener = undefined;
      };
    },
    ...overrides,
  };
  return {
    driver,
    emit(event: BrowserDiagnostic) {
      listener?.(event);
    },
    detached: () => detached,
  };
}
test('captures scoped private snapshots with bounded ordered action diagnostics and detached outputs', async () => {
  const fixture = source();
  const observer = createBrowserObserver(scope, fixture.driver, {
    isCurrent: async () => true,
    limits: { maxEvents: 2 },
  });
  observer.markAction('checkout');
  fixture.emit({ kind: 'console_error' });
  fixture.emit({ kind: 'http_error', status: 500 });
  fixture.emit({ kind: 'request_failed' });
  const result = await observer.observe();
  assert.equal(result.runId, scope.runId);
  assert.equal(result.actionId, 'checkout');
  assert.equal(result.untrusted, true);
  assert.equal(result.droppedEvents, 1);
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.events[1].sequence, 2);
  assert.ok(
    result.events.every(
      (event) => event.actionId === 'checkout' && event.elapsedMs >= 0,
    ),
  );
  result.events.length = 0;
  result.screenshot?.fill(0);
  const next = await observer.observe();
  assert.equal(next.events.length, 2);
  assert.deepEqual(next.screenshot, png);
  observer.close();
  observer.close();
  assert.equal(fixture.detached(), 1);
  await assert.rejects(observer.observe(), /observation_unavailable/);
});
test('oversized captures and source failures are explicit gaps without payload retention', async () => {
  const fixture = source({
    snapshot: async () => 'secret'.repeat(10),
    screenshot: async () => Buffer.alloc(100),
  });
  const observer = createBrowserObserver(scope, fixture.driver, {
    isCurrent: async () => true,
    limits: { maxSnapshotBytes: 2, maxScreenshotBytes: 2 },
  });
  const result = await observer.observe();
  assert.equal(result.snapshot, undefined);
  assert.equal(result.screenshot, undefined);
  assert.deepEqual(result.gaps, ['snapshot_size', 'screenshot_size']);
  observer.close();
  const broken = createBrowserObserver(
    scope,
    source({
      snapshot: async () => {
        throw Error('secret');
      },
    }).driver,
    { isCurrent: async () => true },
  );
  assert.ok(!JSON.stringify(await broken.observe()).includes('secret'));
  broken.close();
});
for (const failure of ['cancel', 'stale', 'timeout', 'close'] as const) {
  test(`observation with ${failure} cannot release captured page data`, async () => {
    const controller = new AbortController();
    let checks = 0;
    const fixture = source(
      failure === 'timeout' ? { snapshot: () => new Promise(() => {}) } : {},
    );
    const observer = createBrowserObserver(scope, fixture.driver, {
      signal: controller.signal,
      limits: { captureMs: 20 },
      isCurrent: async () => {
        checks++;
        if (failure === 'cancel') controller.abort();
        if (failure === 'close') observer.close();
        return failure !== 'stale' || checks < 2;
      },
    });
    const result = await observer.observe();
    assert.equal(result.snapshot, undefined);
    assert.equal(result.screenshot, undefined);
    assert.ok(result.gaps.includes('observation_stopped'));
    observer.close();
  });
}
test('capture count, concurrency, schema and action-marker limits apply before extra work', async () => {
  const fixture = source();
  const observer = createBrowserObserver(scope, fixture.driver, {
    isCurrent: async () => true,
    limits: { maxObservations: 1 },
  });
  assert.throws(() => observer.markAction('raw user text / secret'));
  const pending = observer.observe();
  await assert.rejects(observer.observe());
  assert.throws(() => observer.markAction('later'));
  await pending;
  await assert.rejects(observer.observe());
  observer.close();
  assert.throws(() =>
    createBrowserObserver({ ...scope, headSha: 'bad' }, fixture.driver, {
      isCurrent: async () => true,
    }),
  );
});
