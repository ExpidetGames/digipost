# Payment matching runs right after every trigger

Document type: decision
Lifecycle: active
Owner: src/modules/payments (the trigger rule), src/platform/jobs (the queue and runner changes)
Scope: when the workspace-wide `match-payments` job runs after a finished document or an
imported statement (`JobsRepository.scheduleNow`/`hasQueuedPending`), how the job runner keeps
going within one `after()` invocation (`runDue`'s `budgetMs`, `JobsRepository.release`,
`AFTER_RESPONSE_JOB_BUDGET_MS`), and the `maxDuration` of the routes that run jobs after their
response
Canonical responsibility: Active source for why matching is never left waiting for the cron
sweep, how a burst of triggers is deduplicated, and how long an `after()` runner keeps starting
jobs
Maintenance triggers:
- The AI arbiter starts caching "no match" answers (the cost estimate below then shrinks)
- Production gains a frequent scheduler, or the cron interval in `vercel.json` changes
- The Vercel plan or Fluid Compute setting changes the maximum function duration
- The upload form starts uploading several files in parallel
Last verified: 2026-10-22, against `src/persistence/use-cases/jobs-use-cases.ts`,
`src/persistence/repositories/drizzle/jobs-repository.ts`, `documents-use-cases.ts`,
`accounts-use-cases.ts`, `payments-use-cases.ts`, `src/app/api/documents/route.ts`,
`src/app/api/webhooks/resend/route.ts`, `vercel.json`, and the tests named under "Verification"

## Status

Accepted. Supersedes the debounce of decisions/0041-debounced-matching.md (its 15-minute job
lease still holds) and refines decisions/0039-matching-hardening-after-first-real-upload.md's
fourth point ("at most one scheduled follow-up").

## Context

Production runs on Vercel. Jobs run only when something calls `runDueJobs`: the cron
`GET /api/cron/process-jobs` every two hours (`vercel.json`), and an `after()` callback in the
upload route, the Resend webhook and a few Server Actions. A more frequent cron is not
acceptable: the Neon database must be allowed to scale to zero between uses.

decisions/0041 scheduled `match-payments` 90 seconds after the last trigger. By then the
`after()` runner that processed the document had long finished, so matching waited for the next
cron sweep: an invoice that arrived at 12:39 was due for matching at 12:41 and would have been
matched at 14:00. The same held for every imported statement.

## Decision

1. **Due now, one queued run per workspace.** A finished invoice-shaped document
   (`processOcrDocument`, so also an e-mail attachment, a retry and a kind correction that end
   in `done`) and a statement import that inserted at least one new transaction
   (`importFromDocument`: camt.053, MT940, a confirmed CSV, the pending-account resolution and
   "Erneut importieren") call `JobsRepository.scheduleNow`. If a `match-payments` job of the
   workspace is queued (pending and not leased), its `run_at` becomes `least(run_at, now)`:
   a due one keeps its place, a six-hour follow-up of decisions/0039 is pulled forward instead
   of swallowing the trigger. Otherwise a job due now is inserted. A job that is running right
   now does not count, because it may already have read the data the trigger is about.
   `scheduleMatching` (the auto-confirm mode change, decisions/0044) uses the same call.
   `MATCHING_DEBOUNCE_MS` and `scheduleDebounced` are gone.
2. **The follow-up check counts any queued run.** decisions/0039's `hasScheduledPending` only
   saw jobs scheduled in the future, so a run due now would have got a second, six-hour
   follow-up next to it. `hasQueuedPending` counts every pending, unleased job of the kind; a
   queued run schedules its own follow-up when it finishes.
3. **The runner keeps claiming within a time budget.** `runDue` already re-claimed up to ten
   rounds until a round claimed nothing; claims are ordered by `run_at`, then `created_at`, so
   a matching job queued by the first finished document runs after the documents already
   queued before it. New: `budgetMs`. Once it is used up the runner starts no further job and
   releases the claimed ones it did not start (`JobsRepository.release` clears the lease and
   gives back the attempt), so they are not stuck behind a lease of an invocation the platform
   is about to stop. Every `after()` trigger passes `AFTER_RESPONSE_JOB_BUDGET_MS` (two
   minutes); the cron sweep passes none.
