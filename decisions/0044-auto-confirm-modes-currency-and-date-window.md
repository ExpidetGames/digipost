# Auto-confirm modes, currency-aware matching, and a date window for rules matches

Document type: decision
Lifecycle: active
Owner: src/modules/payments
Scope: `workspaces.payment_auto_confirm` and `applyAutoConfirmPolicy`, the same-currency guard in
the rules and arithmetic stages and the AI evidence gate, the date window for rules matches
without an invoice number, and the amount-before-date ranking of competing suggestions
Canonical responsibility: Active source for which payment suggestions are booked without a human,
and how amounts in different currencies are treated
Maintenance triggers:
- A fourth auto-confirm mode is requested
- Exchange rates become available (the 25 % tolerance could then tighten)
- Matching gains a signal stronger than amount and date for recurring charges
Last verified: 2026-09-22, initial version

## Status

Accepted

## Context

Reviewing 64 bulk-uploaded receipts against the owner's bank statements showed 36 correct
suggestions waiting for a click and three defects: a 38,40 EUR IONOS debit kept on a 4,20 EUR
invoice because the date-closest cleanup (decisions/0043) ignored the amount; 11 Automattic
invoices in USD compared cent for cent with EUR debits, producing chance pairings months apart and
a "collective" payment made of an Automattic and a Meta receipt; and rules matches without any
date limit.

The owner then defined how much should be booked automatically, as a workspace setting with three
modes.

## Decision

**Auto-confirm modes** (`payment_auto_confirm`, admin-only via `finance.manage`, on "Zuordnung"):
`all` books every unambiguous suggestion including AI ones; `system` (default) books unambiguous
suggestions of the deterministic stages only; `none` books nothing. In every mode a suggestion is
only booked when it is the only open suggestion of its transaction and of its document, and the
transaction is not already confirmed elsewhere; collective suggestions are never booked
automatically. The policy runs at the end of every matching run, after the date-closest cleanup, so
it also applies to suggestions already open when an admin switches the mode (switching schedules a
run). The invoice-number auto-confirm of decisions/0023 is suppressed in mode `none`.

**Currency.** The rules and arithmetic stages only compare amounts of the same currency. A
foreign-currency document is left to the AI stage, where a name or IBAN counts as evidence only
with an amount within 25 % of the open amount (room for the exchange rate); a confirmed
foreign-currency link settles the document in full.

**Plausibility of AI evidence.** Name or IBAN alone never suffices any more: in the same currency
the payment may be less than the open amount (a partial payment), never more.

**Date window.** A rules match without the invoice number in the remittance text requires the
debit within 45 days of the document date.

**Ranking.** Competing suggestions are ranked by exact amount first, then by date.

## Consequences

- Positive: in mode `system` the unambiguous vendor-and-amount matches of receipts are booked
  without clicks; mode `none` keeps full manual control.
- Positive: foreign-currency invoices no longer produce chance matches.
- Negative: mode `all` books AI suggestions, which the benchmark showed are occasionally wrong
  (decisions/0039); the admin chooses that risk explicitly.
- Negative: a foreign-currency document is only ever suggested by the AI stage, never by the rules.
- Neutral: the setting is a column on `workspaces`, cascading with the workspace like every other
  column; no new table.
