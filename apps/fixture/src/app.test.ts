/** Real HTTP tests on ephemeral loopback ports. Every test owns and closes its server. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createFixtureApp, parseFixtureMode } from './app.js';
import type { FixtureMode } from './app.js';

async function withFixture(
  mode: FixtureMode,
  run: (url: string) => Promise<void>,
) {
  const server = createFixtureApp(mode).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
/** Helper submits the same synthetic checkout shape used by the browser. */
function submit(url: string, body: unknown, token = 'fixture-alice') {
  return fetch(`${url}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

test('healthy checkout creates a readable order, while auth and ownership are enforced', async () => {
  await withFixture('healthy', async (url) => {
    assert.equal((await fetch(`${url}/health`)).status, 200);
    assert.equal((await fetch(`${url}/`)).status, 200);
    assert.equal((await fetch(`${url}/api/orders/order-alice`)).status, 401);
    assert.equal(
      (
        await fetch(`${url}/api/orders/order-bob`, {
          headers: { Authorization: 'Bearer fixture-alice' },
        })
      ).status,
      403,
    );
    const response = await submit(url, { address: '1 Test Lane', quantity: 1 });
    assert.equal(response.status, 201);
    const order = (await response.json()) as { id: string };
    assert.equal(
      (
        await fetch(`${url}/api/orders/${order.id}`, {
          headers: { Authorization: 'Bearer fixture-alice' },
        })
      ).status,
      200,
    );
    assert.equal(
      (await submit(url, { address: '1 Test Lane', quantity: 1 }, 'invalid'))
        .status,
      401,
    );
  });
});

test('healthy API rejects missing address, boundary quantities, malformed JSON, and large payloads', async () => {
  await withFixture('healthy', async (url) => {
    for (const body of [
      null,
      [],
      {},
      { address: '', quantity: 1 },
      ...[0, 11, 1.5, '1'].map((quantity) => ({
        address: '1 Test Lane',
        quantity,
      })),
    ]) {
      assert.equal((await submit(url, body)).status, 400);
    }
    assert.equal(
      (await submit(url, { address: '1 Test Lane', quantity: 10 })).status,
      201,
    );
    const headers = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer fixture-alice',
    };
    assert.equal(
      (await fetch(`${url}/api/orders`, { method: 'POST', headers, body: '{' }))
        .status,
      400,
    );
    assert.equal(
      (await submit(url, { address: 'a'.repeat(20000), quantity: 1 })).status,
      413,
    );
  });
});

test('fault modes have explicit predictable contracts and unknown modes fail startup', async () => {
  await withFixture('missing-address-500', async (url) => {
    assert.equal((await submit(url, { address: '', quantity: 1 })).status, 500);
    assert.equal(
      (await submit(url, { address: '1 Test Lane', quantity: 1 })).status,
      201,
    );
  });
  await withFixture('checkout-stuck', async (url) => {
    assert.deepEqual(
      await fetch(`${url}/fixture-config`).then((response) => response.json()),
      { mode: 'checkout-stuck' },
    );
    // This fault is in the browser; the API must still correctly reject bad input.
    assert.equal((await submit(url, { address: '', quantity: 1 })).status, 400);
  });
  assert.throws(() => parseFixtureMode('typo'), /Unknown FIXTURE_MODE/);
});
