# Payment matching wiring: persistence, orchestration, permission-scoped UI

Document type: decision
Lifecycle: active
Owner: src/modules/payments
Scope: Persisting F3a's pure matching engine's decisions (`document_transactions`,
`payment_aliases`, `payment_rejections`, `payment_no_document_rules`), the `runMatching`
orchestration use case that actually runs the three fixed stages in order, the trigger points
that call it, the AI stage's caching and self-rescheduling, the decision actions (confirm,
reject, unlink, manual link, "kein Beleg nötig", "ohne Zahlung erledigt"), and the
permission-scoped UI (`/dashboard/documents/[id]`'s payment section, `/dashboard/finance`'s
"Zuordnung"/"Offene Posten" tabs, the inbox status chip/filter)
Canonical responsibility: Active source for why `document_transactions` allocates a portion of
a transaction's amount per document rather than storing a single "matched transaction" pointer,
why the AI stage caches by (transaction, candidate set) using a self-rescheduling job instead of
a dedicated cron route, why redaction of amounts/counterparties happens in the server read-model
layer rather than the UI, and every judgment call F3a's own README left for this phase to make
Maintenance triggers:
- The redaction rule (what a member vs. an admin sees) changes
- A new persisted learning mechanism (beyond aliases/rejections/no-document-needed rules) is
  added
- F4 (platform settlement payouts) lands and starts writing to `transactions.transfer_group_id`
  or reusing `core/settlement.ts`
Last verified: 2026-10-21, "A transaction is never allocated past its amount" added below.
Previously 2026-09-20, F3b (payment matching wiring)

## Status
Accepted

## Context

decisions/0023-payment-matching.md (F3a) built the entire three-stage matching engine as pure,
dependency-free domain code with no schema, no persistence, and no UI - deliberately, so it
could ship concurrently with F1b/F2's own persistence work on unrelated files. This phase (F3b)
is the wiring: real tables for a matching decision, the use case that actually runs
`matchByRules` -> `findSubsetSums`/`partialPaymentFor` -> `PaymentArbiter.rank` in that fixed
order per transaction, the trigger points (after a bank import, after a document's invoice
fields are extracted), the human decision actions, and the UI two audiences - an ordinary
member and an admin - see two very different amounts of it.

## Decision

### 1. `document_transactions` allocates an amount per document, not a single "match" pointer

Each row is a `(document_id, transaction_id)` pairing with its own `allocated_amount_cents` -
never a single "this transaction settles this document" boolean. This is what makes a
`collective` suggestion (one transaction, several invoices) representable at all: it becomes
several rows sharing the same `transaction_id`, each with its own document's own full open
amount as its allocation (the collective sum equals the transaction's paid amount by
construction, `findSubsetSums`'s own contract). A document's `openAmountCents` is never a
stored column - it is `abs(total_amount_cents) - sum(allocated_amount_cents where status =
'confirmed')`, aggregated fresh by `DocumentTransactionRepository.sumConfirmedAllocatedByDocument`
every time `runMatching`/a decision action needs it. `documents.payment_status`/`paid_at` ARE
stored (a plain `PaymentStatus`/timestamp), but only ever written by `PaymentsUseCases`'s own
`recomputeDocumentStatus`, immediately after a real decision (confirm/reject/link/unlink) or a
matching run's own auto-confirms - never freely settable, matching decisions/0023's own
`derivePaymentStatus` "derive, don't duplicate" rule for the underlying `PaymentStatus`
computation itself.

### 2. Two rejection records - `document_transactions.status = 'rejected'` AND `payment_rejections`

A rejected suggestion's own row moves to `status: 'rejected'` (kept, not deleted, so a human can
see it was rejected and when). `payment_rejections` is a SEPARATE table recording the same
`(document_id, transaction_id)` pair a second time. This duplication is deliberate: F3a's own
`filterRejectedPairs` contract takes a flat `RejectedPairSet` the ENTIRE matching pass consults
before proposing anything (including a pair that has no `document_transactions` row yet at all,
e.g. a rejected pairing whose row was later deleted by an unrelated cleanup) - a single query
against `payment_rejections` gives `runMatching` that whole set cheaply, without having to
reason about `document_transactions.status` transitions (which also has to represent
`confirmed`, an entirely different kind of "done"). `unlink` (undoing a confirmed match) never
writes to `payment_rejections` - only an explicit "Ablehnen" on a suggestion does; a future
matching run, or a fresh manual link, may re-propose an unlinked pairing.

