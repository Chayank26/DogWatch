/** Explicit fixture scripts only; observations are unconfirmed until independent replay. */
import { scopeSchema } from './api-execution.js';
import { browserPolicySchema } from './browser-actions.js';
import { chaosScriptSchema } from './browser-chaos.js';
import { createFixtureActionExecutor } from './browser-actions-fixture.js';
import type { BrowserBudget } from './browser-budget.js';
import { bounded } from './api-runtime.js';
export async function runFixtureChaos(
  scopeInput: unknown,
  policyInput: unknown,
  scriptInput: unknown,
  options: {
    isCurrent: () => Promise<boolean>;
    signal?: AbortSignal;
    budget?: BrowserBudget;
  },
) {
  const scope = scopeSchema.parse(scopeInput),
    policy = browserPolicySchema.parse(policyInput),
    script = chaosScriptSchema.parse(scriptInput);
  if (!policy.disposableData) throw Error('chaos_requires_disposable_data');
  let executor:
    Awaited<ReturnType<typeof createFixtureActionExecutor>> | undefined;
  let capture:
    | Awaited<
        ReturnType<
          Awaited<ReturnType<typeof createFixtureActionExecutor>>['observe']
        >
      >
    | undefined;
  const trace: Array<{ step: number; kind: string; code: string }> = [];
  let code: string;
  let cleanup = 'not_started';
  let fault: ReturnType<
    Awaited<ReturnType<typeof createFixtureActionExecutor>>['chaos']
  >;
  try {
    executor = await createFixtureActionExecutor(scope, policy, {
      ...options,
      chaos: script.fault,
    });
    cleanup = 'unverified';
    code = 'chaos_unconfirmed';
    for (const action of script.steps) {
      if (action.kind !== 'stop') options.budget?.reserve(scope, 'action');
      const result = await executor.execute(action);
      trace.push({
        step: trace.length + 1,
        kind: action.kind,
        code: result.code,
      });
      if (result.code !== 'executed') {
        code = 'chaos_inconclusive';
        break;
      }
    }
    if (code === 'chaos_unconfirmed') await executor.settle();
    fault = executor.chaos();
    if (script.fault && !fault?.applied) code = 'fault_not_applied';
    if (code === 'chaos_unconfirmed') {
      capture = await executor.observe();
      if (capture.status !== 'captured') code = 'chaos_inconclusive';
    }
  } catch {
    code = 'chaos_inconclusive';
  } finally {
    if (executor) {
      fault = executor.chaos();
      try {
        await bounded(executor.close(), AbortSignal.timeout(2000));
        cleanup = 'closed';
      } catch {
        cleanup = 'unverified';
        code = 'chaos_cleanup_unavailable';
      }
    }
  }
  return {
    version: 1,
    ...scope,
    scenarioId: script.id,
    scenarioKind: script.kind,
    audience: 'private_synthetic_fixture' as const,
    confirmation: 'unconfirmed' as const,
    code,
    cleanup,
    trace,
    fault,
    capture,
  };
}
