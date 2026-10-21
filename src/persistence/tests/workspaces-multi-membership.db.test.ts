// Real Postgres (WEBAPP_TEMPLATE_SPEC.md §10.1/§10.3, `pnpm test:docker` reference,
// `pnpm test:db` on the host against `docker/compose.yml`).
//
// decisions/0070-several-workspaces-per-user.md: the database-level half of "a user may
// belong to several workspaces". The two invariants that actually have to hold in Postgres,
// not only in application code, are
//   1. the dropped unique on `workspace_members.user_id` really is gone (several
//      memberships for one user now insert), and
//   2. the composite unique on `(workspace_id, user_id)` really is there (the same user in
//      the same workspace twice still does not).
// The ordering case is the third: `resolveAccess`'s fallback is only "deterministic" if the
// database returns the oldest membership first every time, including when `joined_at` ties.
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "@/persistence/foundation/client";
import { isDbError } from "@/persistence/foundation/db-errors";
import { createDrizzleRepositories } from "@/persistence/repositories/drizzle/create-repositories";
import {
  createDrizzleWorkspaceMemberRepository,
  createDrizzleWorkspaceRepository,
} from "@/persistence/repositories/drizzle/workspaces-repository";
import { createDrizzleUnitOfWork } from "@/persistence/repositories/drizzle/unit-of-work";
import { user } from "@/persistence/schema/auth";
import { workspaceMembers } from "@/persistence/schema/workspaces";
import { createWorkspaceUseCases } from "@/persistence/use-cases/workspaces-use-cases";

const db = getDb();

async function createTestUser(label = "multi"): Promise<{ id: string; email: string }> {
  const email = `${label}-${randomUUID()}@example.test`;
  const [row] = await db.insert(user).values({ name: "Test User", email, emailVerified: false }).returning({ id: user.id });
  if (!row) throw new Error("failed to insert test user fixture");
  return { id: row.id, email };
}

function useCases() {
  return createWorkspaceUseCases({ repos: createDrizzleRepositories(db), uow: createDrizzleUnitOfWork(db) });
}

describe("workspace_members composite unique (decisions/0070-several-workspaces-per-user.md)", () => {
  it("accepts the same user in two different workspaces", async () => {
    const workspaceRepo = createDrizzleWorkspaceRepository(db);
    const memberRepo = createDrizzleWorkspaceMemberRepository(db);
    const owner = await createTestUser("two-companies");
    const first = await workspaceRepo.create({ name: "Erste GmbH" });
    const second = await workspaceRepo.create({ name: "Zweite GmbH" });

    await memberRepo.create({ workspaceId: first.id, userId: owner.id, role: "admin" });
    await memberRepo.create({ workspaceId: second.id, userId: owner.id, role: "admin" });

    const rows = await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, owner.id));
    expect(rows).toHaveLength(2);
  });

  it("still rejects the same user in the SAME workspace twice", async () => {
    const workspaceRepo = createDrizzleWorkspaceRepository(db);
    const memberRepo = createDrizzleWorkspaceMemberRepository(db);
    const owner = await createTestUser("duplicate");
    const workspace = await workspaceRepo.create({ name: "Doppelt GmbH" });

    await memberRepo.create({ workspaceId: workspace.id, userId: owner.id, role: "admin" });

    try {
      await memberRepo.create({ workspaceId: workspace.id, userId: owner.id, role: "member" });
      expect.unreachable("expected the same user in the same workspace twice to fail");
    } catch (err) {
      expect(isDbError(err, "unique")).toBe(true);
    }
  });

  it("still rejects a second admin in one workspace (the pre-existing partial unique index is untouched)", async () => {
    const workspaceRepo = createDrizzleWorkspaceRepository(db);
    const memberRepo = createDrizzleWorkspaceMemberRepository(db);
    const first = await createTestUser("admin-a");
    const second = await createTestUser("admin-b");
    const workspace = await workspaceRepo.create({ name: "Ein Admin GmbH" });

    await memberRepo.create({ workspaceId: workspace.id, userId: first.id, role: "admin" });

    try {
      await memberRepo.create({ workspaceId: workspace.id, userId: second.id, role: "admin" });
      expect.unreachable("expected a second admin for the same workspace to fail");
    } catch (err) {
      expect(isDbError(err, "unique")).toBe(true);
    }
  });
});

describe("membership resolution against real Postgres (decisions/0070-several-workspaces-per-user.md)", () => {
  it("lists every membership oldest first and picks the oldest as the default", async () => {
    const owner = await createTestUser("ordering");
    const cases = useCases();

    const first = await cases.createForUser({ userId: owner.id, name: "Erste GmbH" });
    const second = await cases.createForUser({ userId: owner.id, name: "Zweite GmbH" });
    const third = await cases.createForUser({ userId: owner.id, name: "Dritte GmbH" });

    const memberships = await cases.listMembershipsForUser(owner.id);
    expect(memberships.map((m) => m.workspace.id)).toEqual([first.workspace.id, second.workspace.id, third.workspace.id]);

    // `resolveAccess`'s fallback: the oldest membership, stable across repeated calls even
    // though all three rows can share the same `joined_at` timestamp down to the millisecond.
    for (let i = 0; i < 3; i += 1) {
      await expect(cases.getMembershipForUser(owner.id)).resolves.toMatchObject({
        workspace: { id: first.workspace.id },
      });
    }
  });

  it("getMembershipInWorkspace returns null for a workspace owned by somebody else", async () => {
    const owner = await createTestUser("mine");
    const stranger = await createTestUser("theirs");
    const cases = useCases();

    const mine = await cases.createForUser({ userId: owner.id, name: "Meine GmbH" });
    const theirs = await cases.createForUser({ userId: stranger.id, name: "Fremde GmbH" });

    await expect(cases.getMembershipInWorkspace({ userId: owner.id, workspaceId: mine.workspace.id })).resolves.toMatchObject(
      { role: "admin", workspace: { id: mine.workspace.id } },
    );
    // The gate behind the active-workspace cookie: a workspace that exists but is not the
    // caller's resolves exactly like one that does not exist at all.
    expect(await cases.getMembershipInWorkspace({ userId: owner.id, workspaceId: theirs.workspace.id })).toBeNull();
    expect(await cases.getMembershipInWorkspace({ userId: owner.id, workspaceId: randomUUID() })).toBeNull();
  });

  it("leaving one workspace leaves the other memberships untouched", async () => {
    const owner = await createTestUser("leaver");
    const admin = await createTestUser("host-admin");
    const cases = useCases();

    const own = await cases.createForUser({ userId: owner.id, name: "Eigene GmbH" });
    const host = await cases.createForUser({ userId: admin.id, name: "Gast GmbH" });
    const guestMembership = await createDrizzleWorkspaceMemberRepository(db).create({
      workspaceId: host.workspace.id,
      userId: owner.id,
      role: "member",
    });

    await cases.leaveWorkspace({ workspaceId: host.workspace.id, membershipId: guestMembership.id });

    const remaining = await cases.listMembershipsForUser(owner.id);
    expect(remaining.map((m) => m.workspace.id)).toEqual([own.workspace.id]);
  });
});
