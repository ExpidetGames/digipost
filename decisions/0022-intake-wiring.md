# Intake wiring: schema, upload route, pipeline branching, and the confirmation UI

Document type: decision
Lifecycle: active
Owner: src/modules/documents, src/modules/intake, src/platform/mistral
Scope: Wiring decisions/0020-universal-intake.md's pure recognizer into an actual product
feature: the `documents`/`intake_source_fingerprints` schema, the upload route's acceptance of
XML/CSV/TSV, the processing job's branching between OCR and the three non-OCR intake paths,
the confirmation UI and its Server Actions, the admin-only fingerprint settings page, the
inbox's kind filter and status chip, and the exact shape of `documents.intake_result` F2/F4
will consume
Canonical responsibility: Active source for the `documents.kind`/`file_hash`/`intake_status`/
`intake_result` columns and the `intake_source_fingerprints` table, the branching decision
between OCR/camt.053/tabular-known/tabular-unknown, the exact-duplicate (`fileHash`) and
semantic-duplicate (`semanticInvoiceKey`) checks and where each runs, the ZUGFeRD
field-priority scope cut, and the confirmation flow's re-validation contract
Maintenance triggers:
- The `documents.intake_result` payload shape changes, or F2/F4 need a different one
- The upload route accepts a new file type, or the branching decision table changes
- The ZUGFeRD extraction scope (currently invoice fields + kind only, not full party override)
  is extended
- The confirmation UI's amount-sign-is-not-editable scope cut is revisited
Last verified: 2026-09-20, F1b (universal intake wiring)

## Status
Accepted

## Context

decisions/0020-universal-intake.md (F1a) built the pure recognizer - file-kind sniffing,
camt.053 detection/parsing, embedded-ZUGFeRD-XML extraction, tabular sampling, the
`IntakeClassifier` port and its real/fake adapters, mapping validation, and duplicate-detection
helpers - but explicitly shipped no persistence, no upload-route wiring, and no UI. This phase
(F1b) is that wiring: a real migration, the upload route accepting the new file types, the
processing job actually branching between OCR and the three non-OCR paths, a confirmation UI a
human can act on, and the admin settings page for a workspace's confirmed source layouts.

decisions/0021-extraction-direction-and-invoice-fields.md (C2) landed in parallel and already
extended the OCR pipeline's single analyzer call with party/invoice extraction and code-decided
direction; this phase does not touch that logic, only adds `documents.kind` alongside it and,
where a ZUGFeRD attachment is found, lets its fields take priority over the model's for the
existing invoice columns.

## Decision

### 1. Schema

`documents` gains four columns (`src/persistence/schema/documents.ts`): `file_hash` (text,
nullable - `null` for a document created before this migration), `kind` (text, one of
`@/modules/intake`'s `DOCUMENT_KINDS`, `not null default 'letter'`), `intake_status` (text, one
of the new `DOCUMENT_INTAKE_STATUSES` - `pending_confirmation | confirmed | rejected |
not_applicable`, `not null default 'not_applicable'`), `intake_result` (jsonb, nullable). Three
new indexes: `(workspace_id, file_hash)`, `(workspace_id, kind)`, `(workspace_id,
intake_status)`.

