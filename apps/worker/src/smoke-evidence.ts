/** Validated smoke records: no source, input values, DOM or raw browser diagnostics. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { runSmoke, smokePlanSchema } from './smoke.js';
import type { SmokeDriver, SmokePlan } from './smoke.js';
const uuid = z.uuid();
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const outcome = z.enum(['passed', 'failed', 'skipped', 'inconclusive']);
const code = z.enum([
  'ok',
  'navigation_failed',
  'interaction_failed',
  'assertion_failed',
  'browser_errors',
  'dependency_failed',
  'smoke_stale',
  'smoke_step_budget',
  'smoke_destination_blocked',
  'smoke_cancelled',
  'smoke_timeout',
  'smoke_driver_unavailable',
  'smoke_context_unavailable',
]);
const events = z.strictObject({
  consoleErrors: z.number().int().min(0).max(100000),
  pageErrors: z.number().int().min(0).max(100000),
  serverErrors: z.number().int().min(0).max(100000),
  networkErrors: z.number().int().min(0).max(100000),
  blockedRequests: z.number().int().min(0).max(100000),
});
const traceEntry = z.strictObject({
  id,
  outcome,
  code,
  stepsCompleted: z.number().int().min(0).max(50),
  events,
  stepKinds: z
    .array(z.enum(['navigate', 'fill', 'select', 'click', 'visible', 'text']))
    .min(1)
    .max(50),
});
export const smokeEvidenceSchema = z
  .strictObject({
    version: z.literal(1),
    tenantId: uuid,
    runId: uuid,
    repositoryId: z.number().int().positive().safe(),
    sha,
    role: z.enum(['base', 'head']),
    scenarioId: id,
    compatibilityDigest: digest,
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    outcome: z.enum(['passed', 'failed', 'inconclusive']),
    code: z.enum([
      'smoke_finished',
      'smoke_cleanup_failed',
      'smoke_stale',
      'smoke_step_budget',
      'smoke_destination_blocked',
      'smoke_cancelled',
      'smoke_timeout',
      'smoke_driver_unavailable',
      'smoke_context_unavailable',
    ]),
    executionMs: z.number().int().min(0),
    stepsAttempted: z.number().int().min(0).max(200),
    trace: z.array(traceEntry).min(1).max(20),
    screenshot: z.discriminatedUnion('status', [
      z.strictObject({
        status: z.literal('captured'),
        policy: z.literal('synthetic_fixture_masked'),
        pngBase64: z.string().max(1398104),
        sha256: digest,
      }),
      z.strictObject({ status: z.literal('unavailable') }),
    ]),
  })
  .superRefine((record, context) => {
    const fail = () =>
      context.addIssue({
        code: 'custom',
        message: 'Inconsistent smoke evidence',
      });
    if (new Set(record.trace.map((row) => row.id)).size !== record.trace.length)
      fail();
    if (
      Date.parse(record.expiresAt) <= Date.parse(record.createdAt) ||
      Date.parse(record.expiresAt) - Date.parse(record.createdAt) > 7 * 86400000
    )
      fail();
    for (const row of record.trace) {
      if (row.stepsCompleted > row.stepKinds.length) fail();
      const failures =
        row.events.consoleErrors +
        row.events.pageErrors +
        row.events.serverErrors +
        row.events.networkErrors;
      if (
        row.outcome === 'passed' &&
        (row.code !== 'ok' || failures || row.events.blockedRequests)
      )
        fail();
      if (
        row.outcome === 'failed' &&
        (![
          'navigation_failed',
          'interaction_failed',
          'assertion_failed',
          'browser_errors',
        ].includes(row.code) ||
          row.events.blockedRequests)
      )
        fail();
      if (
        row.outcome === 'failed' &&
        row.code === 'browser_errors' &&
        !failures
      )
        fail();
    }
    if (
      record.outcome === 'passed' &&
      (record.code !== 'smoke_finished' ||
        record.trace.some((row) => row.outcome !== 'passed'))
    )
      fail();
    if (
      record.outcome === 'failed' &&
      !record.trace.some((row) => row.outcome === 'failed')
    )
      fail();
    if (record.screenshot.status === 'captured') {
      const png = Buffer.from(record.screenshot.pngBase64, 'base64');
      if (
        png.length > 1048576 ||
        png.toString('base64') !== record.screenshot.pngBase64 ||
        !png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
        createHash('sha256').update(png).digest('hex') !==
          record.screenshot.sha256
      )
        fail();
    }
  });
export type SmokeEvidence = z.infer<typeof smokeEvidenceSchema>;
export type EvidenceSmokeDriver = SmokeDriver & {
  /** Only trusted synthetic fixture drivers may provide this capture policy. */
  captureScreenshot?: () => Promise<Buffer>;
};
export function smokeCompatibilityDigest(
  planInput: SmokePlan,
  scenarioIdInput: string,
) {
  const plan = smokePlanSchema.parse(planInput);
  return createHash('sha256')
    .update(
      JSON.stringify({
        executor: 'smoke-v1',
        scenarioId: id.parse(scenarioIdInput),
        maxExecutionMs: plan.maxExecutionMs,
        maxSteps: plan.maxSteps,
        journeys: plan.journeys,
      }),
    )
    .digest('hex');
}

