import { z } from 'zod';
import { repositoryPolicySchema } from '@dogwatch/contracts';
import type { RepositoryPolicy } from '@dogwatch/contracts';
/** Remote context is fetched using a repository-restricted installation credential. */
export interface PullRequestContext {
  installationActive: boolean;
  repositoryId: number;
  number: number;
  state: 'open' | 'closed';
  headSha: string;
  headRepositoryId: number | null;
  baseRepositoryId: number;
  labels: string[];
}
export interface AuthorizationDependencies {
  // Tenant ownership comes from trusted configuration, never webhook tenantId.
  policies: RepositoryPolicy[];
  resolvePullRequest: (
    installationId: number,
    repositoryId: number,
    number: number,
  ) => Promise<PullRequestContext>;
}
/** Validate operator configuration once; ambiguous repository ownership is rejected. */
export function parsePolicies(input: unknown): RepositoryPolicy[] {
  const policies = z.array(repositoryPolicySchema).max(1000).parse(input);
  const repositories = new Set<number>();
  const installations = new Map<number, string>();
  for (const policy of policies) {
    if (repositories.has(policy.repositoryId))
      throw new Error('Duplicate repository policy');
    if (
      installations.has(policy.installationId) &&
      installations.get(policy.installationId) !== policy.tenantId
    ) {
      throw new Error('Installation cannot belong to multiple tenants');
    }
    repositories.add(policy.repositoryId);
    installations.set(policy.installationId, policy.tenantId);
  }
  return policies;
}
