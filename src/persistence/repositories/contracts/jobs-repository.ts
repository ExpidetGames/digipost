// Owner: src/platform/jobs (WEBAPP_TEMPLATE_SPEC.md §14's jobqueue recipe). Contracts only:
// no Drizzle import here besides type-only schema references, erased at runtime
// (WEBAPP_TEMPLATE_SPEC.md §5.1 "contracts separate from Drizzle").
import type { InferSelectModel } from "drizzle-orm";

import type { jobs } from "@/persistence/schema/jobs";

export { JOB_STATUSES } from "@/persistence/schema/jobs";
export type { JobStatus } from "@/persistence/schema/jobs";

export type JobRow = InferSelectModel<typeof jobs>;

export type EnqueueJobInput = {
  kind: string;
  payload: unknown;
  /** `null`/omitted for a job that is not scoped to one workspace. */
  workspaceId?: string | null;
  /** Default now (the DB's `defaultNow()`). */
  runAt?: Date;
  /** Default 5. */
  maxAttempts?: number;
};

export type ClaimDueJobsInput = {
  limit: number;
  /** Restrict claiming to one workspace's own due jobs (the UI "kick" trigger,
   * decisions/0016-processing-pipeline-and-ai.md) - omitted for the cron sweeper, which
   * claims across every workspace. */
  workspaceId?: string;
  now: Date;
  /** How long the claim's lease lasts before it is reclaimable by another claimer. */
  leaseMs: number;
};

export interface JobsRepository {
  /** Inserts a new job row, `status: "pending"`. Called both directly (a request-scoped
   * enqueue) and from inside another owner's `uow.transaction(...)` callback with that
   * callback's transaction-bound `Repositories.jobs` (the same shared-transaction pattern
   * `src/persistence/use-cases/billing-use-cases.ts`'s `recordDocumentsCreated` already
   * uses), so a job only ever exists once the write that motivated it has actually
   * committed. */
  enqueue(input: EnqueueJobInput): Promise<JobRow>;
  /**
   * Atomically claims up to `limit` due jobs: `status = 'pending'`, `run_at <= now`, and
   * either never locked or a lease that already expired (`locked_until is null or
   * locked_until < now`) - `select ... for update skip locked` so two concurrent claimers
   * never receive the same row (WEBAPP_TEMPLATE_SPEC.md §14). Sets `locked_until = now +
   * leaseMs` and increments `attempts` for every claimed row before returning it, so the
   * returned `attempts` already reflects the attempt about to run. Must be called inside a
   * transaction (the `for update` lock only means anything there).
   */
  claimDue(input: ClaimDueJobsInput): Promise<JobRow[]>;
  markSucceeded(id: string, now: Date): Promise<void>;
  /** Terminal failure: no further attempts (either a `PermanentJobError` or
   * `attempts >= maxAttempts`). */
  markFailed(id: string, input: { errorCode: string; now: Date }): Promise<void>;
  /** A transient failure with attempts remaining: moves `run_at` forward by the caller's
   * computed backoff delay, clears the lease, and records `lastErrorCode`. Status stays
   * `"pending"` - the job is due again once `run_at` passes. */
  reschedule(id: string, input: { runAt: Date; errorCode: string; now: Date }): Promise<void>;
  findById(id: string): Promise<JobRow | null>;
  /** Gives claimed jobs back without running them (`runDue` ran out of its time budget before
   * reaching them): clears the lease and undoes the attempt `claimDue` counted, so the job is
   * due again right away for the next claimer and no attempt is lost to a job that never ran. */
  release(ids: string[], now: Date): Promise<void>;
  /** `true` when a job of this kind is queued for this workspace: `status = 'pending'` and not
   * currently leased (`locked_until` null or expired), whatever its `run_at`. A job that is
   * running right now is excluded, so a running `match-payments` job asking this about its own
   * kind only sees OTHER queued runs. Lets a self-rescheduling job keep at most one queued run
   * (decisions/0039): a queued run, due now or hours out, schedules its own follow-up when it
   * finishes. */
  hasQueuedPending(input: { kind: string; workspaceId: string; now: Date }): Promise<boolean>;
  /** Makes a job of this kind due right now for this workspace (decisions/0076): if one is
   * already queued (pending and not leased, see `hasQueuedPending`), its `run_at` is pulled
   * forward to `now` when it lies in the future (a six-hour follow-up becomes the immediate
   * run) instead of adding another; otherwise a new job due at `now` is enqueued. A job that is
   * running right now does not count, because it may already have read the data the new
   * trigger is about. A burst of triggers therefore leaves at most one queued run. */
  scheduleNow(input: { kind: string; workspaceId: string; payload: unknown; now: Date }): Promise<void>;
}
