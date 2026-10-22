// Owner: src/platform/jobs (WEBAPP_TEMPLATE_SPEC.md §14's jobqueue recipe,
// decisions/0016-processing-pipeline-and-ai.md). Deliberately domain-free: this file has no
// idea what "process-document" or "send-quota-warning" actually do - it only claims due
// jobs, looks up a handler by `kind` in the `handlers` map the composition root built (from
// each owning module's own use-case methods - "handlers registered where they belong"), runs
// it, and records the outcome with backoff. No `next/*`, `react`, `src/platform/*/client`, or
// a module's own `server.ts`/`client.ts`.
import { computeBackoffMs, PermanentJobError, TransientJobError } from "@/platform/jobs";
import { captureError } from "@/platform/observability/server";
import type { JobRow, Repositories, UnitOfWork } from "@/persistence/repositories/contracts";

/** A handler receives the job's raw `payload` (whatever `enqueue` was called with - the
 * handler itself is responsible for validating its own shape) and either resolves (success)
 * or throws `TransientJobError`/`PermanentJobError` (any other thrown error is treated as
 * transient, so a genuine bug is retried and eventually surfaces via `max_attempts`
 * exhaustion rather than being silently treated as permanent on its first occurrence). */
export type JobHandler = (payload: unknown) => Promise<void>;

export type JobHandlers = Partial<Record<string, JobHandler>>;

/** How long a claimed job's lease lasts before another claimer may reclaim it as "expired"
 * (WEBAPP_TEMPLATE_SPEC.md §14: "Lease"). Generous relative to a single job's expected
 * runtime (an OCR call plus a chat completion, well under a minute) so a merely slow job is
 * never double-processed by an overlapping claim. */
// 15 minutes: a workspace-wide matching run after a bulk upload makes one AI call per open
// transaction and can outlast 5 minutes; a shorter lease would let a second claimer run it twice.
const LEASE_MS = 15 * 60_000;

/**
 * Best-effort, generic: several job kinds (`process-document`, `import-account-transactions`)
 * happen to carry a `documentId` in their payload, and surfacing it in a failure log is
 * worth the field even though this file otherwise has no idea what a job's payload means
 * (see the file header comment). Returns `undefined` for any payload shape without one -
 * never throws, never assumes the field exists.
 */
function extractDocumentId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>).documentId;
  return typeof value === "string" ? value : undefined;
}

type JobFailureLogFields = {
  jobId: string;
  kind: string;
  documentId?: string;
  attempt: number;
  maxAttempts: number;
  errorCode: string;
  transient: boolean;
  retryAt?: string;
};

/**
 * Structured, server-side-only logging for a job's own failure (D3, decisions/0016's
 * processing pipeline) - job id, kind, document id (when the payload carries one), attempt
 * number, the stable error code, whether it was transient, and the retry time when one was
 * scheduled. `console.error`/`console.warn`, consistent with
 * `src/platform/api-pipeline/core/handler-factory.ts`'s `logUnhandledError` (same
 * `[owner] message` prefix convention, server-side only). Never logs the job's own
 * `payload` or the thrown error's raw message - only these named, already-stable fields
 * (AGENTS.md "Security": never log document content, personal data, or the API key).
 */
function logJobFailure(level: "warn" | "error", message: string, fields: JobFailureLogFields): void {
  const log = level === "error" ? console.error : console.warn;
  log(`[jobs] ${message}`, fields);
}

export type RunDueInput = {
  limit?: number;
  workspaceId?: string;
  /** Wall-clock budget in milliseconds (decisions/0076). Once it is used up, no further job is
   * started: the loop stops claiming, and jobs already claimed in the current round but not
   * yet started are released (`JobsRepository.release`), so they never sit behind a lease of a
   * runner the platform is about to stop. A job that already started always runs to its end;
   * the caller's own time limit must leave room for that. Omitted: no budget, only the round
   * limit. */
  budgetMs?: number;
};

export interface JobsUseCases {
  /** Claims and runs up to `limit` due jobs (optionally scoped to one workspace). Never
   * throws for an individual job's failure - each job's own outcome (succeeded, rescheduled
   * with backoff, or permanently failed) is recorded on that job's row; only an error from
   * the claim step itself propagates. */
  runDue(input: RunDueInput): Promise<{ processed: number }>;
}

