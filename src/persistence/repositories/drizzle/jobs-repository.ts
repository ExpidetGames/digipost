// Owner: src/platform/jobs. Encapsulates access only: no backoff computation, no handler
// dispatch (WEBAPP_TEMPLATE_SPEC.md §5.3) - that all lives in
// `src/persistence/use-cases/jobs-use-cases.ts` and `src/platform/jobs`.
import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

import type { DbExecutor } from "@/persistence/foundation/db-types";
import { jobs } from "@/persistence/schema/jobs";
import type { JobsRepository } from "@/persistence/repositories/contracts/jobs-repository";

export function createDrizzleJobsRepository(db: DbExecutor): JobsRepository {
  return {
    async hasQueuedPending({ kind, workspaceId, now }) {
      const [row] = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.kind, kind), eq(jobs.workspaceId, workspaceId), eq(jobs.status, "pending"), or(isNull(jobs.lockedUntil), lt(jobs.lockedUntil, now))))
        .limit(1);
      return row !== undefined;
    },

    async scheduleNow({ kind, workspaceId, payload, now }) {
      // `least`: a queued job that is already due keeps its earlier `run_at` (its place in the
      // claim order); one scheduled hours out (decisions/0039's follow-up) becomes due now. The
      // lease condition is re-checked on the locked row version, so a job a concurrent claimer
      // just leased is skipped here and a fresh one is inserted instead.
      const pulled = await db
        .update(jobs)
        .set({ runAt: sql`least(${jobs.runAt}, ${now})`, updatedAt: now })
        .where(and(eq(jobs.kind, kind), eq(jobs.workspaceId, workspaceId), eq(jobs.status, "pending"), or(isNull(jobs.lockedUntil), lt(jobs.lockedUntil, now))))
        .returning({ id: jobs.id });
      if (pulled.length > 0) return;
      await db.insert(jobs).values({ kind, payload, workspaceId, runAt: now, maxAttempts: 5 });
    },

    async enqueue(input) {
      const [row] = await db
        .insert(jobs)
        .values({
          kind: input.kind,
          payload: input.payload,
          workspaceId: input.workspaceId ?? null,
          runAt: input.runAt ?? new Date(),
          maxAttempts: input.maxAttempts ?? 5,
        })
        .returning();
      if (!row) throw new Error("insert into jobs returned no row");
      return row;
    },

    async claimDue({ limit, workspaceId, now, leaseMs }) {
      const conditions = [
        eq(jobs.status, "pending"),
        lte(jobs.runAt, now),
        or(isNull(jobs.lockedUntil), lt(jobs.lockedUntil, now)),
      ];
      if (workspaceId) conditions.push(eq(jobs.workspaceId, workspaceId));

      // `for update skip locked` (WEBAPP_TEMPLATE_SPEC.md §14): two concurrent claimers
      // racing this same query never both receive the same row - the loser simply skips
      // any row already locked by the other, rather than blocking on it.
      const candidates = await db
        .select()
        .from(jobs)
        .where(and(...conditions))
        // `created_at` breaks ties: jobs enqueued at the same instant run in insertion order.
        .orderBy(jobs.runAt, jobs.createdAt)
        .limit(limit)
        .for("update", { skipLocked: true });

      if (candidates.length === 0) return [];

      const ids = candidates.map((c) => c.id);
      const lockedUntil = new Date(now.getTime() + leaseMs);
      await db
        .update(jobs)
        .set({ lockedUntil, attempts: sql`${jobs.attempts} + 1`, updatedAt: now })
        .where(inArray(jobs.id, ids));

      return candidates.map((c) => ({ ...c, lockedUntil, attempts: c.attempts + 1, updatedAt: now }));
    },

    async markSucceeded(id, now) {
      await db.update(jobs).set({ status: "done", lockedUntil: null, completedAt: now, updatedAt: now }).where(eq(jobs.id, id));
    },

    async markFailed(id, { errorCode, now }) {
      await db
        .update(jobs)
        .set({ status: "failed", lockedUntil: null, lastErrorCode: errorCode, completedAt: now, updatedAt: now })
        .where(eq(jobs.id, id));
    },

    async reschedule(id, { runAt, errorCode, now }) {
      await db
        .update(jobs)
        .set({ runAt, lockedUntil: null, lastErrorCode: errorCode, updatedAt: now })
        .where(eq(jobs.id, id));
    },

    async release(ids, now) {
      if (ids.length === 0) return;
      await db
        .update(jobs)
        .set({ lockedUntil: null, attempts: sql`greatest(${jobs.attempts} - 1, 0)`, updatedAt: now })
        .where(and(inArray(jobs.id, ids), eq(jobs.status, "pending")));
    },

    async findById(id) {
      const [row] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
      return row ?? null;
    },
  };
}
