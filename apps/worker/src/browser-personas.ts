/** Explicit synthetic behavior profiles; prompts never grant actions or certify accessibility. */
import { z } from 'zod';
import { scopeSchema } from './api-execution.js';
import { runBrowserLoop } from './browser-loop.js';
import type { BrowserLoopExecutor } from './browser-loop.js';
import type { BrowserModel } from './browser-model.js';
import { BrowserBudget, browserBudgetSchema } from './browser-budget.js';
import { bounded } from './api-runtime.js';
import { personaSchema } from './browser-persona-profile.js';
import type { BrowserPersona } from './browser-persona-profile.js';
const suiteSchema = scopeSchema.extend({
  personas: z
    .array(personaSchema)
    .min(1)
    .max(4)
    .refine((items) => new Set(items).size === items.length),
  budget: browserBudgetSchema,
});
export async function runPersonaSuite(
  input: unknown,
  loopConfig: Record<string, unknown>,
  options: {
    createExecutor: (
      persona: BrowserPersona,
      budget: BrowserBudget,
      signal: AbortSignal,
    ) => Promise<BrowserLoopExecutor>;
    model: BrowserModel;
    isCurrent: () => Promise<boolean>;
    signal?: AbortSignal;
  },
) {
  const config = suiteSchema.parse(input);
  const scope = scopeSchema.parse(
    Object.fromEntries(
      Object.keys(scopeSchema.shape).map((key) => [
        key,
        config[key as keyof typeof config],
      ]),
    ),
  );
  const base = structuredClone(loopConfig);
  const budget = new BrowserBudget(scope, config.budget);
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(() => controller.abort(), budget.remainingMs());
  const results: Array<{
    persona: BrowserPersona;
    code: string;
    result?: Awaited<ReturnType<typeof runBrowserLoop>>;
  }> = [];
  try {
    for (const persona of config.personas) {
      if (persona === 'keyboard_only') {
        results.push({ persona, code: 'persona_unsupported' });
        continue;
      }
      if (signal.aborted || budget.remainingMs() <= 0) {
        results.push({ persona, code: 'suite_stopped' });
        break;
      }
      let executor: BrowserLoopExecutor | undefined;
      try {
        if (!(await bounded(options.isCurrent(), signal))) throw Error('stale');
        const pending = options.createExecutor(persona, budget, signal);
        // A factory that ignores cancellation still owns eventual resource disposal.
        void pending.then(
          (value) => {
            if (signal.aborted) void value.close().catch(() => {});
          },
          () => {},
        );
        executor = await bounded(pending, signal);
        const result = await runBrowserLoop(
          { ...base, ...scope, persona },
          executor,
          options.model,
          { isCurrent: options.isCurrent, signal, budget },
        );
        executor = undefined;
        results.push({ persona, code: result.code, result });
      } catch {
        results.push({ persona, code: 'persona_unavailable' });
        break;
      } finally {
        if (executor)
          await bounded(executor.close(), AbortSignal.timeout(2000)).catch(
            () => {},
          );
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return { version: 1, ...scope, results, budget: budget.snapshot() };
}
