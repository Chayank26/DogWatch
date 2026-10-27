import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLogger,
  metricsText,
  metricsPort,
  startMetricsServer,
} from './index.js';

test('metrics aggregate sanitized events and cumulative durations even when sinks fail', () => {
  const log = createLogger('api', () => {
    throw Error('SECRET');
  });
  for (const durationMs of [25, 500, 2000])
    log('http.request', 'failed', {
      route: '/SECRET?token=SECRET',
      statusCode: 503,
      durationMs,
      tenantId: '00000000-0000-4000-8000-000000000001',
    });
  const text = metricsText();
  assert.match(
    text,
    /dogwatch_events_total\{service="api",event="http.request",route="unmatched",outcome="failed",status_class="5xx"\} 3/,
  );
  const prefix =
    'dogwatch_duration_seconds_bucket{service="api",event="http.request",route="unmatched",le=';
  for (const [bound, count] of [
    ['0.025', 1],
    ['0.5', 2],
    ['5', 3],
    ['+Inf', 3],
  ])
    assert.ok(text.includes(`${prefix}"${bound}"} ${count}\n`));
  assert.match(text, /dogwatch_logs_dropped_total 3\n/);
  assert.ok(!text.includes('SECRET'));
  assert.ok(!text.includes('tenantId'));
  assert.ok(!text.includes('00000000'));
  log('SECRET' as 'http.request', 'completed');
  assert.ok(!metricsText().includes('SECRET'));
});

test('unique paths and identities collapse to bounded labels; invalid durations are omitted', () => {
  const log = createLogger('queue', () => {});
  for (let n = 0; n < 10000; n++)
    log('queue.process', 'started', {
      route: `/private/${n}`,
      durationMs: Infinity,
    });
  const text = metricsText();
  assert.match(
    text,
    /dogwatch_events_total\{service="queue",event="queue.process",route="none",outcome="started",status_class="none"\} 10000/,
  );
  assert.ok(!text.includes('dogwatch_duration_seconds_count{service="queue"'));
  assert.ok(text.length < 6000);
});

test('metrics port configuration is disabled by default and rejects invalid values', async () => {
  assert.equal(metricsPort(undefined), undefined);
  assert.equal(await startMetricsServer(undefined), undefined);
  assert.equal(metricsPort('9401'), 9401);
  for (const value of ['', '0', '-1', '65536', '1.2', '1e3', ' 9401'])
    assert.throws(() => metricsPort(value));
});

test('dedicated scrape server binds loopback, rejects other requests and does not count scrapes', async () => {
  const server = (await startMetricsServer(0))!;
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    assert.equal(address.address, '127.0.0.1');
    const url = `http://127.0.0.1:${address.port}`;
    const before = metricsText()
      .split('\n')
      .filter((line) => line.startsWith('dogwatch_events_total'));
    const response = await fetch(url + '/metrics');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /version=0.0.4/);
    assert.match(await response.text(), /# TYPE dogwatch_events_total counter/);
    for (const path of ['/metrics?token=SECRET', '/health', '/'])
      assert.equal((await fetch(url + path)).status, 404);
    assert.equal(
      (await fetch(url + '/metrics', { method: 'POST' })).status,
      404,
    );
    assert.deepEqual(
      metricsText()
        .split('\n')
        .filter((line) => line.startsWith('dogwatch_events_total')),
      before,
    );
    await assert.rejects(startMetricsServer(address.port), {
      code: 'EADDRINUSE',
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
