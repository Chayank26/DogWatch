import test from 'node:test';
import assert from 'node:assert/strict';
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createLogger } from '@dogwatch/telemetry';
import { createApiApp } from './app.js';
test('HTTP correlation ignores caller headers, logs one completion and excludes OAuth/cookie/body secrets', async () => {
  const records: Record<string, unknown>[] = [];
  const log = createLogger('api', (line) => records.push(JSON.parse(line)));
  const router = Router();
  router.get('/github/callback', (_req, res) =>
    res.status(400).json({ error: 'Invalid login callback' }),
  );
  const app = createApiApp(
    undefined,
    undefined,
    undefined,
    undefined,
    router,
    log,
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  try {
    const spoof = randomUUID();
    const response = await fetch(
      base + '/auth/github/callback?code=SECRET&state=SECRET',
      {
        headers: {
          cookie: 'session=SECRET',
          authorization: 'Bearer SECRET',
          'x-request-id': spoof,
          traceparent: 'SECRET',
        },
      },
    );
    assert.equal(response.status, 400);
    assert.notEqual(response.headers.get('x-request-id'), spoof);
    await fetch(base + '/unknown/SECRET');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(records.length, 2);
    assert.equal(records[0].requestId, response.headers.get('x-request-id'));
    assert.equal(records[0].route, '/github/callback');
    assert.equal(records[1].route, 'unmatched');
    assert.ok(!JSON.stringify(records).includes('SECRET'));
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});
test('a broken injected logger does not fail a healthy HTTP request', async () => {
  const app = createApiApp(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => {
      throw Error('broken logger');
    },
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    assert.equal(
      (
        await fetch(
          'http://127.0.0.1:' +
            (server.address() as AddressInfo).port +
            '/health',
        )
      ).status,
      200,
    );
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});

test('an interrupted HTTP response emits one aborted record without a misleading success status', async () => {
  const records: Record<string, unknown>[] = [];
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const router = Router();
  router.get('/me', () => entered());
  const app = createApiApp(
    undefined,
    undefined,
    undefined,
    undefined,
    router,
    createLogger('api', (line) => records.push(JSON.parse(line))),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const controller = new AbortController();
    const pending = fetch(
      'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/auth/me',
      { signal: controller.signal },
    );
    const rejected = assert.rejects(pending);
    await ready;
    controller.abort();
    await rejected;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, 'aborted');
    assert.equal(records[0].statusCode, undefined);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});
