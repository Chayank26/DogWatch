/** Trusted service boundary; never expose this persistence adapter as an unauthenticated route. */
import { z } from 'zod';
import type { PrismaClient } from './generated/prisma/client.js';
const scopeSchema = z.strictObject({
  tenantId: z.uuid(),
  sessionHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const linkSchema = scopeSchema.extend({
  installationId: z.number().int().positive().safe(),
  githubId: z.string().regex(/^[1-9][0-9]{0,18}$/),
});
export type LinkScope = z.infer<typeof scopeSchema>;
export type VerifiedInstallationLink = z.infer<typeof linkSchema>;
export interface InstallationLinkStore {
  owner(scope: LinkScope): Promise<string>;
  link(input: VerifiedInstallationLink): Promise<'linked' | 'unchanged'>;
}
export function createInstallationLinkStore(
  db: PrismaClient,
): InstallationLinkStore {
  return {
    async owner(input) {
      const scope = scopeSchema.parse(input);
      const session = await db.loginSession.findFirst({
        where: {
          tokenHash: scope.sessionHash,
          expiresAt: { gt: new Date() },
          user: {
            disabledAt: null,
            memberships: { some: { tenantId: scope.tenantId, role: 'owner' } },
          },
        },
        include: { user: true },
      });
      if (!session) throw Error('installation_link_denied');
      return session.user.githubId.toString();
    },
    async link(input) {
      const value = linkSchema.parse(input);
      return db.$transaction(
        async (tx) => {
          // Lock the actual authorization rows: logout, disablement and demotion
          // serialize with this commit, not just an earlier application snapshot.
          const owners = await tx.$queryRaw<{ githubId: bigint }[]>`
          SELECT u."githubId" FROM "LoginSession" s
          JOIN "User" u ON u.id = s."userId"
          JOIN "Membership" m ON m."userId" = u.id
          WHERE s."tokenHash" = ${value.sessionHash}
            AND s."expiresAt" > clock_timestamp() AND u."disabledAt" IS NULL
            AND m."tenantId" = ${value.tenantId}::uuid AND m.role = 'owner'
          FOR UPDATE OF s, u, m`;
          if (
            owners.length !== 1 ||
            owners[0].githubId.toString() !== value.githubId
          )
            throw Error('installation_link_denied');
          // Unique installation identity arbitrates both same-tenant and cross-tenant races.
          const inserted = await tx.installation.createMany({
            data: {
              id: BigInt(value.installationId),
              tenantId: value.tenantId,
            },
            skipDuplicates: true,
          });
          const installation = await tx.installation.findUniqueOrThrow({
            where: { id: BigInt(value.installationId) },
          });
          if (installation.tenantId !== value.tenantId)
            throw Error('installation_link_conflict');
          // Recheck expiry after waiting on a concurrent installation insert.
          const live = await tx.$queryRaw<
            { live: boolean }[]
          >`SELECT "expiresAt" > clock_timestamp() AS live FROM "LoginSession" WHERE "tokenHash" = ${value.sessionHash}`;
          if (!live[0]?.live) throw Error('installation_link_denied');
          return inserted.count ? 'linked' : 'unchanged';
        },
        { timeout: 5000 },
      );
    },
  };
}
