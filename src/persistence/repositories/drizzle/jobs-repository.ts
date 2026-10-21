// Owner: src/platform/jobs. Encapsulates access only: no backoff computation, no handler
// dispatch (WEBAPP_TEMPLATE_SPEC.md §5.3) - that all lives in
// `src/persistence/use-cases/jobs-use-cases.ts` and `src/platform/jobs`.
import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

import type { DbExecutor } from "@/persistence/foundation/db-types";
import { jobs } from "@/persistence/schema/jobs";
import type { JobsRepository } from "@/persistence/repositories/contracts/jobs-repository";

export function createDrizzleJobsRepository(db: DbExecutor): JobsRepository {
  return {
    async hasScheduledPending({ kind, workspaceId, now }) {
      const [row] = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.kind, kind), eq(jobs.workspaceId, workspaceId), eq(jobs.status, "pending"), sql`${jobs.runAt} > ${now}`))
        .limit(1);
      return row !== undefined;
    },

    async scheduleDebounced({ kind, workspaceId, payload, runAt, now }) {
      const postponed = await db
        .update(jobs)
        .set({ runAt, updatedAt: now })
        .where(and(eq(jobs.kind, kind), eq(jobs.workspaceId, workspaceId), eq(jobs.status, "pending"), sql`${jobs.runAt} > ${now}`))
        .returning({ id: jobs.id });
      if (postponed.length > 0) return;
      await db.insert(jobs).values({ kind, payload, workspaceId, runAt, maxAttempts: 5 });
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
        .orderBy(jobs.runAt)
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

    async findById(id) {
      const [row] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
      return row ?? null;
    },
  };
}