### 3. `documents.payment_status` is not kept live-updated by a clock

Crossing a due date is not an event this codebase's job queue can react to - nothing schedules
"recompute every open invoice's status at midnight". `resolveDisplayStatus`
(`@/modules/payments`) upgrades a stored `open`/`partially_paid` status to `overdue` for DISPLAY
purposes only, computed at read time from the stored status and due date - the inbox filter/chip,
"Offene Posten"'s bucketing, and the document detail badge all go through this function (or the
equivalent SQL `CASE` expression, `documents-repository.ts`'s `effectivePaymentStatus`, for
filtering). The STORED column can therefore lag `overdue` by up to a day in the worst case (the
due date passed since the last real decision) with no functional consequence: every read path
already corrects for it.

### 4. Redaction happens in the server read-model layer, never only in the UI

A member sees a document's payment status and paid-on date; only `finance.read` sees a matched
transaction's amount/counterparty, and only `finance.manage` sees or acts on a SUGGESTION at
all (reviewing a suggestion inherently means seeing the transaction it proposes - the entire
`suggestions` array is empty for a non-admin, not merely hidden by the client). This is decided
in `src/modules/payments/server/read-models.ts`'s `getDocumentPaymentSectionProjection`, which
takes the caller's own `revealFinanceDetails` boolean and either includes or OMITS the
amount/currency/counterparty fields on `matchedTransactions`, and returns `suggestions: []`
outright when `false` - never merely a UI-side `{revealed ? ... : null}` render, since a Server
Component's props are serialized into the client bundle regardless of what actually renders,
and Chrome DevTools does not honor a component's own conditional rendering. `getDocumentPaymentSection`
(the use case) itself returns the FULL, unredacted data always - it has no notion of the
caller's permissions, matching this codebase's usual separation between "use cases decide
business rules" and "read-models decide what a page/component is allowed to receive".

### 5. "kein Beleg nötig" is a transaction-level flag; the standing rule is a separate table

`transactions.no_document_needed` (owned by `src/modules/accounts`, the `transactions` table's
existing owner) is the actual exclusion switch every candidate-preselection query
(`TransactionRepository.listForMatching`/`listUnmatched`) filters on. `payment_no_document_rules`
(owned by `src/modules/payments`) is the separate, persisted "für diese Gegenpartei immer"
standing rule - `runMatching` applies every rule to whatever is currently unmatched at the START
of each run (`applyNoDocumentRules`), so a rule learned after some of that counterparty's
transactions already arrived still catches up on them, not only future imports. The flag lives
on `transactions` (not a new join table) because it is a property of the transaction itself,
independent of any particular document pairing - unlike a rejection, which is inherently about
one specific (document, transaction) pair.

### 6. The AI stage caches by `(transaction, candidate set)`, and self-reschedules instead of a dedicated cron route

Before ever calling `PaymentArbiter.rank`, `runMatching` computes F3a's own
`arbiterCacheKey(tx, candidateIds)` and checks `DocumentTransactionRepository.findAiSuggestionForTransaction`
for an existing `kind: "ai"` row with the SAME key - if found, the cached suggestion is reused
and the model is never called again for an unchanged pairing. The F3b brief asked for a trigger
"plus the existing cron sweep" without specifying a mechanism; rather than add a second cron
route (`GET /api/cron/process-jobs` already dispatches any due job kind, `match-payments`
included), `runMatching` itself enqueues ONE follow-up `match-payments` job a few hours out
(`trigger: "cron"`) whenever the workspace still has an unresolved `suggested` row or an
unmatched, non-excluded transaction at the end of its own run - the existing sweep picks it up
exactly like any other due job. Once nothing remains unresolved, the self-rescheduling chain
simply stops; the next real document/import event restarts it. This is a judgment call: a
periodic re-evaluation is what lets a newly learned alias retroactively corroborate a
previously-unmatched transaction without a human re-triggering anything, at the cost of a
standing, indefinitely-recurring job per workspace with any open item at all - acceptable at
this product's scale (a single small business's own transaction volume).

### 7. Stage progression is strict per transaction, with one adaptation for a rejected stage-2 candidate

