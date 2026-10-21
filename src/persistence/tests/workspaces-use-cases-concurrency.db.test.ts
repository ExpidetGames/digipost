// Real Postgres (WEBAPP_TEMPLATE_SPEC.md §10.1/§10.3): proves the row lock
// (`workspace.lockForUpdate`, `select ... for update`) actually serializes two concurrent
// invites against the same pending-invitation cap, mirroring
// `documents-use-cases-concurrency.db.test.ts`'s pattern for the upload quota. Before P6's
// fix (A6), `invite()` checked `countPending` without locking the workspace row first: two
// concurrent invites could both read a pending count of `MAX_PENDING_INVITATIONS - 1` and
// both succeed, exceeding the cap - this test fails against that code (both settle
// fulfilled, 51 pending rows) and passes once the lock serializes them.
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "@/persistence/foundation/client";
import { createDrizzleRepositories } from "@/persistence/repositories/drizzle/create-repositories";
import { createDrizzleUnitOfWork } from "@/persistence/repositories/drizzle/unit-of-work";
import { createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";
import { user } from "@/persistence/schema/auth";
import { workspaceInvitations } from "@/persistence/schema/workspaces";
import { createWorkspaceUseCases, MAX_PENDING_INVITATIONS, WORKSPACE_ERROR } from "@/persistence/use-cases/workspaces-use-cases";

const db = getDb();

describe("invite concurrency", () => {
  it("serializes two concurrent invites at the pending cap: exactly one succeeds", async () => {
    const workspaceRepo = createDrizzleWorkspaceRepository(db);
    const workspace = await workspaceRepo.create({ name: "Invite Concurrency Co" });

    const [admin] = await db
      .insert(user)
      .values({ name: "Invite Concurrency Admin", email: `${randomUUID()}@example.test`, emailVerified: false })
      .returning({ id: user.id });
    if (!admin) throw new Error("failed to insert test admin fixture");

    const repos = createDrizzleRepositories(db);
    const uow = createDrizzleUnitOfWork(db);
    const useCases = createWorkspaceUseCases({ repos, uow });

    // Fill MAX_PENDING_INVITATIONS - 10 slots directly, so exactly 10 more invites fit, then
    // race TWICE that many (20) concurrent invites for those 10 remaining slots. Racing more
    // requests than remaining slots (rather than just "one over" with 2 requests) makes the
    // missing-lock race reliably observable: without `lockForUpdate` serializing the
    // transactions, most of the 20 concurrent `countPending` reads happen before any of the
    // concurrent inserts commit, so far more than 10 of them see room and succeed -
    // overshooting the cap - whereas a single racing pair is fast enough, on a local
    // loopback Postgres, to sometimes serialize by sheer scheduling luck even with the lock
    // removed.
    const seedCount = MAX_PENDING_INVITATIONS - 10;
    for (let i = 0; i < seedCount; i += 1) {
      await useCases.invite({
        workspaceId: workspace.id,
        invitedByUserId: admin.id,
        email: `seed-${i}@example.test`,
      });
    }

    const raceSize = 20;
    const results = await Promise.allSettled(
      Array.from({ length: raceSize }, (_, i) =>
        useCases.invite({
          workspaceId: workspace.id,
          invitedByUserId: admin.id,
          email: `race-${i}@example.test`,
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(10);
    expect(rejected).toHaveLength(10);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: WORKSPACE_ERROR.invitationCapReached });
    }

    // The invariant this test actually protects: the pending-invitation cap is never
    // exceeded, no matter how many concurrent invites race for the last few slots.
    const pending = await db.select().from(workspaceInvitations).where(eq(workspaceInvitations.workspaceId, workspace.id));
    expect(pending).toHaveLength(MAX_PENDING_INVITATIONS);
  });
});
