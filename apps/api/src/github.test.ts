/** Exercise the actual Octokit auth/request path with a synthetic key and transport. */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { createGitHubResolver } from './github.js';

// This key exists only in test memory; no App registration or external calls occur.
const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('adapter limits token to one repository and read grants, resolves canonical PR context', async () => {
  const calls: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/app/installations/10'))
      return json({ id: 10, suspended_at: null });
    if (url.endsWith('/app/installations/10/access_tokens')) {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        repository_ids: [20],
        permissions: { metadata: 'read', pull_requests: 'read' },
      });
      return json(
        {
          token: 'synthetic-installation-token',
          expires_at: '2099-01-01T00:00:00Z',
        },
        201,
      );
    }
    if (url.endsWith('/repositories/20'))
      return json({ id: 20, name: 'pawmart', owner: { login: 'fixture' } });
    if (url.endsWith('/repos/fixture/pawmart/pulls/42'))
      return json({
        number: 42,
        state: 'open',
        head: { sha: 'b'.repeat(40), repo: { id: 20 } },
        base: { repo: { id: 20 } },
        labels: [{ name: 'dogwatch' }],
      });
    throw new Error('Unexpected remote endpoint');
  };
  const result = await createGitHubResolver(1, key, transport)(10, 20, 42);
  assert.equal(result.headSha, 'b'.repeat(40));
  assert.equal(result.repositoryId, 20);
  assert.equal(result.installationActive, true);
  assert.equal(calls.length, 4);
});

test('suspended installations stop before minting tokens and remote failures propagate', async () => {
  let calls = 0;
  const suspended: typeof fetch = async () => {
    calls++;
    return json({ suspended_at: '2026-10-04T00:00:00Z' });
  };
  assert.equal(
    (await createGitHubResolver(1, key, suspended)(10, 20, 42))
      .installationActive,
    false,
  );
  assert.equal(calls, 1);
  const revoked: typeof fetch = async () => json({ message: 'Not Found' }, 404);
  await assert.rejects(createGitHubResolver(1, key, revoked)(10, 20, 42));
});
