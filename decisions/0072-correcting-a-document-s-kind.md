# Correcting a document's kind ("Dokumentart ändern")

Document type: decision
Lifecycle: active
Owner: src/modules/documents
Scope: The member-level action that re-extracts a processed PDF as a kind a human chose, the
`kindOverride` field of the `process-document` job payload, which kinds may be chosen, the guards
that refuse a correction, and how open payment suggestions of the corrected document are cleared
Canonical responsibility: Active source for why a human can override the classifier's kind, why
that override replaces the classifier and the own-IBAN flip but nothing else in the pipeline, and
why a correction is refused under booked money
Maintenance triggers:
- `RECLASSIFIABLE_KINDS` (`src/modules/documents/core/reclassification.ts`) changes
- `processOcrDocument` gains another kind heuristic the override must also win over
- A new payment status that records booked money appears (it needs its own guard here)
- A path appears that should clear `documents.manual_kind` again (today nothing does)
Last verified: 2026-10-21, against sample data (two Meta ad invoices, one classified
`other`, one `platform_settlement`) and the unit tests named under "Verification"

## Status

Accepted

## Context

The classifier labeled a Meta ad invoice (2,00 EUR) `other`, and a second Meta ad invoice
(100,00 EUR) `platform_settlement`. Nothing in the app could fix either. "Erneut verarbeiten" only
exists for a `failed` document and asks the classifier again, and the inbox kind filter only
reads the kind.

The kind drives everything downstream: the guided extraction question
(decisions/0036-guided-extraction.md), direction, which invoice fields count, the payment status,
whether payment matching considers the document at all (decisions/0025), and whether a supplier
clearing account books it (decisions/0068-supplier-clearing-accounts.md only books an
`incoming_invoice`). A wrong kind therefore silently removes an invoice from every finance view,
and `ui/document-detail-client.tsx`'s unclear-direction hint already told the user to "check
whether the document kind is right" without giving them anything to do about it.

## Decision

1. **A new use case, `reclassifyDocument({ workspaceId, documentId, kind })`**
   (`src/persistence/use-cases/documents-use-cases.ts`). It marks the document `processing` and
   enqueues `process-document` with `kindOverride: kind` in one transaction, exactly the shape
   `retryProcessing` already has. The document is re-extracted from its stored original; no new
   column and no migration.

2. **The override replaces the kind decision and nothing else.** In `processOcrDocument`, a set
   `kindOverride` is used instead of the `IntakeClassifier` call (and instead of the ZUGFeRD
   seller-name guess), and `correctInvoiceKind`'s own-IBAN flip (decisions/0039, decisions/0043)
   is skipped: that heuristic exists to catch the classifier's mistakes, and the human just
   corrected exactly that. Everything after the kind runs unchanged: `planCounterparty`, the
   guided analyzer for that kind, direction, invoice fields, `payment_status`, the debounced
   matching run, and `replaceDocumentLinks`, which was already designed to replace a previous
   run's links. The self-counterparty guard (decisions/0036) still applies: if the human picks
   a derived kind whose counterparty turns out to be the workspace itself, direction stays
   `unknown` rather than inverting a real business relationship.

3. **Who and what.** `reclassifyDocumentAction` is gated behind `documents.write`, like
   confirming an intake proposal: correcting one document is ordinary document work every
   member does (AGENTS.md's "Intake confirmation is member-level"). The workspace comes from
   `requirePermission`, never from the input. Only a `done` PDF qualifies
   (`reclassify_not_allowed` otherwise): camt.053, MT940 and CSV/TSV uploads get their kind from
   their own deterministic or confirmed intake flows (decisions/0020, decisions/0022).

4. **Selectable kinds: every kind except `bank_statement`, `payout_report`,
   `platform_settlement`** (`RECLASSIFIABLE_KINDS`, `kind_not_selectable` otherwise). The PDF
   pipeline does handle those three today, but only as labels: a PDF classified
   `platform_settlement` gets a derived counterparty and `payment_status` `not_applicable`, and
   nothing else. It is never imported into a clearing account, never decomposed into settlement
   lines (the detail page's settlement section requires `intakeStatus: "confirmed"`, which a PDF
   never has), and a scanned bank statement is never imported either. Offering them would
   promise an import that does not happen. A document that currently carries one of them can
   still be corrected AWAY from it, which is exactly the second Meta invoice's case. Choosing
   the kind a document already has is refused (`kind_unchanged`) rather than silently treated
   as a re-run: re-running a processed document is not a feature this product offers.

5. **Refused under booked money.**
   - A CONFIRMED `document_transactions` row (`payment_linked`): re-extraction resets
     `payment_status` and `paid_at` (`markDone`), which would leave an allocation pointing at a
     document whose status no longer reflects it. The user removes the link first
     ("Verknüpfung aufheben", finance admins) and then corrects the kind. Checked inside the
     same transaction as the status change, reading the payments table read-only.
   - `payment_status` `settled` (`payment_settled`): a clearing account wrote it (a platform
     fee invoice, decisions/0026, or a supplier clearing account, decisions/0068, which also
     books a clearing-account transaction keyed by this document). There is no link to remove,
     so the correction is refused outright.
   - `no_document_needed` ("ohne Zahlung erledigt") is NOT refused: no money is booked behind
     it, and the second Meta invoice carries exactly this status from its wrong kind. The
     correction resets it like any processing run does; after the correction to
     `incoming_invoice`, the next matching run's clearing-account booking settles it (the sample
     data has a clearing account for Meta).

