import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  chmod,
  symlink,
  unlink,
  mkdir,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import {
  persistPrivateArtifact,
  readPrivateArtifact,
  prunePrivateArtifacts,
  verifyFindingArtifacts,
} from './private-artifacts.js';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dogwatch-private-'));
  const scope = {
    tenantId: randomUUID(),
    runId: randomUUID(),
    repositoryId: 20,
    sha: 'a'.repeat(40),
    role: 'head',
  };
  const content = {
    version: 1,
    kind: 'browser_observation',
    contentPolicy: 'reviewed_redacted',
    createdAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    payload: { format: 'json', value: { code: 'synthetic_failure' } },
  };
  return {
    root,
    scope,
    content,
    cleanup: () => rm(root, { recursive: true, force: true }),
    dir: join(root, 'findings-v2', scope.tenantId, scope.runId),
  };
}
test('private roundtrip detaches input, persists integrity metadata and uses private file permissions', async () => {
  const f = await fixture();
  try {
    const pending = persistPrivateArtifact(f.root, f.scope, f.content);
    f.content.payload.value.code = 'changed';
    const ref = await pending;
    const saved = await readPrivateArtifact(f.root, f.scope, ref);
    assert.equal(saved.content.payload.format, 'json');
    if (saved.content.payload.format === 'json')
      assert.deepEqual(saved.content.payload.value, {
        code: 'synthetic_failure',
      });
    assert.equal(
      (await stat(join(f.dir, ref.artifactId + '.json'))).mode & 0o777,
      0o600,
    );
    assert.equal((await stat(f.dir)).mode & 0o777, 0o700);
  } finally {
    await f.cleanup();
  }
});
test('all scope dimensions, forged metadata and traversal identifiers fail closed', async () => {
  const f = await fixture();
  try {
    const ref = await persistPrivateArtifact(f.root, f.scope, f.content);
    for (const patch of [
      { tenantId: randomUUID() },
      { runId: randomUUID() },
      { repositoryId: 99 },
      { sha: 'b'.repeat(40) },
      { role: 'base' },
    ])
      await assert.rejects(
        readPrivateArtifact(f.root, { ...f.scope, ...patch }, ref),
      );
    for (const patch of [
      { artifactId: '../outside' },
      { kind: 'replay_result' },
      { sha256: 'f'.repeat(64) },
      { bytes: ref.bytes + 1 },
    ])
      await assert.rejects(
        readPrivateArtifact(f.root, f.scope, { ...ref, ...patch }),
      );
  } finally {
    await f.cleanup();
  }
});
test('tampered payload, permissive files and symlinks cannot be read', async () => {
  const f = await fixture();
  try {
    const ref = await persistPrivateArtifact(f.root, f.scope, f.content),
      path = join(f.dir, ref.artifactId + '.json');
    const original = await readFile(path, 'utf8');
    const envelope = JSON.parse(original);
    envelope.content.payload.value.code = 'tampered';
    await writeFile(path, JSON.stringify(envelope));
    await assert.rejects(readPrivateArtifact(f.root, f.scope, ref));
    await writeFile(path, original);
    await chmod(path, 0o644);
    await assert.rejects(readPrivateArtifact(f.root, f.scope, ref));
    await chmod(path, 0o600);
    const target = join(f.root, 'target');
    await writeFile(target, original, { mode: 0o600 });
    await unlink(path);
    await symlink(target, path);
    await assert.rejects(readPrivateArtifact(f.root, f.scope, ref));
  } finally {
    await f.cleanup();
  }
});
test('payload complexity, raw unsupported values, expiry and byte limits are enforced before write', async () => {
  const f = await fixture();
  try {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [
      cyclic,
      { bad: undefined },
      { date: new Date() },
      'x'.repeat(2 * 1024 * 1024),
    ])
      await assert.rejects(
        persistPrivateArtifact(f.root, f.scope, {
          ...f.content,
          payload: { format: 'json', value },
        }),
      );
    await assert.rejects(
      persistPrivateArtifact(f.root, f.scope, {
        ...f.content,
        expiresAt: new Date(Date.now() - 100).toISOString(),
      }),
    );
    await assert.rejects(
      persistPrivateArtifact(f.root, f.scope, {
        ...f.content,
        expiresAt: new Date(Date.now() + 8 * 86400000).toISOString(),
      }),
    );
    await assert.rejects(
      persistPrivateArtifact(f.root, f.scope, {
        ...f.content,
        kind: 'screenshot',
        payload: { format: 'png', base64: 'bad' },
      }),
    );
  } finally {
    await f.cleanup();
  }
});
test('existing writer locks and unsafe directories are not repaired or stolen', async () => {
  const f = await fixture();
  try {
    await persistPrivateArtifact(f.root, f.scope, f.content);
    await mkdir(join(f.dir, '.write-lock'));
    await assert.rejects(persistPrivateArtifact(f.root, f.scope, f.content));
    await chmod(f.dir, 0o755);
    await assert.rejects(persistPrivateArtifact(f.root, f.scope, f.content));
  } finally {
    await f.cleanup();
  }
});
test('pruning removes only validated expired objects in the authorized scope', async () => {
  const f = await fixture();
  try {
    const ref = await persistPrivateArtifact(f.root, f.scope, f.content),
      other = await persistPrivateArtifact(
        f.root,
        { ...f.scope, sha: 'b'.repeat(40) },
        f.content,
      );
    const path = join(f.dir, ref.artifactId + '.json');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    saved.content.expiresAt = new Date(Date.now() - 1).toISOString();
    saved.reference.expiresAt = saved.content.expiresAt;
    const bytes = Buffer.from(JSON.stringify(saved.content));
    saved.reference.bytes = bytes.length;
    saved.reference.sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(path, JSON.stringify(saved));
    await assert.rejects(readPrivateArtifact(f.root, f.scope, saved.reference));
    assert.equal(await prunePrivateArtifacts(f.root, f.scope), 1);
    assert.equal(await prunePrivateArtifacts(f.root, f.scope), 0);
    assert.ok(
      await readPrivateArtifact(
        f.root,
        { ...f.scope, sha: 'b'.repeat(40) },
        other,
      ),
    );
  } finally {
    await f.cleanup();
  }
});
test('finding verification authorizes each stored reference and leaves semantic truth unverified', async () => {
  const f = await fixture();
  try {
    const ref = await persistPrivateArtifact(f.root, f.scope, f.content);
    const context = {
      tenantId: f.scope.tenantId,
      runId: f.scope.runId,
      repositoryId: 20,
      pullRequestNumber: 42,
      headSha: f.scope.sha,
    };
    const finding = {
      ...context,
      version: 2,
      findingId: 'fixture',
      tier: 'tier2',
      environment: { deploymentId: 'fixture', role: 'head' },
      contentPolicy: 'reviewed_redacted',
      createdAt: new Date().toISOString(),
      target: { kind: 'journey', journeyId: 'checkout' },
      title: 'Synthetic failure',
      expected: 'Success',
      actual: 'Failure',
      reproductionSteps: ['Run synthetic fixture'],
      evidence: [ref],
      baseline: { status: 'unavailable' },
      category: 'confirmed_failure',
      severity: 'low',
      confidence: 'confirmed',
      basis: { kind: 'validated_observation', artifactId: ref.artifactId },
    };
    let checked = 0;
    const result = await verifyFindingArtifacts(
      f.root,
      finding,
      context,
      async () => {
        checked++;
        return true;
      },
    );
    assert.equal(checked, 1);
    assert.equal(result.verification, 'references_verified');
    assert.equal(result.semanticVerification, 'not_performed');
    await assert.rejects(
      verifyFindingArtifacts(f.root, finding, context, async () => false),
      /artifact_forbidden/,
    );
    await unlink(join(f.dir, ref.artifactId + '.json'));
    await assert.rejects(
      verifyFindingArtifacts(f.root, finding, context, async () => true),
    );
  } finally {
    await f.cleanup();
  }
});

