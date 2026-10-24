/** Fresh real browsers share a single ledger; model transport remains offline. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { runPersonaSuite } from './browser-personas.js';
import { createJsonBrowserModel } from './browser-model.js';
import { createFixtureActionExecutor } from './browser-actions-fixture.js';
const server = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(
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
let browsers = 0;
try {
  const result = await runPersonaSuite(
    {
      ...scope,
      personas: ['novice', 'keyboard_only', 'impatient'],
      budget: {
        maxCalls: 4,
        maxTokens: 16800,
        maxActions: 4,
        maxRequests: 2,
        maxCostMicros: 400,
        costPerCallMicros: 100,
      },
    },
    {
      syntheticModelInput: true,
      initialPath: '/',
      goal: 'Synthetic checkout',
      actions: [action],
    },
    {
      isCurrent: async () => true,
      model: createJsonBrowserModel(async (request) =>
        JSON.stringify({
          action: request.observation.snapshot.includes('Complete')
            ? { kind: 'stop' }
            : action,
          usage: { inputTokens: 100, outputTokens: 20 },
        }),
      ),
      createExecutor: async (_persona, budget, signal) => {
        browsers++;
        return createFixtureActionExecutor(
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
          { isCurrent: async () => true, signal, budget },
        );
      },
    },
  );
  assert.deepEqual(
    result.results.map((row) => row.code),
    ['model_stopped', 'persona_unsupported', 'model_stopped'],
  );
  assert.equal(browsers, 2);
  assert.equal(result.budget.requests, 2);
  assert.equal(result.budget.actions, 4);
  assert.equal(result.budget.calls, 4);
  assert.equal(result.budget.costMicros, 400);
  console.log(
    'Persona suite verified: fresh Chromium contexts, explicit keyboard gap, shared request/action/token/cost reservations.',
  );
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
