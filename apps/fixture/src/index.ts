/** Entry point only; importing the app factory in tests never starts a listener. */
import { createFixtureApp, parseFixtureMode } from './app.js';

const port = Number(process.env.FIXTURE_PORT ?? 4100);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('Invalid FIXTURE_PORT');
const mode = parseFixtureMode(process.env.FIXTURE_MODE);
const server = createFixtureApp(mode).listen(port, '127.0.0.1', () => {
  process.stdout.write(`PawMart fixture (${mode}): http://127.0.0.1:${port}\n`);
});
// Stop accepting work and close keep-alive connections on developer/CI shutdown.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close();
    server.closeIdleConnections();
  });
}
