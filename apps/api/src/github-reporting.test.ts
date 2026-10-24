/** Actual Octokit transport path with synthetic keys and in-memory GitHub responses only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createGitHubReporter,
  createGitHubReportRetirer,
} from './github-reporting.js';
const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dogwatch-reporting-'));
  const scope = {
    tenantId: randomUUID(),
    runId: randomUUID(),
    installationId: 10,
    repositoryId: 20,
    pullRequestNumber: 42,
    headSha: 'a'.repeat(40),
  };
  const comments: Record<string, unknown>[] = [];
  const checks: Record<string, unknown>[] = [];
  let commentPosts = 0,
    checkPosts = 0,
    writes = 0,
    head = scope.headSha,
    loseComment = false,
    hideComments = false,
    foreignApp = false,
    losePatch = false,
    changeAfterCheck = false;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      method = init?.method ?? 'GET',
      body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.pathname === '/app/installations/10')
      return json({ id: 10, app_id: 1, suspended_at: null });
    if (url.pathname.endsWith('/access_tokens')) {
      assert.deepEqual(body, {
        repository_ids: [20],
        permissions: {
          metadata: 'read',
          pull_requests: 'write',
          checks: 'write',
        },
      });
      return json(
        { token: 'synthetic-token', expires_at: '2099-01-01T00:00:00Z' },
        201,
      );
    }
    if (url.pathname === '/repositories/20')
      return json({ id: 20, name: 'fixture', owner: { login: 'owner' } });
    if (url.pathname.endsWith('/pulls/42'))
      return json({
        number: 42,
        state: 'open',
        head: { sha: head, repo: { id: 20 } },
        base: { repo: { id: 20 } },
      });
    if (url.pathname.includes('/commits/'))
      return json({ total_count: checks.length, check_runs: checks });
    if (url.pathname.endsWith('/issues/42/comments') && method === 'GET')
      return json(hideComments ? [] : comments);
    if (method === 'POST' && url.pathname.endsWith('/check-runs')) {
      writes++;
      checkPosts++;
      const record = { ...body, id: 200, app: { id: 1 } };
      checks.push(record);
      if (changeAfterCheck) head = 'b'.repeat(40);
      return json(record, 201);
    }
    if (method === 'PATCH' && url.pathname.endsWith('/check-runs/200')) {
      writes++;
      Object.assign(checks[0], body);
      if (losePatch) {
        losePatch = false;
        return json({ message: 'lost patch' }, 503);
      }
      return json(checks[0]);
    }
    if (method === 'POST' && url.pathname.endsWith('/issues/42/comments')) {
      writes++;
      commentPosts++;
      const record = {
        ...body,
        id: 100,
        performed_via_github_app: { id: foreignApp ? 2 : 1 },
      };
      comments.push(record);
      if (loseComment) {
        loseComment = false;
        return json({ message: 'synthetic response lost' }, 503);
      }
      return json(record, 201);
    }
    if (method === 'PATCH' && url.pathname.endsWith('/issues/comments/100')) {
      writes++;
      Object.assign(comments[0], body);
      return json(comments[0]);
    }
    throw Error('Unexpected endpoint ' + method + ' ' + url.pathname);
  };
  return {
    root,
    scope,
    comments,
    checks,
    publish: createGitHubReporter(1, key, transport),
    retire: createGitHubReportRetirer(1, key, transport),
    retirement: { scope, publicationApproved: true, reason: 'head_changed' },
    losePatch: () => {
      losePatch = true;
    },
    changeAfterCheck: () => {
      changeAfterCheck = true;
    },
    input: {
      scope,
      publicationApproved: true,
      revision: 1,
      phase: 'queued',
      markdown: 'Reviewed synthetic report',
    },
    counts: () => ({ commentPosts, checkPosts, writes }),
    setHead: (sha: string) => {
      head = sha;
    },
    lose: () => {
      loseComment = true;
    },
    hide: () => {
      hideComments = true;
    },
    foreign: () => {
      foreignApp = true;
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
test('queued, running and final revisions update one owned comment and check; identical retries are no-ops', async () => {
  const f = await fixture();
  try {
    const first = await f.publish(f.root, f.input, async () => true);
    assert.equal(first.status, 'published');
    assert.equal(
      (await f.publish(f.root, f.input, async () => true)).status,
      'unchanged',
    );
    assert.equal(f.counts().writes, 2);
    await f.publish(
      f.root,
      { ...f.input, revision: 2, phase: 'in_progress' },
      async () => true,
    );
    await f.publish(
      f.root,
      { ...f.input, revision: 3, phase: 'completed', conclusion: 'neutral' },
      async () => true,
    );
    assert.equal(f.counts().commentPosts, 1);
    assert.equal(f.counts().checkPosts, 1);
    assert.equal(f.checks[0].status, 'completed');
    assert.equal(f.checks[0].conclusion, 'neutral');
    const saved = await readFile(
      join(f.root, f.scope.tenantId, f.scope.runId, 'state.json'),
      'utf8',
    );
    assert.ok(!saved.includes('synthetic-token'));
    assert.ok(!saved.includes('Reviewed synthetic report'));
  } finally {
    await f.cleanup();
  }
});
test('lost create responses reconcile owned remote objects without another POST', async () => {
  const f = await fixture();
  try {
    f.lose();
    await assert.rejects(f.publish(f.root, f.input, async () => true));
    assert.equal(
      (await f.publish(f.root, f.input, async () => true)).status,
      'published',
    );
    assert.equal(f.counts().commentPosts, 1);
    assert.equal(f.counts().checkPosts, 1);
  } finally {
    await f.cleanup();
  }
});
test('uncertain creates absent from reconciliation never trigger blind recreation', async () => {
  const f = await fixture();
  try {
    f.lose();
    await assert.rejects(f.publish(f.root, f.input, async () => true));
    f.hide();
    await assert.rejects(
      f.publish(f.root, f.input, async () => true),
      /delivery_uncertain/,
    );
    assert.equal(f.counts().commentPosts, 1);
  } finally {
    await f.cleanup();
  }
});
test('foreign-app markers cannot be adopted after an uncertain create', async () => {
  const f = await fixture();
  try {
    f.foreign();
    f.lose();
    await assert.rejects(f.publish(f.root, f.input, async () => true));
    await assert.rejects(
      f.publish(f.root, f.input, async () => true),
      /delivery_uncertain/,
    );
  } finally {
    await f.cleanup();
  }
});
test('stale SHA and revoked local authority prevent publication', async () => {
  const f = await fixture();
  try {
    f.setHead('b'.repeat(40));
    await assert.rejects(
      f.publish(f.root, f.input, async () => true),
      /report_stale/,
    );
    assert.equal(f.counts().writes, 0);
    await assert.rejects(
      f.publish(f.root, f.input, async () => false),
      /report_stale/,
    );
  } finally {
    await f.cleanup();
  }
});
test('publication approval, complete-coverage success and blocking-failure policy are explicit', async () => {
  const f = await fixture();
  try {
    for (const patch of [
      { publicationApproved: false },
      { phase: 'completed', conclusion: 'success' },
      { phase: 'completed', conclusion: 'failure' },
      { phase: 'queued', conclusion: 'neutral' },
    ])
      await assert.rejects(
        f.publish(f.root, { ...f.input, ...patch }, async () => true),
      );
    assert.equal(f.counts().writes, 0);
    await f.publish(
      f.root,
      { ...f.input, phase: 'completed', conclusion: 'failure', blocking: true },
      async () => true,
    );
    assert.equal(f.checks[0].conclusion, 'failure');
  } finally {
    await f.cleanup();
  }
});
test('older revisions, conflicting content and phase regression cannot overwrite delivered state', async () => {
  const f = await fixture();
  try {
    await f.publish(
      f.root,
      { ...f.input, revision: 2, phase: 'completed', conclusion: 'neutral' },
      async () => true,
    );
    const before = f.counts().writes;
    await assert.rejects(
      f.publish(f.root, f.input, async () => true),
      /revision_stale/,
    );
    await assert.rejects(
      f.publish(
        f.root,
        {
          ...f.input,
          revision: 2,
          phase: 'completed',
          conclusion: 'neutral',
          markdown: 'Changed',
        },
        async () => true,
      ),
      /revision_conflict/,
    );
    await assert.rejects(
      f.publish(f.root, { ...f.input, revision: 3 }, async () => true),
      /phase_regression/,
    );
    assert.equal(f.counts().writes, before);
  } finally {
    await f.cleanup();
  }
});

test('concurrent attempts serialize and cannot create duplicate remote objects', async () => {
  const f = await fixture();
  try {
    const results = await Promise.allSettled([
      f.publish(f.root, f.input, async () => true),
      f.publish(f.root, f.input, async () => true),
    ]);
    assert.ok(results.some((result) => result.status === 'fulfilled'));
    assert.equal(f.counts().commentPosts, 1);
    assert.equal(f.counts().checkPosts, 1);
    assert.equal(
      (await f.publish(f.root, f.input, async () => true)).status,
      'unchanged',
    );
  } finally {
    await f.cleanup();
  }
});

test('retirement withdraws an old verdict, is idempotent and permanently fences publication', async () => {
  const f = await fixture();
  try {
    await f.publish(
      f.root,
      {
        ...f.input,
        phase: 'completed',
        conclusion: 'success',
        coverageComplete: true,
      },
      async () => true,
    );
    f.setHead('b'.repeat(40));
    assert.equal(
      (await f.retire(f.root, f.retirement, async () => true)).status,
      'retired',
    );
    assert.equal(f.checks[0].conclusion, 'cancelled');
    assert.match(String(f.comments[0].body), /report withdrawn/);
    assert.ok(!String(f.comments[0].body).includes(f.input.markdown));
    const writes = f.counts().writes;
    assert.equal(
      (await f.retire(f.root, f.retirement, async () => true)).status,
      'unchanged',
    );
    f.setHead(f.scope.headSha);
    await assert.rejects(
      f.publish(f.root, { ...f.input, revision: 99 }, async () => true),
      /report_retired/,
    );
    assert.equal(f.counts().writes, writes);
    assert.equal(f.counts().checkPosts, 1);
    assert.equal(f.counts().commentPosts, 1);
  } finally {
    await f.cleanup();
  }
});
test('head change between writes retires only the existing check without creating a comment', async () => {
  const f = await fixture();
  try {
    f.changeAfterCheck();
    await assert.rejects(
      f.publish(f.root, f.input, async () => true),
      /report_stale/,
    );
    await f.retire(f.root, f.retirement, async () => true);
    assert.equal(f.checks[0].conclusion, 'cancelled');
    assert.equal(f.counts().commentPosts, 0);
  } finally {
    await f.cleanup();
  }
});
test('retirement recovers a lost PATCH response and finishes the remaining comment update', async () => {
  const f = await fixture();
  try {
    await f.publish(f.root, f.input, async () => true);
    f.setHead('b'.repeat(40));
    f.losePatch();
    await assert.rejects(f.retire(f.root, f.retirement, async () => true));
    await assert.rejects(
      f.publish(f.root, f.input, async () => true),
      /report_retired/,
    );
    await f.retire(f.root, f.retirement, async () => true);
    assert.equal(f.checks[0].conclusion, 'cancelled');
    assert.match(String(f.comments[0].body), /report withdrawn/);
    assert.equal(f.counts().writes, 4);
  } finally {
    await f.cleanup();
  }
});
test('retirement requires independent authority, approval and evidence of a changed head', async () => {
  const f = await fixture();
  try {
    await f.publish(f.root, f.input, async () => true);
    await assert.rejects(
      f.retire(f.root, f.retirement, async () => true),
      /not_stale/,
    );
    f.setHead('b'.repeat(40));
    await assert.rejects(
      f.retire(f.root, f.retirement, async () => false),
      /report_stale/,
    );
    await assert.rejects(
      f.retire(
        f.root,
        { ...f.retirement, publicationApproved: false },
        async () => true,
      ),
    );
    await assert.rejects(
      f.retire(f.root, f.retirement, async () => {
        throw Error('authority unavailable');
      }),
      /authority unavailable/,
    );
    assert.equal(f.counts().writes, 2);
  } finally {
    await f.cleanup();
  }
});
test('same-head cancellation or supersession is explicitly authorized and retirement reasons are immutable', async () => {
  for (const reason of ['cancelled', 'superseded']) {
    const f = await fixture();
    try {
      await f.publish(f.root, f.input, async () => true);
      await f.retire(f.root, { ...f.retirement, reason }, async () => true);
      assert.equal(f.checks[0].conclusion, 'cancelled');
      await assert.rejects(
        f.retire(f.root, f.retirement, async () => true),
        /retirement_conflict/,
      );
    } finally {
      await f.cleanup();
    }
  }
});
test('retirement reconciles lost creates but refuses hidden or foreign remote objects', async () => {
  for (const kind of ['visible', 'hidden', 'foreign']) {
    const f = await fixture();
    try {
      if (kind === 'foreign') f.foreign();
      f.lose();
      await assert.rejects(f.publish(f.root, f.input, async () => true));
      if (kind === 'hidden') f.hide();
      f.setHead('b'.repeat(40));
      if (kind === 'visible') {
        await f.retire(f.root, f.retirement, async () => true);
        assert.match(String(f.comments[0].body), /withdrawn/);
      } else {
        await assert.rejects(
          f.retire(f.root, f.retirement, async () => true),
          /delivery_uncertain/,
        );
        assert.equal(f.counts().writes, 2);
      }
      assert.equal(f.counts().commentPosts, 1);
      assert.equal(f.counts().checkPosts, 1);
    } finally {
      await f.cleanup();
    }
  }
});
test('retiring an unpublished run records a fence without creating remote objects', async () => {
  const f = await fixture();
  try {
    await f.retire(
      f.root,
      { ...f.retirement, reason: 'cancelled' },
      async () => true,
    );
    assert.equal(f.counts().writes, 0);
    await assert.rejects(
      f.publish(f.root, f.input, async () => true),
      /report_retired/,
    );
  } finally {
    await f.cleanup();
  }
});
test('retirement refuses changed tracked identity and cross-scope journals', async () => {
  const f = await fixture();
  try {
    await f.publish(f.root, f.input, async () => true);
    f.setHead('b'.repeat(40));
    await assert.rejects(
      f.retire(
        f.root,
        { ...f.retirement, scope: { ...f.scope, headSha: 'c'.repeat(40) } },
        async () => true,
      ),
      /journal_scope/,
    );
    f.checks[0].app = { id: 2 };
    await assert.rejects(
      f.retire(f.root, f.retirement, async () => true),
      /check_identity/,
    );
    assert.equal(f.counts().writes, 2);
  } finally {
    await f.cleanup();
  }
});

test('revoked retirement authority stops between writes and an authorized retry finishes', async () => {
  const f = await fixture();
  try {
    await f.publish(f.root, f.input, async () => true);
    f.setHead('b'.repeat(40));
    await assert.rejects(
      f.retire(
        f.root,
        f.retirement,
        async () => f.checks[0].conclusion !== 'cancelled',
      ),
      /report_stale/,
    );
    assert.equal(f.checks[0].conclusion, 'cancelled');
    assert.ok(String(f.comments[0].body).includes(f.input.markdown));
    await f.retire(f.root, f.retirement, async () => true);
    assert.match(String(f.comments[0].body), /withdrawn/);
  } finally {
    await f.cleanup();
  }
});
test('retirement leaves another run and SHA untouched', async () => {
  const f = await fixture();
  try {
    await f.publish(f.root, f.input, async () => true);
    const otherComment = {
      ...f.comments[0],
      id: 101,
      body: '<!-- another-run -->\nCurrent report',
    };
    const otherCheck = {
      ...f.checks[0],
      id: 201,
      external_id: 'another-run',
      head_sha: 'b'.repeat(40),
    };
    f.comments.push(otherComment);
    f.checks.push(otherCheck);
    const before = JSON.stringify([otherComment, otherCheck]);
    f.setHead('b'.repeat(40));
    await f.retire(f.root, f.retirement, async () => true);
    assert.equal(JSON.stringify([otherComment, otherCheck]), before);
  } finally {
    await f.cleanup();
  }
});
