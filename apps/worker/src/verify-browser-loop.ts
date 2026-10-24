/** Real Chromium; deterministic offline provider transport, no external model request. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createFixtureActionExecutor } from './browser-actions-fixture.js';
import { createJsonBrowserModel } from './browser-model.js';
import { runBrowserLoop } from './browser-loop.js';
const server = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html');
  response.end(
    "<h1>Ready</h1><button onclick=\"document.querySelector('h1').textContent='Complete'\">Checkout</button>",
  );
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
const scope = {
  tenantId: randomUUID(),
  runId: randomUUID(),
  repositoryId: 20,
  pullRequestNumber: 42,
  headSha: 'a'.repeat(40),
};
const action = { kind: 'click', target: 'checkout' };
let executor:
  Awaited<ReturnType<typeof createFixtureActionExecutor>> | undefined;
try {
  executor = await createFixtureActionExecutor(
    scope,
    {
      ...scope,
      origin: `http://127.0.0.1:${address.port}`,
      disposableData: true,
      navigationPaths: ['/'],
      requests: [{ path: '/', method: 'GET' }],
      targets: [
        {
          id: 'checkout',
          locator: { kind: 'role', role: 'button', name: 'Checkout' },
          actions: ['click'],
        },
      ],
      values: {},
    },
    { isCurrent: async () => true },
  );
  let sawComplete = false;
  const model = createJsonBrowserModel(async (request) => {
    assert.ok(request.observation.pngBase64.length > 100);
    sawComplete = request.observation.snapshot.includes('Complete');
    return JSON.stringify({
      action: sawComplete ? { kind: 'stop' } : action,
      usage: { inputTokens: 100, outputTokens: 20 },
    });
  });
  const result = await runBrowserLoop(
    {
      ...scope,
      syntheticModelInput: true,
      goal: 'Complete synthetic checkout',
      initialPath: '/',
      actions: [action],
    },
    executor,
    model,
    { isCurrent: async () => true },
  );
  assert.equal(result.code, 'model_stopped');
  assert.equal(result.calls, 2);
  assert.equal(sawComplete, true);
  console.log(
    'Browser loop verified with real Chromium and deterministic offline model transport.',
  );
} finally {
  await executor?.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
