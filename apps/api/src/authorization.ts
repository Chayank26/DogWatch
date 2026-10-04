/**
 * Authenticated webhook-to-domain adapter. Network access is injected so policy
 * behavior can be tested without real credentials or calls to GitHub.
 */
import { z } from 'zod';
import { evaluateOptIn, repositoryPolicySchema } from '@dogwatch/contracts';
import type { RepositoryPolicy, OptInEvent } from '@dogwatch/contracts';

// GitHub objects have many extra keys; z.object deliberately strips those keys.
// Strict schemas remain appropriate for our own configuration, not remote payloads.
const githubId = z.number().int().positive().safe();
const common = {
  action: z.string(),
  installation: z.object({ id: githubId }),
  repository: z.object({ id: githubId }),
  sender: z.object({ id: githubId, type: z.literal('User') }),
};
const prPayload = z.object({
  ...common,
  number: githubId,
  pull_request: z.object({
    number: githubId,
    labels: z.array(z.object({ name: z.string() })),
  }),
  label: z.object({ name: z.string() }).optional(),
});
const commentPayload = z.object({
  ...common,
  issue: z.object({ number: githubId, pull_request: z.object({}).optional() }),
  comment: z.object({
    body: z.string().max(65536),
    user: z.object({ id: githubId }),
  }),
});

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
export type AuthorizationResult =
  | {
      status: 'eligible_only';
      queued: false;
      event: OptInEvent;
      policy: RepositoryPolicy;
      trigger: 'label' | 'command';
    }
  | { status: 'ignored'; queued: false; reason: string };

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

export async function authorizeDelivery(
  eventName: string | undefined,
  deliveryId: string | undefined,
  payload: unknown,
  dependencies: AuthorizationDependencies,
): Promise<AuthorizationResult> {
  const ignore = (reason: string): AuthorizationResult => ({
    status: 'ignored',
    queued: false,
    reason,
  });
  // Filter unsupported events/actions without assuming they are malformed PR events.
  if (!['pull_request', 'issue_comment'].includes(eventName ?? ''))
    return ignore('unsupported_event');
  // Bots are outside the explicitly human actor policy; ignore rather than retry.
  const actorType = z
    .object({ sender: z.object({ type: z.string() }).optional() })
    .parse(payload).sender?.type;
  if (actorType && actorType !== 'User')
    return ignore('unsupported_actor_type');
  const action = z.object({ action: z.string() }).parse(payload).action;
  if (eventName === 'pull_request' && !['opened', 'labeled'].includes(action))
    return ignore('unsupported_action');
  if (eventName === 'issue_comment' && action !== 'created')
    return ignore('unsupported_action');
  if (!deliveryId || !/^[a-zA-Z0-9-]{1,100}$/.test(deliveryId))
    throw new Error('Invalid delivery ID');

  let installationId: number,
    repositoryId: number,
    actorId: number,
    number: number;
  let kind: OptInEvent['kind'],
    labels: string[] = [],
    addedLabel = '',
    body = '';
  if (eventName === 'pull_request') {
    const parsed = prPayload.parse(payload);
    if (parsed.number !== parsed.pull_request.number)
      return ignore('pr_number_mismatch');
    ({ id: installationId } = parsed.installation);
    ({ id: repositoryId } = parsed.repository);
    ({ id: actorId } = parsed.sender);
    number = parsed.number;
    labels = parsed.pull_request.labels.map((label) => label.name);
    kind = action === 'opened' ? 'pr_opened' : 'pr_labeled';
    if (kind === 'pr_labeled' && !parsed.label)
      throw new Error('Missing added label');
    addedLabel = parsed.label?.name ?? '';
  } else {
    const parsed = commentPayload.parse(payload);
    if (!parsed.issue.pull_request) return ignore('ordinary_issue_comment');
    if (parsed.sender.id !== parsed.comment.user.id)
      return ignore('comment_actor_mismatch');
    installationId = parsed.installation.id;
    repositoryId = parsed.repository.id;
    actorId = parsed.sender.id;
    number = parsed.issue.number;
    kind = 'pr_comment';
    body = parsed.comment.body;
  }
  const policy = dependencies.policies.find(
    (entry) =>
      entry.installationId === installationId &&
      entry.repositoryId === repositoryId,
  );
  if (!policy) return ignore('unknown_repository');
  // Reject non-opt-in and unauthorized traffic before spending GitHub API requests.
  if (!policy.enabled) return ignore('disabled');
  if (!policy.authorizedActorIds.includes(actorId))
    return ignore('unauthorized_actor');
  if (
    (kind === 'pr_opened' && !labels.includes(policy.label)) ||
    (kind === 'pr_labeled' && addedLabel !== policy.label) ||
    (kind === 'pr_comment' && body.trim() !== policy.command)
  )
    return ignore('no_opt_in');

  // Current API context, not comment URLs or PR SHA claims, supplies the run target.
  const context = await dependencies.resolvePullRequest(
    installationId,
    repositoryId,
    number,
  );
  if (!context.installationActive) return ignore('installation_inactive');
  if (
    context.repositoryId !== repositoryId ||
    context.baseRepositoryId !== repositoryId ||
    context.number !== number
  )
    return ignore('remote_scope_mismatch');
  if (context.state !== 'open') return ignore('pr_closed');
  // Forks cannot inherit preview credentials automatically; default-deny for MVP.
  if (context.headRepositoryId !== repositoryId)
    return ignore('fork_not_allowed');
  if (kind !== 'pr_comment' && !context.labels.includes(policy.label))
    return ignore('label_removed');
  const base = {
    tenantId: policy.tenantId,
    installationId,
    repositoryId,
    actorId,
    deliveryId,
    pullRequestNumber: number,
    headSha: context.headSha,
  };
  const event: OptInEvent =
    kind === 'pr_opened'
      ? { ...base, kind, labels }
      : kind === 'pr_labeled'
        ? { ...base, kind, addedLabel }
        : { ...base, kind, body };
  const decision = evaluateOptIn(policy, event);
  if (!decision.accepted) return ignore(decision.reason);
  return {
    status: 'eligible_only',
    queued: false,
    event,
    policy,
    trigger: decision.trigger,
  };
}