Per decisions/0023's decision 1: stage 1 runs first; only when it produces NOTHING for a given
transaction does stage 2 run; only when stage 2 also produces nothing (including "the only
candidate it found was already rejected by a human") does stage 3 run. The one place this phase
had to make a call the brief did not: a rejected stage-1 pairing is still "stage 1 found
something" for that transaction (the transaction itself already has a decided outcome, even
though it isn't a fresh suggestion) - `filterRejectedPairs` runs BEFORE the "did stage 1 find
anything" check, so a transaction whose only stage-1 candidate was rejected correctly falls
through to stage 2/3 rather than being treated as already resolved.

### 8. Stage 2's own signal requirement (a judgment call the F3a brief left open)

F3a's `findSubsetSums`/`partialPaymentFor` are pure arithmetic with no textual-signal concept at
all - they will happily report a subset or a partial-payment candidate purely by amount. This
phase adds its own gate before turning either into a persisted suggestion: a SOLO subset-sum
result (one document) or a partial-payment candidate must still have at least one corroborating
signal (an invoice number, an IBAN match, or an exact normalized-name match) - the same
"never an amount-only coincidence" rule decisions/0023 already established for stage 1's
`matchByRules`, re-applied here so stage 2 does not flood a human with amount-only guesses. A
genuine COLLECTIVE result (2+ documents) has no such gate - `findSubsetSums` finding exactly one
non-ambiguous multi-document solution is itself the signal (the arithmetic coincidence of
several invoices summing exactly to one transfer, within tolerance, is unlikely by chance for
more than one document).

### 9. Allocation amount per suggestion kind

`computeAllocation` (`payments-use-cases.ts`): `exact`/`ai`/`manual`/a solo stage-2 result apply
`min(paid, open)` (never claim more than what is actually owed); `skonto` and `collective` apply
the document's own FULL remaining open amount (a Skonto discount, or a collective payment's own
subset-sum share, settles that document entirely despite the transaction paying slightly
less/exactly that share) - this is what makes a confirmed `skonto`/`collective` row correctly
zero out `openAmountCents` rather than leaving a phantom few cents "still open".

### 10. Alias learning fires on every confirm (auto or human), not only a human's explicit action

Confirming a suggestion - whether stage 1's own `autoConfirm`, or a human clicking
"Bestätigen" on a weaker suggestion, or a manual link - always attempts
`learnAliasFromConfirmation` when both the transaction's counterparty name and the document's
own resolved primary contact (`resolvePrimaryContact`: the `sender`-role contact for an incoming
document, `recipient` for outgoing) are known. The F3b brief only asked for this on "confirming",
without distinguishing auto vs. human confirms; treating both identically is the more useful
default (an auto-confirmed exact match with a mismatched trading name is exactly the case an
alias should be learned from) and the alias itself is inert until an actual amount/direction/
open-document match still occurs later, so there is no over-application risk.

### 11. "Ohne Zahlung erledigt" maps to `no_document_needed`, and stays behind `documents.write`

A document a human marks "ohne Zahlung erledigt" (e.g. a paid-in-cash receipt) gets
`payment_status: "no_document_needed"` - decisions/0023's own wording for that value ("this will
never be paid through this app") fits a cash payment exactly: it already happened, just not
through a bank transaction this app will ever see. This action is the one payment-related
mutation that stays behind `documents.write` (every member) rather than `finance.manage`: it
never references a transaction, amount, or counterparty at all, only the document's own status -
the same tier recategorizing/reassigning/deleting a document already sits behind. Every other
mutation (confirm, reject, unlink, manual link, "kein Beleg nötig") sits behind `finance.manage`
because each one necessarily reveals or acts on transaction-level data.

### 12. Candidate pools are rebuilt fresh on every `runMatching` call, workspace-wide

No incremental/delta matching: each run fetches every currently-open invoice-shaped document
(`DocumentRepository.listInvoiceCandidates`) and up to 500 non-excluded transactions
(`TransactionRepository.listForMatching`), then runs the three stages over the full cross
product (bounded per-transaction to `MAX_CANDIDATES`/`MAX_ARBITER_CANDIDATES` by F3a's own
`selectCandidateDocuments`). This is a judgment call trading simplicity for a workspace-size
ceiling: acceptable at this product's target scale (a small business's own open invoices and
recent transactions, realistically dozens to low hundreds, not thousands) - a future phase would
need incremental matching (e.g. only re-evaluating transactions/documents touched since the last
run) if that ceiling is ever actually reached in practice.

### 13. The manual-link candidate list is a plain recency-bounded slice, not scored per document

