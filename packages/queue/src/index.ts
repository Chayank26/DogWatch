/** Queue primitives: only UUID references cross Redis, never credentials/source. */
import { Queue, Worker, UnrecoverableError } from 'bullmq';
import type { ConnectionOptions, Job } from 'bullmq';
import { z } from 'zod';

export const runJobSchema = z.strictObject({
  runId: z.uuid(),
  tenantId: z.uuid(),
});
export type { Job } from 'bullmq';
export type RunJob = z.infer<typeof runJobSchema>;

/** Keep Redis target operator-controlled; producers fail quickly, workers can reconnect. */
function connection(redisUrl: string, worker = false): ConnectionOptions {
  const url = new URL(redisUrl);
  if (!['redis:', 'rediss:'].includes(url.protocol))
    throw new Error('Expected a Redis URL');
  const db = Number(url.pathname.slice(1) || 0);
  if (!Number.isInteger(db) || db < 0)
    throw new Error('Invalid Redis database');
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    db,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: worker ? null : 1,
    ...(worker ? {} : { commandTimeout: 2000 }),
    connectTimeout: 2000,
  };
}
export function createRunQueue(redisUrl: string, name = 'dogwatch-runs') {
  const queue = new Queue<RunJob>(name, {
    connection: connection(redisUrl),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      // Retain job identities until a deliberate reconciliation/retention policy exists.
      removeOnComplete: false,
      removeOnFail: false,
    },
  });
  // Avoid unhandled emitter errors; operators receive sanitized diagnostic codes.
  queue.on('error', () =>
    process.stderr.write('DogWatch queue connection error\n'),
  );
  return queue;
}

/** A mismatched stable ID is deterministic, so dispatch must not retry it. */
export class QueueIdentityConflictError extends Error {
  readonly retryable = false;
}

export async function enqueueRun(queue: Queue<RunJob>, input: RunJob) {
  const data = runJobSchema.parse(input);
  // UUIDs avoid BullMQ's reserved colon separator in custom job IDs.
  // Redis enforces this ceiling across all worker processes on this queue.
  await queue.setGlobalConcurrency(2);
  const existing = await queue.getJob(data.runId);
  if (
    existing &&
    JSON.stringify(runJobSchema.parse(existing.data)) !== JSON.stringify(data)
  ) {
    throw new QueueIdentityConflictError(
      'Queue identity conflicts with durable run',
    );
  }
  return queue.add('run.requested', data, { jobId: data.runId });
}

/**
 * Reusable worker harness for later isolated execution, currently used only in
 * synthetic verification. Processor implementations must revalidate DB ownership
 * and be idempotent: Redis delivery/retries alone do not guarantee exactly once.
 */
export function createRunWorker(
  redisUrl: string,
  processor: (data: RunJob, job: Job<RunJob>) => Promise<unknown>,
  name = 'dogwatch-runs',
  concurrency = 2,
) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10)
    throw new Error('Invalid worker concurrency');
  const worker = new Worker<RunJob>(
    name,
    async (job) => {
      const parsed = runJobSchema.safeParse(job.data);
      if (!parsed.success || job.name !== 'run.requested')
        throw new UnrecoverableError('Invalid run job');
      return processor(parsed.data, job);
    },
    { connection: connection(redisUrl, true), concurrency, maxStalledCount: 1 },
  );
  worker.on('error', () =>
    process.stderr.write('DogWatch worker connection error\n'),
  );
  return worker;
}
