/**
 * Phase 2.4 runner hosts the outbox dispatcher only. Production QA consumption
 * stays disabled until preview readiness and isolated execution are implemented.
 */
import { createLogger } from '@dogwatch/telemetry';
const log = createLogger('dispatcher');
import { setTimeout as pause } from 'node:timers/promises';
import { createDatabase, dispatchNext } from '@dogwatch/database';
import { createRunQueue, enqueueRun } from '@dogwatch/queue';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (!databaseUrl && !redisUrl) {
  log('service.lifecycle', 'disabled');
} else {
  if (!databaseUrl || !redisUrl)
    throw new Error('Dispatcher requires both DATABASE_URL and REDIS_URL');
  const database = createDatabase(databaseUrl);
  const queue = createRunQueue(redisUrl);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      stopping = true;
    });
  log('service.lifecycle', 'started');
  try {
    while (!stopping) {
      try {
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
    await queue.close();
    await database.$disconnect();
    log('service.lifecycle', 'stopped');
  }
}
