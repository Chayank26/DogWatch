/** Opt-in browser identity. OAuth credentials never enter sessions or worker inputs. */
import { Router, json } from 'express';
import { workspaceNameSchema } from '@dogwatch/database';
import type {
  OnboardingStore,
  RunViewStore,
  RunControlStore,
  ControlScope,
} from '@dogwatch/database';
import type { Request } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Identity, IdentityStore } from '@dogwatch/database';
const token = () => randomBytes(32).toString('base64url');
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const opaque = /^[A-Za-z0-9_-]{43}$/;
const configSchema = z.strictObject({
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().min(1).max(500),
  origin: z.url(),
});
export type LoginConfig = z.infer<typeof configSchema>;
export function validateLoginConfig(input: LoginConfig) {
  const config = configSchema.parse(input);
  const url = new URL(config.origin);
  if (
    url.origin !== config.origin ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1'].includes(url.hostname)
      ))
  )
    throw Error('Login origin must be an HTTPS origin or local loopback HTTP');
  return config;
}
function cookie(request: Request, name: string): string | undefined {
  const matches = (request.get('cookie') ?? '')
    .split(';')
    .map((v) => v.trim())
    .filter((v) => v.startsWith(name + '='));
  if (matches.length !== 1) return undefined;
  const value = matches[0].slice(name.length + 1);
  return opaque.test(value) ? value : undefined;
}
/** Fresh membership snapshot; never authorize from tenant IDs in requests alone. */
export function requireMembership(
  identity: Identity,
  tenantId: string,
  role?: 'owner',
) {
  const membership = identity.memberships.find((m) => m.tenantId === tenantId);
  if (!membership || (role && membership.role !== role))
    throw Error('membership_denied');
  return membership;
}
export function createIdentityRouter(
  input: LoginConfig,
  store: IdentityStore,
  transport: typeof fetch = fetch,
  now = () => new Date(),
  onboarding?: OnboardingStore,
  runs?: RunViewStore,
  controls?: {
    store: RunControlStore;
    rerun?: (scope: ControlScope, requestId: string) => Promise<unknown>;
  },
) {
  const config = validateLoginConfig(input);
  const secure = config.origin.startsWith('https:');
  const sessionName = secure ? '__Host-dogwatch-session' : 'dogwatch-session';
  const flowName = secure ? '__Host-dogwatch-flow' : 'dogwatch-flow';
  const options = {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/',
  };
  const callback = config.origin + '/auth/github/callback';
  const router = Router();
  router.use((_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    next();
  });
  async function provider(url: string, init: RequestInit) {
    const response = await transport(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || !response.body) throw Error('oauth_provider');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 65536) throw Error('oauth_response_limit');
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } finally {
      await reader.cancel();
    }
  }
  router.get('/github', async (_req, res) => {
    try {
      const state = token(),
        verifier = token();
      await store.begin(
        hash(state),
        hash(verifier),
        new Date(now().getTime() + 600000),
      );
      const url = new URL('https://github.com/login/oauth/authorize');
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: callback,
        state,
        scope: '',
        code_challenge: createHash('sha256')
          .update(verifier)
          .digest('base64url'),
        code_challenge_method: 'S256',
      }).toString();
      res
        .cookie(flowName, verifier, { ...options, maxAge: 600000 })
        .redirect(url.href);
    } catch {
      res.status(503).json({ error: 'Login unavailable' });
    }
  });
  router.get('/github/callback', async (req, res) => {
    const verifier = cookie(req, flowName);
    res.clearCookie(flowName, options);
    const query = z
      .object({
        state: z.string().regex(opaque),
        code: z.string().min(1).max(512),
      })
      .safeParse(req.query);
    if (!query.success || !verifier) {
      res.status(400).json({ error: 'Invalid login callback' });
      return;
    }
    try {
      if (
        !(await store.consume(hash(query.data.state), hash(verifier), now()))
      ) {
        res.status(400).json({ error: 'Invalid login callback' });
        return;
      }
      const grant = z
        .object({
          access_token: z.string().min(1).max(4096),
          token_type: z.literal('bearer'),
        })
        .parse(
          await provider('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              client_id: config.clientId,
              client_secret: config.clientSecret,
              code: query.data.code,
              redirect_uri: callback,
              code_verifier: verifier,
            }),
          }),
        );
      const user = z
        .object({
          id: z.number().int().positive().safe(),
          login: z.string().min(1).max(100),
          type: z.literal('User'),
        })
        .parse(
          await provider('https://api.github.com/user', {
            headers: {
              accept: 'application/vnd.github+json',
              authorization: `Bearer ${grant.access_token}`,
              'user-agent': 'DogWatch',
            },
          }),
        );
      const session = token(),
        old = cookie(req, sessionName);
      await store.issue(
        String(user.id),
        user.login,
        hash(session),
        new Date(now().getTime() + 28800000),
        old ? hash(old) : undefined,
      );
      res
        .cookie(sessionName, session, { ...options, maxAge: 28800000 })
        .redirect(config.origin + (onboarding ? '/onboarding' : '/auth/me'));
    } catch {
      res.status(503).json({ error: 'Login unavailable' });
    }
  });
  router.get('/me', async (req, res) => {
    try {
      const session = cookie(req, sessionName);
      const identity = session
        ? await store.resolve(hash(session), now())
        : null;
      if (!identity) {
        res.status(401).json({ error: 'Login required' });
        return;
      }
      res.json(identity);
    } catch {
      res.status(503).json({ error: 'Identity unavailable' });
    }
  });
  router.get('/tenants/:tenantId/membership', async (req, res) => {
    try {
      const session = cookie(req, sessionName);
      const identity = session
        ? await store.resolve(hash(session), now())
        : null;
      if (!identity) {
        res.status(401).json({ error: 'Login required' });
        return;
      }
      const tenantId = z.uuid().safeParse(req.params.tenantId);
      if (!tenantId.success) {
        res.status(404).json({ error: 'Membership not found' });
        return;
      }
      const membership = identity.memberships.find(
        (m) => m.tenantId === tenantId.data,
      );
      if (!membership) {
        res.status(404).json({ error: 'Membership not found' });
        return;
      }
      res.json(requireMembership(identity, tenantId.data));
    } catch {
      res.status(503).json({ error: 'Identity unavailable' });
    }
  });
  if (onboarding) {
    router.get('/onboarding', async (req, res) => {
      const session = cookie(req, sessionName);
      if (!session) {
        res.status(401).json({ error: 'Login required' });
        return;
      }
      try {
        res.json(await onboarding.status(hash(session)));
      } catch (error) {
        res
          .status(
            error instanceof Error &&
              error.message === 'onboarding_unauthorized'
              ? 401
              : 503,
          )
          .json({ error: 'Onboarding unavailable' });
      }
    });
    router.post(
      '/onboarding/workspace',
      json({ limit: '2kb', inflate: false }),
      async (req, res) => {
        if (req.get('origin') !== config.origin) {
          res.status(403).json({ error: 'Invalid origin' });
          return;
        }
        const session = cookie(req, sessionName);
        if (!session) {
          res.status(401).json({ error: 'Login required' });
          return;
        }
        const input = z
          .strictObject({ name: workspaceNameSchema })
          .safeParse(req.body);
        if (!input.success) {
          res
            .status(400)
            .json({ error: 'Provide a workspace name of 1–80 characters' });
          return;
        }
        try {
          res.json(await onboarding.create(hash(session), input.data.name));
        } catch (error) {
          const code = error instanceof Error ? error.message : '';
          res
            .status(
              code === 'onboarding_unauthorized'
                ? 401
                : code === 'onboarding_already_member'
                  ? 409
                  : 503,
            )
            .json({
              error:
                code === 'onboarding_already_member'
                  ? 'You already belong to a workspace'
                  : 'Workspace creation unavailable',
            });
        }
      },
    );
  }
  if (runs) {
    router.get('/tenants/:tenantId/runs{/:runId}', async (req, res) => {
      const session = cookie(req, sessionName);
      if (!session) {
        res.status(401).json({ error: 'Login required' });
        return;
      }
      const scope = z
        .object({ tenantId: z.uuid(), runId: z.uuid().optional() })
        .safeParse(req.params);
      const query = z
        .strictObject({ after: z.uuid().optional() })
        .safeParse(req.query);
      if (!scope.success || !query.success) {
        res.status(404).json({ error: 'Run view not found' });
        return;
      }
      try {
        res.json(
          scope.data.runId
            ? await runs.detail(
                hash(session),
                scope.data.tenantId,
                scope.data.runId,
              )
            : await runs.list(
                hash(session),
                scope.data.tenantId,
                query.data.after,
              ),
        );
      } catch (error) {
        res
          .status(
            error instanceof Error && error.message === 'run_view_not_found'
              ? 404
              : 503,
          )
          .json({ error: 'Run view unavailable' });
      }
    });
  }
  if (controls) {
    const controlPath = '/tenants/:tenantId/runs/:runId';
    router.use(controlPath, (req, res, next) => {
      if (req.method !== 'GET' && req.get('origin') !== config.origin) {
        res.status(403).json({ error: 'Invalid origin' });
        return;
      }
      next();
    });
    const scopeFor = (req: Request) => {
      const session = cookie(req, sessionName);
      if (!session) throw Error('control_login_required');
      return {
        sessionHash: hash(session),
        ...z.object({ tenantId: z.uuid(), runId: z.uuid() }).parse(req.params),
      };
    };
    const fail = (res: import('express').Response, error: unknown) => {
      const code = error instanceof Error ? error.message : '';
      res
        .status(
          error instanceof z.ZodError
            ? 400
            : code === 'control_login_required'
              ? 401
              : code === 'control_not_found'
                ? 404
                : [
                      'control_revision_conflict',
                      'control_request_conflict',
                      'control_run_active',
                      'control_disabled',
                      'control_pr_unavailable',
                    ].includes(code)
                  ? 409
                  : 503,
        )
        .json({
          error: [
            'control_revision_conflict',
            'control_run_active',
            'control_disabled',
            'control_pr_unavailable',
          ].includes(code)
            ? code
            : 'Run control unavailable',
        });
    };
    router.get(controlPath + '/configuration', async (req, res) => {
      try {
        res.json(await controls.store.get(scopeFor(req)));
      } catch (error) {
        fail(res, error);
      }
    });
    router.post(
      controlPath + '/configuration',
      json({ limit: '4kb', inflate: false }),
      async (req, res) => {
        try {
          res.json(await controls.store.save(scopeFor(req), req.body));
        } catch (error) {
          fail(res, error);
        }
      },
    );
    router.post(
      controlPath + '/rerun',
      json({ limit: '1kb', inflate: false }),
      async (req, res) => {
        try {
          const scope = scopeFor(req);
          const { requestId } = z
            .strictObject({ requestId: z.uuid() })
            .parse(req.body);
          if (!controls.rerun) throw Error('control_unconfigured');
          res.status(202).json(await controls.rerun(scope, requestId));
        } catch (error) {
          fail(res, error);
        }
      },
    );
  }
  router.post('/logout', async (req, res) => {
    if (req.get('origin') !== config.origin) {
      res.status(403).json({ error: 'Invalid origin' });
      return;
    }
    try {
      const session = cookie(req, sessionName);
      if (session) await store.revoke(hash(session));
      res.clearCookie(sessionName, options).status(204).end();
    } catch {
      res.status(503).json({ error: 'Logout unavailable' });
    }
  });
  return router;
}
