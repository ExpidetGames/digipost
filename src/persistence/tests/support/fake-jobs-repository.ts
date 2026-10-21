// Typed in-memory fake for `JobsRepository` (WEBAPP_TEMPLATE_SPEC.md §10.2). `claimDue`
// mimics the real `for update skip locked` claim query's predicate (pending, due, unlocked
// or lease-expired) but has no real concurrency semantics - two concurrent claimers racing
// each other is `src/persistence/tests/jobs-repository.db.test.ts`'s job, against real
// Postgres.
import type { ClaimDueJobsInput, EnqueueJobInput, JobRow, JobsRepository } from "@/persistence/repositories/contracts";

export function jobRow(overrides: Partial<JobRow> & Pick<JobRow, "kind">): JobRow {
  return {
    id: crypto.randomUUID(),
    payload: {},
    workspaceId: null,
    status: "pending",
    runAt: new Date(0),
    attempts: 0,
    maxAttempts: 5,
    lockedUntil: null,
    lastErrorCode: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    completedAt: null,
    ...overrides,
  };
}

export function createFakeJobsRepository(seed: JobRow[] = []): { repo: JobsRepository; state: JobRow[] } {
  const rows = [...seed];

  const repo: JobsRepository = {
    async hasScheduledPending({ kind, workspaceId, now }: { kind: string; workspaceId: string; now: Date }) {
      return rows.some((r) => r.kind === kind && r.workspaceId === workspaceId && r.status === "pending" && r.runAt.getTime() > now.getTime());
    },

    async scheduleDebounced({ kind, workspaceId, payload, runAt, now }: { kind: string; workspaceId: string; payload: unknown; runAt: Date; now: Date }) {
      const scheduled = rows.filter((r) => r.kind === kind && r.workspaceId === workspaceId && r.status === "pending" && r.runAt.getTime() > now.getTime());
      if (scheduled.length > 0) {
        for (const row of scheduled) row.runAt = runAt;
        return;
      }
      rows.push(jobRow({ kind, payload: payload as JobRow["payload"], workspaceId, runAt, maxAttempts: 5 }));
    },

    async enqueue(input: EnqueueJobInput) {
      const row = jobRow({
        kind: input.kind,
        payload: input.payload,
        workspaceId: input.workspaceId ?? null,
        runAt: input.runAt ?? new Date(),
        maxAttempts: input.maxAttempts ?? 5,
      });
      rows.push(row);
      return row;
    },

    async claimDue({ limit, workspaceId, now, leaseMs }: ClaimDueJobsInput) {
      const due = rows
        .filter(
          (r) =>
            r.status === "pending" &&
            r.runAt.getTime() <= now.getTime() &&
            (!r.lockedUntil || r.lockedUntil.getTime() < now.getTime()) &&
            (!workspaceId || r.workspaceId === workspaceId),
        )
        .sort((a, b) => a.runAt.getTime() - b.runAt.getTime());

      const claimed = due.slice(0, limit);
      const lockedUntil = new Date(now.getTime() + leaseMs);
      for (const row of claimed) {
        row.lockedUntil = lockedUntil;
        row.attempts += 1;
        row.updatedAt = now;
      }
      return claimed.map((r) => ({ ...r }));
    },

    async markSucceeded(id, now) {
      const row = rows.find((r) => r.id === id);
      if (!row) return;
      row.status = "done";
      row.lockedUntil = null;
      row.completedAt = now;
      row.updatedAt = now;
    },

    async markFailed(id, { errorCode, now }) {
      const row = rows.find((r) => r.id === id);
      if (!row) return;
      row.status = "failed";
      row.lockedUntil = null;
      row.lastErrorCode = errorCode;
      row.completedAt = now;
      row.updatedAt = now;
    },

    async reschedule(id, { runAt, errorCode, now }) {
      const row = rows.find((r) => r.id === id);
      if (!row) return;
      row.runAt = runAt;
      row.lockedUntil = null;
      row.lastErrorCode = errorCode;
      row.updatedAt = now;
    },

    async findById(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
  };

  return { repo, state: rows };
}
