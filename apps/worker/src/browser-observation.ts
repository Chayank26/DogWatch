/** Private, untrusted observations. This module grants no browser action authority. */
import { z } from 'zod';
import { scopeSchema } from './api-execution.js';
import { bounded } from './api-runtime.js';
const limitsSchema = z.strictObject({
  maxObservations: z.number().int().min(1).max(100).default(20),
  maxEvents: z.number().int().min(1).max(1000).default(200),
  maxSnapshotBytes: z.number().int().min(1).max(65536).default(16384),
  maxScreenshotBytes: z.number().int().min(1).max(1048576).default(524288),
  captureMs: z.number().int().min(1).max(5000).default(1000),
});
const diagnosticSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.enum(['console_error', 'page_exception', 'request_failed']),
  }),
  z.strictObject({
    kind: z.literal('http_error'),
    status: z.number().int().min(400).max(599),
  }),
]);
export type BrowserDiagnostic = z.infer<typeof diagnosticSchema>;
export interface ObservationSource {
  snapshot(timeoutMs: number): Promise<string>;
  screenshot(timeoutMs: number): Promise<Buffer>;
  subscribe(listener: (event: BrowserDiagnostic) => void): () => void;
}
/** Sources belong to the trusted browser supervisor, never the page or model. */
export function createBrowserObserver(
  scopeInput: z.input<typeof scopeSchema>,
  source: ObservationSource,
  options: {
    isCurrent: () => Promise<boolean>;
    signal?: AbortSignal;
    limits?: z.input<typeof limitsSchema>;
  },
) {
  const scope = scopeSchema.parse(scopeInput);
  const limits = limitsSchema.parse(options.limits ?? {});
  const isCurrent = options.isCurrent;
  const parentSignal = options.signal;
  const started = performance.now();
  const elapsed = () => Math.max(0, Math.floor(performance.now() - started));
  const events: Array<
    BrowserDiagnostic & {
      sequence: number;
      elapsedMs: number;
      actionId: string | null;
    }
  > = [];
  let droppedEvents = 0,
    sequence = 0,
    observations = 0,
    busy = false,
    closed = false;
  let actionId: string | null = null;
  const unsubscribe = source.subscribe((event) => {
    if (closed) return;
    const parsed = diagnosticSchema.safeParse(event);
    if (!parsed.success) return;
    if (events.length >= limits.maxEvents) {
      droppedEvents = Math.min(Number.MAX_SAFE_INTEGER, droppedEvents + 1);
      return;
    }
    events.push({
      ...parsed.data,
      sequence: ++sequence,
      elapsedMs: elapsed(),
      actionId,
    });
  });
  let detached = false;
  const detach = () => {
    if (!detached) {
      detached = true;
      unsubscribe();
    }
  };
  return {
    /** Correlation only: delayed browser events may outlive the originating action. */
    markAction(value: string | null) {
      if (closed || busy) throw Error('observer_unavailable');
      actionId = z
        .string()
        .regex(/^[a-zA-Z0-9_-]{1,100}$/)
        .nullable()
        .parse(value);
    },
    close() {
      if (!closed) {
        closed = true;
        detach();
      }
    },
    async observe() {
      if (closed || busy || observations >= limits.maxObservations)
        throw Error('observation_unavailable');
      busy = true;
      observations++;
      const controller = new AbortController();
      const signal = parentSignal
        ? AbortSignal.any([parentSignal, controller.signal])
        : controller.signal;
      const timer = setTimeout(() => controller.abort(), limits.captureMs);
      const startedMs = elapsed();
      let snapshot: string | undefined, screenshot: Buffer | undefined;
      const gaps: string[] = [];
      try {
        signal.throwIfAborted();
        if (!(await bounded(isCurrent(), signal)) || closed)
          throw Error('stopped');
        try {
          const text = await bounded(source.snapshot(limits.captureMs), signal);
          if (Buffer.byteLength(text, 'utf8') > limits.maxSnapshotBytes)
            gaps.push('snapshot_size');
          else snapshot = text;
        } catch {
          gaps.push('snapshot_unavailable');
        }
        signal.throwIfAborted();
        try {
          const bytes = await bounded(
            source.screenshot(limits.captureMs),
            signal,
          );
          if (bytes.length > limits.maxScreenshotBytes)
            gaps.push('screenshot_size');
          else if (
            !bytes
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          )
            gaps.push('screenshot_invalid');
          else screenshot = Buffer.from(bytes);
        } catch {
          gaps.push('screenshot_unavailable');
        }
        signal.throwIfAborted();
        if (!(await bounded(isCurrent(), signal)) || closed)
          throw Error('stopped');
      } catch {
        // Never release captures after loss of authority, cancellation or deadline.
        snapshot = undefined;
        screenshot = undefined;
        gaps.push('observation_stopped');
        closed = true;
        detach();
      } finally {
        clearTimeout(timer);
        busy = false;
      }
      if (droppedEvents) gaps.push('diagnostics_truncated');
      return {
        version: 1 as const,
        ...scope,
        observationId: observations,
        audience: 'private_synthetic_fixture' as const,
        untrusted: true as const,
        actionId,
        startedMs,
        finishedMs: elapsed(),
        status: gaps.length ? ('inconclusive' as const) : ('captured' as const),
        snapshot,
        screenshot,
        events: events.map((event) => ({ ...event })),
        droppedEvents,
        gaps,
      };
    },
  };
}
