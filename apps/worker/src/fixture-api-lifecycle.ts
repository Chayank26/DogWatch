/** In-process disposable PawMart adapter. Never enables remote reset endpoints. */
import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ApiNamespace, ApiLifecycleProvider } from './api-lifecycle.js';
import type { ApiScope } from './api-execution.js';

export async function createFixtureApiLifecycle(
  authority: Omit<ApiScope, 'runId'> & { deploymentId: string },
) {
  const trusted = { ...authority };
  const moduleUrl = new URL('../../fixture/dist/app.js', import.meta.url);
  const { createFixtureApp } = await import(moduleUrl.href);
  const fingerprint = (value: string) =>
    createHash('sha256').update(value).digest('hex');
  const fixtureDigest = fingerprint(await readFile(moduleUrl, 'utf8'));
  let active: { context: ApiNamespace; app: RequestListener } | undefined;
  let closed = false;
  // Bounded receipts permit idempotent compensation without retaining application data.
  const owned = new Map<string, string>();
  const key = (context: ApiNamespace) =>
    JSON.stringify(Object.entries(context).sort());
  const server = createServer((request, response) => {
    if (active) active.app(request, response);
    else {
      response.statusCode = 503;
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('fixture_address');
  const origin = `http://127.0.0.1:${address.port}`;
  const authorized = (context: ApiNamespace) =>
    context.origin === origin &&
    Object.entries(trusted).every(
      ([name, value]) => context[name as keyof ApiNamespace] === value,
    );
  const owns = (context: ApiNamespace) =>
    authorized(context) && owned.get(context.namespaceId) === key(context);
  const lifecycle: ApiLifecycleProvider = {
    async prepare(context, signal) {
      signal.throwIfAborted();
      if (
        closed ||
        !authorized(context) ||
        active ||
        owned.has(context.namespaceId) ||
        owned.size >= 100
      )
        throw Error('fixture_scope');
      // No await between abort check, ownership registration and state creation.
      owned.set(context.namespaceId, key(context));
      active = { context: { ...context }, app: createFixtureApp('healthy') };
      return {
        ...context,
        fixtureDigest,
        datasetDigest: fingerprint('PawMart healthy seeded orders v1'),
        identityDigest: fingerprint(
          'PawMart alice/customer bob/customer admin/admin v1',
        ),
      };
    },
    async canCleanup(context, signal) {
      signal.throwIfAborted();
      return owns(context);
    },
    async cleanup(context, signal) {
      signal.throwIfAborted();
      if (!owns(context)) throw Error('fixture_scope');
      if (active?.context.namespaceId === context.namespaceId)
        active = undefined;
    },
    async verifyEmpty(context, signal) {
      signal.throwIfAborted();
      if (!owns(context)) throw Error('fixture_scope');
      return {
        ...context,
        empty: active?.context.namespaceId !== context.namespaceId,
      };
    },
  };
  return {
    origin,
    lifecycle,
    async close() {
      closed = true;
      active = undefined;
      owned.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
