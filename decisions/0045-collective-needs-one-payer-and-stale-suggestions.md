# A collective payment needs one payer, and deterministic suggestions are recomputed each run

Document type: decision
Lifecycle: active
Owner: src/modules/payments
Scope: the collective (subset-sum) suggestion in stage 2 and the lifetime of open suggestions of
the deterministic stages in `payments-use-cases.ts`
Canonical responsibility: Active source for when several documents may be suggested for one
payment, and why open rules and arithmetic suggestions do not outlive a run
Maintenance triggers:
- A payer is found who legitimately settles several different vendors' invoices in one payment
- AI suggestions lose their cache
Last verified: 2026-09-22, initial version

## Status

Accepted

## Context

After decisions/0044 two kinds of wrong suggestions remained on the owner's receipts: a 18,00 EUR
Facebook debit suggested as an IONOS invoice plus four Meta receipts (subset sums across unrelated
vendors), and a ChatGPT debit still attached to a USD invoice, a suggestion created before the
currency guard existed. Open suggestions were only ever added, never re-evaluated.

## Decision

- A collective suggestion requires every one of its documents to share the transaction's
  counterparty (the same corroborating signal the solo stage-2 suggestion already needs: name,
  IBAN or invoice number).
- At the start of every matching run all open suggestions of the deterministic stages are
  deleted; the run recomputes what the current rules still support. Open AI suggestions stay,
  because their answer is cached per transaction and candidate set (decisions/0025). Rejected and
  confirmed rows are never touched.

## Consequences

- Positive: a changed rule retires the suggestions it no longer supports on the next run.
- Negative: a user looking at "Zuordnung" during a run can briefly see fewer suggestions.
- Negative: a collective payment covering several vendors is never suggested; it stays manual.
