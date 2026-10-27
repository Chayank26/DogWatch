import type { RunControlStore, ControlScope } from '@dogwatch/database';
import { z } from 'zod';
import type { AuthorizationDependencies } from './authorization.js';
export function createRerunService(
  store: RunControlStore,
  resolve: AuthorizationDependencies['resolvePullRequest'],
) {
  return async (scope: ControlScope, requestId: string) => {
    z.uuid().parse(requestId);
    const context = await store.prepare(scope);
    const pr = await resolve(
      context.installationId,
      context.repositoryId,
      context.pullRequestNumber,
    );
    if (
      !pr.installationActive ||
      pr.state !== 'open' ||
      pr.number !== context.pullRequestNumber ||
      pr.repositoryId !== context.repositoryId ||
      pr.baseRepositoryId !== context.repositoryId ||
      pr.headRepositoryId !== context.repositoryId
    )
      throw Error('control_pr_unavailable');
    return store.commit(
      scope,
      requestId,
      context,
      z
        .string()
        .regex(/^[a-f0-9]{40}$/)
        .parse(pr.headSha),
    );
  };
}
