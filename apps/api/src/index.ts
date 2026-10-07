/** API process entry point; configure secrets in the shell, never in source files. */
import { createApiApp } from './app.js';
import { readFileSync } from 'node:fs';
import { parsePolicies } from './authorization.js';
import { createGitHubResolver } from './github.js';
import { createDatabase, acceptDelivery, stopRuns } from '@dogwatch/database';

const port = Number(process.env.API_PORT ?? 4000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('API_PORT must be an integer between 1 and 65535');
}
// A missing secret leaves health available but webhook requests fail closed.
const secret = process.env.GITHUB_WEBHOOK_SECRET;
if (secret !== undefined && (!secret.trim() || secret.length < 32)) {
  throw new Error(
    'GITHUB_WEBHOOK_SECRET must contain at least 32 characters and not be blank',
  );
}
// Operator-owned local files bootstrap policy until persistent configuration exists.
// Do not accept either path from an HTTP body or webhook field.
const policyFile = process.env.GITHUB_POLICIES_FILE;
const keyFile = process.env.GITHUB_PRIVATE_KEY_FILE;
const appIdText = process.env.GITHUB_APP_ID;
let authorization;
if (policyFile || keyFile || appIdText) {
  if (!secret || !policyFile || !keyFile || !appIdText)
    throw new Error('Complete GitHub authorization configuration is required');
  const appId = Number(appIdText);
  if (!Number.isSafeInteger(appId) || appId <= 0)
    throw new Error('Invalid GITHUB_APP_ID');
  authorization = {
    policies: parsePolicies(JSON.parse(readFileSync(policyFile, 'utf8'))),
    resolvePullRequest: createGitHubResolver(
      appId,
      readFileSync(keyFile, 'utf8'),
    ),
  };
}
// DATABASE_URL explicitly opts authorized ingress into durable acceptance.
// No fallback database URL is used for customer event writes.
if (process.env.DATABASE_URL && !authorization)
  throw new Error('Persistence requires GitHub authorization configuration');
const database = process.env.DATABASE_URL
  ? createDatabase(process.env.DATABASE_URL)
  : undefined;
const persist = database
  ? (input: Parameters<typeof acceptDelivery>[1]) =>
      acceptDelivery(database, input)
  : undefined;
const server = createApiApp(
  secret,
  authorization,
  persist,
  database ? (input) => stopRuns(database, input) : undefined,
).listen(port, '127.0.0.1', () => {
  process.stdout.write(`DogWatch API listening on http://127.0.0.1:${port}\n`);
});
// Graceful shutdown stops new requests and releases keep-alive connections.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => {
      void database?.$disconnect();
    });
    server.closeIdleConnections();
  });
}