`/dashboard/documents/[id]`'s "Transaktion manuell verknüpfen" dropdown offers the 100 most
unmatched transactions workspace-wide, filtered client-side by a free-text search over
counterparty/remittance/amount - it is NOT run through `selectCandidateDocuments`'s own
scoring for the specific document being viewed. A known simplification for this phase's UI, not
a functional gap: every transaction is still reachable, and "Zuordnung"'s own confirm/reject
flow (driven by the real, scored suggestions) is the primary path for anything the matching
engine can already find on its own: manual linking exists for what none of the three stages ever
proposed.

### A transaction is never allocated past its amount (added 2026-10-21)

Observed in real data: one 50,00 EUR debit to "Stadt Beispielstadt" carried 100,00 EUR of
confirmed links. The same letter had been uploaded twice, matching rightly suggested the debit
for both copies, and both suggestions were confirmed. Neither `confirmSuggestion` nor
`linkManually` checked how much of the transaction was already claimed; `confirmSuggestion` did
not check the document's open amount either.

Both now check at the moment of the decision, against `sum(allocated_amount_cents)` of the
confirmed rows (`sumConfirmedAllocatedByTransaction`, `sumConfirmedAllocatedByDocument`):

- the allocation must fit the document's open amount (`amount_exceeds_open`, as before for
  `linkManually`, new for `confirmSuggestion`);
- it must fit the part of the transaction no confirmed link claims yet
  (`amount_exceeds_transaction`, "Diese Buchung ist bereits anderen Belegen zugeordnet. Der
  verbleibende Betrag reicht dafür nicht aus.").

It is an error only. The suggestion stays `suggested` and no `payment_rejections` row is written:
the owner decides what is wrong (here: a duplicate document to delete), not the check. Two
allocations legitimately exceed the paid amount and are exempt from the transaction check: a
`skonto` match, which settles the document in full with a smaller payment, and a document in a
different currency than the transaction (decisions/0044: the cents are not comparable).

## Consequences

- Positive: every property a fake repository test cannot prove (the idempotent upsert-onto-
  `suggested`-only guard, the AI cache lookup, the real `check` constraints on
  `status`/`kind`/`matched_by`) is proved against real Postgres
  (`tests/integration/workflows/payments-matching.integration.test.ts`), following this
  repository's usual "prove it under the real constraint" discipline.
- Positive: the redaction boundary is a single, testable function
  (`getDocumentPaymentSectionProjection`'s `revealFinanceDetails` branch) rather than scattered
  UI conditionals, so a future reviewer only has one place to audit for "does a member ever see
  an amount".
- Negative: decision 12's workspace-wide, full-rebuild matching pass has no upper bound on
  workspace size baked into its own design beyond the per-transaction candidate caps - a future
  phase revisits this if a workspace's open-item count ever grows large enough to matter.
- Negative: decision 6's self-rescheduling job means an idle workspace with even one long-
  standing "kein Beleg nötig" candidate or unconfirmed suggestion runs a `match-payments` job
  every few hours indefinitely - cheap at this scale (a bounded query, no AI call when the cache
  already covers every remaining transaction), but not literally free.
- Negative: decision 13's unscored manual-link list is a UX simplification, not the fully
  ranked experience `core/candidates.ts` could offer if wired in - noted as a follow-up.
- Implementation status: **implemented** (F3b): the schema (`src/persistence/schema/payments.ts`,
  plus `documents.payment_status`/`paid_at` and `transactions.no_document_needed`), the
  repositories, `PaymentsUseCases` (`runMatching` and every decision action), the job wiring
  (`JOB_KINDS.matchPayments`, the two trigger points in `documents-use-cases.ts`/
  `accounts-use-cases.ts`, the composition root), `src/modules/payments`'s `server.ts`/
  `client.ts`/`actions.ts`/UI, the document-detail payment section, the inbox status chip/filter,
  and `/dashboard/finance`'s "Zuordnung"/"Offene Posten" tabs. Covered by unit tests (`runMatching`
  orchestration with fakes: auto-confirm, suggestion, alias corroboration, rejection filtering,
  AI-stage cache reuse, the self-reschedule condition, every decision action and its guard
  rails), one real-Postgres+MinIO integration test, and one `@smoke`-tagged e2e spec.
  **Not implemented**: F4's platform-payout decomposition (`core/settlement.ts` stays unwired),
  incremental/delta matching (decision 12), and a scored manual-link candidate list
  (decision 13).

## Supersedes / Superseded By
- None
