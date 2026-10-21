/** Private local artifact adapter. Root and scope come from an authorized supervisor. */
import { constants } from 'node:fs';
import {
  mkdir,
  lstat,
  open,
  link,
  unlink,
  readdir,
  rmdir,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  smokeEvidenceSchema,
  compareSmokeEvidence,
  comparisonContextSchema,
} from './smoke-evidence.js';
import type { SmokeEvidence } from './smoke-evidence.js';
const limit = 2 * 1024 * 1024;
export const evidenceScopeSchema = z.strictObject({
  tenantId: z.uuid(),
  runId: z.uuid(),
  repositoryId: z.number().int().positive().safe(),
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  role: z.enum(['base', 'head']),
});
export type EvidenceScope = z.infer<typeof evidenceScopeSchema>;
const referenceSchema = evidenceScopeSchema.extend({
  artifactId: z.uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().min(1).max(limit),
  expiresAt: z.iso.datetime(),
});
const envelopeSchema = z.strictObject({
  reference: referenceSchema,
  record: smokeEvidenceSchema,
});
function checkScope(scope: EvidenceScope, record: EvidenceScope) {
  if (
    Object.keys(scope).some(
      (key) =>
        scope[key as keyof EvidenceScope] !==
        record[key as keyof EvidenceScope],
    )
  )
    throw new Error('evidence_scope_mismatch');
}
async function privateDirectory(path: string, create: boolean) {
  if (create)
    await mkdir(path, { mode: 0o700 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error('evidence_directory_not_private');
}
async function directory(root: string, scope: EvidenceScope, create: boolean) {
  // The root's parent is operator-owned; descendants must never be symlinks.
  const resolvedRoot = resolve(root);
  await privateDirectory(resolvedRoot, create);
  const tenant = join(resolvedRoot, scope.tenantId);
  await privateDirectory(tenant, create);
  const run = join(tenant, scope.runId);
  await privateDirectory(run, create);
  return run;
}
async function readEnvelope(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit || (info.mode & 0o077) !== 0)
      throw new Error('evidence_file_invalid');
    // Allocate the fixed ceiling rather than allowing a concurrent file growth to
    // make readFile allocate arbitrary memory. The directory is operator-private.
    const bytes = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const chunk = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!chunk.bytesRead) break;
      offset += chunk.bytesRead;
    }
    if (offset > limit) throw new Error('evidence_byte_budget');
    const saved = envelopeSchema.parse(
      JSON.parse(bytes.subarray(0, offset).toString('utf8')),
    );
    const content = Buffer.from(JSON.stringify(saved.record));
    if (
      content.length !== saved.reference.bytes ||
      createHash('sha256').update(content).digest('hex') !==
        saved.reference.sha256 ||
      saved.record.expiresAt !== saved.reference.expiresAt
    )
      throw new Error('evidence_integrity_failed');
    checkScope(
      evidenceScopeSchema.strip().parse(saved.reference),
      saved.record,
    );
    return saved;
  } finally {
    await file.close();
  }
}

export async function persistSmokeEvidence(
  root: string,
  scopeInput: EvidenceScope,
  recordInput: SmokeEvidence,
) {
  const scope = evidenceScopeSchema.parse(scopeInput);
  const record = smokeEvidenceSchema.parse(recordInput);
  checkScope(scope, record);
  const now = Date.now();
  if (Date.parse(record.createdAt) > now || Date.parse(record.expiresAt) <= now)
    throw new Error('evidence_expired');
  const content = Buffer.from(JSON.stringify(record));
  if (content.length > limit - 2048) throw new Error('evidence_byte_budget');
  const run = await directory(root, scope, true);
  // Serialize writers across processes. A crashed writer leaves a fail-closed
  // lock requiring supervisor reconciliation; never steal a potentially live lock.
  const lock = join(run, '.write-lock');
  await mkdir(lock, { mode: 0o700 });
  const artifactId = randomUUID();
  const temporary = join(run, `.${artifactId}.tmp`);
  try {
    const names = await readdir(run);
    if (names.filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)).length >= 50)
      throw new Error('evidence_run_budget');
    const reference = referenceSchema.parse({
      ...scope,
      artifactId,
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes: content.length,
      expiresAt: record.expiresAt,
    });
    const file = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(JSON.stringify({ reference, record }));
      await file.sync();
    } finally {
      await file.close();
    }
    // Publish only complete, synced records, without replacing an existing name.
    await link(temporary, join(run, `${artifactId}.json`));
    await unlink(temporary);
    const folder = await open(run, constants.O_RDONLY);
    try {
      await folder.sync();
    } finally {
      await folder.close();
    }
    return reference;
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await rmdir(lock);
  }
}
export async function readSmokeEvidence(
  root: string,
  scopeInput: EvidenceScope,
  artifactIdInput: string,
) {
  const scope = evidenceScopeSchema.parse(scopeInput);
  const artifactId = z.uuid().parse(artifactIdInput);
  const run = await directory(root, scope, false);
  const saved = await readEnvelope(join(run, `${artifactId}.json`));
  checkScope(scope, saved.record);
  if (saved.reference.artifactId !== artifactId)
    throw new Error('evidence_identity_mismatch');
  if (
    Date.parse(saved.record.createdAt) > Date.now() ||
    Date.parse(saved.record.expiresAt) <= Date.now()
  )
    throw new Error('evidence_expired');
  return saved;
}
/** Remove only validated expired records for an independently authorized scope. */
export async function pruneSmokeEvidence(
  root: string,
  scopeInput: EvidenceScope,
) {
  const scope = evidenceScopeSchema.parse(scopeInput);
  const run = await directory(root, scope, false);
  let removed = 0;
  for (const name of await readdir(run)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const saved = await readEnvelope(join(run, name));
    // Other commits/roles can share a run directory; leave them to their scope.
    if (
      Object.keys(scope).some(
        (key) =>
          scope[key as keyof EvidenceScope] !==
          saved.record[key as keyof EvidenceScope],
      )
    )
      continue;
    if (saved.reference.artifactId + '.json' !== name)
      throw new Error('evidence_identity_mismatch');
    if (Date.parse(saved.record.expiresAt) <= Date.now()) {
      await unlink(join(run, name));
      removed++;
    }
  }
  return removed;
}

/** Authenticated internal lookup plus attribution; never accept scope from a public body. */
export async function compareStoredSmokeEvidence(
  root: string,
  contextInput: Parameters<typeof compareSmokeEvidence>[0],
  headArtifactId: string,
  baseArtifactId?: string,
) {
  const context = comparisonContextSchema.parse(contextInput);
  const identity = {
    tenantId: context.tenantId,
    runId: context.runId,
    repositoryId: context.repositoryId,
  };
  const head = await readSmokeEvidence(
    root,
    { ...identity, sha: context.headSha, role: 'head' },
    headArtifactId,
  );
  const base =
    baseArtifactId === undefined
      ? undefined
      : await readSmokeEvidence(
          root,
          { ...identity, sha: context.baseSha, role: 'base' },
          baseArtifactId,
        );
  return {
    ...compareSmokeEvidence(context, head.record, base?.record),
    artifactReferences: { head: head.reference, base: base?.reference },
  };
}
