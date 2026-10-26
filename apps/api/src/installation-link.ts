/** Callable linking; user tokens must come from a trusted server-side GitHub authorization flow. */
import { createHash } from 'node:crypto';
import { Octokit } from 'octokit';
import { createAppAuth } from '@octokit/auth-app';
import { z } from 'zod';
import type { InstallationLinkStore } from '@dogwatch/database';
const id = z.number().int().positive().safe();
const requestSchema = z.strictObject({
  tenantId: z.uuid(),
  installationId: id,
  sessionToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
const accountSchema = z.object({
  id,
  login: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
  type: z.enum(['User', 'Organization']),
});
const installationSchema = z.object({
  id,
  app_id: id,
  suspended_at: z.string().nullable(),
  account: accountSchema,
});
export function createInstallationLinker(
  appId: number,
  privateKey: string,
  store: InstallationLinkStore,
  requestFetch: typeof fetch = fetch,
) {
  id.parse(appId);
  const options = {
    request: { timeout: 2000, fetch: requestFetch },
    retry: { enabled: false },
    throttle: { enabled: false },
  };
  const app = new Octokit({
    ...options,
    authStrategy: createAppAuth,
    auth: { appId, privateKey },
  });
  return async (input: unknown, userAccessToken: string) => {
    const request = requestSchema.parse(input);
    const credential = z.string().min(1).max(4096).parse(userAccessToken);
    const scope = {
      tenantId: request.tenantId,
      sessionHash: createHash('sha256')
        .update(request.sessionToken)
        .digest('hex'),
    };
    const githubId = await store.owner(scope);
    const user = new Octokit({ ...options, auth: credential });
    const actor = z
      .object({ id, type: z.literal('User') })
      .parse((await user.request('GET /user')).data);
    if (String(actor.id) !== githubId)
      throw Error('installation_actor_mismatch');
    const readInstallation = async () => {
      const installation = installationSchema.parse(
        (
          await app.request('GET /app/installations/{installation_id}', {
            installation_id: request.installationId,
          })
        ).data,
      );
      if (
        installation.id !== request.installationId ||
        installation.app_id !== appId ||
        installation.suspended_at !== null
      )
        throw Error('installation_unavailable');
      return installation;
    };
    const installation = await readInstallation();
    let accessible = false;
    for (let page = 1; page <= 5; page++) {
      const result = await user.request('GET /user/installations', {
        per_page: 100,
        page,
      });
      const entries = z
        .array(installationSchema)
        .max(100)
        .parse(result.data.installations);
      accessible = entries.some(
        (entry) =>
          entry.id === installation.id &&
          entry.app_id === appId &&
          entry.account.id === installation.account.id &&
          entry.account.type === installation.account.type &&
          entry.suspended_at === null,
      );
      if (accessible || entries.length < 100) break;
      if (page === 5) throw Error('installation_scan_limit');
    }
    if (!accessible) throw Error('installation_access_denied');
    if (installation.account.type === 'User') {
      if (installation.account.id !== actor.id)
        throw Error('installation_owner_required');
    } else {
      const membership = z
        .object({
          state: z.literal('active'),
          role: z.literal('admin'),
          organization: z.object({ id }),
          user: z.object({ id }),
        })
        .parse(
          (
            await user.request('GET /user/memberships/orgs/{org}', {
              org: installation.account.login,
            })
          ).data,
        );
      if (
        membership.organization.id !== installation.account.id ||
        membership.user.id !== actor.id
      )
        throw Error('installation_owner_required');
    }
    const current = await readInstallation();
    if (
      current.account.id !== installation.account.id ||
      current.account.type !== installation.account.type
    )
      throw Error('installation_account_changed');
    const status = await store.link({
      ...scope,
      installationId: installation.id,
      githubId,
    });
    return {
      status,
      tenantId: scope.tenantId,
      installationId: installation.id,
    };
  };
}
