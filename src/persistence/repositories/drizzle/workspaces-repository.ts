// Owner: src/modules/workspaces. Encapsulates access only: no validation, no status
// transitions, no external calls (WEBAPP_TEMPLATE_SPEC.md §5.3). Every workspace-scoped
// method takes `workspaceId` and filters on it explicitly, even though the use case will
// already have resolved it from the caller's own session membership.
import { and, asc, eq, isNull } from "drizzle-orm";

import type { DbExecutor } from "@/persistence/foundation/db-types";
import { user } from "@/persistence/schema/auth";
import { workspaceInvitations, workspaceMembers, workspaces } from "@/persistence/schema/workspaces";
import type {
  WorkspaceInvitationRepository,
  WorkspaceMemberRepository,
  WorkspaceRepository,
} from "@/persistence/repositories/contracts/workspaces-repository";

export function createDrizzleWorkspaceRepository(db: DbExecutor): WorkspaceRepository {
  return {
    async create(input) {
      const [row] = await db.insert(workspaces).values(input).returning();
      if (!row) throw new Error("insert into workspaces returned no row");
      return row;
    },

    async findById(id) {
      const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
      return row ?? null;
    },

    async lockForUpdate(id) {
      const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id)).for("update").limit(1);
      return row ?? null;
    },

    async updateTier(id, tier) {
      const [row] = await db.update(workspaces).set({ tier, updatedAt: new Date() }).where(eq(workspaces.id, id)).returning();
      return row ?? null;
    },

    async updateCompanyProfile(id, fields) {
      const [row] = await db.update(workspaces).set({ ...fields, updatedAt: new Date() }).where(eq(workspaces.id, id)).returning();
      return row ?? null;
    },

    async updatePaymentAutoConfirm(id, mode) {
      const [row] = await db.update(workspaces).set({ paymentAutoConfirm: mode, updatedAt: new Date() }).where(eq(workspaces.id, id)).returning();
      return row ?? null;
    },

    async delete(id) {
      const [row] = await db.delete(workspaces).where(eq(workspaces.id, id)).returning();
      return row ?? null;
    },
  };
}

export function createDrizzleWorkspaceMemberRepository(db: DbExecutor): WorkspaceMemberRepository {
  return {
    async listByUserIdWithWorkspace(userId) {
      const rows = await db
        .select({ member: workspaceMembers, workspace: workspaces })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
        .where(eq(workspaceMembers.userId, userId))
        .orderBy(asc(workspaceMembers.joinedAt), asc(workspaceMembers.id));
      return rows;
    },

    async findByWorkspaceAndUser(workspaceId, userId) {
      const [row] = await db
        .select()
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
        .limit(1);
      return row ?? null;
    },

    async findById(workspaceId, memberId) {
      const [row] = await db
        .select()
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.id, memberId), eq(workspaceMembers.workspaceId, workspaceId)))
        .limit(1);
      return row ?? null;
    },

    async create(input) {
      const [row] = await db.insert(workspaceMembers).values(input).returning();
      if (!row) throw new Error("insert into workspace_members returned no row");
      return row;
    },

    listByWorkspace: (workspaceId) =>
      db
        .select({
          id: workspaceMembers.id,
          workspaceId: workspaceMembers.workspaceId,
          userId: workspaceMembers.userId,
          role: workspaceMembers.role,
          joinedAt: workspaceMembers.joinedAt,
          email: user.email,
          name: user.name,
        })
        .from(workspaceMembers)
        .innerJoin(user, eq(user.id, workspaceMembers.userId))
        .where(eq(workspaceMembers.workspaceId, workspaceId))
        .orderBy(workspaceMembers.joinedAt),

    async deleteById(workspaceId, memberId) {
      const [row] = await db
        .delete(workspaceMembers)
        .where(and(eq(workspaceMembers.id, memberId), eq(workspaceMembers.workspaceId, workspaceId)))
        .returning();
      return row ?? null;
    },
  };
}

export function createDrizzleWorkspaceInvitationRepository(db: DbExecutor): WorkspaceInvitationRepository {
  return {
    async countPending(workspaceId) {
      const rows = await db
        .select({ id: workspaceInvitations.id })
        .from(workspaceInvitations)
        .where(and(eq(workspaceInvitations.workspaceId, workspaceId), isNull(workspaceInvitations.acceptedAt)));
      return rows.length;
    },

    async deletePendingByEmail(workspaceId, email) {
      await db
        .delete(workspaceInvitations)
        .where(
          and(
            eq(workspaceInvitations.workspaceId, workspaceId),
            eq(workspaceInvitations.email, email),
            isNull(workspaceInvitations.acceptedAt),
          ),
        );
    },

    async create(input) {
      const [row] = await db.insert(workspaceInvitations).values(input).returning();
      if (!row) throw new Error("insert into workspace_invitations returned no row");
      return row;
    },

    async findByTokenHash(tokenHash) {
      const [row] = await db
        .select()
        .from(workspaceInvitations)
        .where(eq(workspaceInvitations.tokenHash, tokenHash))
        .limit(1);
      return row ?? null;
    },

    async findByTokenHashWithDetails(tokenHash) {
      const [row] = await db
        .select({
          id: workspaceInvitations.id,
          workspaceId: workspaceInvitations.workspaceId,
          email: workspaceInvitations.email,
          tokenHash: workspaceInvitations.tokenHash,
          invitedByUserId: workspaceInvitations.invitedByUserId,
          expiresAt: workspaceInvitations.expiresAt,
          acceptedAt: workspaceInvitations.acceptedAt,
          createdAt: workspaceInvitations.createdAt,
          workspaceName: workspaces.name,
          inviterEmail: user.email,
        })
        .from(workspaceInvitations)
        .innerJoin(workspaces, eq(workspaces.id, workspaceInvitations.workspaceId))
        // leftJoin, not innerJoin (P6 review finding A9): `invitedByUserId` is nullable
        // (`onDelete: "set null"`) - an invitation must stay readable even after the
        // inviting user's account has been deleted, instead of silently disappearing from
        // this lookup.
        .leftJoin(user, eq(user.id, workspaceInvitations.invitedByUserId))
        .where(eq(workspaceInvitations.tokenHash, tokenHash))
        .limit(1);
      if (!row) return null;
      const { workspaceName, inviterEmail, ...invitation } = row;
      return { invitation, workspaceName, inviterEmail };
    },

    listPendingByWorkspace: (workspaceId) =>
      db
        .select()
        .from(workspaceInvitations)
        .where(and(eq(workspaceInvitations.workspaceId, workspaceId), isNull(workspaceInvitations.acceptedAt)))
        .orderBy(workspaceInvitations.createdAt),

    async deleteById(workspaceId, invitationId) {
      const [row] = await db
        .delete(workspaceInvitations)
        .where(
          and(
            eq(workspaceInvitations.id, invitationId),
            eq(workspaceInvitations.workspaceId, workspaceId),
            isNull(workspaceInvitations.acceptedAt),
          ),
        )
        .returning();
      return row ?? null;
    },

    async markAccepted(id, acceptedAt) {
      const [row] = await db
        .update(workspaceInvitations)
        .set({ acceptedAt })
        .where(and(eq(workspaceInvitations.id, id), isNull(workspaceInvitations.acceptedAt)))
        .returning();
      return row ?? null;
    },
  };
}
