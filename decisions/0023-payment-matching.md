# Payment matching: three-stage engine deciding whether an invoice is paid

Document type: decision
Lifecycle: active
Owner: src/modules/payments
Scope: The pure payment-matching domain layer answering "Ist diese Rechnung bezahlt?": the
three fixed stages (deterministic rules, arithmetic, an AI arbiter), the auto-confirm
predicate, direction discipline between bank transactions and documents, candidate
preselection, learned knowledge (aliases, rejected pairs, payment channels), safety checks
(duplicate payment, an already-paid reminder), and the settlement-decomposition arithmetic F4
needs for platform payouts
Canonical responsibility: Active source for why the three stages run in a fixed order and
never skip ahead, the exact auto-confirm condition, why the AI arbiter is a ranker over a
bounded candidate list rather than a searcher, why `MatchableTransaction`/`MatchableDocument`
are this module's own shape rather than a re-export of `@/modules/intake`'s or a persistence
row type, and the judgment calls made where the F3a brief left a mechanism unspecified
(subset-sum bounding, candidate scoring, `PaymentStatus`'s overdue-vs-partially-paid
precedence)
Maintenance triggers:
- The stage order, the auto-confirm condition, or the skonto tolerance default changes
- A new match reason code or match kind is added
- F3b (persistence, UI, wiring) lands and this ADR's "not yet implemented" list needs updating
- F4 (platform payout decomposition) becomes its own phase and takes over `core/settlement.ts`
Last verified: 2026-09-20, F3a (payment matching engine, pure core)

## Status
Accepted

## Context

Digipost already extracts invoice-shaped fields from incoming/outgoing documents
(decisions/0021-extraction-direction-and-invoice-fields.md) and will soon ingest bank
transactions (CAMT.053 statements, bank CSV exports) through the same universal intake
pipeline (decisions/0020-universal-intake.md). The product question this phase answers is
narrow and deliberately not bookkeeping: **"Is this invoice paid?"** - not a general ledger,
not DATEV export, not double-entry accounting. Answering it well requires matching a bank
transaction to the document(s) it settles, handling three realistic cases in increasing order
of ambiguity: a single invoice paid in full (possibly with a Skonto/early-payment discount), a
single invoice paid in installments (partial payments), and several invoices paid by one
transfer (a collective payment) - plus, going the other way, a platform payout (Stripe, Apple,
...) that is not a payment for one invoice at all but a lump sum covering many individual
sales, which needs its own decomposition rather than a direct match attempt.

