/** Scoped disposable-state lifecycle and metadata-only deterministic replay. */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  scopeSchema,
  grantSchema,
  limitsSchema,
  validateApiExecutionContext,
  executeApiCases,
  executeApiAuthentication,
} from './api-execution.js';
import type {
  ApiExecutionInput,
  ApiExecutionOptions,
  ApiExecution,
} from './api-execution.js';
import { executeApiAuthorization } from './api-authorization.js';
import type { AuthorizationExecution } from './api-authorization.js';
import { previewBindingSchema } from './preview.js';
import { boundaryOptionsSchema } from './boundary-cases.js';
import { validateApiContract } from './openapi.js';
import { bounded } from './api-runtime.js';
import { stable } from './boundary-values.js';
const hash = (value: unknown) =>
  createHash('sha256').update(stable(value)).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const stageSchema = z.enum(['boundary', 'authentication', 'authorization']);
const namespaceSchema = scopeSchema.extend({
  deploymentId: z.string().min(1).max(200),
  origin: z.string().url(),
  namespaceId: z.uuid(),
});
export type ApiNamespace = z.infer<typeof namespaceSchema>;
const fingerprintsSchema = z.strictObject({
  fixtureDigest: digest,
  datasetDigest: digest,
  identityDigest: digest,
});
const preparedSchema = namespaceSchema.extend(fingerprintsSchema.shape);
const emptySchema = namespaceSchema.extend({ empty: z.boolean() });
export interface ApiLifecycleProvider {
  /** Must fence this namespace on abort so a late setup cannot create untracked state. */
  prepare: (
    context: ApiNamespace,
    signal: AbortSignal,
  ) => Promise<z.infer<typeof preparedSchema>>;
  canCleanup: (context: ApiNamespace, signal: AbortSignal) => Promise<boolean>;
  cleanup: (context: ApiNamespace, signal: AbortSignal) => Promise<void>;
  verifyEmpty: (
    context: ApiNamespace,
    signal: AbortSignal,
  ) => Promise<z.infer<typeof emptySchema>>;
}
export const apiReplaySchema = z.strictObject({
  version: z.literal(1),
  stage: stageSchema,
  configurationDigest: digest,
  contractDigest: digest,
  ...fingerprintsSchema.shape,
  outcomeDigest: digest,
});
export type ApiReplay = z.infer<typeof apiReplaySchema>;
export interface ApiLifecycleResult {
  version: 1;
  namespace: ApiNamespace;
  status: 'completed' | 'inconclusive';
  code: string;
  cleanup: { status: 'not_needed' | 'verified' | 'unverified'; code: string };
  replay: {
    status:
      | 'not_requested'
      | 'matched'
      | 'different'
      | 'incompatible'
      | 'unavailable';
  };
  execution?: ApiExecution | AuthorizationExecution;
  capsule?: ApiReplay;
}
function sameNamespace(actual: ApiNamespace, expected: ApiNamespace) {
  return Object.entries(expected).every(
    ([key, value]) => actual[key as keyof ApiNamespace] === value,
  );
}
/** Outcome identity deliberately excludes run-specific probe IDs, tokens, raw inputs and usage. */
function outcome(execution: ApiExecution | AuthorizationExecution) {
  return hash({
    status: execution.status,
    code: execution.code,
    results: execution.results.map((row) => ({
      operationKey: row.operationKey,
      status: row.status,
      code: row.code,
      httpStatus: row.httpStatus ?? null,
      probe: 'probe' in row ? (row.probe ?? null) : null,
      scenarioId: 'scenarioId' in row ? row.scenarioId : null,
      step: 'step' in row ? row.step : null,
      evidenceMatched:
        'evidenceMatched' in row ? (row.evidenceMatched ?? null) : null,
    })),
    gaps: 'coverageGaps' in execution ? execution.coverageGaps : [],
  });
}
export async function runApiLifecycle(
  input: ApiExecutionInput,
  options: ApiExecutionOptions & {
    stage: z.infer<typeof stageSchema>;
    lifecycle: ApiLifecycleProvider;
    getIdentity?: Parameters<typeof executeApiAuthorization>[1]['getIdentity'];
    setupMs?: number;
    cleanupMs?: number;
    replay?: ApiReplay;
  },
): Promise<ApiLifecycleResult> {
  const stage = stageSchema.parse(options.stage);
  const setupMs = z
    .number()
    .int()
    .min(1)
    .max(10000)
    .parse(options.setupMs ?? 2000);
  const cleanupMs = z
    .number()
    .int()
    .min(1)
    .max(10000)
    .parse(options.cleanupMs ?? 2000);
  const scope = scopeSchema.parse(input.scope),
    binding = previewBindingSchema.parse(input.binding),
    grant = grantSchema.parse(input.grant);
  const generation = boundaryOptionsSchema.parse(input.generation ?? {}),
    limits = limitsSchema.parse(input.limits ?? {});
  const contractText = input.contractText;
  const snapshot = { scope, binding, grant, generation, limits, contractText };
  const callbacks = { ...options };
  const provider: ApiLifecycleProvider = {
    prepare: options.lifecycle.prepare.bind(options.lifecycle),
    canCleanup: options.lifecycle.canCleanup.bind(options.lifecycle),
    cleanup: options.lifecycle.cleanup.bind(options.lifecycle),
    verifyEmpty: options.lifecycle.verifyEmpty.bind(options.lifecycle),
  };
  const expected =
    options.replay === undefined
      ? undefined
      : apiReplaySchema.parse(options.replay);
  const namespace: ApiNamespace = {
    ...scope,
    deploymentId: binding.deploymentId,
    origin: new URL(binding.url).origin,
    namespaceId: randomUUID(),
  };
  const result: ApiLifecycleResult = {
    version: 1,
    namespace,
    status: 'inconclusive',
    code: 'setup_unavailable',
    cleanup: { status: 'not_needed', code: 'setup_not_started' },
    replay: { status: expected ? 'unavailable' : 'not_requested' },
  };
  const contract = validateApiContract(
    {
      tenantId: scope.tenantId,
      repositoryId: scope.repositoryId,
      headSha: scope.headSha,
    },
    contractText,
  );
  // runId and attempt namespace differ on replay; all authority and test policy otherwise match.
  const configurationDigest = hash({
    version: 1,
    stage,
    scope: { ...scope, runId: null },
    binding,
    grant: { ...grant, runId: null },
    generation,
    limits,
    contractDigest: contract.contractDigest ?? null,
  });
  if (contract.status !== 'supported' || !contract.contractDigest) {
    result.code = 'contract_unavailable';
    return result;
  }
  try {
    validateApiExecutionContext(scope, binding, grant, callbacks.fixture);
  } catch {
    result.code = 'context_forbidden';
    return result;
  }
  if (stage === 'authorization' && !callbacks.getIdentity) {
    result.code = 'identity_provider_unavailable';
    return result;
  }
  if (
    expected &&
    (expected.stage !== stage ||
      expected.configurationDigest !== configurationDigest ||
      expected.contractDigest !== contract.contractDigest)
  ) {
    result.code = 'replay_incompatible';
    result.replay.status = 'incompatible';
    return result;
  }
  let attempted = false,
    settled = false,
    prepared: z.infer<typeof fingerprintsSchema> | undefined;
  const setupController = new AbortController();
  const setupTimer = setTimeout(() => setupController.abort(), setupMs);
  const setupSignal = callbacks.signal
    ? AbortSignal.any([callbacks.signal, setupController.signal])
    : setupController.signal;
  try {
    setupSignal.throwIfAborted();
    if (!(await bounded(callbacks.isCurrent(), setupSignal)))
      throw Error('stopped');
    setupSignal.throwIfAborted();
    attempted = true;
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
    const receipt = preparedSchema.parse(await bounded(pending, setupSignal));
    if (!sameNamespace(receipt, namespace)) throw Error('scope');
    prepared = fingerprintsSchema.parse({
      fixtureDigest: receipt.fixtureDigest,
      datasetDigest: receipt.datasetDigest,
      identityDigest: receipt.identityDigest,
    });
    if (
      expected &&
      Object.entries(prepared).some(
        ([key, value]) => expected[key as keyof ApiReplay] !== value,
      )
    ) {
      result.code = 'replay_incompatible';
      result.replay.status = 'incompatible';
    } else {
      clearTimeout(setupTimer);
      if (callbacks.signal?.aborted) throw Error('stopped');
      const execution =
        stage === 'boundary'
          ? await executeApiCases(snapshot, callbacks)
          : stage === 'authentication'
            ? await executeApiAuthentication(snapshot, callbacks)
            : await executeApiAuthorization(snapshot, {
                ...callbacks,
                getIdentity: callbacks.getIdentity!,
              });
      result.execution = execution;
      result.code = execution.code;
    }
  } catch {
    result.code = callbacks.signal?.aborted
      ? 'stopped'
      : setupSignal.aborted
        ? 'setup_timeout'
        : 'setup_unavailable';
  } finally {
    clearTimeout(setupTimer);
    setupController.abort();
    if (attempted) {
      // Separate cleanup ownership permits compensation after head changes/cancellation.
      const cleanupController = new AbortController();
      const cleanupTimer = setTimeout(
        () => cleanupController.abort(),
        cleanupMs,
      );
      const signal = cleanupController.signal;
      result.cleanup = { status: 'unverified', code: 'cleanup_unavailable' };
      try {
        if (
          !(await bounded(
            provider.canCleanup({ ...namespace }, signal),
            signal,
          ))
        )
          result.cleanup.code = 'cleanup_forbidden';
        else {
          await bounded(provider.cleanup({ ...namespace }, signal), signal);
          const receipt = emptySchema.parse(
            await bounded(
              provider.verifyEmpty({ ...namespace }, signal),
              signal,
            ),
          );
          if (sameNamespace(receipt, namespace) && receipt.empty && settled)
            result.cleanup = { status: 'verified', code: 'namespace_empty' };
          else
            result.cleanup.code = !settled
              ? 'setup_unsettled'
              : 'cleanup_not_empty';
        }
      } catch {
        result.cleanup.code = signal.aborted
          ? 'cleanup_timeout'
          : 'cleanup_unavailable';
      } finally {
        clearTimeout(cleanupTimer);
        cleanupController.abort();
      }
    }
  }
  if (result.cleanup.status === 'unverified') {
    result.code = result.cleanup.code;
    return result;
  }
  if (result.execution && prepared && result.execution.status === 'completed') {
    result.capsule = {
      version: 1,
      stage,
      configurationDigest,
      contractDigest: contract.contractDigest,
      ...prepared,
      outcomeDigest: outcome(result.execution),
    };
    result.status = 'completed';
    if (expected) {
      result.replay.status =
        expected.outcomeDigest === result.capsule.outcomeDigest
          ? 'matched'
          : 'different';
      result.code =
        result.replay.status === 'matched'
          ? 'replay_matched'
          : 'replay_different';
    }
  }
  return result;
}
