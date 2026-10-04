/** Known GitHub test vector plus real HTTP requests verify the authenticity boundary. */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { createApiApp } from './app.js';
import { verifyGitHubSignature } from './webhook.js';

const secret = 'synthetic-webhook-secret-for-tests-only';
const sign = (body: string) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
async function withApi(run: (url: string) => Promise<void>, configured = true) {
  const server = createApiApp(configured ? secret : undefined).listen(
    0,
    '127.0.0.1',
  );
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
function send(
  url: string,
  body: string,
  signature: string = sign(body),
  headers: Record<string, string> = {},
) {
  return fetch(`${url}/webhooks/github`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hub-signature-256': signature,
      ...headers,
    },
    body,
  });
}

test('GitHub published test vector verifies independently of the test signing helper', () => {
  assert.equal(
    verifyGitHubSignature(
      Buffer.from('Hello, World!'),
      'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
      "It's a Secret to Everybody",
    ),
    true,
  );
});

test('raw whitespace and Unicode are authenticated without normalization or side effects', async () => {
  await withApi(async (url) => {
    const body = '{\n "note": "PawMart 🐾", "action": "opened"\n}';
    const response = await send(url, body);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'verified_only',
      queued: false,
    });
    assert.equal((await send(url, body + ' ', sign(body))).status, 401);
    assert.equal((await fetch(`${url}/health`)).status, 200);
  });
});

test('missing, malformed, duplicate, incorrect and legacy signatures are rejected safely', async () => {
  await withApi(async (url) => {
    for (const signature of [
      '',
      'sha256=abc',
      `sha256=${'z'.repeat(64)}`,
      `sha256=${'0'.repeat(64)}`,
      sign('{}') + ', ' + sign('{}'),
      'sha1=abc',
    ]) {
      assert.equal((await send(url, '{}', signature)).status, 401);
    }
    assert.equal(
      (
        await fetch(`${url}/webhooks/github`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      401,
    );
  });
});

test('signed malformed JSON is rejected after signature verification', async () => {
  await withApi(async (url) => {
    for (const body of ['{', 'null', '[]', '42'])
      assert.equal((await send(url, body)).status, 400);
    assert.equal((await send(url, '{', 'bad')).status, 401);
  });
});

test('content type, compression, payload limits and missing configuration fail closed', async () => {
  await withApi(async (url) => {
    assert.equal(
      (await send(url, '{}', sign('{}'), { 'Content-Type': 'text/plain' }))
        .status,
      415,
    );
    assert.equal(
      (await send(url, '{}', sign('{}'), { 'Content-Encoding': 'gzip' }))
        .status,
      415,
    );
    assert.equal(
      (await send(url, JSON.stringify({ data: 'x'.repeat(1024 * 1024) })))
        .status,
      413,
    );
  });
  await withApi(
    async (url) => assert.equal((await send(url, '{}')).status, 503),
    false,
  );
});
