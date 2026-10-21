import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  readdir,
  chmod,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  persistSmokeEvidence,
  readSmokeEvidence,
  pruneSmokeEvidence,
} from './evidence-store.js';
import type { EvidenceScope } from './evidence-store.js';
import { runSmokeWithEvidence } from './smoke-evidence.js';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dogwatch-evidence-'));
  const scope: EvidenceScope = {
    tenantId: randomUUID(),
    runId: randomUUID(),
    repositoryId: 20,
    sha: 'a'.repeat(40),
    role: 'head',
  };
  const record = await runSmokeWithEvidence(
    {
      tenantId: scope.tenantId,
      runId: scope.runId,
      repositoryId: scope.repositoryId,
      headSha: scope.sha,
      maxExecutionMs: 20000,
      maxSteps: 30,
      journeys: [
        {
          id: 'checkout',
          dependsOn: [],
          steps: [{ kind: 'navigate', path: '/' }],
        },
      ],
    },
    {
      execute: async () => {},
      events: () => ({
        consoleErrors: 0,
        pageErrors: 0,
        serverErrors: 0,
        networkErrors: 0,
        blockedRequests: 0,
      }),
      close: async () => {},
    },
    { role: 'head', scenarioId: 'pawmart-v1', isCurrent: async () => true },
  );
  return { root, scope, record };
}
test('private evidence survives adapter restart and rejects cross-scope/path access', async () => {
  const { root, scope, record } = await fixture();
  try {
    const reference = await persistSmokeEvidence(root, scope, record);
    assert.deepEqual(
      (await readSmokeEvidence(root, scope, reference.artifactId)).record,
      record,
    );
    for (const patch of [
      { tenantId: randomUUID() },
      { runId: randomUUID() },
      { repositoryId: 21 },
      { sha: 'b'.repeat(40) },
      { role: 'base' as const },
    ])
      await assert.rejects(
        readSmokeEvidence(root, { ...scope, ...patch }, reference.artifactId),
      );
    await assert.rejects(readSmokeEvidence(root, scope, '../secret'));
    await assert.rejects(
      persistSmokeEvidence(root, { ...scope, repositoryId: 21 }, record),
    );
    assert.equal(
      (await readdir(join(root, scope.tenantId, scope.runId))).length,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('corruption, symlink artifacts and permissive directories fail closed', async () => {
  const { root, scope, record } = await fixture();
  try {
    const reference = await persistSmokeEvidence(root, scope, record);
    const path = join(
      root,
      scope.tenantId,
      scope.runId,
      `${reference.artifactId}.json`,
    );
    const original = await readFile(path, 'utf8');
    const changed = JSON.parse(original);
    changed.record.executionMs++;
    await writeFile(path, JSON.stringify(changed));
    await assert.rejects(readSmokeEvidence(root, scope, reference.artifactId));
    await writeFile(path, original);
    const other = randomUUID();
    await symlink(
      path,
      join(root, scope.tenantId, scope.runId, `${other}.json`),
    );
    await assert.rejects(readSmokeEvidence(root, scope, other));
    await chmod(join(root, scope.tenantId), 0o755);
    await assert.rejects(readSmokeEvidence(root, scope, reference.artifactId));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('expired records are inaccessible and explicitly pruned within their scope', async () => {
  const { root, scope, record } = await fixture();
  try {
    const reference = await persistSmokeEvidence(root, scope, record);
    const path = join(
      root,
      scope.tenantId,
      scope.runId,
      `${reference.artifactId}.json`,
    );
    const saved = JSON.parse(await readFile(path, 'utf8'));
    saved.record.createdAt = new Date(Date.now() - 20000).toISOString();
    saved.record.expiresAt = new Date(Date.now() - 10000).toISOString();
    saved.reference.expiresAt = saved.record.expiresAt;
    const content = Buffer.from(JSON.stringify(saved.record));
    saved.reference.bytes = content.length;
    saved.reference.sha256 = createHash('sha256').update(content).digest('hex');
    await writeFile(path, JSON.stringify(saved));
    await assert.rejects(readSmokeEvidence(root, scope, reference.artifactId));
    assert.equal(await pruneSmokeEvidence(root, { ...scope, role: 'base' }), 0);
    assert.equal(await pruneSmokeEvidence(root, scope), 1);
    assert.equal(
      (await readdir(join(root, scope.tenantId, scope.runId))).length,
      0,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('oversized artifacts and exhausted per-run storage cannot bypass fixed ceilings', async () => {
  const { root, scope, record } = await fixture();
  try {
    const reference = await persistSmokeEvidence(root, scope, record);
    const run = join(root, scope.tenantId, scope.runId);
    await writeFile(
      join(run, `${reference.artifactId}.json`),
      ' '.repeat(2 * 1024 * 1024 + 1),
    );
    await assert.rejects(readSmokeEvidence(root, scope, reference.artifactId));
    for (let index = 1; index < 50; index++)
      await writeFile(join(run, `${randomUUID()}.json`), '{}', { mode: 0o600 });
    await assert.rejects(
      persistSmokeEvidence(root, scope, record),
      /evidence_run_budget/,
    );
    assert.equal((await readdir(run)).includes('.write-lock'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
