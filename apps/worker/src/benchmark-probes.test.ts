import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { probeFixture } from './benchmark-probes.js';
test('malformed controls are inconclusive and response contents never enter evidence', async () => {
  const server = createServer((_req, res) =>
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end('["SECRET"]'),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const result = await probeFixture(
      `http://127.0.0.1:${address.port}`,
      'authentication',
    );
    assert.equal(result.observation, 'inconclusive');
    assert.equal(result.requests, 1);
    assert.ok(!JSON.stringify(result).includes('SECRET'));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
test('benchmark probes refuse nonfixture origins before making requests', async () => {
  for (const origin of [
    'https://example.com',
    'http://localhost:4000',
    'http://127.0.0.1:4000/path',
    'http://user:secret@127.0.0.1:4000',
  ])
    await assert.rejects(probeFixture(origin, 'api'), /benchmark_origin/);
});
