/** Operator-owned, immutable deployment configuration; never loaded from PR content. */
import { z } from 'zod';
import { scopeSchema, grantSchema, limitsSchema } from './api-execution.js';
import type { ApiExecutionInput } from './api-execution.js';
import { previewBindingSchema, validatePreviewUrl } from './preview.js';
const entrySchema = z.strictObject({
  binding: previewBindingSchema,
  contractText: z.string().min(1).max(1048576),
  operations: grantSchema.shape.operations.refine(
    (ops) =>
      ops.length > 0 &&
      ops.every(
        (op) =>
          ['GET', 'HEAD'].includes(op.method) &&
          !op.allowMutation &&
          !op.authentication,
      ),
    'Initial configured execution supports unauthenticated GET/HEAD only',
  ),
  limits: limitsSchema.optional(),
});
export function createApiConfiguration(input: unknown) {
  const entries = z.array(entrySchema).max(1000).parse(input);
  const keys = new Set<string>();
  const key = (b: {
    tenantId: string;
    repositoryId: number;
    pullRequestNumber: number;
    headSha: string;
  }) =>
    JSON.stringify([
      b.tenantId,
      b.repositoryId,
      b.pullRequestNumber,
      b.headSha,
    ]);
  for (const entry of entries) {
    validatePreviewUrl(new URL(entry.binding.url), entry.binding);
    const identity = key(entry.binding);
    if (keys.has(identity)) throw Error('execution_configuration_ambiguous');
    keys.add(identity);
  }
  return (inputScope: unknown): ApiExecutionInput | null => {
    const scope = scopeSchema.parse(inputScope);
    const entry = entries.find((e) => key(e.binding) === key(scope));
    if (!entry) return null;
    return structuredClone({
      scope,
      ...entry,
      grant: {
        ...scope,
        deploymentId: entry.binding.deploymentId,
        origin: new URL(entry.binding.url).origin,
        operations: entry.operations,
      },
    });
  };
}
