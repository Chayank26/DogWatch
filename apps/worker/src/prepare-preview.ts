/**
 * Preview stage orchestration. Called explicitly by a trusted future executor or
 * verification harness, never by an unauthenticated route or startup auto-consumer.
 */
import { z } from 'zod';
import { budgetSchema } from '@dogwatch/contracts';
import { canExecuteRun, createDatabase } from '@dogwatch/database';
import { previewBindingSchema, waitForPreview } from './preview.js';
import type { PreviewBinding, PreviewOutcome } from './preview.js';

export async function preparePreview(
  database: ReturnType<typeof createDatabase>,
  identity: { tenantId: string; runId: string },
  bindings: PreviewBinding[],
  options: {
    // Current SHA must be resolved independently through trusted GitHub context.
    currentHead: () => Promise<string>;
    signal?: AbortSignal;
    fixture?: boolean;
    probe?: Parameters<typeof waitForPreview>[1]['probe'];
  },
): Promise<PreviewOutcome | { status: 'not_claimed' }> {
  const tenantId = z.uuid().parse(identity.tenantId);
  const runId = z.uuid().parse(identity.runId);
  const run = await database.run.findFirst({ where: { id: runId, tenantId } });
  if (!run || run.state !== 'queued') return { status: 'not_claimed' };
  const matches = bindings
    .map((binding) => previewBindingSchema.parse(binding))
    .filter(
      (binding) =>
        binding.tenantId === tenantId &&
        BigInt(binding.repositoryId) === run.repositoryId &&
        binding.pullRequestNumber === run.pullRequestNumber &&
        binding.headSha === run.headSha,
    );
  if (matches.length !== 1) {
    // Missing or ambiguous bindings are setup failures, not application regressions.
    await database.run.updateMany({
      where: { id: runId, tenantId, state: 'queued' },
      data: {
        state: 'failed',
        setupFailureCode: matches.length
          ? 'preview_ambiguous'
          : 'preview_missing',
      },
    });
    return {
      status: 'failed',
      code: matches.length ? 'preview_ambiguous' : 'preview_missing',
      requests: 0,
    };
  }
  const configured = matches[0]!;
  const budget = budgetSchema.parse(run.budgetSnapshot);
  // Readiness uses its separate setup limit, also capped by the overall run ceiling.
  // API probe count is capped by the run request budget; later stages must deduct it.
  const binding = {
    ...configured,
    maxWaitSeconds: Math.min(configured.maxWaitSeconds, budget.maxRunSeconds),
    maxRequests: Math.min(configured.maxRequests, budget.maxApiRequests),
  };
  const claimed = await database.run.updateMany({
    where: { id: runId, tenantId, state: 'queued' },
    data: {
      state: 'waiting_for_preview',
      previewSnapshot: binding,
      setupFailureCode: null,
    },
  });
  if (!claimed.count) return { status: 'not_claimed' };
  const outcome = await waitForPreview(binding, {
    ...options,
    isCurrent: async () => {
      if (!(await canExecuteRun(database, tenantId, runId))) return false;
      const current = await options.currentHead();
      if (current === run.headSha) return true;
      // Head changes stop this run without changing any immutable accepted context.
      await database.run.updateMany({
        where: { id: runId, tenantId, state: 'waiting_for_preview' },
        data: { state: 'superseded' },
      });
      return false;
    },
  });
  const recorded = await database.run.updateMany({
    where: { id: runId, tenantId, state: 'waiting_for_preview' },
    data:
      outcome.status === 'ready'
        ? {
            previewReadyAt: new Date(),
            previewSnapshot: {
              ...binding,
              readinessRequests: outcome.requests,
            },
          }
        : {
            state: 'failed',
            setupFailureCode: outcome.code,
            previewSnapshot: {
              ...binding,
              readinessRequests: outcome.requests,
            },
          },
  });
  // A concurrent cancellation/supersession wins: never overwrite it with success.
  if (!recorded.count)
    return {
      status: 'failed',
      code: 'preview_stopped',
      requests: outcome.requests,
    };
  // Ready remains waiting_for_preview; isolated execution owns the transition to running.
  return outcome;
}
