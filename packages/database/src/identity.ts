import type { PrismaClient } from './generated/prisma/client.js';
export type Identity = {
  id: string;
  githubId: string;
  login: string;
  memberships: { tenantId: string; name: string; role: 'owner' | 'member' }[];
};
export interface IdentityStore {
  begin(stateHash: string, browserHash: string, expiresAt: Date): Promise<void>;
  consume(stateHash: string, browserHash: string, now: Date): Promise<boolean>;
  issue(
    githubId: string,
    login: string,
    tokenHash: string,
    expiresAt: Date,
    oldHash?: string,
  ): Promise<void>;
  resolve(tokenHash: string, now: Date): Promise<Identity | null>;
  revoke(tokenHash: string): Promise<void>;
}
export function createIdentityStore(db: PrismaClient): IdentityStore {
  return {
    async begin(stateHash, browserHash, expiresAt) {
      await db.loginAttempt.create({
        data: { stateHash, browserHash, expiresAt },
      });
    },
    async consume(stateHash, browserHash, now) {
      return (
        (
          await db.loginAttempt.deleteMany({
            where: { stateHash, browserHash, expiresAt: { gt: now } },
          })
        ).count === 1
      );
    },
    async issue(githubId, login, tokenHash, expiresAt, oldHash) {
      await db.$transaction(async (tx) => {
        const user = await tx.user.upsert({
          where: { githubId: BigInt(githubId) },
          create: { githubId: BigInt(githubId), login },
          update: { login },
        });
        if (user.disabledAt) throw Error('identity_disabled');
        if (oldHash)
          await tx.loginSession.deleteMany({ where: { tokenHash: oldHash } });
        await tx.loginSession.create({
          data: { tokenHash, userId: user.id, expiresAt },
        });
      });
    },
    async resolve(tokenHash, now) {
      const session = await db.loginSession.findFirst({
        where: {
          tokenHash,
          expiresAt: { gt: now },
          user: { disabledAt: null },
        },
        include: {
          user: {
            include: {
              memberships: {
                include: { tenant: true },
                orderBy: { tenantId: 'asc' },
              },
            },
          },
        },
      });
      if (!session) return null;
      const { user } = session;
      return {
        id: user.id,
        githubId: user.githubId.toString(),
        login: user.login,
        memberships: user.memberships.map((m) => ({
          tenantId: m.tenantId,
          name: m.tenant.name,
          role: m.role,
        })),
      };
    },
    async revoke(tokenHash) {
      await db.loginSession.deleteMany({ where: { tokenHash } });
    },
  };
}
