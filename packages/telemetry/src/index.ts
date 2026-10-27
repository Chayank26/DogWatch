/** Allowlisted operational metadata only. Never pass raw errors, payloads, URLs or credentials. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { observe, renderMetrics } from './metrics.js';
export { metricsPort, startMetricsServer } from './server.js';
export function metricsText() {
  return renderMetrics(droppedLogCount());
}
export type Service = 'api' | 'dispatcher' | 'queue';
export type Event =
  | 'http.request'
  | 'webhook.acceptance'
  | 'manual.acceptance'
  | 'outbox.dispatch'
  | 'queue.enqueue'
  | 'queue.process'
  | 'service.lifecycle'
  | 'queue.connection';
export type Outcome =
  | 'started'
  | 'accepted'
  | 'duplicate'
  | 'published'
  | 'retry'
  | 'failed'
  | 'completed'
  | 'aborted'
  | 'disabled'
  | 'stopped';
export type Fields = {
  requestId?: string;
  traceId?: string;
  spanId?: string;
  tenantId?: string;
  runId?: string;
  outboxId?: string;
  jobId?: string;
  deliveryId?: string;
  headSha?: string;
  method?: string;
  route?: string;
  statusCode?: number;
  durationMs?: number;
  attempt?: number;
};
export type Logger = (event: Event, outcome: Outcome, fields?: Fields) => void;
type Trace = Pick<Fields, 'requestId' | 'traceId' | 'spanId'>;
const storage = new AsyncLocalStorage<Trace>();
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const events = new Set<Event>([
  'http.request',
  'webhook.acceptance',
  'manual.acceptance',
  'outbox.dispatch',
  'queue.enqueue',
  'queue.process',
  'service.lifecycle',
  'queue.connection',
]);
const outcomes = new Set<Outcome>([
  'started',
  'accepted',
  'duplicate',
  'published',
  'retry',
  'failed',
  'completed',
  'aborted',
  'disabled',
  'stopped',
]);
const routes = new Set([
  'unmatched',
  '/health',
  '/webhooks/github',
  '/github',
  '/github/callback',
  '/me',
  '/logout',
  '/onboarding',
  '/onboarding/workspace',
  '/tenants/:tenantId/membership',
  '/tenants/:tenantId/usage',
  '/tenants/:tenantId/runs{/:runId}',
  '/tenants/:tenantId/runs/:runId/configuration',
  '/tenants/:tenantId/runs/:runId/rerun',
]);
export function newTrace(): Required<Trace> {
  return {
    requestId: randomUUID(),
    traceId: randomBytes(16).toString('hex'),
    spanId: randomBytes(8).toString('hex'),
  };
}
export function withTrace<T>(trace: Trace, work: () => T): T {
  return storage.run({ ...trace }, work);
}
export function runTrace(runId: string): Trace {
  if (!uuid.test(runId))
    return { ...storage.getStore(), spanId: randomBytes(8).toString('hex') };
  return {
    ...storage.getStore(),
    traceId: createHash('sha256')
      .update('dogwatch-run:' + runId)
      .digest('hex')
      .slice(0, 32),
    spanId: randomBytes(8).toString('hex'),
  };
}
let dropped = 0;
let stdoutGuarded = false;
export function protectLogger(log: Logger): Logger {
  return (event, outcome, fields) => {
    try {
      log(event, outcome, fields);
    } catch {
      dropped++;
    }
  };
}
/** Process-local diagnostic counter, also exposed by the optional metrics endpoint. */
export function droppedLogCount() {
  return dropped;
}
export function createLogger(
  service: Service,
  sink?: (line: string) => void,
): Logger {
  if (!sink && !stdoutGuarded) {
    stdoutGuarded = true;
    process.stdout.on('error', () => {
      dropped++;
    });
  }
  const destination =
    sink ??
    ((line: string) => {
      if (process.stdout.destroyed || process.stdout.writableLength > 65536) {
        dropped++;
        return;
      }
      process.stdout.write(line);
    });
  return (event, outcome, fields = {}) => {
    try {
      if (
        !['api', 'dispatcher', 'queue'].includes(service) ||
        !events.has(event) ||
        !outcomes.has(outcome)
      ) {
        dropped++;
        return;
      }
      const input = { ...storage.getStore(), ...fields };
      const record: Record<string, string | number> = {
        version: 1,
        timestamp: new Date().toISOString(),
        service,
        event,
        outcome,
        level:
          outcome === 'failed'
            ? 'error'
            : outcome === 'retry' || outcome === 'aborted'
              ? 'warn'
              : 'info',
      };
      for (const key of [
        'requestId',
        'tenantId',
        'runId',
        'outboxId',
        'jobId',
        'deliveryId',
      ] as const)
        if (typeof input[key] === 'string' && uuid.test(input[key]))
          record[key] = input[key];
      for (const [key, pattern] of [
        ['traceId', /^[a-f0-9]{32}$/],
        ['spanId', /^[a-f0-9]{16}$/],
        ['headSha', /^[a-f0-9]{40}$/],
      ] as const)
        if (typeof input[key] === 'string' && pattern.test(input[key]))
          record[key] = input[key];
      if (
        input.method &&
        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(
          input.method,
        )
      )
        record.method = input.method;
      if (input.route)
        record.route = routes.has(input.route) ? input.route : 'unmatched';
      if (
        Number.isInteger(input.statusCode) &&
        input.statusCode! >= 100 &&
        input.statusCode! <= 599
      )
        record.statusCode = input.statusCode!;
      if (
        Number.isFinite(input.durationMs) &&
        input.durationMs! >= 0 &&
        input.durationMs! <= 86400000
      )
        record.durationMs = Math.round(input.durationMs!);
      if (
        Number.isSafeInteger(input.attempt) &&
        input.attempt! >= 0 &&
        input.attempt! <= 1000000
      )
        record.attempt = input.attempt!;
      observe(record);
      destination(JSON.stringify(record) + '\n');
    } catch {
      dropped++;
    }
  };
}