/** Setup occurs before this call; screenshot capture shares the existing cleanup deadline. */
export async function runSmokeWithEvidence(
  plan: SmokePlan,
  driver: EvidenceSmokeDriver,
  options: Parameters<typeof runSmoke>[2] & {
    role: 'base' | 'head';
    scenarioId: string;
  },
) {
  plan = smokePlanSchema.parse(plan);
  const compatibilityDigest = smokeCompatibilityDigest(
    plan,
    options.scenarioId,
  );
  const role = z.enum(['base', 'head']).parse(options.role);
  let screenshot: SmokeEvidence['screenshot'] = { status: 'unavailable' };
  let captureOpen = true;
  const result = await runSmoke(
    plan,
    {
      execute: (step, timeout) => driver.execute(step, timeout),
      events: () => driver.events(),
      close: async () => {
        try {
          if (driver.captureScreenshot) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              const png = await Promise.race([
                driver.captureScreenshot(),
                new Promise<never>((_resolve, reject) => {
                  timer = setTimeout(
                    () => reject(new Error('evidence_capture_timeout')),
                    750,
                  );
                }),
              ]);
              if (
                captureOpen &&
                png.length <= 1048576 &&
                png
                  .subarray(0, 8)
                  .equals(Buffer.from('89504e470d0a1a0a', 'hex'))
              )
                screenshot = {
                  status: 'captured',
                  policy: 'synthetic_fixture_masked',
                  pngBase64: png.toString('base64'),
                  sha256: createHash('sha256').update(png).digest('hex'),
                };
            } catch {
              /* Missing capture never fabricates visual evidence. */
            } finally {
              if (timer) clearTimeout(timer);
            }
          }
        } finally {
          await driver.close();
        }
      },
    },
    options,
  );
  captureOpen = false;
  const createdAt = new Date();
  return smokeEvidenceSchema.parse({
    version: 1,
    tenantId: result.tenantId,
    runId: result.runId,
    repositoryId: result.repositoryId,
    sha: result.headSha,
    role,
    scenarioId: options.scenarioId,
    compatibilityDigest,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + 7 * 86400000).toISOString(),
    outcome: result.outcome,
    code: result.code,
    executionMs: result.executionMs,
    stepsAttempted: result.stepsAttempted,
    trace: result.journeys.map((row, index) => ({
      ...row,
      stepKinds: plan.journeys[index].steps.map((step) => step.kind),
    })),
    screenshot,
  });
}

export const comparisonContextSchema = z.strictObject({
  tenantId: uuid,
  runId: uuid,
  repositoryId: z.number().int().positive().safe(),
  baseSha: sha,
  headSha: sha,
});
function signature(row: SmokeEvidence['trace'][number]) {
  // Error categories identify the same configured failing observation, not root cause.
  return JSON.stringify([
    row.code,
    row.stepsCompleted,
    Object.values(row.events).map((value) => value > 0),
  ]);
}
export function compareSmokeEvidence(
  contextInput: z.infer<typeof comparisonContextSchema>,
  headInput: SmokeEvidence,
  baseInput?: SmokeEvidence,
) {
  const context = comparisonContextSchema.parse(contextInput);
  const head = smokeEvidenceSchema.parse(headInput);
  const base =
    baseInput === undefined ? undefined : smokeEvidenceSchema.parse(baseInput);
  for (const [record, role, expectedSha] of [
    [head, 'head', context.headSha],
    [base, 'base', context.baseSha],
  ] as const) {
    if (
      record &&
      (record.role !== role ||
        record.sha !== expectedSha ||
        record.tenantId !== context.tenantId ||
        record.runId !== context.runId ||
        record.repositoryId !== context.repositoryId)
    )
      throw new Error('smoke_baseline_scope_mismatch');
  }
  const now = Date.now();
  const validHead =
    Date.parse(head.createdAt) <= now &&
    Date.parse(head.expiresAt) > now &&
    head.code === 'smoke_finished' &&
    head.outcome !== 'inconclusive';
  const compatible =
    base &&
    base.scenarioId === head.scenarioId &&
    base.compatibilityDigest === head.compatibilityDigest &&
    Date.parse(base.createdAt) <= now &&
    Date.parse(base.expiresAt) > now &&
    base.code === 'smoke_finished' &&
    base.outcome !== 'inconclusive' &&
    JSON.stringify(base.trace.map((row) => [row.id, row.stepKinds])) ===
      JSON.stringify(head.trace.map((row) => [row.id, row.stepKinds]));
  return {
    ...context,
    journeys: head.trace.map((row) => {
      let baseline:
        | 'no_failure'
        | 'new_regression'
        | 'pre_existing'
        | 'unavailable'
        | 'inconclusive';
      if (
        !validHead ||
        row.outcome === 'inconclusive' ||
        row.outcome === 'skipped'
      )
        baseline = 'inconclusive';
      else if (row.outcome === 'passed') baseline = 'no_failure';
      else if (!base) baseline = 'unavailable';
      else if (!compatible) baseline = 'inconclusive';
      else {
        const previous = base.trace.find((before) => before.id === row.id)!;
        baseline =
          previous.outcome === 'passed'
            ? 'new_regression'
            : previous.outcome === 'failed' &&
                row.code !== 'browser_errors' &&
                signature(previous) === signature(row)
              ? 'pre_existing'
              : 'inconclusive';
      }
      return { id: row.id, outcome: row.outcome, baseline };
    }),
    baselineAvailable: Boolean(compatible && validHead),
    evidence: {
      headSha: head.sha,
      baseSha: base?.sha,
      screenshotAvailable: head.screenshot.status === 'captured',
    },
  };
}
