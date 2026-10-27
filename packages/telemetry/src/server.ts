import { createServer } from 'node:http';
import { metricsText } from './index.js';
export function metricsPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
    throw Error('Metrics port must be an integer between 1 and 65535');
  return Number(value);
}
/** Dedicated loopback endpoint; never mount this on the application router. */
export async function startMetricsServer(port: number | undefined) {
  if (port === undefined) return undefined;
  const server = createServer(
    { requestTimeout: 5000, headersTimeout: 5000 },
    (req, res) => {
      if (req.method !== 'GET' || req.url !== '/metrics') {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(200, {
          'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        .end(metricsText());
    },
  );
  server.maxConnections = 16;
  server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}