export function createJobsUseCases(deps: {
  repos: Repositories;
  uow: UnitOfWork;
  handlers: JobHandlers;
  now?: () => Date;
  leaseMs?: number;
}): JobsUseCases {
  const now = deps.now ?? (() => new Date());
  const leaseMs = deps.leaseMs ?? LEASE_MS;

  async function runOne(job: JobRow): Promise<void> {
    const handler = deps.handlers[job.kind];
    if (!handler) {
      await deps.repos.jobs.markFailed(job.id, { errorCode: "unknown_job_kind", now: now() });
      // Should never happen in practice (a defensive fallback, see `error-codes.ts`'s own
      // comment) - if it does, it means a job kind was enqueued with no handler registered
      // for it in the composition root, which is itself a bug worth a terminal-level log.
      logJobFailure("error", "job failed: no handler registered for this kind", {
        jobId: job.id,
        kind: job.kind,
        documentId: extractDocumentId(job.payload),
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
        errorCode: "unknown_job_kind",
        transient: false,
      });
      return;
    }

    try {
      await handler(job.payload);
      await deps.repos.jobs.markSucceeded(job.id, now());
    } catch (err) {
      const permanent = err instanceof PermanentJobError;
      const transient = !permanent;
      const errorCode = err instanceof TransientJobError || err instanceof PermanentJobError ? err.code : "unknown";
      const exhausted = job.attempts >= job.maxAttempts;
      const documentId = extractDocumentId(job.payload);

      if (permanent || exhausted) {
        await deps.repos.jobs.markFailed(job.id, { errorCode, now: now() });
        // The terminal outcome - no further retry will happen - logged at a higher level
        // than an ordinary retryable attempt (D3), and the one point where a job failure
        // that never crosses a Next.js request boundary still reaches Sentry when
        // configured (`captureError` is a no-op without a DSN).
        logJobFailure("error", "job failed permanently (no further retries)", {
          jobId: job.id,
          kind: job.kind,
          documentId,
          attempt: job.attempts,
          maxAttempts: job.maxAttempts,
          errorCode,
          transient,
        });
        captureError(err, { jobId: job.id, kind: job.kind, documentId, attempt: job.attempts, maxAttempts: job.maxAttempts, errorCode });
      } else {
        const delayMs = computeBackoffMs(job.attempts);
        const runAt = new Date(now().getTime() + delayMs);
        await deps.repos.jobs.reschedule(job.id, { runAt, errorCode, now: now() });
        // A retryable attempt failing is expected/self-healing (a rate limit, a timeout) -
        // logged, but at a lower level than the terminal case, and not sent to Sentry on its
        // own (the terminal branch above reports it if every attempt eventually fails).
        logJobFailure("warn", "job attempt failed, scheduled for retry", {
          jobId: job.id,
          kind: job.kind,
          documentId,
          attempt: job.attempts,
          maxAttempts: job.maxAttempts,
          errorCode,
          transient,
          retryAt: runAt.toISOString(),
        });
      }
    }
  }

  return {
    async runDue({ limit = 5, workspaceId, budgetMs } = {}) {
      // Looped, not a single claim-and-run pass: a handler can enqueue a follow-up job in
      // the very same call (a confirmed bank statement's `process-document` run enqueues
      // `import-account-transactions`, a finished invoice or an imported statement enqueues
      // `match-payments` due immediately, decisions/0076), which is not yet claimable at the
      // moment of the FIRST claim - only a later `claimDue` call picks it up. Without this loop, a
      // caller (the upload route's `after()`, the UI "kick", the cron sweeper) would need to be
      // invoked twice to actually finish a single processing run's cascade. `MAX_ITERATIONS`
      // bounds this to a handful of claim rounds - enough to drain a realistic cascade (today:
      // process-document -> import-account-transactions -> match-payments, at most a few levels
      // deep) without ever looping indefinitely; `budgetMs` bounds it in wall-clock time.
      const MAX_ITERATIONS = 10;
      const startedAt = now().getTime();
      const budgetUsedUp = () => budgetMs !== undefined && now().getTime() - startedAt >= budgetMs;
      let processed = 0;

      for (let i = 0; i < MAX_ITERATIONS; i++) {
        if (budgetUsedUp()) break;
        // Claiming happens in its own short transaction (the `for update skip locked` lock
        // is only held for the claim itself); running each handler happens OUTSIDE any
        // transaction, since a handler may make a slow external HTTP call (Mistral OCR/chat)
        // that must never hold a database lock open for its duration.
        const claimed = await deps.uow.transaction((repos) => repos.jobs.claimDue({ limit, workspaceId, now: now(), leaseMs }));
        if (claimed.length === 0) break;

        for (const [index, job] of claimed.entries()) {
          if (budgetUsedUp()) {
            await deps.repos.jobs.release(
              claimed.slice(index).map((j) => j.id),
              now(),
            );
            return { processed };
          }
          await runOne(job);
          processed++;
        }
      }

      return { processed };
    },
  };
}
