/** Private local v2 artifacts; root and direct-store scope must come from a trusted supervisor. */
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
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  findingArtifactSchema,
  validateFindingForContext,
} from '@dogwatch/contracts';
import { evidenceScopeSchema } from './evidence-store.js';
const limit = 2 * 1024 * 1024;
const payloadSchema = z.discriminatedUnion('format', [
  z.strictObject({ format: z.literal('json'), value: z.unknown() }),
  z.strictObject({ format: z.literal('png'), base64: z.string().max(1398104) }),
]);
const contentSchema = z.strictObject({
  version: z.literal(1),
  kind: findingArtifactSchema.shape.kind,
  contentPolicy: z.literal('reviewed_redacted'),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  payload: payloadSchema,
});
const envelopeSchema = z.strictObject({
  reference: findingArtifactSchema,
  content: contentSchema,
});
function validatePayload(content: z.infer<typeof contentSchema>) {
  if (content.kind === 'screenshot') {
    if (content.payload.format !== 'png') throw Error('artifact_media');
    const bytes = Buffer.from(content.payload.base64, 'base64');
    if (
      bytes.toString('base64') !== content.payload.base64 ||
      bytes.length > 1048576 ||
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw Error('artifact_png');
  } else {
    if (content.payload.format !== 'json') throw Error('artifact_media');
    const stack: Array<{ value: unknown; depth: number }> = [
      { value: content.payload.value, depth: 0 },
    ];
    const seen = new Set<object>();
    let nodes = 0;
    while (stack.length) {
      const { value, depth } = stack.pop()!;
      if (++nodes > 10000 || depth > 16) throw Error('artifact_complexity');
      if (
        value === null ||
        typeof value === 'boolean' ||
        typeof value === 'string'
      )
        continue;
      if (typeof value === 'number' && Number.isFinite(value)) continue;
      if (typeof value !== 'object' || seen.has(value))
        throw Error('artifact_json');
      seen.add(value);
      if (
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
      )
        throw Error('artifact_json');
      for (const [key, item] of Object.entries(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key))
          throw Error('artifact_json');
        stack.push({ value: item, depth: depth + 1 });
      }
    }
  }
  const lifetime =
    Date.parse(content.expiresAt) - Date.parse(content.createdAt);
  if (lifetime <= 0 || lifetime > 7 * 86400000) throw Error('artifact_expiry');
}
function matches(
  scope: z.infer<typeof evidenceScopeSchema>,
  reference: z.infer<typeof findingArtifactSchema>,
) {
  return Object.entries(scope).every(
    ([key, value]) => reference[key as keyof typeof reference] === value,
  );
}
async function privateDir(path: string, create: boolean) {
  if (create)
    await mkdir(path, { mode: 0o700 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw Error('artifact_directory');
}
async function directory(
  root: string,
  scope: z.infer<typeof evidenceScopeSchema>,
  create: boolean,
) {
  let path = resolve(root);
  await privateDir(path, create);
  for (const part of ['findings-v2', scope.tenantId, scope.runId]) {
    path = join(path, part);
    await privateDir(path, create);
  }
  return path;
}
async function load(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > limit + 2048)
      throw Error('artifact_file');
    const bytes = Buffer.alloc(limit + 2049);
    let size = 0;
    while (size < bytes.length) {
      const result = await file.read(bytes, size, bytes.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > limit + 2048) throw Error('artifact_size');
    const saved = envelopeSchema.parse(
      JSON.parse(bytes.subarray(0, size).toString('utf8')),
    );
    validatePayload(saved.content);
    const content = Buffer.from(JSON.stringify(saved.content));
    if (
      content.length !== saved.reference.bytes ||
      createHash('sha256').update(content).digest('hex') !==
        saved.reference.sha256 ||
      saved.content.kind !== saved.reference.kind ||
      saved.content.expiresAt !== saved.reference.expiresAt
    )
      throw Error('artifact_integrity');
    return saved;
  } finally {
    await file.close();
  }
}
export async function persistPrivateArtifact(
  root: string,
  scopeInput: unknown,
  input: unknown,
) {
  const scope = evidenceScopeSchema.parse(scopeInput);
  const parsed = contentSchema.parse(input);
  validatePayload(parsed);
  // Serialize before the first await: detach unknown JSON payload values as well.
  const contentBytes = Buffer.from(JSON.stringify(parsed));
  if (contentBytes.length > limit) throw Error('artifact_size');
  const content = contentSchema.parse(
    JSON.parse(contentBytes.toString('utf8')),
  );
  const now = Date.now();
  if (
    Date.parse(content.createdAt) > now ||
    Date.parse(content.expiresAt) <= now
  )
    throw Error('artifact_expired');
  const reference = findingArtifactSchema.parse({
    ...scope,
    kind: content.kind,
    artifactId: randomUUID(),
    sha256: createHash('sha256').update(contentBytes).digest('hex'),
    bytes: contentBytes.length,
    expiresAt: content.expiresAt,
  });
  const dir = await directory(root, scope, true),
    lock = join(dir, '.write-lock');
  await mkdir(lock, { mode: 0o700 });
  const temporary = join(dir, `.${reference.artifactId}.tmp`);
  try {
    const files = await readdir(dir);
    if (files.filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)).length >= 50)
      throw Error('artifact_run_budget');
    const file = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(JSON.stringify({ reference, content }));
      await file.sync();
    } finally {
      await file.close();
    }
    await link(temporary, join(dir, reference.artifactId + '.json'));
    await unlink(temporary);
    const folder = await open(dir, constants.O_RDONLY);
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
export async function readPrivateArtifact(
  root: string,
  scopeInput: unknown,
  referenceInput: unknown,
) {
  const scope = evidenceScopeSchema.parse(scopeInput),
    reference = findingArtifactSchema.parse(referenceInput);
  if (!matches(scope, reference)) throw Error('artifact_scope');
  const dir = await directory(root, scope, false),
    saved = await load(join(dir, reference.artifactId + '.json'));
  if (
    Object.entries(reference).some(
      ([key, value]) =>
        saved.reference[key as keyof typeof reference] !== value,
    )
  )
    throw Error('artifact_reference_mismatch');
  if (
    Date.parse(saved.content.createdAt) > Date.now() ||
    Date.parse(reference.expiresAt) <= Date.now()
  )
    throw Error('artifact_expired');
  return saved;
}
export async function prunePrivateArtifacts(root: string, scopeInput: unknown) {
  const scope = evidenceScopeSchema.parse(scopeInput),
    dir = await directory(root, scope, false);
  let removed = 0;
  for (const name of await readdir(dir)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const saved = await load(join(dir, name));
    if (!matches(scope, saved.reference)) continue;
    if (name !== saved.reference.artifactId + '.json')
      throw Error('artifact_identity');
    if (Date.parse(saved.content.expiresAt) <= Date.now()) {
      await unlink(join(dir, name));
      removed++;
    }
  }
  return removed;
}
/** Scope/bytes verified only. This function does not attest the finding's semantic truth. */
export async function verifyFindingArtifacts(
  root: string,
  record: unknown,
  context: unknown,
  authorize: (
    reference: z.infer<typeof findingArtifactSchema>,
  ) => Promise<boolean>,
) {
  const finding = validateFindingForContext(record, context);
  const references = [
    ...finding.evidence,
    ...('evidence' in finding.baseline ? finding.baseline.evidence : []),
  ];
  for (const reference of references) {
    if (!(await authorize({ ...reference }))) throw Error('artifact_forbidden');
    await readPrivateArtifact(
      root,
      {
        tenantId: reference.tenantId,
        runId: reference.runId,
        repositoryId: reference.repositoryId,
        sha: reference.sha,
        role: reference.role,
      },
      reference,
    );
  }
  // Authorization callbacks may take time: never return already-expired references.
  validateFindingForContext(finding, context);
  return {
    finding,
    verification: 'references_verified' as const,
    semanticVerification: 'not_performed' as const,
    artifactIds: references.map((reference) => reference.artifactId),
  };
}
