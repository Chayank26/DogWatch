import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createLogger,
  newTrace,
  withTrace,
  runTrace,
  droppedLogCount,
  protectLogger,
} from './index.js';
import type { Fields } from './index.js';
test('JSON records allow only bounded operational fields and omit secrets and malformed identifiers', () => {
  const lines: string[] = [];
  const log = createLogger('api', (line) => lines.push(line));
  log('http.request', 'completed', {
    requestId: randomUUID(),
    route: '/auth/callback?code=SECRET',
    method: 'GET',
    statusCode: 200,
    durationMs: 12.3,
    tenantId: 'SECRET',
    headSha: 'SECRET',
    authorization: 'Bearer SECRET',
    payload: 'SECRET',
    error: new Error('SECRET'),
    duration: Infinity,
  } as unknown as Fields);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith('\n'));
  assert.ok(lines[0].length < 2048);
  assert.ok(!lines[0].includes('SECRET'));
  const record = JSON.parse(lines[0]);
  assert.equal(record.route, 'unmatched');
  assert.equal(record.durationMs, 12);
  assert.equal(record.version, 1);
  assert.ok(!('error' in record));
});
test('concurrent asynchronous contexts remain isolated and do not leak after completion', async () => {
  const records: Record<string, string>[] = [];
  const log = createLogger('api', (line) => records.push(JSON.parse(line)));
  const traces = [newTrace(), newTrace()];
  await Promise.all(
    traces.map((trace, index) =>
      withTrace(trace, async () => {
        await new Promise((resolve) => setTimeout(resolve, index ? 1 : 10));
        log('http.request', 'completed');
      }),
    ),
  );
  assert.deepEqual(
    new Set(records.map((r) => r.requestId)),
    new Set(traces.map((t) => t.requestId)),
  );
  for (const record of records)
    assert.equal(
      record.traceId,
      traces.find((t) => t.requestId === record.requestId)?.traceId,
    );
  log('service.lifecycle', 'started');
  assert.equal(records[2].requestId, undefined);
});
test('run correlation is stable across attempts with separate spans and preserves local request identity', () => {
  const runId = randomUUID(),
    root = newTrace();
  withTrace(root, () => {
    const a = runTrace(runId),
      b = runTrace(runId);
    assert.equal(a.traceId, b.traceId);
    assert.notEqual(a.spanId, b.spanId);
    assert.equal(a.requestId, root.requestId);
    assert.notEqual(a.traceId, runTrace(randomUUID()).traceId);
  });
});
test('sink errors and invalid runtime events fail open without leaking error messages', () => {
  const before = droppedLogCount();
  assert.doesNotThrow(() =>
    createLogger('api', () => {
      throw Error('SECRET');
    })('http.request', 'failed'),
  );
  assert.doesNotThrow(() =>
    protectLogger(() => {
      throw Error('SECRET');
    })('http.request', 'failed'),
  );
  assert.ok(droppedLogCount() >= before + 2);
  const lines: string[] = [];
  const log = createLogger('api', (line) => lines.push(line));
  log('SECRET' as 'http.request', 'completed');
  assert.equal(lines.length, 0);
});