4. **Room to finish.** The upload route and the Resend webhook declare `maxDuration = 300`
   (previously 30 and 60), so a job started just before the budget ends has three minutes.
   Server Actions inherit the platform default (300 seconds with Fluid Compute).
   `importFromDocumentAction` and `setPaymentAutoConfirmAction` now also start the runner in
   `after()`, like the document actions already did.
5. **Kind correction.** The `process-document` handler discards a re-extracted document's
   stale suggestions after re-extraction (decisions/0072). Since matching is now due at once, a
   concurrent runner could run it between the two and lose its fresh suggestions to that
   cleanup, so the handler schedules matching once more after the cleanup (deduplicated).

## Consequences

- Positive: a single upload, an e-mail attachment, a retry, a kind correction and every
  statement import end matched within the same invocation that processed them, without the
  cron.
- Positive: the cron's two-hour interval only matters for retries and for the six-hour
  follow-up; the database can still scale to zero.
- Negative: matching runs more often. A bulk upload through the upload form sends one request
  per document, and each request's `after()` runs the queue. The worst case is one matching run
  per finished invoice-shaped document (and one per statement import with new transactions):
  when every document finishes while the previous run is already going, each finish queues one
  new run. The best case, documents queued before a runner reaches the matching job, is one run
  for all of them. Many queued triggers never pile up: there is at most one queued run plus the
  ones running.
- Negative, cost: a run asks the AI arbiter about every open transaction that has candidates
  and no cached answer. An answer naming a match is cached by `arbiter_cache_key`
  (decisions/0025), but "no match" still is not, so each run asks again for those. With N runs
  and T such transactions this is up to N x T calls (decisions/0041's concern, which the
  debounce had bounded). These calls share `mistral-small`'s per-minute limit with document
  processing; a rate-limited document retries with backoff (decisions/0042), and a retry that
  is not due before the runner's budget ends waits for the next trigger or the cron. Caching
  "no match" per cache key would bound this; it is not part of this decision.
- Negative: an `after()` invocation can now last minutes instead of seconds (billed as active
  CPU time and memory on Fluid Compute).
- Neutral: a pulled-forward follow-up keeps its payload (`trigger: "cron"`); the trigger is only
  logged, never branched on.
- Neutral: two runs can still be queued when two triggers insert at the very same instant in
  parallel transactions (neither sees the other's row); both run, matching is idempotent.

## Verification

- Unit: `src/persistence/tests/jobs-use-cases.test.ts` (a document queues matching that runs
  once, after the earlier documents, in the same call; a trigger during a running match queues
  one more run; the budget stops starting jobs and releases the rest),
  `payments-use-cases.test.ts` (no extra follow-up next to a queued run; a six-hour follow-up is
  pulled forward), `documents-use-cases.test.ts` and `accounts-use-cases.test.ts` (both triggers
  queue a run due now), the action tests of `src/modules/documents` and `src/modules/accounts`.
- DB: `src/persistence/tests/jobs-repository.db.test.ts` (`scheduleNow` inserts, deduplicates,
  pulls forward, ignores a leased run; `hasQueuedPending`; `release`; the `created_at` tie break).
- Integration: `tests/integration/workflows/payments-matching.integration.test.ts` (a statement
  upload and then an invoice upload each end matched within one `runDueJobs` call, the invoice
  despite a queued six-hour follow-up; two invoices queued together get one matching run).
- E2E: `tests/e2e/payments.spec.ts` waits for the app's own `after()` runner to finish matching
  and never triggers or reschedules a job itself (`tests/e2e/helpers/jobs.ts`).

## Supersedes / Superseded By

Supersedes: decisions/0041-debounced-matching.md (the 90-second trailing debounce; the 15-minute
lease is kept). Refines: decisions/0039-matching-hardening-after-first-real-upload.md, point 4.
