/** Dispatcher with explicitly enabled, read-only API consumer. */
import {
  createLogger,
  metricsPort,
  startMetricsServer,
} from '@dogwatch/telemetry';
const log = createLogger('dispatcher');
import { setTimeout as pause } from 'node:timers/promises';
import {
  createDatabase,
  dispatchNext,
  expireExecution,
} from '@dogwatch/database';
import { createRunQueue, enqueueRun, createRunWorker } from '@dogwatch/queue';

import { consumerSettings, configureApiConsumer } from './api-consumer.js';
const settings = consumerSettings(process.env);
const shutdown = new AbortController();
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const scrapePort = metricsPort(process.env.DISPATCHER_METRICS_PORT);
if (!databaseUrl && !redisUrl) {
  log('service.lifecycle', 'disabled');
} else {
  if (!databaseUrl || !redisUrl)
    throw new Error('Dispatcher requires both DATABASE_URL and REDIS_URL');
  const metrics = await startMetricsServer(scrapePort);
  const database = createDatabase(databaseUrl);
  const queue = createRunQueue(redisUrl);
  let consumer: ReturnType<typeof createRunWorker> | undefined;
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      stopping = true;
      shutdown.abort();
    });
  log('service.lifecycle', 'started');
  try {
    if (settings) {
      const processor = await configureApiConsumer(
        database,
        settings,
        shutdown.signal,
      );
      consumer = createRunWorker(redisUrl, processor);
    }
    let nextExpiry = 0;
    while (!stopping) {
      try {
        if (consumer && Date.now() >= nextExpiry) {
          nextExpiry = Date.now() + 10000;
          const expired = await database.runExecution.findMany({
            where: { finishedAt: null, expiresAt: { lte: new Date() } },
            select: { tenantId: true, runId: true },
            take: 100,
            orderBy: { expiresAt: 'asc' },
          });
          for (const identity of expired)
            await expireExecution(database, identity);
        }
        const result = await dispatchNext(database, (data) =>
          enqueueRun(queue, data),
        );
        // Idle polling is bounded, and operational DB errors do not create a hot loop.
        if (result === 'idle') await pause(1000);
      } catch {
        // dispatchNext records a sanitized failure; do not duplicate raw exceptions.
        await pause(1000);
      }
    }
  } finally {
    shutdown.abort();
    await consumer?.close();
    metrics?.close();
    metrics?.closeAllConnections();
    await queue.close();
    await database.$disconnect();
    log('service.lifecycle', 'stopped');
  }
}
