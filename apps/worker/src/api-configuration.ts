/** Operator-owned, immutable deployment configuration; never loaded from PR content. */
import { validateApiContract } from './openapi.js';
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
  const entries = z.array(entrySchema).min(1).max(1000).parse(input);
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
    const contract = validateApiContract(
      {
        tenantId: entry.binding.tenantId,
        repositoryId: entry.binding.repositoryId,
        headSha: entry.binding.headSha,
      },
      entry.contractText,
    );
    if (contract.status !== 'supported')
      throw Error('execution_contract_invalid');
    const grants = new Set<string>();
    for (const grant of entry.operations) {
      const identity = `${grant.method} ${grant.path}`;
      if (grants.has(identity)) throw Error('execution_operation_duplicate');
      grants.add(identity);
      const operation = contract.operations.find(
        (op) => op.method === grant.method && op.path === grant.path,
      );
      if (!operation) throw Error('execution_operation_missing');
      if (
        operation.security.length &&
        !operation.security.some(
          (requirement) => Object.keys(requirement).length === 0,
        )
      )
        throw Error('execution_credentials_unsupported');
    }
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
