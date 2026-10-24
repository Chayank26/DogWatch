/** Repeated, compatible synthetic predicate observations; no PR attribution. */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { scopeSchema } from './api-execution.js';
import { browserPolicySchema } from './browser-actions.js';
import { chaosScriptSchema } from './browser-chaos.js';
import { runFixtureChaos } from './browser-chaos-runner.js';
import type { ApiLifecycleProvider, ApiNamespace } from './api-lifecycle.js';
import { bounded } from './api-runtime.js';
import { stable } from './boundary-values.js';
import { BrowserBudget } from './browser-budget.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const namespaceSchema = scopeSchema.extend({
  deploymentId: z.string().min(1).max(200),
  origin: z.string().url(),
  namespaceId: z.uuid(),
});
const preparedSchema = namespaceSchema.extend({
  fixtureDigest: digest,
  datasetDigest: digest,
  identityDigest: digest,
});
const emptySchema = namespaceSchema.extend({ empty: z.boolean() });
const assertionSchema = z
  .strictObject({
    failureText: z.string().min(1).max(200),
    successText: z.string().min(1).max(200),
  })
  .refine(
    (value) =>
      !value.failureText.includes(value.successText) &&
      !value.successText.includes(value.failureText),
  );
const hash = (value: unknown) =>
  createHash('sha256').update(stable(value)).digest('hex');
const equalScope = (value: ApiNamespace, expected: ApiNamespace) =>
  Object.entries(expected).every(
    ([key, item]) => value[key as keyof ApiNamespace] === item,
  );
