import express from 'express';

const port = Number(process.env.API_PORT ?? 4000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('API_PORT must be an integer between 1 and 65535');
}

const app = express();
app.disable('x-powered-by');
app.get('/health', (_request, response) => {
  response.json({ service: 'dogwatch-api', status: 'ok' });
});
const server = app.listen(port, '127.0.0.1', () => {
  process.stdout.write(`DogWatch API listening on http://127.0.0.1:${port}\n`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close());
}
