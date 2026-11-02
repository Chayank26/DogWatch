/** Durable, read-only API execution slice. No public route or automatic customer consumer. */
import { budgetSchema } from '@dogwatch/contracts';
import {
  claimExecution,
  renewExecution,
  finishExecution,
} from '@dogwatch/database';
import type { createDatabase } from '@dogwatch/database';
import { executeApiCases, scopeSchema, grantSchema } from './api-execution.js';
import type {
  ApiExecutionInput,
  ApiExecutionOptions,
} from './api-execution.js';
import { previewBindingSchema, waitForPreview } from './preview.js';
import { bounded } from './api-runtime.js';
export type ExecutionAuthority = {
  tenantId: string;
  runId: string;
  repositoryId: number;
  installationId: number;
  pullRequestNumber: number;
  headSha: string;
};
export async function runApiExecution(
  db: ReturnType<typeof createDatabase>,
  input: ApiExecutionInput,
  resolveAuthority: (
    scope: Readonly<ExecutionAuthority>,
  ) => Promise<{ authorized: boolean; headSha: string }>,
  options: Omit<ApiExecutionOptions, 'isCurrent'> = {},
) {
  input = structuredClone(input);
  options = { ...options };
  const scope = scopeSchema.parse(input.scope);
  const binding = previewBindingSchema.parse(input.binding);
  const grant = grantSchema.parse(input.grant);
  if (
    grant.operations.some(
      (op) => !['GET', 'HEAD'].includes(op.method) || op.allowMutation,
    )
  )
    throw Error('execution_read_only');
  for (const [key, value] of Object.entries(scope)) {
    if (grant[key as keyof typeof scope] !== value)
      throw Error('execution_grant_scope');
    if (key !== 'runId' && binding[key as keyof typeof binding] !== value)
      throw Error('execution_binding_scope');
  }
  if (
    grant.deploymentId !== binding.deploymentId ||
    new URL(binding.url).origin !== grant.origin
  )
    throw Error('execution_deployment');
  const run = await db.run.findFirst({
    where: { id: scope.runId, tenantId: scope.tenantId },
    include: { repository: true },
  });
  if (
    !run ||
    run.repositoryId !== BigInt(scope.repositoryId) ||
    run.pullRequestNumber !== scope.pullRequestNumber ||
    run.headSha !== scope.headSha
  )
    return { status: 'not_claimed' as const };
  const installationId = Number(run.repository.installationId);
  if (!Number.isSafeInteger(installationId))
    throw Error('execution_installation');
  const authorityScope = Object.freeze({ ...scope, installationId });
  const authorized = async (signal: AbortSignal) => {
    const current = await bounded(resolveAuthority(authorityScope), signal);
    return current.authorized === true && current.headSha === scope.headSha;
  };
  if (
    !(await authorized(
      options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(5000)])
        : AbortSignal.timeout(5000),
    ))
  )
    return { status: 'not_authorized' as const };
  const claim = await claimExecution(db, {
    tenantId: scope.tenantId,
    runId: scope.runId,
  });
  if (!claim) return { status: 'not_claimed' as const };
  const budget = budgetSchema.parse(claim.run.budgetSnapshot);
  const started = performance.now();
  const deadline = AbortSignal.timeout(budget.maxRunSeconds * 1000);
  const signal = options.signal
    ? AbortSignal.any([deadline, options.signal])
    : deadline;
  const identity = { tenantId: scope.tenantId, runId: scope.runId };
  const isCurrent = async () =>
    (await authorized(signal)) &&
    (await renewExecution(db, identity, claim.token));
  try {
    const readiness = await waitForPreview(
      {
        ...binding,
        maxWaitSeconds: Math.min(binding.maxWaitSeconds, budget.maxRunSeconds),
        maxRequests: Math.min(binding.maxRequests, budget.maxApiRequests),
      },
      { isCurrent, signal, fixture: options.fixture },
    );
    let result;
    if (readiness.status !== 'ready')
      result = {
        status: 'inconclusive' as const,
        code: readiness.code,
        requests: readiness.requests,
        results: [],
        coverageGaps: [{ code: readiness.code }],
      };
    else {
      const remainingMs = Math.max(
        1,
        Math.floor(budget.maxRunSeconds * 1000 - (performance.now() - started)),
      );
      const output = await executeApiCases(
        {
          ...input,
          binding,
          grant,
          limits: {
            ...input.limits,
            maxRequests: Math.min(
              input.limits?.maxRequests ?? 100,
              budget.maxApiRequests - readiness.requests,
            ),
            maxExecutionMs: Math.min(
              input.limits?.maxExecutionMs ?? 20000,
              remainingMs,
            ),
          },
        },
        { ...options, signal, isCurrent },
      );
      result = {
        status: output.status,
        code: output.code,
        requests: readiness.requests + output.requests,
        results: output.results.map(
          ({ caseId, operationKey, status, code, httpStatus }) => ({
            caseId,
            operationKey,
            status,
            code,
            ...(httpStatus === undefined ? {} : { httpStatus }),
          }),
        ),
        coverageGaps: output.coverageGaps,
      };
    }
    if (!(await isCurrent())) return { status: 'interrupted' as const };
    const committed = await finishExecution(db, identity, claim.token, result, {
      browserSeconds: 0,
      runSeconds: Math.ceil((performance.now() - started) / 1000),
      apiRequests: result.requests,
      browserSteps: 0,
      modelCalls: 0,
      modelTokens: 0,
      modelCostCents: 0,
      artifactBytes: 0,
    });
    return {
      status: committed ? ('recorded' as const) : ('interrupted' as const),
    };
  } catch {
    // Do not invent zero usage or reclaim uncertain side effects after a lost lease.
    return { status: 'interrupted' as const };
  }
}
