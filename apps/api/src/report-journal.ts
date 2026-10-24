/** Local serialized publication journal. Operator-owned parent; abandoned locks require reconciliation. */
import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, unlink, rmdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
export const deliveryScopeSchema = z.strictObject({
  tenantId: z.uuid(),
  runId: z.uuid(),
  installationId: z.number().int().positive().safe(),
  repositoryId: z.number().int().positive().safe(),
  pullRequestNumber: z.number().int().positive().safe(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
});
export type DeliveryScope = z.infer<typeof deliveryScopeSchema>;
export const deliveryStateSchema = z.strictObject({
  scope: deliveryScopeSchema,
  commentId: z.number().int().positive().safe().optional(),
  checkId: z.number().int().positive().safe().optional(),
  pending: z.enum(['comment', 'check']).optional(),
  revision: z.number().int().nonnegative().default(0),
  digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  delivered: z.boolean().optional(),
  retired: z.enum(['head_changed', 'superseded', 'cancelled']).optional(),
  phase: z.enum(['queued', 'in_progress', 'completed']).optional(),
});
export type DeliveryState = z.infer<typeof deliveryStateSchema>;
async function directory(path: string) {
  await mkdir(path, { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw Error('journal_directory');
}
export async function withReportJournal<T>(
  root: string,
  scope: DeliveryScope,
  work: (state: DeliveryState, save: () => Promise<void>) => Promise<T>,
) {
  const base = resolve(root);
  await directory(base);
  const tenant = join(base, scope.tenantId);
  await directory(tenant);
  const run = join(tenant, scope.runId);
  await directory(run);
  const lock = join(run, '.lock');
  await mkdir(lock, { mode: 0o700 });
  try {
    const path = join(run, 'state.json');
    let state: DeliveryState = { scope: { ...scope }, revision: 0 };
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 4096)
          throw Error('journal_file');
        const bytes = Buffer.alloc(4097);
        const read = await file.read(bytes, 0, bytes.length, 0);
        if (read.bytesRead > 4096) throw Error('journal_size');
        state = deliveryStateSchema.parse(
          JSON.parse(bytes.subarray(0, read.bytesRead).toString('utf8')),
        );
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (
      Object.entries(scope).some(
        ([key, value]) => state.scope[key as keyof DeliveryScope] !== value,
      )
    )
      throw Error('journal_scope');
    const save = async () => {
      const data = JSON.stringify(deliveryStateSchema.parse(state));
      const temporary = join(run, '.' + randomUUID() + '.tmp');
      try {
        const file = await open(
          temporary,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await file.writeFile(data);
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, path);
        const folder = await open(run, constants.O_RDONLY);
        try {
          await folder.sync();
        } finally {
          await folder.close();
        }
      } finally {
        await unlink(temporary).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    };
    return await work(state, save);
  } finally {
    await rmdir(lock);
  }
}
