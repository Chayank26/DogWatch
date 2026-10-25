import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Identity, IdentityStore } from '@dogwatch/database';
import { createApiApp } from './app.js';
import {
  createIdentityRouter,
  requireMembership,
  validateLoginConfig,
} from './identity.js';
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
async function fixture(secure = false) {
  let time = Date.now(),
    unavailable = false,
    providerFailure = false;
  const attempts = new Map<string, { browser: string; expires: number }>();
  const sessions = new Map<string, number>();
  const identity: Identity = {
    id: randomUUID(),
    githubId: '42',
    login: 'fixture',
    memberships: [{ tenantId: randomUUID(), name: 'Fixture', role: 'owner' }],
  };
  const calls: string[] = [];
  const store: IdentityStore = {
    async begin(state, browser, expires) {
      attempts.set(state, { browser, expires: +expires });
    },
    async consume(state, browser, now) {
      const attempt = attempts.get(state);
      if (!attempt || attempt.browser !== browser || attempt.expires <= +now)
        return false;
      attempts.delete(state);
      return true;
    },
    async issue(id, login, token, expires, old) {
      assert.equal(id, '42');
      assert.equal(login, 'fixture');
      if (old) sessions.delete(old);
      sessions.set(token, +expires);
    },
    async resolve(token, now) {
      if (unavailable) throw Error('private database detail');
      return (sessions.get(token) ?? 0) > +now ? identity : null;
    },
    async revoke(token) {
      sessions.delete(token);
    },
  };
  const origin = secure ? 'https://dogwatch.example' : 'http://localhost:4000';
  let expectedVerifier = '';
  const transport: typeof fetch = async (url, init) => {
    calls.push(String(url));
    assert.equal(init?.redirect, 'error');
    if (providerFailure) return new Response('secret error', { status: 500 });
    if (String(url).endsWith('/access_token')) {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('code_verifier'), expectedVerifier);
      assert.equal(body.get('redirect_uri'), origin + '/auth/github/callback');
      return Response.json({
        access_token: 'private-token',
        token_type: 'bearer',
      });
    }
    assert.equal(
      new Headers(init?.headers).get('authorization'),
      'Bearer private-token',
    );
    return Response.json({ id: 42, login: 'fixture', type: 'User' });
  };
  const app = createApiApp(
    undefined,
    undefined,
    undefined,
    undefined,
    createIdentityRouter(
      { clientId: 'fixture', clientSecret: 'secret', origin },
      store,
      transport,
      () => new Date(time),
    ),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const request = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, redirect: 'manual' });
  const start = async () => {
    const response = await request('/auth/github');
    assert.equal(response.status, 302);
    const url = new URL(response.headers.get('location')!);
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    expectedVerifier = cookie.split('=')[1];
    assert.equal(
      url.searchParams.get('code_challenge'),
      createHash('sha256').update(expectedVerifier).digest('base64url'),
    );
    assert.equal(url.searchParams.get('scope'), '');
    return {
      cookie,
      path:
        '/auth/github/callback?code=synthetic&state=' +
        url.searchParams.get('state'),
      response,
    };
  };
  const login = async (old?: string) => {
    const flow = await start();
    const response = await request(flow.path, {
      headers: { cookie: flow.cookie + (old ? '; ' + old : '') },
    });
    assert.equal(response.status, 302);
    const cookie = response.headers
      .getSetCookie()
      .find((c) => c.includes('dogwatch-session='))!
      .split(';')[0];
    return { cookie, response };
  };
  return {
    identity,
    attempts,
    sessions,
    calls,
    request,
    start,
    login,
    origin,
    advance: (ms: number) => {
      time += ms;
    },
    failStore: () => {
      unavailable = true;
    },
    failProvider: () => {
      providerFailure = true;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeAllConnections();
      }),
  };
}
test('OAuth identity uses PKCE and hashed storage; login grants no new memberships', async () => {
  const f = await fixture(true);
  try {
    f.identity.memberships = [];
    const { cookie, response } = await f.login();
    assert.match(cookie, /^__Host-/);
    const header = response.headers
      .getSetCookie()
      .find((c) => c.includes('dogwatch-session='))!;
    for (const value of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/'])
      assert.ok(header.includes(value));
    const token = cookie.split('=')[1];
    assert.ok(f.sessions.has(digest(token)));
    assert.ok(!f.sessions.has(token));
    const me = await f.request('/auth/me', { headers: { cookie } });
    assert.equal(me.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await me.json(), f.identity);
    assert.equal(f.calls.length, 2);
  } finally {
    await f.close();
  }
});
test('OAuth callback rejects missing browser binding, wrong state, duplicate parameters and replay', async () => {
  const f = await fixture();
  try {
    const flow = await f.start();
    assert.equal((await f.request(flow.path)).status, 400);
    assert.equal(
      (
        await f.request(flow.path + '&state=other', {
          headers: { cookie: flow.cookie },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.request(flow.path, {
          headers: { cookie: flow.cookie.replace(/=.+/, '=' + 'z'.repeat(43)) },
        })
      ).status,
      400,
    );
    assert.equal(f.calls.length, 0);
    const responses = await Promise.all([
      f.request(flow.path, { headers: { cookie: flow.cookie } }),
      f.request(flow.path, { headers: { cookie: flow.cookie } }),
    ]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [302, 400]);
    assert.equal(f.calls.length, 2);
  } finally {
    await f.close();
  }
});
test('expired state and sessions fail closed', async () => {
  const f = await fixture();
  try {
    const flow = await f.start();
    f.advance(600001);
    assert.equal(
      (await f.request(flow.path, { headers: { cookie: flow.cookie } })).status,
      400,
    );
    const { cookie } = await f.login();
    f.advance(28800001);
    assert.equal(
      (await f.request('/auth/me', { headers: { cookie } })).status,
      401,
    );
  } finally {
    await f.close();
  }
});
test('successful login rotates and invalidates the previous session', async () => {
  const f = await fixture();
  try {
    const first = await f.login();
    const second = await f.login(first.cookie);
    assert.notEqual(first.cookie, second.cookie);
    assert.equal(
      (await f.request('/auth/me', { headers: { cookie: first.cookie } }))
        .status,
      401,
    );
    assert.equal(
      (await f.request('/auth/me', { headers: { cookie: second.cookie } }))
        .status,
      200,
    );
  } finally {
    await f.close();
  }
});
test('membership is read fresh, tenant isolation and owner checks refuse escalation', async () => {
  const f = await fixture();
  try {
    const { cookie } = await f.login(),
      tenant = f.identity.memberships[0].tenantId;
    assert.equal(
      (
        await f.request('/auth/tenants/' + randomUUID() + '/membership', {
          headers: { cookie },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await f.request('/auth/tenants/' + tenant + '/membership', {
          headers: { cookie },
        })
      ).status,
      200,
    );
    f.identity.memberships[0].role = 'member';
    assert.throws(
      () => requireMembership(f.identity, tenant, 'owner'),
      /denied/,
    );
    assert.equal(requireMembership(f.identity, tenant).role, 'member');
    f.identity.memberships = [];
    assert.equal(
      (
        await f.request('/auth/tenants/' + tenant + '/membership', {
          headers: { cookie },
        })
      ).status,
      404,
    );
  } finally {
    await f.close();
  }
});
test('logout requires exact Origin and revokes the server session', async () => {
  const f = await fixture();
  try {
    const { cookie } = await f.login();
    for (const origin of ['', 'https://attacker.example'])
      assert.equal(
        (
          await f.request('/auth/logout', {
            method: 'POST',
            headers: { cookie, origin },
          })
        ).status,
        403,
      );
    assert.equal(
      (
        await f.request('/auth/logout', {
          method: 'POST',
          headers: { cookie, origin: f.origin },
        })
      ).status,
      204,
    );
    assert.equal(
      (await f.request('/auth/me', { headers: { cookie } })).status,
      401,
    );
  } finally {
    await f.close();
  }
});
test('upstream failure consumes the attempt and returns no tokens or diagnostics', async () => {
  const f = await fixture();
  try {
    const flow = await f.start();
    f.failProvider();
    const response = await f.request(flow.path, {
      headers: { cookie: flow.cookie },
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Login unavailable' });
    assert.equal(
      (await f.request(flow.path, { headers: { cookie: flow.cookie } })).status,
      400,
    );
    assert.equal(f.sessions.size, 0);
  } finally {
    await f.close();
  }
});
test('storage failures and ambiguous session cookies fail closed', async () => {
  const f = await fixture();
  try {
    const { cookie } = await f.login();
    assert.equal(
      (
        await f.request('/auth/me', {
          headers: { cookie: cookie + '; ' + cookie },
        })
      ).status,
      401,
    );
    f.failStore();
    const response = await f.request('/auth/me', { headers: { cookie } });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Identity unavailable' });
  } finally {
    await f.close();
  }
});
test('login configuration refuses unsafe origins and credentials in URLs', () => {
  for (const origin of [
    'http://example.com',
    'https://example.com/path',
    'https://user:pass@example.com',
    'https://example.com/?next=evil',
  ])
    assert.throws(() =>
      validateLoginConfig({ clientId: 'x', clientSecret: 'y', origin }),
    );
});