export function classifyReplay(
  outcomes: readonly ('failure' | 'success' | 'inconclusive')[],
) {
  if (outcomes.length < 2 || outcomes.includes('inconclusive'))
    return 'inconclusive' as const;
  if (outcomes.every((value) => value === 'failure'))
    return 'reproduced' as const;
  if (outcomes.every((value) => value === 'success'))
    return 'not_reproduced' as const;
  return 'unstable' as const;
}
export async function replayFixtureFailure(
  input: {
    scope: unknown;
    policy: unknown;
    script: unknown;
    deploymentId: string;
    assertion: unknown;
    attempts?: number;
    executionMs?: number;
  },
  options: {
    lifecycle: ApiLifecycleProvider;
    isCurrent: () => Promise<boolean>;
    signal?: AbortSignal;
  },
) {
  const scope = scopeSchema.parse(input.scope),
    policy = browserPolicySchema.parse(input.policy),
    script = chaosScriptSchema.parse(input.script),
    assertion = assertionSchema.parse(input.assertion);
  const attempts = z
    .number()
    .int()
    .min(2)
    .max(3)
    .parse(input.attempts ?? 2);
  const executionMs = z
    .number()
    .int()
    .min(1)
    .max(120000)
    .parse(input.executionMs ?? 60000);
  const deploymentId = z.string().min(1).max(200).parse(input.deploymentId);
  if (
    Object.entries(scope).some(
      ([key, value]) => policy[key as keyof typeof scope] !== value,
    ) ||
    !policy.disposableData
  )
    throw Error('replay_scope');
  const configurationDigest = hash({
    version: 1,
    scope,
    policy,
    script,
    assertion,
    deploymentId,
  });
  const budget = new BrowserBudget(scope, {
    maxCalls: 0,
    maxTokens: 0,
    maxActions: 60,
    maxRequests: 200,
    maxCostMicros: 0,
    costPerCallMicros: 1,
    maxExecutionMs: executionMs,
  });
  const provider = options.lifecycle;
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(() => controller.abort(), executionMs);
  const rows: Array<{
    namespaceId: string;
    outcome: 'failure' | 'success' | 'inconclusive';
    code: string;
    cleanup: 'not_needed' | 'verified' | 'unverified';
    screenshotDigest?: string;
  }> = [];
  let stateDigest: string | undefined;
  try {
    for (let index = 0; index < attempts; index++) {
      const namespace: ApiNamespace = {
        ...scope,
        deploymentId,
        origin: policy.origin,
        namespaceId: randomUUID(),
      };
      const row: (typeof rows)[number] = {
        namespaceId: namespace.namespaceId,
        outcome: 'inconclusive',
        code: 'attempt_unavailable',
        cleanup: 'not_needed',
      };
      rows.push(row);
      let started = false,
        settled = false;
      const setup = new AbortController();
      const setupTimer = setTimeout(() => setup.abort(), 2000);
      const setupSignal = AbortSignal.any([signal, setup.signal]);
      try {
        setupSignal.throwIfAborted();
        if (!(await bounded(options.isCurrent(), setupSignal)))
          throw Error('stale');
        setupSignal.throwIfAborted();
        started = true;
        const pending = Promise.resolve().then(() =>
          provider.prepare({ ...namespace }, setupSignal),
        );
        void pending.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        const receipt = preparedSchema.parse(
          await bounded(pending, setupSignal),
        );
        if (!equalScope(receipt, namespace)) throw Error('scope');
        clearTimeout(setupTimer);
        const fingerprint = hash({
          fixture: receipt.fixtureDigest,
          dataset: receipt.datasetDigest,
          identity: receipt.identityDigest,
        });
        if (stateDigest && fingerprint !== stateDigest) {
          row.code = 'replay_incompatible';
        } else {
          stateDigest = fingerprint;
          const result = await runFixtureChaos(scope, policy, script, {
            isCurrent: options.isCurrent,
            signal,
            budget,
          });
          row.code = 'observation_incomplete';
          if (
            result.code === 'chaos_unconfirmed' &&
            result.cleanup === 'closed' &&
            result.capture?.status === 'captured' &&
            result.capture.snapshot !== undefined
          ) {
            signal.throwIfAborted();
            if (!(await bounded(options.isCurrent(), signal)))
              throw Error('stale');
            const failure = result.capture.snapshot.includes(
                assertion.failureText,
              ),
              success = result.capture.snapshot.includes(assertion.successText);
            if (failure !== success) {
              row.outcome = failure ? 'failure' : 'success';
              row.code = failure
                ? 'failure_predicate_observed'
                : 'success_predicate_observed';
            } else row.code = 'assertion_ambiguous';
            if (result.capture.screenshot)
              row.screenshotDigest = createHash('sha256')
                .update(result.capture.screenshot)
                .digest('hex');
          }
        }
      } catch {
        row.outcome = 'inconclusive';
        row.code = signal.aborted ? 'replay_stopped' : 'attempt_unavailable';
      } finally {
        clearTimeout(setupTimer);
        setup.abort();
        if (started) {
          row.cleanup = 'unverified';
          const cleanup = new AbortController();
          const cleanupTimer = setTimeout(() => cleanup.abort(), 2000);
          try {
            if (
              await bounded(
                provider.canCleanup({ ...namespace }, cleanup.signal),
                cleanup.signal,
              )
            ) {
              await bounded(
                provider.cleanup({ ...namespace }, cleanup.signal),
                cleanup.signal,
              );
              const receipt = emptySchema.parse(
                await bounded(
                  provider.verifyEmpty({ ...namespace }, cleanup.signal),
                  cleanup.signal,
                ),
              );
              if (equalScope(receipt, namespace) && receipt.empty && settled)
                row.cleanup = 'verified';
            }
          } catch {
            row.cleanup = 'unverified';
          } finally {
            clearTimeout(cleanupTimer);
            cleanup.abort();
          }
          if (row.cleanup !== 'verified') {
            row.outcome = 'inconclusive';
            row.code = 'cleanup_unverified';
          }
        }
      }
      if (row.outcome !== 'inconclusive') {
        try {
          signal.throwIfAborted();
          if (!(await bounded(options.isCurrent(), signal)))
            throw Error('stale');
        } catch {
          row.outcome = 'inconclusive';
          row.code = 'replay_stopped';
        }
      }
      if (row.outcome === 'inconclusive') break;
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return {
    version: 1,
    ...scope,
    configurationDigest,
    stateDigest,
    classification:
      rows.length === attempts
        ? classifyReplay(rows.map((row) => row.outcome))
        : 'inconclusive',
    attribution: 'unavailable' as const,
    attempts: rows,
    budget: budget.snapshot(),
  };
}
