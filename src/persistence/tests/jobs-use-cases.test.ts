// Unit tests for createJobsUseCases (WEBAPP_TEMPLATE_SPEC.md §10.2): a typed in-memory fake
// jobs repository, no DB, no vi.mock of the database layer. `@/platform/observability/server`
// is mocked (not stubbed via a real env) so these tests never need a full valid
// `serverEnv()` - `@/platform/env`'s own unit-guard deletes required env vars for every unit
// test on purpose (`scripts/test/unit-guard.ts`), and this file has nothing to do with env
// validation.
//
// Covers D2 (decisions/0016-processing-pipeline-and-ai.md, P7 defect list): a job's own
// `last_error_code` must preserve the specific, stable error code end to end - through a
// single transient failure, through a permanent failure, and through a whole
// transient-then-exhausted retry cycle - never collapsing to a generic code except for a
// genuinely unclassified error. Also covers D3: every failure is logged with its code, and
// only the terminal outcome (permanent or exhausted) reaches Sentry via `captureError`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeJobsRepository, jobRow } from "@/persistence/tests/support/fake-jobs-repository";
import { withUnusedRepositories } from "@/persistence/tests/support/unused-repositories";
import type { JobRow, Repositories, UnitOfWork } from "@/persistence/repositories/contracts";
import { createJobsUseCases, type JobHandlers } from "@/persistence/use-cases/jobs-use-cases";
import { PermanentJobError, TransientJobError } from "@/platform/jobs";

vi.mock("@/platform/observability/server", () => ({ captureError: vi.fn() }));

const FIXED_NOW = new Date("2026-03-15T00:00:00.000Z");

function setup(seed: JobRow[], handlers: JobHandlers) {
  const { repo: jobs, state } = createFakeJobsRepository(seed);
  const repos: Repositories = withUnusedRepositories({ jobs });
  const uow: UnitOfWork = { transaction: (work) => work(repos) };
  const useCases = createJobsUseCases({ repos, uow, handlers, now: () => FIXED_NOW });
  return { useCases, state };
}

