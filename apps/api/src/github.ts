/**
 * GitHub App adapter. App authentication checks current installation state, then
 * creates a read-only token limited to the configured repository for each lookup.
 * Tokens/keys are never returned to webhook callers, logged, or saved in jobs.
 */
import { Octokit } from 'octokit';
import { createAppAuth } from '@octokit/auth-app';
import type { AuthorizationDependencies } from './authorization.js';

/** Octokit's ID types may be bigint; reject values our numeric contracts cannot represent. */
function safeId(value: number | bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0)
    throw new Error('Unrepresentable GitHub ID');
  return result;
}

export function createGitHubResolver(
  appId: number,
  privateKey: string,
  requestFetch: typeof fetch = fetch,
): AuthorizationDependencies['resolvePullRequest'] {
  const app = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId, privateKey },
    request: { timeout: 2000, fetch: requestFetch },
    retry: { enabled: false },
    throttle: { enabled: false },
  });
  return async (installationId, repositoryId, number) => {
    const { data: installation } = await app.request(
      'GET /app/installations/{installation_id}',
      { installation_id: installationId },
    );
    if (installation.suspended_at)
      return {
        installationActive: false,
        repositoryId,
        number,
        state: 'closed',
        headSha: '',
        headRepositoryId: null,
        baseRepositoryId: repositoryId,
        labels: [],
      };
    // Explicitly restrict the grant: even a public repository must be accessible to
    // this installation, not merely visible through unauthenticated metadata APIs.
    const { data: grant } = await app.request(
      'POST /app/installations/{installation_id}/access_tokens',
      {
        installation_id: installationId,
        repository_ids: [repositoryId],
        permissions: { metadata: 'read', pull_requests: 'read' },
      },
    );
    const client = new Octokit({
      auth: grant.token,
      request: { timeout: 2000, fetch: requestFetch },
      retry: { enabled: false },
      throttle: { enabled: false },
    });
    const { data: repository } = await client.request(
      'GET /repositories/{repository_id}',
      { repository_id: repositoryId },
    );
    const { data: pr } = await client.request(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}',
      {
        owner: repository.owner.login,
        repo: repository.name,
        pull_number: number,
      },
    );
    return {
      installationActive: true,
      repositoryId: safeId(repository.id),
      number: pr.number,
      state: pr.state === 'open' ? 'open' : 'closed',
      headSha: pr.head.sha,
      headRepositoryId: pr.head.repo ? safeId(pr.head.repo.id) : null,
      baseRepositoryId: safeId(pr.base.repo.id),
      labels: pr.labels.map((label) => label.name),
    };
  };
}