test('baseline artifacts require independent read authorization', async () => {
  const f = await fixture();
  try {
    const head = await persistPrivateArtifact(f.root, f.scope, f.content);
    const baseScope = {
      ...f.scope,
      runId: randomUUID(),
      sha: 'b'.repeat(40),
      role: 'base',
    };
    const base = await persistPrivateArtifact(f.root, baseScope, f.content);
    const comparison = await persistPrivateArtifact(f.root, f.scope, {
      ...f.content,
      kind: 'baseline_comparison',
    });
    const context = {
      tenantId: f.scope.tenantId,
      runId: f.scope.runId,
      repositoryId: 20,
      pullRequestNumber: 42,
      headSha: f.scope.sha,
    };
    const finding = {
      ...context,
      version: 2,
      findingId: 'baseline',
      tier: 'tier2',
      environment: { deploymentId: 'fixture', role: 'head' },
      contentPolicy: 'reviewed_redacted',
      createdAt: new Date().toISOString(),
      target: { kind: 'journey', journeyId: 'checkout' },
      title: 'Synthetic comparison',
      expected: 'Success',
      actual: 'Failure',
      reproductionSteps: ['Run fixture'],
      evidence: [head, comparison],
      baseline: {
        status: 'new_regression',
        baseSha: baseScope.sha,
        baseRunId: baseScope.runId,
        comparisonArtifactId: comparison.artifactId,
        evidence: [base],
      },
      category: 'confirmed_failure',
      severity: 'low',
      confidence: 'confirmed',
      basis: { kind: 'validated_observation', artifactId: head.artifactId },
    };
    await assert.rejects(
      verifyFindingArtifacts(
        f.root,
        finding,
        context,
        async (reference) => reference.role === 'head',
      ),
      /artifact_forbidden/,
    );
    assert.equal(
      (await verifyFindingArtifacts(f.root, finding, context, async () => true))
        .artifactIds.length,
      3,
    );
  } finally {
    await f.cleanup();
  }
});

test('per-run quota refuses additional publication without overwriting existing files', async () => {
  const f = await fixture();
  try {
    const ref = await persistPrivateArtifact(f.root, f.scope, f.content);
    for (let i = 0; i < 49; i++)
      await writeFile(join(f.dir, randomUUID() + '.json'), '{}', {
        mode: 0o600,
      });
    await assert.rejects(
      persistPrivateArtifact(f.root, f.scope, f.content),
      /artifact_run_budget/,
    );
    assert.ok(await readPrivateArtifact(f.root, f.scope, ref));
  } finally {
    await f.cleanup();
  }
});

test('two tenants with the same run ID cannot substitute or prune each other’s artifacts', async () => {
  const f = await fixture();
  try {
    const other = { ...f.scope, tenantId: randomUUID() };
    const a = await persistPrivateArtifact(f.root, f.scope, f.content);
    const b = await persistPrivateArtifact(f.root, other, f.content);
    await readPrivateArtifact(f.root, f.scope, a);
    await readPrivateArtifact(f.root, other, b);
    await assert.rejects(readPrivateArtifact(f.root, f.scope, b));
    await assert.rejects(readPrivateArtifact(f.root, other, a));
    await assert.rejects(
      readPrivateArtifact(f.root, other, { ...a, tenantId: other.tenantId }),
    );
    await prunePrivateArtifacts(f.root, other);
    await readPrivateArtifact(f.root, f.scope, a);
  } finally {
    await f.cleanup();
  }
});
