# Retry backoff for per-minute provider limits, and a local job sweeper

Document type: decision
Lifecycle: active
Owner: src/platform/jobs (backoff), src/platform/api-pipeline (local sweeper)
Scope: `computeBackoffMs`'s defaults and the development-only sweeper started from
`src/instrumentation.ts`
Canonical responsibility: Active source for why retries wait tens of seconds to minutes, and why
`next dev` sweeps the job queue on its own
Maintenance triggers:
- The AI provider's rate limits change (per minute today)
- Production gets its own scheduler inside the app instead of an external cron call
Last verified: 2026-09-22, initial version

## Status

Accepted

## Context

The owner bulk-uploaded 64 receipts. `mistral-small` allows 100 requests and 100,000 tokens per
minute; each receipt sends its full OCR text to the classifier and the analyzer, several thousand
tokens. 26 receipts were rate-limited. The retry backoff started at 2 seconds, so they spent three
to five of their five attempts within about a minute, while the per-minute window was still
exhausted; one failed for good.

At the same time nothing ran the job queue once uploads stopped. Locally, jobs only ran as the
tail of an upload request, and the dashboard's poller only kicks while documents are processing.
Due retries and the debounced matching run (decisions/0041) therefore waited indefinitely: none of
the receipts was matched. Production is meant to be driven by an external scheduler calling
`GET /api/cron/process-jobs` (decisions/0016); `next dev` has none.

## Decision

- Backoff defaults: 30 seconds for the first retry (15 to 30 with jitter), doubling, capped at
  10 minutes. Five attempts now span roughly a quarter of an hour, long enough for per-minute
  limits to recover.
- In development only (`NODE_ENV=development`, Node runtime), `src/instrumentation.ts` starts a
  sweeper that calls `GET /api/cron/process-jobs` with the cron secret every 20 seconds, never two
  calls at once. It exercises the same route production's scheduler uses.

## Consequences

- Positive: a burst of uploads degrades into delay, not into failed documents.
- Positive: locally, retries and matching run without anyone clicking anything.
- Negative: a genuinely transient failure (a timeout) also waits 15 to 30 seconds before its
  first retry.
- Neutral: production still needs its external scheduler at a short interval; this changes
  nothing there.
