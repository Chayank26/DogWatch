/** Bounded smoke orchestration; drivers own isolated browser/network enforcement. */
import { z } from 'zod';
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const locator = z.string().min(1).max(200);
const stepSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('navigate'),
    path: z
      .string()
      .min(1)
      .max(2048)
      .refine(
        (path) =>
          path.startsWith('/') &&
          !path.startsWith('//') &&
          !/[?#\\\s]/.test(path) &&
          [...path].every((c) => c.charCodeAt(0) >= 32) &&
          !path.split('/').some((p) => p === '.' || p === '..'),
      ),
  }),
  z.strictObject({ kind: z.literal('fill'), selector: locator, valueRef: id }),
  z.strictObject({
    kind: z.literal('select'),
    selector: locator,
    valueRef: id,
  }),
  z.strictObject({ kind: z.literal('click'), selector: locator }),
  z.strictObject({ kind: z.literal('visible'), selector: locator }),
  z.strictObject({
    kind: z.literal('text'),
    selector: locator,
    expected: z.string().min(1).max(500),
  }),
]);
export const smokePlanSchema = z.strictObject({
  tenantId: z.uuid(),
  runId: z.uuid(),
  repositoryId: z.number().int().positive().safe(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  maxExecutionMs: z.number().int().min(1).max(20000).default(20000),
  maxSteps: z.number().int().min(1).max(200).default(30),
  journeys: z
    .array(
      z.strictObject({
        id,
        dependsOn: z.array(id).max(20).default([]),
        steps: z.array(stepSchema).min(1).max(50),
      }),
    )
    .min(1)
    .max(20),
});
export type SmokePlan = z.infer<typeof smokePlanSchema>;
export type SmokeStep = z.infer<typeof stepSchema>;
export type SmokeEvents = {
  consoleErrors: number;
  pageErrors: number;
  serverErrors: number;
  networkErrors: number;
  blockedRequests: number;
};
export interface SmokeDriver {
  execute(step: SmokeStep, timeoutMs: number): Promise<void>;
  events(): SmokeEvents;
  close(): Promise<void>;
}
export class SmokeStepError extends Error {
  constructor(
    readonly code:
      'navigation_failed' | 'interaction_failed' | 'assertion_failed',
  ) {
    super(code);
  }
}
export interface SmokeJourneyResult {
  id: string;
  outcome: 'passed' | 'failed' | 'skipped' | 'inconclusive';
  code: string;
  stepsCompleted: number;
  events: SmokeEvents;
}
const emptyEvents = (): SmokeEvents => ({
  consoleErrors: 0,
  pageErrors: 0,
  serverErrors: 0,
  networkErrors: 0,
  blockedRequests: 0,
});
function counters(driver: SmokeDriver): SmokeEvents {
  return z
    .strictObject({
      consoleErrors: z.number().int().min(0).max(100000),
      pageErrors: z.number().int().min(0).max(100000),
      serverErrors: z.number().int().min(0).max(100000),
      networkErrors: z.number().int().min(0).max(100000),
      blockedRequests: z.number().int().min(0).max(100000),
    })
    .parse(driver.events());
}
function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('smoke_stopped'));
    if (signal.aborted) reject(new Error('smoke_stopped'));
    else signal.addEventListener('abort', abort, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Caller must supply current authority and a prepared, credential-scoped driver. */
export async function runSmoke(
  planInput: SmokePlan,
  driver: SmokeDriver,
  options: {
    signal?: AbortSignal;
    isCurrent: () => Promise<boolean>;
  },
) {
  const plan = smokePlanSchema.parse(planInput);
  const seen = new Set<string>();
  for (const journey of plan.journeys) {
    if (
      seen.has(journey.id) ||
      journey.dependsOn.some((dependency) => !seen.has(dependency))
    )
      throw new Error('smoke_invalid_dependencies');
    seen.add(journey.id);
  }
  const start = Date.now();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), plan.maxExecutionMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  const results: SmokeJourneyResult[] = [];
  let steps = 0;
  let stopped: string | undefined;
  let cleanupFailed = false;
  let executionMs: number;
  try {
    for (const journey of plan.journeys) {
      if (
        stopped ||
        journey.dependsOn.some(
          (dependency) =>
            results.find((result) => result.id === dependency)?.outcome !==
            'passed',
        )
      ) {
        results.push({
          id: journey.id,
          outcome: 'skipped',
          code: stopped ?? 'dependency_failed',
          stepsCompleted: 0,
          events: emptyEvents(),
        });
        continue;
      }
      let completed = 0;
      let before = emptyEvents();
      try {
        before = counters(driver);
        for (const step of journey.steps) {
          if (!(await bounded(options.isCurrent(), signal))) {
            stopped = 'smoke_stale';
            throw new Error(stopped);
          }
          if (steps >= plan.maxSteps) {
            stopped = 'smoke_step_budget';
            throw new Error(stopped);
          }
          steps++;
          await bounded(
            driver.execute(
              step,
              Math.max(
                1,
                Math.min(2000, plan.maxExecutionMs - (Date.now() - start)),
              ),
            ),
            signal,
          );
          completed++;
        }
        if (!(await bounded(options.isCurrent(), signal))) {
          stopped = 'smoke_stale';
          throw new Error(stopped);
        }
        const after = counters(driver);
        const events = Object.fromEntries(
          Object.entries(after).map(([key, value]) => [
            key,
            Math.max(0, value - before[key as keyof SmokeEvents]),
          ]),
        ) as SmokeEvents;
        const failed =
          events.consoleErrors +
            events.pageErrors +
            events.serverErrors +
            events.networkErrors >
          0;
        if (events.blockedRequests) stopped = 'smoke_destination_blocked';
        results.push({
          id: journey.id,
          outcome: events.blockedRequests
            ? 'inconclusive'
            : failed
              ? 'failed'
              : 'passed',
          code: events.blockedRequests
            ? stopped!
            : failed
              ? 'browser_errors'
              : 'ok',
          stepsCompleted: completed,
          events,
        });
      } catch (error) {
        if (signal.aborted)
          stopped = options.signal?.aborted
            ? 'smoke_cancelled'
            : 'smoke_timeout';
        let events = emptyEvents();
        try {
          const after = counters(driver);
          events = Object.fromEntries(
            Object.entries(after).map(([key, value]) => [
              key,
              Math.max(0, value - before[key as keyof SmokeEvents]),
            ]),
          ) as SmokeEvents;
        } catch {
          stopped = 'smoke_driver_unavailable';
        }
        if (events.blockedRequests) stopped = 'smoke_destination_blocked';
        const applicationFailure = !stopped && error instanceof SmokeStepError;
        if (!applicationFailure && !stopped)
          stopped = 'smoke_context_unavailable';
        results.push({
          id: journey.id,
          outcome: applicationFailure ? 'failed' : 'inconclusive',
          code: applicationFailure ? (error as SmokeStepError).code : stopped!,
          stepsCompleted: completed,
          events,
        });
      }
    }
  } finally {
    executionMs = Date.now() - start;
    clearTimeout(timer);
    const cleanup = new AbortController();
    const cleanupTimer = setTimeout(() => cleanup.abort(), 3000);
    try {
      await bounded(driver.close(), cleanup.signal);
    } catch {
      cleanupFailed = true;
    } finally {
      clearTimeout(cleanupTimer);
    }
  }
  return {
    tenantId: plan.tenantId,
    runId: plan.runId,
    repositoryId: plan.repositoryId,
    headSha: plan.headSha,
    outcome: cleanupFailed
      ? 'inconclusive'
      : results.some((result) => result.outcome === 'failed')
        ? 'failed'
        : results.every((result) => result.outcome === 'passed')
          ? 'passed'
          : 'inconclusive',
    code: cleanupFailed
      ? 'smoke_cleanup_failed'
      : (stopped ?? 'smoke_finished'),
    executionMs,
    stepsAttempted: steps,
    baseline: 'unavailable',
    journeys: results,
  };
}
