/** Synthetic GitHub transport; no token, network, or repository execution. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { retrieveImmutableDiff } from './diff.js';
const input = {
  owner: 'fixture',
  repository: 'pawmart',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  token: 'synthetic',
};
const payload = {
  base_commit: { sha: input.baseSha },
  merge_base_commit: { sha: input.baseSha },
  commits: [{ sha: input.headSha }],
  total_commits: 1,
  files: [
    {
      filename: 'src/new.ts',
      previous_filename: 'src/old.ts',
      status: 'renamed',
      additions: 1,
      deletions: 1,
    },
  ],
};
test('comparison is SHA-bound and preserves rename metadata without patches', async () => {
  const result = await retrieveImmutableDiff(input, {
    requestFetch: async (url, options) => {
      assert.match(String(url), new RegExp(input.headSha));
      assert.equal(options?.redirect, 'error');
      return Response.json(payload);
    },
  });
  assert.equal(result.complete, true);
  assert.equal(result.files[0].previous_filename, 'src/old.ts');
});
test('wrong heads, unsafe paths, oversized bodies, and failed authorization cannot yield a diff', async () => {
  for (const value of [
    { ...payload, commits: [] },
    { ...payload, files: [{ ...payload.files[0], filename: '../secret' }] },
  ])
    await assert.rejects(
      retrieveImmutableDiff(input, {
        requestFetch: async () => Response.json(value),
      }),
    );
  await assert.rejects(
    retrieveImmutableDiff(input, {
      requestFetch: async () => new Response('x'.repeat(2097153)),
    }),
  );
  await assert.rejects(
    retrieveImmutableDiff(input, {
      requestFetch: async () => new Response('', { status: 403 }),
    }),
  );
});

test('provider limits remain explicit coverage gaps rather than false completeness', async () => {
  const result = await retrieveImmutableDiff(input, {
    requestFetch: async () =>
      Response.json({
        ...payload,
        total_commits: 251,
        files: Array.from({ length: 300 }, () => payload.files[0]),
      }),
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.coverageGaps, ['file_limit', 'commit_limit']);
});
