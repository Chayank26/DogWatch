/** API process entry point; configure secrets in the shell, never in source files. */
import { createApiApp } from './app.js';

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
const server = createApiApp(secret).listen(port, '127.0.0.1', () => {
  process.stdout.write(`DogWatch API listening on http://127.0.0.1:${port}\n`);
});
// Graceful shutdown stops new requests and releases keep-alive connections.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close();
    server.closeIdleConnections();
  });
}