This phase (F3a) builds the entire matching engine as pure, dependency-free domain code
(`src/modules/payments`) plus the AI arbiter's Mistral adapter (`src/platform/mistral`) - no
schema, no persistence, no route, no UI. It runs concurrently with F1b (persistence, upload
wiring for the universal intake pipeline) on unrelated files, following this repository's
usual phase-by-phase, file-scope-isolated approach (compare decisions/0019's C1 shipping the
contacts domain before C2's pipeline integration used it, or decisions/0020's F1a shipping the
intake domain before F1b's persistence wiring). F3b (a later phase) is expected to persist
`MatchableTransaction`/`MatchableDocument` rows, call into this module's pure functions, wire
the real vs. fake `PaymentArbiter`, and build the confirmation UI.

## Decision

### 1. Three fixed stages, strictly in order, never skipped

`matchByRules` (rules) -> `findSubsetSums`/`partialPaymentFor` (arithmetic) ->
`PaymentArbiter.rank` via `validateArbiterResult` (AI), exactly the order the F3a brief fixes.
A caller (F3b) is expected to run stage 1 first; only when it finds nothing does stage 2 run;
only when stage 2 finds nothing (or reports ambiguity) does stage 3 run at all. This module
does not itself orchestrate that sequencing (there is no single `matchPayment()` entrypoint) -
F3b's persistence/job-queue layer is where "try stage 1, then 2, then 3" actually happens,
following the same "use case orchestrates, pure functions decide" split this repository
already uses everywhere else (e.g. `documents-use-cases.ts`'s `processDocument` orchestrating
OCR -> categorize -> route, decisions/0016). This phase ships the three stages as separate,
independently testable functions specifically so that orchestration choice is F3b's to make
with full context (retries, caching, transactions) that pure code should not need to know
about.

### 2. `MatchableTransaction`/`MatchableDocument`: this module's own shape

Deliberately not a re-export of `@/modules/intake`'s `NormalizedTransaction` (camt.053) or a
persistence row type: F1b is mid-flight on the intake schema and persistence layer while this
phase builds concurrently, and coupling this module's own types to either would make F3a's
build depend on F1b's in-flight, unstable shape. F3b maps its own bank-transaction/document
rows into these two types at the call site (`src/modules/payments/README.md`'s "Public
contract for F3b" spells out the exact mapping). One consequence worth flagging explicitly:
`MatchableDocument.direction` is `"incoming" | "outgoing"` only, narrower than
`documents.direction`'s three-value column (`incoming | outgoing | unknown`,
decisions/0021) - a document whose direction is not yet known has nothing for the "never
cross" direction discipline to check against, so F3b must filter out `unknown`-direction
documents before ever constructing a `MatchableDocument`, never pass `"unknown"` through as a
silent pass-through value.

### 3. Auto-confirm: exactly the brief's condition, nothing broader

`isAutoConfirmMatch` (`core/rules.ts`) returns `true` only when direction is correct AND the
invoice number was found in the remittance text AND the amount matches (exact or within the
Skonto tolerance) - the product owner's own fixed condition. This is a standalone, directly
unit-tested function specifically so `core/arbiter.ts`'s validation can prove an AI-stage
suggestion structurally can never satisfy it (`autoConfirm` is hardcoded `false` there, not
merely defaulted). No suggestion from the arithmetic stage (`partial`/`collective` kind) can
ever auto-confirm either - `matchByRules` is the only stage that ever sets `autoConfirm: true`.

### 4. Skonto tolerance: percentage of the OPEN amount, 3% default

`isWithinSkontoTolerance` compares the paid amount against the document's currently open
amount (not its original total) - a judgment call: once part of an invoice has already been
paid at a different rate, comparing a later partial payment's discount against the still-open
remainder is what keeps "tolerance" meaningful for that remainder specifically. Default 3%
(the F3a brief's own number), configurable per call via `MatchRuleOptions.skontoTolerancePercent`;
per-contact configuration is left to F3b, which owns wherever a contact's own preferences would
be persisted.

### 5. The AI arbiter is a ranker, never a searcher - enforced, not just documented

`core/arbiter.ts`'s `validateArbiterResult` re-checks every guarantee a `PaymentArbiter`
adapter's raw answer needs to satisfy before it becomes a `MatchSuggestion`: a `bestDocumentId`
not present in the given `candidates` is rejected (hallucination guard, the same "AI proposes,
code verifies" contract decisions/0020 and decisions/0021 already established for their own
model calls); the picked candidate's direction is re-checked against the transaction even
though the candidate list was already direction-filtered upstream (an arbiter implementation
is verified on what it actually returned, never trusted to have received an already-correct
list); and a candidate list larger than `MAX_ARBITER_CANDIDATES` (20) makes both
`validateArbiterResult` and the real Mistral adapter throw rather than silently truncate - a
caller that forgets to bound its own preselection fails loudly instead of quietly paying for
(and trusting) what would functionally become a search over an unbounded list. `arbiterCacheKey`
gives F3b a stable, order-independent cache key over (transaction, candidate set) so repeated
calls for the same pairing can be avoided, per the brief's own instruction.

### 6. Candidate preselection never hard-excludes by amount

`core/candidates.ts`'s `selectCandidateDocuments`/`selectCandidateTransactions` (the mirrored
direction the brief asks for: transaction -> documents, and document -> transactions for an
overdue/unmatched document) use amount closeness only to SCORE/sort candidates, never to
exclude one - a partial payment is by definition less than a document's open amount, and a
collective payment's constituent invoices are each individually smaller than the transfer that
eventually pays all of them together, so a strict amount filter would systematically remove
exactly the candidates the arithmetic stage needs to see. Direction and a date window (around
the transaction's booking date, or the document's own due/document date for the mirrored
direction) are the only hard filters; a same-counterparty match (shared IBAN or a similar
name) always sorts first when `sameContactFirst` is enabled (the default).

### 7. `findSubsetSums`: bounded, deterministic, ambiguity-reporting

A full `2^n` subset enumeration bounded at `maxItems` (default 15, matching the brief's own
performance requirement) - deliberately not a smarter DP, since at n=15 (32768 subsets) a full
enumeration already runs in low single-digit milliseconds and every subset is inspected once,
never pruned in a way that could hide a legitimate ambiguous case. When more open documents
than `maxItems` are given, only the `maxItems` smallest-`openAmountCents` documents are
considered (a judgment call: the smallest amounts are the ones most likely to compose into a
target sum without overshooting it), chosen deterministically (ties broken by id).
`SubsetSumResult.ambiguous` is `true` whenever more than one solution exists, independent of
how many are actually returned (`maxSolutions` caps only the returned list, never the
ambiguity flag) - a caller must treat an ambiguous result as "cannot auto-confirm this
collective payment", never silently pick the first solution.

### 8. `PaymentStatus`: derived, never a freely-settable stored field

`derivePaymentStatus` (`core/payment-status.ts`) computes `open | partially_paid | paid |
overdue | settled | no_document_needed` from a document's own open/total amount and due date,
plus an optional `manualStatus` override for the two states this function never derives on its
own (`settled`, for a document resolved through `core/settlement.ts`'s platform-payout
decomposition rather than a direct transaction match; `no_document_needed`, a human's explicit
"this will never be paid through this app" marker). Judgment call: when a document is BOTH
partially paid and past its due date, `overdue` wins over `partially_paid` - an unpaid
remainder past its due date is more urgent information than "some money already arrived", and
nothing is lost by not having a fourth combined state since `openAmountCents`/`totalAmountCents`
remain visible regardless of which status word is shown.

### 9. Learning is deterministic, and lives as pure functions over caller-provided state

`core/learning.ts`'s `applyAliases`/`learnAliasFromConfirmation` (counterparty-name -> contact
id, keyed by `@/modules/contacts`'s `normalizeName` - reused, not duplicated),
`filterRejectedPairs`/`rejectedPairKey` (a rejected (document, transaction) pairing is never
re-suggested), and `matchesLearnedChannel` (a contact's confirmed payment IBAN) are all pure
transforms over a `Map`/`Set` the caller owns - this phase persists nothing itself; F3b decides
where these maps actually live.

### 10. F4's settlement arithmetic, built here because it is arithmetic

`core/settlement.ts`'s `decomposeSettlement` (asserts, by computing rather than throwing, that
`gross - fees - refunds` from the settlement lines equals the actual payout amount, reporting
any discrepancy in cents) and `matchSettlementLinesToDocuments` (invoice number in a dedicated
field or embedded in a free-text description first, falling back to customer name + amount +
date proximity) are F4's own pure arithmetic, built in this phase specifically because they
have no I/O of their own and the brief asked for them here rather than deferring an entire
future phase for two functions. `SettlementLine` is this module's own shape (not a re-import of
`@/modules/intake`'s `NormalizedSettlementLine`) for the same reason `MatchableTransaction`/
`MatchableDocument` are: this file only needs a handful of that type's fields, and importing
the full intake type would couple this module to intake's exact field set unnecessarily.
Product decision carried over unchanged: a platform payout is never matched against an invoice
directly by stages 1-3 (`MatchableTransaction.isPlatformPayout` documents this exclusion, and
`selectCandidateTransactions` filters it out); only this settlement arithmetic ever touches
one.

## Consequences

- Positive: every stage is independently unit-tested with no database and no network
  (`src/modules/payments/tests/`), including a direct performance assertion for the 15-item
  subset-sum bound and a full boundary table for the 3%/2.9%/3.1% Skonto tolerance example the
  brief specified.
- Positive: the "AI proposes, code verifies" contract is enforced by
  `validateArbiterResult`/`isAutoConfirmMatch` as actual code paths a test exercises (a
  hallucinated id, a cross-direction pick, and a maximum-confidence AI answer are all proven to
  fail closed), not merely a documented intention - the same discipline decisions/0020/0021
  already established for their own model calls.
- Negative: `selectCandidateDocuments`/`selectCandidateTransactions`'s scoring formula
  (amount-difference-ratio weighted against day-distance) and `findSubsetSums`'s
  "smallest-amounts-first" truncation when there are more open documents than `maxItems` are
  both judgment calls the F3a brief did not specify precisely - reasonable defaults, tested for
  the properties that matter (never hard-excluding a legitimate partial/collective candidate by
  amount, deterministic ordering), but a future phase may need to tune the exact weights once
  real data shows how well they rank in practice.
- Negative: `PaymentStatus.overdue` winning over `partially_paid` when both apply is a
  one-bit-of-information loss by design (see decision 8) - accepted, since the underlying
  amounts remain visible.
- Negative: this phase never calls `learnAliasFromConfirmation`/`filterRejectedPairs`/etc. from
  anywhere - they exist as a stable contract for F3b, unverified against a real persisted
  alias/rejection store until that phase lands.
- Implementation status: **implemented** (F3a): `src/modules/payments`'s entire `core/` layer
  (types, direction discipline, `PaymentStatus` derivation, text signals, the three matching
  stages, learning helpers, safety checks, settlement arithmetic) and its neutral `index.ts`;
  `src/platform/mistral`'s real `PaymentArbiter` adapter (`server/mistral-payment-arbiter.ts`),
  its German prompt (`server/payment-arbiter-prompts.ts`), and its composition-root getter
  (`server/get-payment-arbiter.ts`, re-exported from `server.ts`). **Not implemented yet,
  explicitly out of scope for F3a**: any schema/persistence for a bank transaction or a
  matching decision, the confirmation UI, wiring the three stages together into one
  orchestrating use case, and calling any of the learning helpers from real, persisted state
  (all F3b).

## Supersedes / Superseded By
- None
