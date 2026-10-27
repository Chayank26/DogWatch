import { z } from 'zod';
import type { PrismaClient, Prisma } from './generated/prisma/client.js';
const requestSchema = z.strictObject({
  sessionHash: z.string().regex(/^[a-f0-9]{64}$/),
  tenantId: z.uuid(),
});
export type RunView = {
  id: string;
  repository: string;
  pullRequestNumber: number;
  headSha: string;
  state: string;
  createdAt: string;
  previewReady: boolean;
};
export type RunDetail = RunView & {
  evidence: { status: 'not_cataloged'; message: string };
};
export interface RunViewStore {
  list(
    sessionHash: string,
    tenantId: string,
    after?: string,
  ): Promise<{ runs: RunView[]; nextCursor: string | null }>;
  detail(
    sessionHash: string,
    tenantId: string,
    runId: string,
  ): Promise<RunDetail>;
}
const select = {
  id: true,
  repository: { select: { fullName: true } },
  pullRequestNumber: true,
  headSha: true,
  state: true,
  createdAt: true,
  previewReadyAt: true,
} as const;
function view(run: {
  id: string;
  repository: { fullName: string };
  pullRequestNumber: number;
  headSha: string;
  state: string;
  createdAt: Date;
  previewReadyAt: Date | null;
}): RunView {
  return {
    id: run.id,
    repository: run.repository.fullName,
    pullRequestNumber: run.pullRequestNumber,
    headSha: run.headSha,
    state: run.state,
    createdAt: run.createdAt.toISOString(),
    previewReady: run.previewReadyAt !== null,
  };
}
export function createRunViewStore(db: PrismaClient): RunViewStore {
  // Lock authorization rows through the read; revocation cannot interleave between the guard and query.
  async function authorized<T>(
    sessionHash: string,
    tenantId: string,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const scope = requestSchema.parse({ sessionHash, tenantId });
    return db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<
          { id: string }[]
        >`SELECT u.id FROM "LoginSession" s JOIN "User" u ON u.id = s."userId" JOIN "Membership" m ON m."userId" = u.id WHERE s."tokenHash" = ${scope.sessionHash} AND s."expiresAt" > clock_timestamp() AND u."disabledAt" IS NULL AND m."tenantId" = ${scope.tenantId}::uuid FOR SHARE OF s, u, m`;
        if (rows.length !== 1) throw Error('run_view_not_found');
        return work(tx);
      },
      { timeout: 5000 },
    );
  }
  return {
    async list(sessionHash, tenantId, after) {
      if (after !== undefined) z.uuid().parse(after);
      return authorized(sessionHash, tenantId, async (tx) => {
        const cursor = after
          ? await tx.run.findFirst({
              where: { id: after, tenantId },
              select: { id: true, createdAt: true },
            })
          : null;
        if (after && !cursor) throw Error('run_view_not_found');
        const records = await tx.run.findMany({
          where: {
            tenantId,
            ...(cursor
              ? {
                  OR: [
                    { createdAt: { lt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                  ],
                }
              : {}),
          },
          select,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 51,
        });
        const runs = records.slice(0, 50).map(view);
        return {
          runs,
          nextCursor: records.length > 50 ? runs[runs.length - 1].id : null,
        };
      });
    },
    async detail(sessionHash, tenantId, runId) {
      z.uuid().parse(runId);
      return authorized(sessionHash, tenantId, async (tx) => {
        const run = await tx.run.findFirst({
          where: { id: runId, tenantId },
          select,
        });
        if (!run) throw Error('run_view_not_found');
        return {
          ...view(run),
          evidence: {
            status: 'not_cataloged',
            message:
              'Findings and evidence are not yet cataloged for dashboard access. This does not mean that the run found no issues.',
          },
        };
      });
    },
  };
}
