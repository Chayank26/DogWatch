/** Opt-in browser identity. OAuth credentials never enter sessions or worker inputs. */
import { Router } from 'express';
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
        .redirect(config.origin + '/auth/me');
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
