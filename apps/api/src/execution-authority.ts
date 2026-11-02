/** Internal capability: revalidate stored acceptance against current operator policy and GitHub. */
import { z } from 'zod';
import type { createDatabase } from '@dogwatch/database';
import { repositoryPolicySchema } from '@dogwatch/contracts';
import { parsePolicies } from './authorization.js';
import type { AuthorizationDependencies } from './authorization.js';

const scopeSchema = z.strictObject({
  tenantId: z.uuid(),
  runId: z.uuid(),
  installationId: z.number().int().positive().safe(),
  repositoryId: z.number().int().positive().safe(),
  pullRequestNumber: z.number().int().positive(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
});
const acceptedSchema = repositoryPolicySchema.extend({
  actorId: z.number().int().positive().safe(),
  trigger: z.enum(['label', 'command']),
});
export function createExecutionAuthority(
  db: Pick<ReturnType<typeof createDatabase>, 'run'>,
  loadPolicies: () => Promise<unknown>,
  resolvePullRequest: AuthorizationDependencies['resolvePullRequest'],
) {
  return async (input: z.infer<typeof scopeSchema>) => {
    const denied = { authorized: false, headSha: '' };
    try {
      const scope = scopeSchema.parse(input);
      const policies = parsePolicies(await loadPolicies());
      const policy = policies.find(
        (p) =>
          p.tenantId === scope.tenantId &&
          p.repositoryId === scope.repositoryId &&
          p.installationId === scope.installationId,
      );
      if (!policy?.enabled) return denied;
      const run = await db.run.findFirst({
        where: { id: scope.runId, tenantId: scope.tenantId },
        include: { repository: true },
      });
      if (
        !run ||
        !['queued', 'running'].includes(run.state) ||
        run.repositoryId !== BigInt(scope.repositoryId) ||
        run.repository.installationId !== BigInt(scope.installationId) ||
        run.pullRequestNumber !== scope.pullRequestNumber ||
        run.headSha !== scope.headSha
      )
        return denied;
      const accepted = acceptedSchema.safeParse(run.policySnapshot);
      if (!accepted.success) return denied;
      const prior = accepted.data;
      if (
        prior.tenantId !== scope.tenantId ||
        prior.repositoryId !== scope.repositoryId ||
        prior.installationId !== scope.installationId ||
        !prior.enabled ||
        !prior.authorizedActorIds.includes(prior.actorId) ||
        !policy.authorizedActorIds.includes(prior.actorId) ||
        (prior.trigger === 'command' && prior.command !== policy.command) ||
        (prior.trigger === 'label' && prior.label !== policy.label)
      )
        return denied;
      const remote = await resolvePullRequest(
        scope.installationId,
        scope.repositoryId,
        scope.pullRequestNumber,
      );
      const authorized =
        remote.installationActive &&
        remote.repositoryId === scope.repositoryId &&
        remote.baseRepositoryId === scope.repositoryId &&
        remote.headRepositoryId === scope.repositoryId &&
        remote.number === scope.pullRequestNumber &&
        remote.state === 'open' &&
        remote.headSha === scope.headSha &&
        (prior.trigger === 'command' || remote.labels.includes(policy.label));
      return { authorized, headSha: authorized ? remote.headSha : '' };
    } catch {
      return denied;
    }
  };
}
