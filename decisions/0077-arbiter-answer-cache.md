# The AI arbiter remembers every answer

Document type: decision
Lifecycle: active
Owner: src/modules/payments (the cache key, the table, `runMatching`'s use of it),
src/platform/mistral (the real arbiter's `version`)
Scope: how `runMatching`'s stage 3 decides whether to ask the AI arbiter
(`PaymentArbiter.rank`) or to reuse an earlier answer: `arbiterCacheKey`,
`PaymentArbiter.version`, `paymentArbiterPromptFingerprint`, `toCacheableArbiterAnswer`, the
`payment_arbiter_answers` table and its `PaymentArbiterAnswerRepository`
Canonical responsibility: Active source for what makes two arbiter questions "the same", which
answers are kept, and when a kept answer goes away
Maintenance triggers:
- `MatchableTransaction`/`MatchableDocument` gain a field that changes often without changing
  the question (it is hashed into the key and would cost extra questions)
- The arbiter starts receiving anything beyond `PaymentArbiterInput` (it must enter the key)
- A second `PaymentArbiter` implementation is added (it needs its own `version`)
- The arbiter prompt starts rendering a value that the two fixed fingerprint samples in
  `payment-arbiter-prompts.ts` do not exercise
Last verified: 2026-10-22, initial version, against `src/modules/payments/core/arbiter.ts`,
`src/persistence/use-cases/payments-use-cases.ts`, `src/persistence/schema/payments.ts`,
`src/platform/mistral/server/payment-arbiter-prompts.ts`, migration `0024_salty_vindicator.sql`,
and the tests named under "Verification"

## Status

Accepted. Refines decisions/0025-payment-matching-wiring.md's decision 6 (the AI stage cache:
what the key covers and which answers are kept). Resolves the cost noted in
decisions/0076-match-after-every-trigger.md's "Consequences" and decisions/0041's remark that
"no match" answers were not cached.

## Context

decisions/0076 runs payment matching right after every analyzed document and every statement
import, and decisions/0039 adds a follow-up run six hours later while anything is unresolved.
Every run walks every open transaction. Stage 3 asks the AI arbiter about each transaction that
stages 1 and 2 could not explain and that has candidate documents.

decisions/0025's cache only covered a positive answer: `arbiterCacheKey(tx, candidateIds)` was
stored on the `kind: "ai"` suggestion row (`document_transactions.arbiter_cache_key`), and a run
skipped the call only when such a row existed with the same key. A "no match" answer, a pick
that failed the code checks (decisions/0033, decisions/0039), and a pick whose suggestion was
later withdrawn left nothing behind, so every run asked again. Salaries, fees and card charges
without a receipt are exactly such transactions and they never go away. With N runs and T of
them, a bulk upload cost up to N x T calls, all on `mistral-small`'s per-minute limit that
document processing also needs (decisions/0042).

The old key also did not cover what the candidates looked like: only their ids. A candidate
whose open amount dropped (a partial payment booked elsewhere), whose fields were re-extracted
or whose kind was corrected (decisions/0072) kept the same key, so a cached pick could be reused
for a question that had in fact changed. And it did not cover the model or the prompt.

## Decision

1. **The key is the whole question.** `arbiterCacheKey(tx, candidates, arbiterVersion)`
   (`core/arbiter.ts`) is a SHA-256 over: every field of the `MatchableTransaction` (its `id`
   included), every field of every candidate `MatchableDocument` (`openAmountCents`,
   `direction`, invoice number, dates, contact, `referenceText`, ...), candidates sorted by id,
   and `PaymentArbiter.version`. Fields are serialized as sorted `[key, value]` pairs, and a
   `null` field is left out like an absent one, so property order and "absent vs. null" never
   change the key; a format number is part of the payload. Everything `rank` receives is in the
   key, so the same key really is the same question. Hashing all fields instead of the ones
   today's prompt shows means a field a future prompt starts using is covered without touching
   the key; the cost is an occasional extra question when a field the prompt ignores changes
   (a contact's IBAN, say), which is rare.
2. **The arbiter names its version.** `PaymentArbiter` gained `readonly version: string`. The
   real adapter's is `mistral:<model>:<prompt fingerprint>`, where
   `paymentArbiterPromptFingerprint()` hashes the system prompt and the user prompt body rendered
   for two fixed samples (one with every field set, one with every optional field missing),
   without `wrapUntrustedSection`'s random per-call delimiters. Any edit to the prompt text or
   its formatting, and any model change (`MISTRAL_CHAT_MODEL`), therefore asks every question
   again once, with no manual version bump to forget. The fake's is `fake:1`; the "not
   configured" adapter's is `not_configured` (it never answers, so nothing is stored under it).
3. **Every answer is kept, one row per transaction.** A new table `payment_arbiter_answers`
   (owner `src/modules/payments`, migration `0024_salty_vindicator.sql`): `workspace_id`
   (cascade from `workspaces`), `transaction_id` (cascade from `transactions`, unique),
   `cache_key`, and the raw answer (`best_document_id` as text with no foreign key, since it may
   name a hallucinated id or a document deleted since; `confidence`; `reason`). The answer is
   stored through `toCacheableArbiterAnswer`: a malformed answer becomes "no pick", the
   confidence is clamped, the reason is cut to 1000 characters. Validation reads only the first
   sentence (at most 300 characters) and clamps again, so validating the stored answer gives
   exactly what validating the live one gave. A new answer for the same transaction replaces
   the old row (`ON CONFLICT (transaction_id) DO UPDATE`, restricted to the same workspace).
4. **Reuse, then validate as always.** For a transaction that reaches stage 3, `runMatching`
   computes the key. If a `kind: "ai"` suggestion row already carries it, nothing happens (as
   before). Otherwise, if `payment_arbiter_answers` holds an answer under the same key, that
   answer is used; only if not is the arbiter called (counted in `aiCalls`) and its answer
   stored. Either way the answer then goes through `validateArbiterResult` and the rejection
   filter against the current data, exactly like a fresh one: these are code checks and cost
   nothing. A "no match" stays "no match"; a pick whose suggestion was withdrawn by a later rule
   is rebuilt without a call, as the old code rebuilt it with one.
5. **A failed call stores nothing.** A rate limit or any other error propagates as before (the
   job retries, decisions/0042); only an answer is cached.
6. **Invalidation is the key itself.** Nothing is invalidated explicitly. A new candidate in
   the window, a dropped candidate (a deleted document, one that was paid or settled), a changed
   candidate or transaction field, a kind correction, a model or prompt change: each makes a
   different key, the next run asks once and replaces the row. The six-hour follow-up of
   decisions/0039 and a follow-up pulled forward by decisions/0076 run the same `runMatching`,
   so they ask nothing that has not changed.
7. **No cleanup when a transaction is matched, no TTL, no pruning.** The table is bounded by
   construction (at most one row per transaction), and a row is removed together with its
   transaction or its workspace by the foreign-key cascades, never by a job. A matched
   transaction's row stays: it is never read while the transaction is matched, and if the link
   is undone and nothing else changed, the same key comes back and the answer is still valid.
   Replacing a row with the answer to a newer question is not an automatic deletion in the
   sense of decisions/0027 ("Nothing is auto-deleted except one thing"): the row is derived
   data, a memo of an external call that can be recomputed at the price of one call, never
   user data and never shown to anyone; the old answer cannot be useful again, because its key
   only recurs with exactly the inputs that produced it. No new deletion path for anything a
   human created or decided exists.

The existing `document_transactions.arbiter_cache_key` column stays and now holds the new key
for an AI suggestion; it still lets a run skip a transaction whose AI suggestion is already in
place (or already decided by a human) without reading the answer table.

## Consequences

- Positive: the arbiter is asked about a transaction once per distinct question, however many
  runs there are. A bulk upload of D documents against T unexplained debits costs at most one
  call per debit for every document that actually enters that debit's candidate window
  (bounded by D x T only if every document lands in every window), not one per debit per run.
  The follow-up runs ask nothing for an unchanged workspace.
- Positive: a cached pick is never reused for a question that changed (an open amount, a
  re-extracted field, a kind), which the old id-only key allowed.
- Negative: after this deploys, every key differs from the old ones (new payload, new
  version), so the first run of each workspace asks once per open transaction with candidates.
  An existing AI suggestion is then updated with the new key. One-time cost.
- Negative: one more table and one more read per stage-3 transaction per run (an indexed
  lookup by `transaction_id`).
- Neutral: two runs that overlap may both ask the same new question; the later answer wins.
  Matching is idempotent either way.
- Neutral, data protection: the stored `reason` is the model's one sentence about a payment
  and may repeat a counterparty name from the remittance text. It sits next to the transaction
  it describes, is never displayed, is read only by `runMatching`, and goes with the
  transaction and the workspace. It adds nothing to what is sent to Mistral
  (decisions/0016's data protection note is unchanged).

## Verification

- Unit: `src/modules/payments/tests/arbiter.test.ts` (`arbiterCacheKey`: stable for the same
  question, under a different property order, candidate order, and absent vs. `null`; different
  for every transaction field, every listed candidate field, an added, dropped or swapped
  candidate, and a different model or prompt version; `toCacheableArbiterAnswer` validates to
  the same result as the live answer), `src/persistence/tests/payments-use-cases.test.ts`
  ("the arbiter answer cache": no second call for an unchanged question across a trigger run
  and a follow-up run, "no match" and a discarded pick included; exactly one new call, only
  for the transaction that gained a candidate; a new call after a candidate field or the
  arbiter version changed; a withdrawn AI suggestion rebuilt without a call; nothing stored
  when the call fails), `src/platform/mistral/tests/mistral-payment-arbiter.test.ts` and
  `payment-arbiter-prompts.test.ts` (the version names the model; the fingerprint is stable).
- DB: `src/persistence/tests/payment-arbiter-answers.db.test.ts` (one row per transaction,
  replaced by a new answer; workspace-scoped read and write; removed with its transaction),
  `src/persistence/tests/workspaces-repository.db.test.ts` (removed with its workspace,
  decisions/0027's cascade list).
- Integration: `tests/integration/workflows/payments-matching.integration.test.ts` (real
  Postgres, the fake arbiter's `rank` counted with a spy: a "no match" question is asked once
  across two direct runs and one job-runner run, and exactly once more, for that transaction
  with both documents, after a second candidate document appears).

## Supersedes / Superseded By

Refines decisions/0025-payment-matching-wiring.md, decision 6. Supersedes nothing.
