import { z } from 'zod';
import type { PrismaClient } from './generated/prisma/client.js';
export type OnboardingStatus = {
  workspaces: {
    id: string;
    name: string;
    role: 'owner' | 'member';
    installations: number;
    repositories: number;
  }[];
};
export interface OnboardingStore {
  status(sessionHash: string): Promise<OnboardingStatus>;
  create(sessionHash: string, name: string): Promise<{ tenantId: string }>;
}
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const workspaceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(
    (s) => ![...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
    'Invalid workspace name',
  );
export function createOnboardingStore(db: PrismaClient): OnboardingStore {
  return {
    async status(sessionHash) {
      const session = await db.loginSession.findFirst({
        where: {
          tokenHash: hashSchema.parse(sessionHash),
          expiresAt: { gt: new Date() },
          user: { disabledAt: null },
        },
        include: {
          user: {
            include: {
              memberships: {
                include: {
                  tenant: {
                    include: {
                      installations: {
                        select: { _count: { select: { repositories: true } } },
                      },
                    },
                  },
                },
                orderBy: { tenantId: 'asc' },
              },
            },
          },
        },
      });
      if (!session) throw Error('onboarding_unauthorized');
      return {
        workspaces: session.user.memberships.map((m) => ({
          id: m.tenantId,
          name: m.tenant.name,
          role: m.role,
          installations: m.tenant.installations.length,
          repositories: m.tenant.installations.reduce(
            (sum, i) => sum + i._count.repositories,
            0,
          ),
        })),
      };
    },
    async create(sessionHash, name) {
      const tokenHash = hashSchema.parse(sessionHash),
        cleanName = workspaceNameSchema.parse(name);
      return db.$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<
            { id: string }[]
          >`SELECT u.id FROM "User" u JOIN "LoginSession" s ON s."userId" = u.id WHERE s."tokenHash" = ${tokenHash} AND s."expiresAt" > clock_timestamp() AND u."disabledAt" IS NULL FOR UPDATE OF u, s`;
          if (rows.length !== 1) throw Error('onboarding_unauthorized');
          const userId = rows[0].id;
          // A user can bootstrap only their first workspace. This also makes double submits safe.
          const memberships = await tx.membership.findMany({
            where: { userId },
            include: { tenant: true },
          });
          if (memberships.length) {
            if (
              memberships.length === 1 &&
              memberships[0].role === 'owner' &&
              memberships[0].tenant.name === cleanName
            )
              return { tenantId: memberships[0].tenantId };
            throw Error('onboarding_already_member');
          }
          const tenant = await tx.tenant.create({
            data: {
              name: cleanName,
              memberships: { create: { userId, role: 'owner' } },
            },
          });
          return { tenantId: tenant.id };
        },
        { timeout: 5000 },
      );
    },
  };
}
