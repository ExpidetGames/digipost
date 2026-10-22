// Real Postgres (WEBAPP_TEMPLATE_SPEC.md §10.1/§10.3). Proves the properties a fake cannot:
// `for update skip locked` actually serializes two concurrent claimers (WEBAPP_TEMPLATE_SPEC.md
// §14's jobqueue recipe), an expired lease is reclaimable, and `enqueue` participates in its
// caller's transaction (rolls back with it). Every fixture uses its own workspace (no shared
// rows, no outer rollback wrapper), mirroring `documents-repository.db.test.ts`'s pattern.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "@/persistence/foundation/client";
import { createDrizzleJobsRepository } from "@/persistence/repositories/drizzle/jobs-repository";
import { createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";
import { jobs } from "@/persistence/schema/jobs";

const db = getDb();

async function createTestWorkspace(name: string): Promise<{ id: string }> {
  return createDrizzleWorkspaceRepository(db).create({ name });
}

describe("createDrizzleJobsRepository", () => {
  it("enqueue inserts a pending job with the given kind/payload/workspace", async () => {
    const workspace = await createTestWorkspace("Jobs Co A");
    const repo = createDrizzleJobsRepository(db);

    const row = await repo.enqueue({ kind: "process-document", payload: { documentId: "d1" }, workspaceId: workspace.id });

    expect(row.status).toBe("pending");
    expect(row.kind).toBe("process-document");
    expect(row.payload).toEqual({ documentId: "d1" });
    expect(row.workspaceId).toBe(workspace.id);
    expect(row.attempts).toBe(0);
  });

  it("enqueue rolls back when its own transaction throws", async () => {
    const workspace = await createTestWorkspace("Jobs Co B");

    await expect(
      db.transaction(async (tx) => {
        await createDrizzleJobsRepository(tx).enqueue({ kind: "process-document", payload: {}, workspaceId: workspace.id });
        throw new Error("simulated failure after enqueue");
      }),
    ).rejects.toThrow("simulated failure after enqueue");

    const remaining = await db.select().from(jobs).where(eq(jobs.workspaceId, workspace.id));
    expect(remaining).toHaveLength(0);
  });

  it("two concurrent claimers never receive the same job", async () => {
    const workspace = await createTestWorkspace("Jobs Co C");
    const repo = createDrizzleJobsRepository(db);
    const jobA = await repo.enqueue({ kind: "process-document", payload: { n: 1 }, workspaceId: workspace.id });
    const jobB = await repo.enqueue({ kind: "process-document", payload: { n: 2 }, workspaceId: workspace.id });

    const now = new Date();
    const claimOne = () =>
      db.transaction((tx) => createDrizzleJobsRepository(tx).claimDue({ limit: 1, workspaceId: workspace.id, now, leaseMs: 60_000 }));

    const [claimedByA, claimedByB] = await Promise.all([claimOne(), claimOne()]);

    const claimedIds = [...claimedByA, ...claimedByB].map((j) => j.id).sort();
    expect(claimedIds).toEqual([jobA.id, jobB.id].sort());
    // No overlap: each claimer got exactly one, and they are different jobs.
    expect(claimedByA).toHaveLength(1);
    expect(claimedByB).toHaveLength(1);
    expect(claimedByA[0]!.id).not.toBe(claimedByB[0]!.id);
  });

  it("claimDue increments attempts and sets a lease", async () => {
    const workspace = await createTestWorkspace("Jobs Co D");
    const repo = createDrizzleJobsRepository(db);
    const created = await repo.enqueue({ kind: "process-document", payload: {}, workspaceId: workspace.id });

    const now = new Date();
    const [claimed] = await db.transaction((tx) =>
      createDrizzleJobsRepository(tx).claimDue({ limit: 1, workspaceId: workspace.id, now, leaseMs: 30_000 }),
    );

    expect(claimed!.id).toBe(created.id);
    expect(claimed!.attempts).toBe(1);
    expect(claimed!.lockedUntil?.getTime()).toBe(now.getTime() + 30_000);
  });

  it("does not claim a job whose lease is still active", async () => {
    const workspace = await createTestWorkspace("Jobs Co E");
    const repo = createDrizzleJobsRepository(db);
    await repo.enqueue({ kind: "process-document", payload: {}, workspaceId: workspace.id });

    const now = new Date();
    await db.transaction((tx) => createDrizzleJobsRepository(tx).claimDue({ limit: 1, workspaceId: workspace.id, now, leaseMs: 60_000 }));

    // Immediately after: the lease (60s) has not expired yet.
    const second = await db.transaction((tx) =>
      createDrizzleJobsRepository(tx).claimDue({ limit: 1, workspaceId: workspace.id, now, leaseMs: 60_000 }),
    );
    expect(second).toHaveLength(0);
  });

  it("reclaims a job whose lease already expired", async () => {
    const workspace = await createTestWorkspace("Jobs Co F");
    const repo = createDrizzleJobsRepository(db);
    const created = await repo.enqueue({ kind: "process-document", payload: {}, workspaceId: workspace.id });

    // Claim it with a negative lease duration: `lockedUntil` lands in the past relative to
    // `now` itself, immediately "expired" without needing to wait for real time to pass.
    await db.transaction((tx) =>
      createDrizzleJobsRepository(tx).claimDue({ limit: 1, workspaceId: workspace.id, now: new Date(), leaseMs: -1_000 }),
    );

    const now = new Date();
    const reclaimed = await db.transaction((tx) =>
      createDrizzleJobsRepository(tx).claimDue({ limit: 1, workspaceId: workspace.id, now, leaseMs: 60_000 }),
    );

    expect(reclaimed.map((j) => j.id)).toEqual([created.id]);
    expect(reclaimed[0]!.attempts).toBe(2);
  });

  it("does not claim a job scheduled in the future", async () => {
    const workspace = await createTestWorkspace("Jobs Co G");
    const repo = createDrizzleJobsRepository(db);
    const future = new Date(Date.now() + 60_000);
    await repo.enqueue({ kind: "process-document", payload: {}, workspaceId: workspace.id, runAt: future });

    const claimed = await db.transaction((tx) =>
      createDrizzleJobsRepository(tx).claimDue({ limit: 10, workspaceId: workspace.id, now: new Date(), leaseMs: 60_000 }),
    );
    expect(claimed).toHaveLength(0);
  });

  it("scopes claiming to the given workspace when one is provided", async () => {
    const workspaceA = await createTestWorkspace("Jobs Co H1");
    const workspaceB = await createTestWorkspace("Jobs Co H2");
    const repo = createDrizzleJobsRepository(db);
    await repo.enqueue({ kind: "process-document", payload: {}, workspaceId: workspaceA.id });
    const jobB = await repo.enqueue({ kind: "process-document", payload: {}, workspaceId: workspaceB.id });

    const claimed = await db.transaction((tx) =>
      createDrizzleJobsRepository(tx).claimDue({ limit: 10, workspaceId: workspaceB.id, now: new Date(), leaseMs: 60_000 }),
    );

    expect(claimed.map((j) => j.id)).toEqual([jobB.id]);
  });

  it("markSucceeded sets status done and completedAt", async () => {
    const workspace = await createTestWorkspace("Jobs Co I");
    const repo = createDrizzleJobsRepository(db);
    const created = await repo.enqueue({ kind: "process-document", payload: {}, workspaceId: workspace.id });

    const now = new Date();
    await repo.markSucceeded(created.id, now);

    const found = await repo.findById(created.id);
    expect(found?.status).toBe("done");
    expect(found?.completedAt?.getTime()).toBe(now.getTime());
  });

  it("markFailed sets status failed and records the error code", async () => {
    const workspace = await createTestWorkspace("Jobs Co J");
    const repo = createDrizzleJobsRepository(db);
    const created = await repo.enqueue({ kind: "process-document", payload: {}, workspaceId: workspace.id });

    await repo.markFailed(created.id, { errorCode: "ai_auth_failed", now: new Date() });

    const found = await repo.findById(created.id);
    expect(found?.status).toBe("failed");
    expect(found?.lastErrorCode).toBe("ai_auth_failed");
  });

  it("reschedule moves run_at forward, clears the lease, and keeps status pending", async () => {
    const workspace = await createTestWorkspace("Jobs Co K");
    const repo = createDrizzleJobsRepository(db);
    const created = await repo.enqueue({ kind: "process-document", payload: {}, workspaceId: workspace.id });
    await db.transaction((tx) =>
      createDrizzleJobsRepository(tx).claimDue({ limit: 1, workspaceId: workspace.id, now: new Date(), leaseMs: 60_000 }),
    );

    const newRunAt = new Date(Date.now() + 5_000);
    await repo.reschedule(created.id, { runAt: newRunAt, errorCode: "ai_rate_limited", now: new Date() });

    const found = await repo.findById(created.id);
    expect(found?.status).toBe("pending");
    expect(found?.lockedUntil).toBeNull();
    expect(found?.lastErrorCode).toBe("ai_rate_limited");
    expect(found?.runAt.getTime()).toBe(newRunAt.getTime());
  });

  // decisions/0076: matching triggers make a run due now, at most one queued run per workspace.
  describe("scheduleNow / hasQueuedPending / release", () => {
    const MATCH = "match-payments";

    async function matchJobs(workspaceId: string) {
      return db.select().from(jobs).where(eq(jobs.workspaceId, workspaceId)).orderBy(jobs.createdAt);
    }

    it("enqueues a job due now when none is queued", async () => {
      const workspace = await createTestWorkspace("Jobs Co L");
      const repo = createDrizzleJobsRepository(db);
      const now = new Date();

      await repo.scheduleNow({ kind: MATCH, workspaceId: workspace.id, payload: { workspaceId: workspace.id }, now });

      const rows = await matchJobs(workspace.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: MATCH, status: "pending", attempts: 0, lockedUntil: null });
      expect(rows[0]!.runAt.getTime()).toBe(now.getTime());
    });

    it("adds nothing while a run is queued and due, and keeps its earlier run_at", async () => {
      const workspace = await createTestWorkspace("Jobs Co M");
      const repo = createDrizzleJobsRepository(db);
      const first = new Date(Date.now() - 10_000);
      await repo.scheduleNow({ kind: MATCH, workspaceId: workspace.id, payload: {}, now: first });

      await repo.scheduleNow({ kind: MATCH, workspaceId: workspace.id, payload: {}, now: new Date() });
      await repo.scheduleNow({ kind: MATCH, workspaceId: workspace.id, payload: {}, now: new Date() });

      const rows = await matchJobs(workspace.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.runAt.getTime()).toBe(first.getTime());
    });

    it("pulls a queued six-hour follow-up forward to now instead of adding a second run", async () => {
      const workspace = await createTestWorkspace("Jobs Co N");
      const repo = createDrizzleJobsRepository(db);
      const now = new Date();
      await repo.enqueue({ kind: MATCH, payload: { trigger: "cron" }, workspaceId: workspace.id, runAt: new Date(now.getTime() + 6 * 3_600_000) });
      expect(await repo.hasQueuedPending({ kind: MATCH, workspaceId: workspace.id, now })).toBe(true);

      await repo.scheduleNow({ kind: MATCH, workspaceId: workspace.id, payload: { trigger: "document_done" }, now });

      const rows = await matchJobs(workspace.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.runAt.getTime()).toBe(now.getTime());
      const claimed = await db.transaction((tx) => createDrizzleJobsRepository(tx).claimDue({ limit: 5, workspaceId: workspace.id, now: new Date(now.getTime() + 1), leaseMs: 60_000 }));
      expect(claimed.map((j) => j.id)).toEqual([rows[0]!.id]);
    });

    it("ignores a run that is in progress (leased) and queues a new one, which hasQueuedPending then reports", async () => {
      const workspace = await createTestWorkspace("Jobs Co O");
      const repo = createDrizzleJobsRepository(db);
      const running = await repo.enqueue({ kind: MATCH, payload: {}, workspaceId: workspace.id });
      const now = new Date();
      await db.transaction((tx) => createDrizzleJobsRepository(tx).claimDue({ limit: 1, workspaceId: workspace.id, now, leaseMs: 60_000 }));
      // The running job itself is not "queued": a follow-up check from inside it sees nothing.
      expect(await repo.hasQueuedPending({ kind: MATCH, workspaceId: workspace.id, now })).toBe(false);

      await repo.scheduleNow({ kind: MATCH, workspaceId: workspace.id, payload: {}, now });

      const rows = await matchJobs(workspace.id);
      expect(rows).toHaveLength(2);
      const fresh = rows.find((r) => r.id !== running.id)!;
      expect(fresh).toMatchObject({ status: "pending", lockedUntil: null });
      expect(fresh.runAt.getTime()).toBe(now.getTime());
      expect(await repo.hasQueuedPending({ kind: MATCH, workspaceId: workspace.id, now })).toBe(true);
    });

    it("counts only jobs of the given kind and workspace, never done ones", async () => {
      const workspace = await createTestWorkspace("Jobs Co P");
      const other = await createTestWorkspace("Jobs Co P2");
      const repo = createDrizzleJobsRepository(db);
      const now = new Date();
      await repo.enqueue({ kind: "process-document", payload: {}, workspaceId: workspace.id });
      await repo.enqueue({ kind: MATCH, payload: {}, workspaceId: other.id });
      const done = await repo.enqueue({ kind: MATCH, payload: {}, workspaceId: workspace.id });
      await repo.markSucceeded(done.id, now);

      expect(await repo.hasQueuedPending({ kind: MATCH, workspaceId: workspace.id, now })).toBe(false);

      await repo.scheduleNow({ kind: MATCH, workspaceId: workspace.id, payload: {}, now });
      expect((await matchJobs(workspace.id)).filter((r) => r.kind === MATCH && r.status === "pending")).toHaveLength(1);
      expect((await matchJobs(other.id))).toHaveLength(1);
    });

    it("release clears the lease and gives back the attempt claimDue counted", async () => {
      const workspace = await createTestWorkspace("Jobs Co Q");
      const repo = createDrizzleJobsRepository(db);
      const created = await repo.enqueue({ kind: "process-document", payload: {}, workspaceId: workspace.id });
      const now = new Date();
      await db.transaction((tx) => createDrizzleJobsRepository(tx).claimDue({ limit: 1, workspaceId: workspace.id, now, leaseMs: 60_000 }));

      await repo.release([created.id], now);

      const found = await repo.findById(created.id);
      expect(found).toMatchObject({ status: "pending", lockedUntil: null, attempts: 0 });
      const reclaimed = await db.transaction((tx) => createDrizzleJobsRepository(tx).claimDue({ limit: 1, workspaceId: workspace.id, now, leaseMs: 60_000 }));
      expect(reclaimed.map((j) => j.id)).toEqual([created.id]);
    });

    it("claimDue breaks a run_at tie by creation order", async () => {
      const workspace = await createTestWorkspace("Jobs Co R");
      const repo = createDrizzleJobsRepository(db);
      const runAt = new Date(Date.now() - 1_000);
      const first = await repo.enqueue({ kind: "process-document", payload: { n: 1 }, workspaceId: workspace.id, runAt });
      const second = await repo.enqueue({ kind: MATCH, payload: { n: 2 }, workspaceId: workspace.id, runAt });

      const claimed = await db.transaction((tx) => createDrizzleJobsRepository(tx).claimDue({ limit: 5, workspaceId: workspace.id, now: new Date(), leaseMs: 60_000 }));

      expect(claimed.map((j) => j.id)).toEqual([first.id, second.id]);
    });
  });
});