6. **Open suggestions are cleared through the payments owner, twice.** `document_transactions`
   belongs to `src/modules/payments`, so the documents use case never writes it. A new
   `PaymentsUseCases.discardOpenSuggestionsForDocument` deletes the document's `suggested` rows
   (confirmed rows and `payment_rejections` stay: a human's "this payment is not this document"
   stays true whatever the kind). It is called by `reclassifyDocumentAction` right after the
   reclassification commits, so a stale suggestion cannot be auto-confirmed while the document
   is being re-extracted, and again by the `process-document` job handler
   (`src/persistence/composition/job-handlers.ts`) once a run with `kindOverride` finished, which
   removes anything a concurrent matching run created against the old fields in between.
   Matching alone would not have been enough: decisions/0045 only recomputes deterministic
   suggestions on every run, AI suggestions are kept, and a document that stops being
   invoice-shaped does not even schedule a matching run.

## Consequences

- **The human's choice is persisted** in `documents.manual_kind` (migration 0022), written by
  `markProcessingWithManualKind` in the same transaction that enqueues the job.
  `processDocument` uses `kindOverride ?? manualKind`, so every later run of the document (a
  retry after a failure, "Erneut verarbeiten") keeps the correction. Observed before this was
  added: a user clicked "Erneut verarbeiten" while the corrected run was still retrying, and
  that second job, without an override, would have let the classifier set "other" again had it
  finished last.
- A narrow race remains: a matching run that happens to auto-confirm a NEW pairing for this
  document between the reclassification and the end of its re-extraction would see its
  `payment_status` reset by `markDone`. The window is one OCR and analysis run, and the next
  `recomputeDocumentStatus` for that document (any unlink or confirmation) restores the status.
- The first Meta invoice (`other`, `open`) becomes an `incoming_invoice`; with Meta linked as
  its sender, the next matching run books it onto Meta's clearing account and marks it
  `settled`, as decisions/0068 intends.
- A correction costs one OCR call and one analyzer call, like an upload; no classifier call.

## Verification

- `src/persistence/tests/documents-use-cases.test.ts`: every guard of `reclassifyDocument`, the
  enqueued payload, a correction away from `platform_settlement` under `no_document_needed`, and
  `processDocument` with `kindOverride` (no classifier call, the guided analyzer asked for the
  forced kind, the own-IBAN flip skipped where the classified kind IS flipped, a non-invoice
  kind resetting `payment_status` and scheduling no matching).
- `src/persistence/tests/payments-discard-open-suggestions.test.ts`: only the document's own
  `suggested` rows go.
- `src/modules/documents/tests/actions.test.ts`, `schemas.test.ts`,
  `document-detail-client.test.tsx`: permission, scope, error mapping, the selectable kinds,
  and the control's visibility and copy.

## Alternatives considered

- **Write the corrected kind directly, without re-extraction.** Rejected: the kind decides
  which question the analyzer was asked (decisions/0036), so the counterparty, direction and
  invoice fields of the old run answer the wrong question. Changing only the label would leave
  an "incoming invoice" with no amount, no direction and no supplier.
- **Clear suggestions only in the job handler, or rely on the next matching run.** Rejected for
  the reasons in point 6: the first leaves stale suggestions auto-confirmable during
  re-extraction, the second never clears AI suggestions or a no-longer-invoice document's.
- **Offer every kind.** Rejected for the three account-feeding kinds, see point 4.