describe("createJobsUseCases", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let captureError: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    captureError = vi.mocked((await import("@/platform/observability/server")).captureError);
    captureError.mockClear();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("reschedules a transient failure with backoff, keeping the specific error code (not exhausted)", async () => {
    const job = jobRow({ kind: "process-document", payload: { documentId: "doc-1" }, attempts: 0, maxAttempts: 5 });
    const { useCases, state } = setup([job], {
      "process-document": async () => {
        throw new TransientJobError("ai_rate_limited");
      },
    });

    const result = await useCases.runDue({});

    expect(result.processed).toBe(1);
    const row = state.find((r) => r.id === job.id)!;
    expect(row.status).toBe("pending");
    expect(row.lastErrorCode).toBe("ai_rate_limited");
    expect(row.runAt.getTime()).toBeGreaterThan(FIXED_NOW.getTime());

    expect(warnSpy).toHaveBeenCalledWith(
      "[jobs] job attempt failed, scheduled for retry",
      expect.objectContaining({ jobId: job.id, documentId: "doc-1", errorCode: "ai_rate_limited", transient: true, attempt: 1, maxAttempts: 5 }),
    );
    expect(errorSpy).not.toHaveBeenCalled();
    expect(captureError).not.toHaveBeenCalled();
  });

  it("marks a permanent failure failed immediately, logs at error level, and reports it to Sentry", async () => {
    const job = jobRow({ kind: "process-document", payload: { documentId: "doc-2" }, attempts: 0, maxAttempts: 5 });
    const thrown = new PermanentJobError("ai_auth_failed");
    const { useCases, state } = setup([job], {
      "process-document": async () => {
        throw thrown;
      },
    });

    await useCases.runDue({});

    const row = state.find((r) => r.id === job.id)!;
    expect(row.status).toBe("failed");
    expect(row.lastErrorCode).toBe("ai_auth_failed");

    expect(errorSpy).toHaveBeenCalledWith(
      "[jobs] job failed permanently (no further retries)",
      expect.objectContaining({ jobId: job.id, documentId: "doc-2", errorCode: "ai_auth_failed", transient: false }),
    );
    expect(captureError).toHaveBeenCalledWith(thrown, expect.objectContaining({ jobId: job.id, errorCode: "ai_auth_failed" }));
  });

  it("D2: a transient-then-exhausted failure ends with the SAME specific code, never a generic fallback", async () => {
    // Seeded at attempts = maxAttempts - 1: claimDue increments to maxAttempts, so this run
    // is the final allowed attempt - `exhausted` becomes true on this very call.
    const job = jobRow({ kind: "process-document", payload: { documentId: "doc-3" }, attempts: 4, maxAttempts: 5 });
    const { useCases, state } = setup([job], {
      "process-document": async () => {
        // The same root cause on every attempt, exactly like a key that is permanently
        // rate-limited for a given model (P7's real-API finding): classified transient
        // every single time, yet never actually recoverable.
        throw new TransientJobError("ai_rate_limited");
      },
    });

    await useCases.runDue({});

    const row = state.find((r) => r.id === job.id)!;
    expect(row.status).toBe("failed");
    expect(row.lastErrorCode).toBe("ai_rate_limited");
    expect(row.lastErrorCode).not.toBe("processing_failed");
    expect(row.lastErrorCode).not.toBe("unknown");

    expect(errorSpy).toHaveBeenCalledWith(
      "[jobs] job failed permanently (no further retries)",
      expect.objectContaining({ errorCode: "ai_rate_limited", transient: true, attempt: 5, maxAttempts: 5 }),
    );
    expect(captureError).toHaveBeenCalledTimes(1);
  });

  it("D2: an unknown (non-classified) error falls back to a generic code, and is still logged and captured", async () => {
    const job = jobRow({ kind: "process-document", payload: { documentId: "doc-4" }, attempts: 4, maxAttempts: 5 });
    const thrown = new Error("something nobody classified");
    const { useCases, state } = setup([job], {
      "process-document": async () => {
        throw thrown;
      },
    });

    await useCases.runDue({});

    const row = state.find((r) => r.id === job.id)!;
    expect(row.status).toBe("failed");
    expect(row.lastErrorCode).toBe("unknown");
    expect(captureError).toHaveBeenCalledWith(thrown, expect.objectContaining({ errorCode: "unknown" }));
  });

  it("marks a job failed with unknown_job_kind and logs it when no handler is registered", async () => {
    const job = jobRow({ kind: "no-such-kind", attempts: 0, maxAttempts: 5 });
    const { useCases, state } = setup([job], {});

    await useCases.runDue({});

    const row = state.find((r) => r.id === job.id)!;
    expect(row.status).toBe("failed");
    expect(row.lastErrorCode).toBe("unknown_job_kind");
    expect(errorSpy).toHaveBeenCalledWith("[jobs] job failed: no handler registered for this kind", expect.objectContaining({ errorCode: "unknown_job_kind" }));
  });

  it("succeeds without any failure logging or Sentry reporting", async () => {
    const job = jobRow({ kind: "process-document", attempts: 0, maxAttempts: 5 });
    const { useCases, state } = setup([job], { "process-document": async () => {} });

    await useCases.runDue({});

    expect(state.find((r) => r.id === job.id)!.status).toBe("done");
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(captureError).not.toHaveBeenCalled();
  });

  it("omits documentId from the log fields when the payload does not carry one", async () => {
    const job = jobRow({ kind: "send-quota-warning", payload: { workspaceId: "w1" }, attempts: 0, maxAttempts: 5 });
    const { useCases } = setup([job], {
      "send-quota-warning": async () => {
        throw new PermanentJobError("processing_failed");
      },
    });

    await useCases.runDue({});

    expect(errorSpy).toHaveBeenCalledWith(
      "[jobs] job failed permanently (no further retries)",
      expect.objectContaining({ documentId: undefined }),
    );
  });
});