`intake_status` is deliberately a SEPARATE dimension from `documents.status`
(`uploaded|processing|done|failed`, decisions/0015-documents-and-quotas.md): once the
processing job finishes with a tabular proposal, the document is `status: "done"` (processing
itself succeeded) with `intake_status: "pending_confirmation"` (the IMPORT still needs a human
decision). Every OCR'd document (a scanned letter, invoice, ...) stays at `intake_status:
"not_applicable"` forever - the fraud-conscious confirm-before-import gate
(decisions/0020's "Context") only ever applies to a tabular financial import, never to which
"kind" a letter is classified as.

`intake_source_fingerprints` (new table, `src/persistence/schema/intake-fingerprints.ts`,
mirroring `category_routes.ts`'s "own file to avoid an import cycle" pattern):
`(id, workspace_id, fingerprint, document_kind, platform, column_mapping jsonb, amount_sign
jsonb, confirmed_by_user_id, confirmed_at, last_used_at, use_count)`, unique on
`(workspace_id, fingerprint)`. `fingerprint` is `TabularSample.fingerprint` verbatim (a sha256
over the normalized header/delimiter/column-count, F1a) - never re-derived or stored
differently here.

### 2. Upload route: sniff by content, structured files stored as-is, duplicate check first

`processIntakeUpload` (`src/modules/documents/core/intake-upload-processing.ts`) is the new
entry point `POST /api/documents`'s `parse` step calls: for a single-part upload, it first
tries `@/modules/intake`'s `sniffFileKind`; an "xml"/"csv"/"tsv" result takes the structured
path (below), anything else (a single PDF, or 1..20 images) falls through to the existing
`processUploadParts` unchanged.

- **XML**: must declare the camt.053 namespace (`detectCamt053`) - the ONLY defined path for a
  standalone XML upload today. A namespace-declaring-but-malicious document (DOCTYPE/entity)
  throws `UnsafeXmlError`, mapped to the new stable code `unsafe_xml` (400); a well-formed but
  unrecognized XML is `unrecognized_xml_format` (400). **Judgment call**: decisions/0020 gives
  no AI-assisted path for arbitrary XML content (only OCR text or a tabular sample), so this
  phase does not invent one - a future phase could add a generic "XML flattened to a tabular
  sample" path if a real need for non-camt.053 XML shows up.
- **CSV/TSV**: only checked for being READABLE and non-empty at upload time (`sampleTabular`
  succeeds, `header.length > 0`, `rowCount > 0` - `empty_tabular_file`/`unreadable_tabular_file`
  on failure); classification/mapping happens entirely in the processing job, never at upload
  time.
- Stored as-is at `original.<ext>` (`documentOriginalKey` gained an optional `extension`
  parameter, default `"pdf"` for every existing caller), `mimeType` one of `application/xml`,
  `text/csv`, `text/tab-separated-values` - never assembled/converted, unlike an image upload.

**Exact-duplicate check runs first, in `createFromUpload`**, before the quota pre-check and
before any storage write: `DocumentRepository.findByFileHash(workspaceId, fileHash)`, `fileHash`
computed by the route over the EXACT bytes about to be stored (the assembled PDF for an
image/PDF upload, the structured file as-is otherwise - decisions/0020's `fileHash`, F1a). A
match throws `DuplicateDocumentError` (a `UseCaseError` subclass carrying the existing
document's id), mapped to `409 { errorCode: "duplicate_document", existingDocumentId }` - the
client links straight to it ("Dieses Dokument ist bereits vorhanden"). The authoritative
in-transaction quota re-check does NOT re-run this check (a documented, accepted race window,
see the use case's own comment) - `file_hash` has no unique constraint, only an index, since a
pre-migration row's `file_hash` is `null`.

### 3. Pipeline branching (`processDocument`)

`decideIntakeBranch` (`src/modules/documents/core/intake-branch.ts`, pure) is the branching
decision table: `mimeType === "application/pdf"` -> `"ocr"`; else a recognized camt.053 XML ->
`"camt053"`; else a CSV/TSV with a confirmed fingerprint -> `"tabular_known_source"`; else ->
`"tabular_unknown_source"`. `processDocument` dispatches on the document's own stored
`mimeType` first (an OCR document was always a `"application/pdf"` object even before this
phase), then calls this function for the tabular known/unknown decision specifically (camt.053
detection at that point is a re-confirmation of what the upload route already validated, not a
new branch point).

- **`"ocr"`**: unchanged OCR/categorization/direction/linking pipeline
  (decisions/0016/0021), extended with `documents.kind`: an embedded ZUGFeRD/Factur-X/
  XRechnung invoice XML is read FIRST (`extractEmbeddedXml`, F1a); when
  `extractZugferdInvoiceFields` (new, `src/modules/documents/core/zugferd-extraction.ts` - a
  narrow CII/UN-CEFACT reader for the handful of fields this application's own `InvoiceFields`
  needs, not a general-purpose CII parser) finds anything, the document is self-identified as
  `incoming_invoice`/`outgoing_invoice` (from the code-decided direction, no classifier call for
  kind at all), and its invoice number/amount/currency/due date/IBAN take priority over the
  model's own extraction, field by field. Otherwise `IntakeClassifier.classify({kind: "text",
  ...})` on the OCR text sets `kind`. **Scope cut**: ZUGFeRD's seller/buyer names are extracted
  but NOT used to override `analysis.parties` (which still drives direction/contact linking) -
  a minimal CII reader has no address/VAT/IBAN-per-party data to safely replace a full
  `ExtractedContactData`, and forcing partial data in risked worse results than leaving the
  model's own party extraction alone. A future phase can build full party override once that
  is judged worth the added complexity.
- **`"camt053"`**: `parseCamt053` deterministically, always `intake_status: "confirmed"`, kind
  `"bank_statement"`, `intake_result` a `BankStatementIntakeResult` (statement/transaction
  counts, a reconciliation flag, the transactions themselves capped at `MAX_EMBEDDED_ROWS`
  (500) with a `truncated` marker beyond that - "a compact summary if too large").
- **`"tabular_known_source"`**: the confirmed fingerprint's stored `columnMapping`/`amountSign`
  applied via `validateMapping` against the FULL file (never just the fingerprint's own
  recognition, in case the source's layout silently drifted) - success -> `confirmed`,
  `TabularConfirmedIntakeResult`, fingerprint `useCount`/`lastUsedAt` bumped; **a validation
  failure here is treated exactly like `"tabular_unknown_source"`** (a fresh proposal, judgment
  call): the alternative (fail the document, or silently import bad data) was worse than asking
  a human to re-confirm once. The stale fingerprint row itself is left alone.
- **`"tabular_unknown_source"`**: `IntakeClassifier.classify({kind: "tabular", ...})` once,
  `validateMapping` against the full file regardless of whether it will pass, and the result -
  `documentKind`/`platform`/`reason`/`columnMapping`/`amountSign`/a sample preview/`rowCount`/
  the validation outcome - is stored as a `TabularProposalIntakeResult`, `intake_status:
  "pending_confirmation"`, **even when validation failed** (decisions/0020, decision 4: "checked
  ... before anything is shown to the user as ready to import" - a failing validation is still
  shown, with its problems, never silently dropped).

### 4. Confirmation flow: re-validates server-side, amount sign not editable

`DocumentUseCases.confirmIntake`/`rejectIntake` (`confirmIntakeAction`/`rejectIntakeAction`,
behind `PERMISSIONS.documentsWrite` like every other document action - confirming an ordinary
import is everyday document work, not admin-only). `confirmIntake` re-reads the original file
from storage, re-samples it, and re-runs `validateMapping` against the (possibly user-edited)
`documentKind`/`platform`/`mapping` from the request - NEVER trusts the client's claim that a
mapping is valid. A failure throws `MappingValidationError` (carries the problems back to the
UI); success persists the normalized result, sets `intake_status: "confirmed"`, and upserts the
workspace's confirmed fingerprint (`IntakeFingerprintRepository.upsertConfirmed`). Both actions
reject with `intake_not_pending` unless the document is currently `pending_confirmation`.

**Scope cut**: the confirmation UI (`IntakeConfirmationPanel`) lets a human edit the recognized
kind/platform and every column-mapping entry (a `<select>` per `SEMANTIC_FIELD`, options limited
to the file's real header, per the brief), but NOT the `amountSign` decision (signed column vs.
separate credit/debit columns vs. an indicator column) - the proposal's own `amountSign` is
reused as-is on confirm. Building a correct editor for all three `AmountSign` shapes was judged
not worth it for this phase; if the model's sign detection is wrong, the practical workaround
today is "Ablehnen" and a support-assisted re-import, not a documented dead end - a future phase
can add the editor once real usage shows this actually matters.

**Correcting an already-confirmed source** ("Zuordnung zurücksetzen",
`/dashboard/settings/intake`, "Erkannte Quellen") is admin-only (`PERMISSIONS.intakeManage`,
new bundle, same shape as `companyProfileManage`/`routingManage`) - it only removes the
confirmed fingerprint row (`resetIntakeFingerprint`), so the next matching file goes through the
proposal flow again; it does not touch any already-imported document.

### 5. Semantic-duplicate hint (invoices), computed live, not persisted

decisions/0020's `semanticInvoiceKey` (invoice number + normalized sender + amount) is wired as
a LIVE lookup, not a persisted column: `DocumentRepository.findByInvoiceNumber` (using the
existing `(workspace_id, invoice_number)` index from decisions/0021) narrows candidates, and the
new pure `findSemanticDuplicate` (`src/modules/documents/core/semantic-duplicate.ts`) computes
and compares `semanticInvoiceKey` for the current document against each candidate. **Judgment
call**: no new schema column was added for this (the brief's schema list names exactly four new
`documents` columns, none for this) - a live, indexed lookup is cheap enough at this product's
scale and avoids a second denormalized value that could drift from the source columns it is
derived from. The hint is symmetric (whichever of two matching documents is viewed shows a link
to the other, picking the first OTHER match found) rather than strictly "always points at the
earlier one" - a deliberate simplification over tracking upload order for this relationship;
either document lets a human resolve it. Never deletes or blocks anything - a dashed
destructive-colored callout with a link, that is all.

### 6. Inbox and detail UI

The inbox (`/dashboard`) gains a kind filter (`DOCUMENT_KINDS`, "Alle Arten") alongside the
existing category/status/direction filters, and a "Bestätigung nötig" status chip per row when
`intake_status === "pending_confirmation"`. The detail page shows the recognized kind as a
badge next to the title, the confirmation panel when pending, an "Importierte Daten" summary
(row/transaction count, and a reconciliation note for a camt.053 statement) once confirmed, and
a "Dieses Dokument wurde abgelehnt" note if rejected.

## Consequences

- Positive: F2/F4 (a later phase) consume `documents.intake_result` directly - a
  `BankStatementIntakeResult`/`TabularConfirmedIntakeResult`'s `transactions`/`rows` are already
  the exact normalized shapes `@/modules/intake`'s `parseCamt053`/`validateMapping` produce, no
  further transformation needed for anything under `MAX_EMBEDDED_ROWS` (500); above that, F2/F4
  are expected to re-derive the full row set from the stored original file (the same one the
  confirmation flow itself re-reads), not from this column.
- Positive: the exact-duplicate check (`fileHash`) and the tabular known/unknown branching are
  both pure-function-backed (`decideIntakeBranch`, `findSemanticDuplicate`) and unit-tested
  independent of the database.
- Negative: the ZUGFeRD scope cut (invoice fields only, no party override) means a ZUGFeRD
  invoice's contact-linking still runs entirely off the model's own party extraction, not the
  attachment's authoritative seller/buyer identity - accepted for this phase, flagged above as a
  named follow-up.
- Negative: the confirmation UI's amount-sign scope cut means a document whose sign detection
  the model got wrong has no in-UI fix path other than reject-and-reimport.
- Negative: `createFromUpload`'s duplicate check has the documented race window described in
  decision 2 (no unique constraint on `file_hash`) - the same trade-off this codebase already
  accepts for weak contact-matching races (decisions/0019-contacts.md).
- Implementation status: **implemented**. Schema, the upload route, `processDocument`'s full
  branching, `confirmIntake`/`rejectIntake`, `/dashboard/settings/intake`, the inbox/detail UI,
  and the semantic-duplicate hint all land in this phase, covered by unit tests (branching
  table, ZUGFeRD extraction, semantic-duplicate matching, intake-result capping/parsing, route
  validation, action permissions), `.integration.test.ts` coverage against real Postgres/MinIO
  (camt.053, Musterbank-CSV proposal/confirm/fingerprint-reuse, exact-duplicate, malicious XML), and
  one e2e spec (`tests/e2e/intake.spec.ts`, tagged `@smoke`).

## Supersedes / Superseded By
- None
