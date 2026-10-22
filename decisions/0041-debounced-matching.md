# Debounced payment matching

Document type: decision
Lifecycle: active
Owner: src/modules/payments
Scope: when the workspace-wide `match-payments` job runs after a finished invoice or an imported
statement (`MATCHING_DEBOUNCE_MS`, `JobsRepository.scheduleDebounced`), and the job lease
Canonical responsibility: Active source for why matching runs once after a burst of triggers
instead of once per trigger
Maintenance triggers:
- The AI arbiter starts caching "no match" answers (the debounce then matters less)
- Matching moves to a platform with a hard execution time limit (a run can take minutes)
Last verified: 2026-09-22, initial version

## Status

Superseded in part by decisions/0076-match-after-every-trigger.md (2026-10-22): the 90-second
trailing debounce is gone, a trigger now makes one queued run per workspace due immediately, because
production only runs jobs from `after()` and a two-hourly cron and the delayed run waited for the
cron. The 15-minute job lease still holds.

## Context

Every finished invoice and every imported statement enqueued an immediate `match-payments` run.
A run evaluates the whole workspace and asks the AI arbiter about every open transaction that has
candidates; an answer of "no match" is not cached, so the next run asks again. Before a bulk upload
of a year's receipts against 105 debits this meant roughly one AI call per open transaction per
uploaded document: tens of thousands of calls, far above `mistral-small`'s 100 requests per minute,
which the document processing itself shares. Documents would have failed on rate limits.

## Decision

Both triggers schedule the run 90 seconds ahead. If a run is already scheduled in the future, its
start is moved to 90 seconds after the new trigger instead of adding another (trailing debounce).
A continuous bulk upload therefore produces one run shortly after the last document. The job
lease grows from 5 to 15 minutes, because that single run can make an AI call per open transaction
and outlast 5 minutes, and a second claimer must not start it again.

## Consequences

- Positive: AI calls for matching scale with the number of runs, not the number of documents.
- Negative: a newly uploaded invoice is matched about 90 seconds later instead of immediately.
- Negative: a crashed job is retried after 15 minutes instead of 5.
- Neutral: "no match" answers are still not cached, so each follow-up run asks again; with one run
  every six hours this is acceptable for now.
