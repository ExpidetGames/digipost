# src/platform/jobs

Document type: reference
Lifecycle: active
Owner: src/platform/jobs
Scope: The asynchronous job queue (WEBAPP_TEMPLATE_SPEC.md §14's jobqueue recipe): the
`jobs` table, claim/lease/backoff, the generic runner, and the three triggers that call it
Canonical responsibility: The one place that knows how to claim, run, retry, and back off a
job - it has no idea what any given job `kind` actually does
Maintenance triggers:
- The `jobs` table's columns, the claim query, or the backoff formula change
- A new trigger calls `runDueJobs`
- The lease duration or default claim limit changes
Last verified: 2026-10-22, decisions/0075-email-intake.md: two new job kinds, `process-inbound-email`
(handler: `MailIntakeUseCases.processInboundEmail`) and `send-mail-intake-notification`, both
registered in `src/persistence/composition/job-handlers.ts`. Previously 2026-09-20, F5 (decisions/0027-hardening-and-deletion.md): two new job kinds -
`cleanup-workspace-storage` (workspace deletion's durable object-storage cleanup retry,
enqueued with `workspaceId: null` on purpose so the job survives the very `workspaces.id`
cascade it cleans up after) and `purge-rejected-intake` (the retention cron's actual
per-document deletion, one job per eligible document). Neither needed a change to this
owner's own queue/runner logic - both are ordinary handlers registered in
`src/persistence/composition/job-handlers.ts`, the point of a domain-free queue. 2026-09-20, P7 (D2/D3, real-API defect fixes): `jobs-use-cases.ts`'s `runOne`
now logs every job failure (structured, `console.warn`/`console.error`) and reports the
terminal outcome to Sentry via `@/platform/observability/server`'s `captureError` - see
`src/persistence/README.md` and `tests/jobs-use-cases.test.ts` (that file's first dedicated
unit test). P2b (processing pipeline), decisions/0016-processing-pipeline-and-ai.md

## Purpose

A generic, domain-free job queue: `enqueue` a `{ kind, payload }` (optionally inside a
caller's own transaction, so a job only exists once the write that motivated it has
committed), and later `runDueJobs()` claims a batch of due jobs and dispatches each to a
handler by `kind`. This owner never imports a module - it does not know
`"process-document"` or `"send-quota-warning"` exist. The map from `kind` to actual
handler logic is built by the composition root (`src/persistence/composition/job-handlers.ts`),
from each owning module's own use-case methods ("handlers registered where they belong").

## Public interfaces

- `index.ts` (neutral, no `server-only`, no I/O): `JOB_KINDS`/`JobKind` (the stable kind
  identifiers), `TransientJobError`/`PermanentJobError` (the two shapes a handler throws -
  `src/persistence/use-cases/jobs-use-cases.ts`'s runner only ever distinguishes these two),
  `computeBackoffMs` (pure exponential backoff with half-jitter).
- `server.ts` (`import "server-only"`): `runDueJobs({ limit?, workspaceId? })` - the one
  function every trigger calls. A thin wrapper around `getRequestServices().jobs.runDue(...)`;
  the actual claim/dispatch/backoff logic lives in `src/persistence/use-cases/jobs-use-cases.ts`
  (this owner's use case, run through the composition root like every other owner's).

## Structure

- `core/job-kinds.ts` - `JOB_KINDS` (`"process-document"`, `"send-quota-warning"`,
  `"import-account-transactions"`, `"match-payments"`, `"match-settlement-lines"`,
  `"cleanup-workspace-storage"`, `"purge-rejected-intake"` - F5 added those two -,
  `"process-inbound-email"`, `"send-mail-intake-notification"` - decisions/0075-email-intake.md) - the
  literal values are also stored in the `jobs.kind` database column, so renaming one needs a
  data migration, not just a code change.
- `core/errors.ts` - `TransientJobError`/`PermanentJobError`, both carrying a stable `code`.
- `core/backoff.ts` - `computeBackoffMs(attempt, options?)`: `min(maxMs, baseMs *
  2^(attempt-1))` scaled by a random factor in `[0.5, 1)` (half-jitter, avoids many jobs
  retrying at the exact same instant). Pure: `random`/`baseMs`/`maxMs` are all injectable.
- `server/run-due-jobs.ts` - `runDueJobs`, as described above.

The actual database access (`jobs` table, `select ... for update skip locked`) lives in
`src/persistence/repositories/{contracts,drizzle}/jobs-repository.ts` (this owner's schema,
`src/persistence/schema/jobs.ts` - see `src/persistence/README.md`'s ownership table),
and the claim/dispatch/backoff orchestration lives in
`src/persistence/use-cases/jobs-use-cases.ts` - both owned by this concern, physically under
`src/persistence/` per this repository's persistence-layer convention (WEBAPP_TEMPLATE_SPEC.md
§5.7: schema/repositories/use-cases are centralized, not module-local, so foreign keys and
joins can cross owner boundaries cleanly).

## Design notes

- **Claim, then run outside any transaction.** `jobs-use-cases.ts`'s `runDue` claims inside
  a short transaction (the `for update skip locked` lock only matters for the claim itself),
  then runs each handler *outside* any transaction - a handler may call Mistral over HTTP
  (`src/platform/mistral`) and must never hold a database lock open for that long.
- **`runDue` loops, up to a bounded number of rounds.** A handler can enqueue a follow-up
  job in the same call (a confirmed bank statement's `process-document` run enqueues
  `import-account-transactions`), which is not yet due at the moment of the first claim.
  `runDue` re-claims (up to 10 rounds)
  until a round claims nothing, so a single caller invocation - the UI "kick", the cron sweep,
  the upload route's `after()` - actually drains a realistic cascade instead of needing to be
  invoked twice.
- **Status only tracks the terminal outcome.** `jobs.status` is `pending | done | failed`; an
  in-flight claim is `locked_until` being in the future, not a fourth "processing" value -
  this keeps the claim predicate a single comparison instead of two overlapping state
  machines.
- **Any unclassified error is transient.** A handler that throws something other than
  `TransientJobError`/`PermanentJobError` is retried, not silently recorded as permanent - a
  genuine bug surfaces via `max_attempts` exhaustion, never on its first occurrence.
- **Every failure is logged; only the terminal one reaches Sentry (D3).** A retryable
  attempt logs at `console.warn` (job id, kind, a best-effort document id when the payload
  carries one, attempt number, the stable error code, `transient: true`, the computed retry
  time) - expected, self-healing, not worth a Sentry event on its own. The terminal outcome
  (permanent, or attempts exhausted) logs at `console.error` and calls
  `@/platform/observability/server`'s `captureError`, since a background job failure never
  crosses a Next.js request boundary the way `instrumentation.ts`'s `onRequestError` expects
  - without this explicit call it would never reach Sentry regardless of `SENTRY_DSN`. Never
  logs the job's own `payload` or a thrown error's raw message, only these stable fields.
- **Three triggers, one function.** `after()` (the upload route and `retryProcessingAction`),
  the cron sweeper (`src/app/api/cron/process-jobs`), and the UI's workspace-scoped "kick"
  (`src/modules/documents/actions.ts`'s `kickProcessingAction`) all call `runDueJobs` - see
  decisions/0016-processing-pipeline-and-ai.md for why three, and the Vercel Hobby cron
  limitation that makes the other two matter in production.

## Dependencies on other owners

None from this owner's own `core`/`server` files. `src/persistence/use-cases/jobs-use-cases.ts`
(this concern's use case, physically in `src/persistence/`) imports this owner's neutral
`index.ts` for the error classes and `computeBackoffMs`, and (P7, D3)
`@/platform/observability/server`'s `captureError` for terminal-failure Sentry reporting.

## Consumers

`src/persistence/composition/create-request-services.ts` (builds `jobs:
createJobsUseCases({ repos, uow, handlers })`), `src/persistence/composition/job-handlers.ts`
(builds the `handlers` map this owner's runner dispatches through), `src/modules/documents/actions.ts`
(`retryProcessingAction`/`kickProcessingAction` both call `runDueJobs` via `after()`),
`src/app/api/cron/process-jobs/route.ts` (the cron sweeper),
`src/app/api/cron/purge-rejected-intake/route.ts` (F5: enqueues then immediately sweeps),
and `src/persistence/use-cases/documents-use-cases.ts`/`workspaces-use-cases.ts`
(`createFromUpload`/`reassign`/`processDocument`/`deleteWorkspace` all call
`repos.jobs.enqueue` - a repository call, not this owner's `server.ts`, since enqueueing
must participate in the caller's own transaction).

## Tests

- `tests/backoff.test.ts` (unit, `pnpm test`): the exponential formula, the cap, the
  half-jitter range, and the default options.
- `src/persistence/tests/jobs-repository.db.test.ts` (real Postgres, `pnpm test:db` / part of
  `pnpm test:docker`): two concurrent `claimDue` callers never receive the same job, an
  expired lease is reclaimable, a not-yet-due or already-leased job is not claimed, workspace
  scoping, and `enqueue` rolling back with its transaction.
- `src/persistence/tests/documents-use-cases.test.ts` (unit, `pnpm test`): the runner's own
  dispatch/retry/backoff behavior is exercised indirectly through `DocumentUseCases.processDocument`
  against a fake `JobsRepository` (`src/persistence/tests/support/fake-jobs-repository.ts`).
- `src/persistence/tests/jobs-use-cases.test.ts` (unit, `pnpm test`, P7): `runOne`'s own
  logic directly (not indirectly through a module's use case) - a single transient failure,
  a single permanent failure, a full transient-then-exhausted retry cycle (D2: the specific
  error code survives, never a generic fallback), an unclassified error (D2: falls back to
  a generic code, still logged/captured), the `unknown_job_kind` no-handler-registered path,
  and (D3) that logging/`captureError` fire with the right level/fields in each case.
- `src/app/api/cron/process-jobs/route.test.ts` (unit): the cron route's own access-step
  gate, `runDueJobs` mocked. `tests/integration/http/cron-process-jobs.integration.test.ts`:
  the same route against real Postgres, unmocked.
- `tests/integration/workflows/processing-pipeline.integration.test.ts`: uploads through the
  real route handler, then calls `runDueJobs` directly against real Postgres + MinIO with the
  fake AI provider.
- F5: `cleanup-workspace-storage`'s handler is exercised indirectly through
  `deleteWorkspaceAction`'s own unit tests (mocked object storage) and directly by
  `WorkspaceUseCases.deleteWorkspace`'s unit tests asserting the enqueued job's shape
  (`workspaceId: null`, the `{ prefix }` payload). `purge-rejected-intake`'s handler and the
  cron route that enqueues it are covered by `src/app/api/cron/purge-rejected-intake/route.test.ts`
  (mocked) and `tests/integration/http/cron-purge-rejected-intake.integration.test.ts` (real
  Postgres + MinIO, proving the row and its storage object are actually deleted).
