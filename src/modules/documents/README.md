# src/modules/documents

Document type: reference
Lifecycle: active
Owner: src/modules/documents
Scope: Upload, storage, the inbox list (search/filter/pagination), the detail view (PDF
embed, metadata, delete), and the pure upload-processing logic
(magic-byte sniffing, PDF validation, image-to-PDF assembly) behind
`/dashboard`, `/dashboard/scan`, and `/dashboard/documents/[id]`
Canonical responsibility: Everything those pages/routes delegate to except their own page
shells, and the data model this owner writes to (`documents`,
decisions/0015-documents-and-quotas.md)
Maintenance triggers:
- The upload path's limits, supported types, or validation rules change
- The processing pipeline's ports (`OcrEngine`/`DocumentAnalyzer`), fakes, or the
  searchable-PDF builder change
- The camera scanner (P2c) needs a different capture-to-upload contract than
  `uploadDocument`
- The direction decision matrix, invoice field set, or amount-parsing rules change
  (decisions/0021-extraction-direction-and-invoice-fields.md, C2)
- The intake branching decision table, the `intake_result` payload shape, or the ZUGFeRD
  field-priority scope changes (decisions/0022-intake-wiring.md, F1b)
- The payment-status computation/filter, or the inbox's "offen/überfällig/bezahlt" chip,
  changes (decisions/0025-payment-matching-wiring.md, F3b)
- `documents.platform`, or which `documentKind`s trigger the `import-account-transactions`
  job, changes (decisions/0026-platform-settlements.md, F4)
- MT940 support, or the upload file picker's accepted-file rules, changes
  (decisions/0028-mt940-support.md)
- The bulk-upload classification rules, or the upload queue's concurrency/quota-stop
  behavior, change (decisions/0030-bulk-upload.md, G2)
- The kinds "Dokumentart ändern" offers, its guards, or how it clears payment suggestions
  change (decisions/0072-correcting-a-document-s-kind.md)
- Apple's or Google's report format changes, or the `appStorePayout` intake-result field
  changes (decisions/0048-app-store-reports.md)
- The inbox's sort options or the date a row shows change
  (decisions/0058-inbox-sorts-by-the-document-s-own-date.md)
- The generated row name, or which chips a row carries, changes
  (decisions/0059-generated-document-names.md)
- A reader stores its period somewhere other than `intakeResult.appStorePayout.period`, or
  another kind gains a period (decisions/0060-app-store-reports-are-named-by-their-period.md)
- The statement reader's transaction shape changes, or another kind needs a date derived from
  its own contents (decisions/0061-a-statement-is-dated-by-its-last-booking.md)
- The shared effective-date expression (`documentEffectiveDate`) changes - it also scopes
  `src/modules/closing`'s periods (decisions/0066-abschluss-check-and-export.md)
Last verified: 2026-10-22, decisions/0076-match-after-every-trigger.md: a document finishing
invoice-shaped queues `match-payments` due now (`JobsRepository.scheduleNow`, one queued run per
workspace) instead of 90 seconds later, so the runner that processed it also matches it; every
`after()` runner call in `actions.ts` passes `AFTER_RESPONSE_JOB_BUDGET_MS`, and
`src/app/api/documents/route.ts` declares `maxDuration = 300` for its `after()` job run.
Previously 2026-10-22, decisions/0075-email-intake.md: `index.ts` also exports
`processIntakeUpload`/`MAX_UPLOAD_PAGES` (pure) so the E-Mail-Eingang's use case sniffs each
attachment exactly like an upload; a document created from a mail has no uploader and
`ui/document-detail-client.tsx` shows "Per E-Mail von <sender>" (optional `emailSender` prop).
Previously 2026-10-21, decisions/0072-correcting-a-document-s-kind.md: "Dokumentart
ändern" (`reclassifyDocumentAction`, `ui/kind-correction-control.tsx`,
`core/reclassification.ts`, the `kindOverride` job payload field, and `documents.manual_kind`,
which keeps the chosen kind for every later processing run). Previously 2026-10-03,
decisions/0066-abschluss-check-and-export.md: the inbox gained a
date-range filter ("Von"/"Bis", `?from=`/`?to=`), matched against that same shared
`documentEffectiveDate` expression rather than a second notion of a document's date -
`documentListQuerySchema` validates the two ISO bounds through `@/shared/date-range`, and
`ListDocumentsParams`/`ListDocumentsInput`/`ListDocumentsFilter` carry them to `list`. It is
what the Abschluss's "Wartet auf Bestätigung"/"Verarbeitung fehlgeschlagen" links now carry,
so a period-scoped count opens a period-scoped list; `listInvoiceCandidates` takes the same
optional range (for "Offene Posten" only - the matching candidate pool passes none).
Previously, 2026-10-02, decisions/0066-abschluss-check-and-export.md: the inbox's own
effective-date expression (`coalesce(document_date, <report period end>, <statement last
booking>, created_at::date)`, decisions/0058/0060/0061) is now ONE exported SQL helper,
`documentEffectiveDate` in `repositories/drizzle/documents-repository.ts`, shared by `list`'s
ordering and by `src/modules/closing`'s period scoping so the two can never disagree about
which month a document belongs to. `DocumentRepository` gained `countsForPeriod` (four real
`count(*)`s in one round trip) and `listForPeriod` (the Abschluss export's "Dokumente"
sheet, whose `confirmedTransactions` names the transactions a document is settled by rather
than counting them, so the export can cross-reference the two sheets); the counterparty
subquery `list` already used was lifted to a module-level constant so both reads share it.
`documentEffectiveDate`, and the two new sibling expressions `documentTotalAmountCents`/
`documentCurrency` (a platform report's amount is the sum of its settlement lines), are
written with explicit `documents.<column>` SQL text rather than drizzle column proxies, which
is what makes them safe to read from a JOINED query too - `src/modules/accounts`'s own
`listForPeriod` resolves a linked document's date and amount with them. No behaviour change to
the inbox itself.
Previously last verified 2026-09-23, decisions/0063-no-category-no-assignment-no-routing.md: document
category, document assignment, and routing are all removed end to end. `categories` (the
table), `documents.category_id`/`documents.category_source`, `CATEGORY_KEYS`/`CategoryKey`,
`core/category-label.ts`'s `resolveCategoryLabel`, `recategorizeDocumentAction`, the inbox's
category filter, and the detail page's category select and "automatisch erkannt" badge are
gone; `documents.assignee_user_id`, `reassignDocumentAction`, `clearAssigneeForUser`, the
inbox's "Meine Post" filter and assignee column, the detail page's assignee select, the
`send-assignment-email` job kind and its handler, and `server/emails/assignment-email.tsx`
(deleted) are gone; the processing pipeline no longer has an auto-routing step. The
`category`/`categoryKey` field is also gone from the Mistral analysis prompt, `AnalysisResult`/
`GuidedAnalysisResult`, and their validation. Previously, 2026-09-23,
decisions/0061-a-statement-is-dated-by-its-last-booking.md:
`buildBankStatementIntakeResult` records `lastBookingDate` over every parsed transaction (before
truncation), and the inbox names a statement "Kontoauszug, 29.01.2026" and sorts it there.
Previously, the same day, decisions/0060-app-store-reports-are-named-by-their-period.md: an
Apple or Google report is named "Apple, November 2025" and sorts at that month's end, its period
read from `intakeResult.appStorePayout.period` and surfaced through the projection as
`reportPeriod` alongside `platform`. Previously, the same day,
decisions/0059-generated-document-names.md: `core/display-name.ts`
generates an inbox row's name from the counterparty (carried into the projection as
`counterpartyName`, resolved by `list`'s own correlated subquery over `document_contacts`) and
the document's date, and the row now carries only the chips that ask something of the reader.
Previously, the same day, decisions/0058-inbox-sorts-by-the-document-s-own-date.md: the inbox
is ordered by `coalesce(document_date, created_at::date)` by default (`DOCUMENT_SORTS`, the
`sort` search param, threaded through `ListDocumentsParams`/`ListDocumentsInput`/
`ListDocumentsFilter` to the repository's `orderBy`), and each row shows the document's own date
with a labelled "Eingang" fallback for a tabular import that has none. Previously,
2026-09-22, decisions/0048-app-store-reports.md: `intake-branch.ts` gained two
more self-identifying branches, `"apple_payment_summary"`/`"google_play_earnings"`, checked
right after `"mt940"`; `documents-use-cases.ts` gained `processApplePaymentSummaryDocument`/
`processGooglePlayEarningsDocument` alongside `processCamt053Document`/`processMt940Document`,
both dispatched from `processTabularDocument` (both formats share `text/csv` with the generic
AI-mapped path, so detection happens one layer down from `intake-upload-processing.ts`, by
content, not by a new upload-time MIME type); `intake-result.ts`'s
`TabularConfirmedIntakeResult` gained an optional `appStorePayout` field. See that ADR for the
full reader/pairing rules (`src/modules/intake`, `src/modules/accounts`, `src/modules/payments`
own the rest of this phase). Previously last verified 2026-09-22, wave 2 of decisions/0036-guided-extraction.md
(`feature/guided-extraction-wiring`, off `main` once all three wave-1 branches merged):
`src/persistence/use-cases/documents-use-cases.ts`'s `processOcrDocument` is switched over -
`kind` is classified BEFORE the analyzer runs (a self-identified ZUGFeRD invoice resolves its own
kind from the CII XML's seller/buyer names via the new `resolveZugferdKind`, never a model call),
`planCounterparty(kind)` decides `direction` outright for a `"derived"` kind
(`plan.ourRole`) or feeds `decideDirection`'s existing kind/party-role priority order for an
`"open"` kind, `deps.analyzer.analyzeGuided` replaces `analyze`, and ONE
`deps.contacts.replaceDocumentLinks` call replaces the old per-party `upsertFromExtraction` loop.
`direction.ts`'s `directionFromKind` no longer treats `reminder` as `"incoming"` - a reminder's
direction now goes through `core/reminder-direction.ts`'s `resolveReminderDirection` instead
(the guided analyzer's own answer, overruled by a payment-IBAN check), and a reminder's
`payment_status` is now unconditionally `not_applicable`. New pure module
`core/self-counterparty-check.ts`'s `isCounterpartySelf` (the self-counterparty guard, "promised
to the owner" during review): after sanitizing a `"derived"`-mode counterparty exactly like
`replaceDocumentLinks` does (strips a matching own IBAN/VAT id first - a small, deliberate
duplication of that use case's own private `stripOwnIdentifiers`, not an import, since it belongs
to a different owner and the logic is four lines), if what remains still resolves to the
workspace's own company, `kind` was probably misclassified - direction becomes `"unknown"`,
nothing is linked, and `ui/document-detail-client.tsx` shows a short hint
(`core/party-roles.ts`'s new `isDerivedCounterpartyKind` predicate: true for exactly the six
`"derived"`-mode kinds, so `isDerivedCounterpartyKind(kind) && direction === "unknown"` is
exactly the condition under which the guard fired). Also, after review: the guided prompts
(`src/platform/mistral/server/prompts.ts`) no longer name any tenant brand ("PayPal, Stripe,
MUSTERBANK" in an earlier draft - a workspace's own bank/payment provider belongs in its own profile
text instead), and drop the payment-provider exclusion specifically for `platform_settlement`/
`payout_report` (whose counterparty IS one). Previously last verified 2026-09-22, wave 1 of
decisions/0036-guided-extraction.md (`feature/guided-extraction`, built in parallel with two
sibling branches, `feature/company-profile` and `feature/contact-links`): additive building
blocks only, `main`'s own pipeline behaviour was unchanged on that branch. New pure module
`core/party-roles.ts`'s `planCounterparty(kind)`: a lookup table (H-contract.md section 2) that
will let wave 2 classify a document's `kind` BEFORE the analyzer runs and derive the workspace's
own role from it in code, instead of asking the model to find and label every party itself (the
root cause behind an outgoing invoice producing the workspace's bank and the workspace's own
company as extracted "contacts" three runs in a row, decisions/0036's own "Context"). New pure
module `core/reminder-direction.ts`'s `resolveReminderDirection`: a reminder's direction stays the
model's own call, but a payment IBAN belonging to the workspace overrules it - deliberately NOT
yet wired into `direction.ts`'s `directionFromKind` (still treats `reminder` as `"incoming"`
unconditionally, unchanged, until wave 2). `core/ports.ts`'s `OwnCompanyContext` gained four
OPTIONAL fields (`aliases`/`ibans`/`domains`/`profileText`) so this branch compiles independently
of the sibling company-profile branch that will populate them; `DocumentAnalyzer` gained a second
method, `analyzeGuided` (beside the untouched `analyze`), implemented in both
`src/platform/mistral`'s real adapter and this module's own fake, validated by
`core/analysis-validation.ts`'s new `validateGuidedAnalysisResult`/`MAX_GUIDED_PARTIES` (2, down
from `analyze`'s 3) - the same never-throws, degrade-to-safe-defaults guarantee
`validateAnalysisResult` already gives every caller, refactored to share its per-party field
mapping (`toExtractedContactFields`) with the new `counterparty` field (`ExtractedParty` minus
`role` - the role is decided in code from `CounterpartyPlan`, never asked of the model in
`"derived"` mode). Previously last verified 2026-09-21, G3 (decisions/0031-direction-from-kind-and-short-invoice-numbers.md):
investigating a real invoice that failed to match its bank transaction found `decideDirection`
(C2) relied ONLY on the model's own per-party `role` hints, which turned out unreliable
run-to-run for the SAME real document/prompt/model (three consecutive runs producing three
different, inconsistent party lists) - `documents.kind` (F1b's own, separate classifier call)
stayed correct every run, so `decideDirection` now takes `kind: DocumentKind | null` and
`documentText: string | null` as two more, lower-priority signals (`kind` above a deterministic
own-company-in-text check, both below the existing party-role check, `unknown` still the final
fallback when nothing resolves it - see decisions/0031 for the full priority order).
`processOcrDocument` now computes `kind` before its real `decideDirection` call (a
self-identified ZUGFeRD invoice still needs a party-only direction guess first to pick its own
`kind`, unchanged from before this phase) and passes the full OCR text through as
`documentText`. Previously last verified 2026-09-21, G2 (decisions/0030-bulk-upload.md): a file selection on
`ui/upload-form.tsx`'s file tab can now become several documents in one go. New pure module
`core/bulk-upload.ts` (`classifyUploadGroups`, `shouldShowImageSplitSwitch`,
`buildBulkUploadRows`/`markGroupUploading`/`applyGroupResult`/`countSettledRows` - the queue
"reducer"): several PDFs or structured files (XML/CSV/TSV/MT940) are always one document each;
several images stay pages of one document unless the "Jede Datei ist ein eigenes Dokument"
switch (shown only with 2+ images) is on; a mixed selection combines both rules. Each group
still becomes exactly one `POST /api/documents` request - the route's own one-document-per-request
contract is unchanged, this only decides how many requests a selection becomes. Groups upload
sequentially; `ui/upload-form.tsx` renders a per-file list ("wartet"/"lädt hoch"/"fertig"/"Fehler")
with an "X von Y" counter once a selection classifies into more than one group (a single-group
selection, still the common case, keeps its pre-existing behavior: one request, redirect
straight to the new document). A per-file error (duplicate/too-large/unsupported/...) marks
only that row and the queue continues; a quota error stops the queue, marking every
still-waiting row "übersprungen" plus a short summary. Deliberately not built this phase:
folder picking, ZIP, cancel, retry-failed-only, drag-and-drop of folders, per-file progress
bars, resumability, a `beforeunload` warning (decisions/0030-bulk-upload.md's own list).
Previously last verified 2026-09-21, decisions/0028-mt940-support.md: `ui/upload-form.tsx`'s file
`<input>` no longer restricts uploads by extension/MIME type at all (`accept` removed
entirely - a real bank export's extension used to be silently hidden by it, the root cause of
a real bug report), `STRUCTURED_FILE_PATTERN` (the client-side "file too large" hint) broadened
to also cover `.mt940`/`.sta`/`.txt`/`.camt053v0N`, `intake-upload-processing.ts` gained an
MT940 branch alongside XML/CSV/TSV (a full, bounded `parseMt940` call at upload time, mirroring
camt.053's own upload-time check), `intake-branch.ts` gained an `"mt940"` branch treated exactly
like `"camt053"`, and `documents-use-cases.ts` gained `processMt940Document` alongside
`processCamt053Document`. See decisions/0028-mt940-support.md and
`@/modules/intake/README.md`'s own "mt940-parser.ts" entry for the parser itself (owned by
`src/modules/intake`, not this module). Previously last verified 2026-09-20, F5 (hardening,
decisions/0027-hardening-and-deletion.md): added
`RETENTION_DAYS_REJECTED_INTAKE` (30) and `DocumentUseCases.enqueuePurgeForRejectedIntake`
(a deliberately cross-workspace read, `DocumentRepository.listIntakeRejectedBefore` -
the retention cron's own exception to this module's usual per-workspace scoping), consumed
by the new `GET /api/cron/purge-rejected-intake` route (`src/app/api/cron/`, not owned by
this module but calling straight into it) - the only auto-deletion in the product, reusing
`deleteDocument` unchanged. Also added `ui/upload-form.tsx`'s structured-file-only
`file_too_large` hint ("Bitte exportieren Sie Kontoauszüge monatsweise.") - the 4 MB cap is
not raised this phase, only explained for the one file category it actually constrains in
practice (a CSV/XML export has no page-count knob to shrink it by the way a scanned PDF
does). Previously, F4 (platform settlements, decisions/0026-platform-settlements.md):
added `documents.platform` (nullable, only set for `kind` `payout_report`/
`platform_settlement` - set by `markIntakeResult`/`confirmIntake` alongside `kind`, the same
"duplicate onto a column for query convenience" precedent `kind` itself already set for
`intakeResult.documentKind`), extended to the `Document`/`DocumentDetailView` view types, and
gave `IntakeConfirmationPanel`'s "Bestätigen und importieren" its own `kickAction` call (the
same workspace-scoped `runDueJobs` kick `ProcessingPoller` already uses) so confirming a
tabular proposal is not silently slower than uploading at triggering its own
`import-account-transactions` job. Previously, F3b (payment matching wiring,
decisions/0025-payment-matching-wiring.md):
added `documents.payment_status`/`paid_at` (computed here at `markDone` time from
`direction`/`totalAmountCents`, via `@/modules/payments`'s `PAYMENT_STATUSES` - `open` for an
invoice-shaped document, `not_applicable` otherwise; written afterwards only by
`PaymentsUseCases.updatePaymentStatus`, never again by this module), `DocumentRepository.updatePaymentStatus`/
`listInvoiceCandidates`/`findPaymentStatusByInvoiceNumber`, the inbox's `paymentStatus` filter
and status chip, and the `match-payments` job enqueue in `processOcrDocument` for an
invoice-shaped document. 2026-09-20, F1b (decisions/0022-intake-wiring.md): wired
decisions/0020-universal-intake.md's pure recognizer (`@/modules/intake`) into this module.
`createFromUpload` now takes `bytes`/`mimeType`/`extension`/`fileHash` instead of only
`pdfBytes` (a structured XML/CSV/TSV file is stored as-is, never assembled) and rejects an
exact-duplicate `fileHash` with `DuplicateDocumentError` before storage or the quota check.
`processDocument` branches on the stored document's `mimeType`: unchanged OCR path (extended
with `documents.kind`, self-identified from an embedded ZUGFeRD invoice XML when present,
else via `IntakeClassifier` on the OCR text), a deterministic camt.053 parse (always
`intake_status: "confirmed"`), or a CSV/TSV path (a confirmed fingerprint's stored mapping, or
a classifier-proposed `pending_confirmation` mapping proposal). New pure modules:
`core/intake-branch.ts` (`decideIntakeBranch`, the branching decision table),
`core/intake-upload-processing.ts` (`processIntakeUpload`, the upload route's structured-file
sniffing/validation), `core/intake-result.ts` (`documents.intake_result`'s typed payload
shapes and builders), `core/zugferd-extraction.ts` (`extractZugferdInvoiceFields`, a narrow
CII/UN-CEFACT reader), `core/semantic-duplicate.ts` (`findSemanticDuplicate`, the
"möglicherweise doppelt" hint, computed live via `DocumentRepository.findByInvoiceNumber`,
never persisted). New use-case methods: `confirmIntake`/`rejectIntake`,
`listIntakeFingerprints`/`resetIntakeFingerprint`, `getPossibleDuplicateInvoice`. New UI:
`ui/intake-confirmation-panel.tsx` (the document detail page's confirmation panel),
`ui/intake-settings-client.tsx` (`/dashboard/settings/intake`, admin-only,
`PERMISSIONS.intakeManage`). Prior verification, C2 (decisions/0021-extraction-direction-and-invoice-fields.md):
extended the ONE existing analyzer call (never a second model call) with per-document party
extraction and invoice-shaped fields; `core/ports.ts`'s `DocumentAnalyzer.analyze()` now also
takes an `ownCompany` context and returns `parties`/`invoice`. New pure modules:
`core/amount-parsing.ts` (`parseGermanAmountToCents`/`inferCurrency` - the model's own
arithmetic is never trusted, only the raw printed text) and `core/direction.ts`
(`decideDirection`/`nonOwnParties`/`resolveLinkRoles` - direction and the contact-linking role
are both decided in code from `@/modules/contacts`'s `isOwnCompany`, never trusted from the
model). `documents` gained `direction`/`invoiceNumber`/`totalAmountCents`/`currency`/
`dueDate`/`paymentIban`/`paymentReference`/`paidNote` (all nullable) plus an index on
`(workspace_id, invoice_number)`. `src/persistence/use-cases/documents-use-cases.ts`'s
`processDocument` now also links every non-own extracted party into
`@/modules/contacts`'s `upsertFromExtraction` (a new `contacts` dependency, built before
`documents` in the composition root) and exposes `getLinkedContacts` for the document detail
page's own read model - see that ADR for why this lives on `DocumentUseCases` rather than
`ContactUseCases`. P7 (real-API defect fixes, D1): `core/ocr-text.ts`'s
`stripMarkdownNoise` used to delete every markdown table row outright (meant to strip only
Mistral's own asset placeholder links, e.g. an image link whose visible text and target are
both `img-0.jpeg`, or a table link whose visible text and target are both `tbl-3.html`) -
a real invoice's line items, quantities, prices and tax rates never reached
`documents.ocr_text` at all. Replaced with `flattenMarkdownTables` (one plain-text line per
table row, separator rows dropped, empty cells collapsed) plus a precise, self-referential
placeholder match (link text equals its own target) instead of stripping every image/link.
`core/searchable-pdf.ts` applies the same flattening to a `type: "table"` OCR block's own
content and to the whole-page markdown fallback, so the invisible PDF text layer and
`ocr_text` no longer disagree about whether a table's content exists. P6 review: added
`core/category-label.ts`'s `resolveCategoryLabel`
(wires the `Categories` i18n lookup this README/schema already documented, C1 doc-drift
fix), the upload route's own `after()` trigger and streaming byte cap (A4/B1), and
`revalidatePath` on upload/delete (A3/A5). P3 (billing): added `countStored` (read by
`src/modules/billing`'s usage view model) and the `canManageBilling`-aware quota-error
message in `ui/upload-form.tsx` (decisions/0017-billing-tiers-and-packages.md). P2b
(processing pipeline) added `index.ts` (the ports/pure helpers/fakes neutral entrypoint),
the processing use-case methods, retry/kick actions, the assignment e-mail, and the
processing UI (decisions/0016-processing-pipeline-and-ai.md)

## Purpose

The core value proposition: getting a piece of paper mail into the system, finding it
again, and doing something with it. A document has an original upload (always stored as a
PDF - a direct PDF upload as-is, or 1..20 JPEG/PNG images assembled into one PDF, one page
per image) and a status (`uploaded -> processing -> done | failed`). Search is Postgres
full-text search over a generated `tsvector` column. There is no document category,
assignee, or routing rule (decisions/0063-no-category-no-assignment-no-routing.md removed
all three).

Once uploaded, a document is processed asynchronously (decisions/0016-processing-pipeline-and-ai.md):
OCR (Mistral, or a deterministic fake outside production without an API key) ->
title/sender/date/summary extraction -> a searchable PDF (the original
pages plus an invisible OCR text layer). This module
owns that pipeline's ports (`OcrEngine`/`DocumentAnalyzer`), pure helpers (searchable-PDF
construction, OCR-text joining, WinAnsi sanitization, the shared analyzer-output validator),
and deterministic fakes; `src/platform/mistral` implements the real adapters, and
`src/platform/jobs` is the queue that drives it all asynchronously.

See decisions/0015-documents-and-quotas.md for the full data model, the upload path
(magic-byte sniffing, quota pre-check, storage-then-transaction-with-compensation), and
quota semantics; decisions/0016-processing-pipeline-and-ai.md for the processing pipeline.

## Public interfaces

- `index.ts` (neutral, no `server-only`, no `"use client"`): the processing pipeline's ports
  (`OcrEngine`, `DocumentAnalyzer`, `OcrResult`/`OcrPage`/`OcrBlock`, `AnalysisResult`), pure
  helpers (`validateAnalysisResult`, `joinOcrText`, `truncateForAnalysis`,
  `buildSearchablePdf`, `mapBlockToPdfRect`, `sanitizeWinAnsi`), and the deterministic fakes
  (`createFakeOcrEngine`, `createFakeDocumentAnalyzer`). F1b added: `decideIntakeBranch`/
  `INTAKE_BRANCHES` (the branching decision table), `extractZugferdInvoiceFields` (embedded
  ZUGFeRD invoice field reader), `findSemanticDuplicate` (the "möglicherweise doppelt" hint),
  `parseIntakeResult`/`buildBankStatementIntakeResult`/`buildTabularConfirmedIntakeResult`/
  `MAX_EMBEDDED_ROWS` (the `documents.intake_result` payload's shape and builders).
  decisions/0036-guided-extraction.md added: `planCounterparty`/`CounterpartyPlan`/
  `isDerivedCounterpartyKind` (`core/party-roles.ts`), `resolveReminderDirection`
  (`core/reminder-direction.ts`), `isCounterpartySelf` (`core/self-counterparty-check.ts`, wave 2's
  self-counterparty guard), `GuidedAnalysisResult`/`GuidedCounterparty` (`core/ports.ts`), and
  `validateGuidedAnalysisResult`/`MAX_GUIDED_PARTIES` (`core/analysis-validation.ts`) - all wired
  into `processOcrDocument` since wave 2. decisions/0072-correcting-a-document-s-kind.md added
  `RECLASSIFIABLE_KINDS`/`isReclassifiableKind`/`ReclassifiableKind`
  (`core/reclassification.ts`), checked again by `reclassifyDocument`. This is
  what lets `src/persistence/use-cases/documents-use-cases.ts` (a use case may only reach a
  module's *neutral* entrypoint, never its `server.ts`/`client.ts` - WEBAPP_TEMPLATE_SPEC.md
  §5.4) and `src/platform/mistral` (implements these same ports) reach this module's `core/`
  without crossing its boundary anywhere else.
- `actions.ts` (`"use server"`): `deleteDocumentAction`, `retryProcessingAction`,
  `reclassifyDocumentAction` (decisions/0072, `PERMISSIONS.documentsWrite`),
  `kickProcessingAction`, and (F1b)
  `confirmIntakeAction`, `rejectIntakeAction`, `resetIntakeFingerprintAction`, each returning
  `ActionResult<TData, DocumentActionErrorCode>` (`@/shared/action-result`,
  `confirmIntakeAction` its own `ConfirmIntakeActionResult` carrying validation `problems` on
  failure) except `kickProcessingAction` (`Promise<void>`, best-effort UI plumbing, never a
  user-facing error). `confirmIntakeAction`/`rejectIntakeAction` are gated behind
  `PERMISSIONS.documentsWrite` (ordinary document work, every member);
  `resetIntakeFingerprintAction` behind the new admin-only `PERMISSIONS.intakeManage`. Upload
  is not a Server Action - it is the route handler below, since it needs multipart parsing.
- `client.ts` (`"use client"`): `uploadDocument` (the browser-side upload helper both the
  file-upload tab and P2c's camera scanner use), `UploadForm`, `DocumentDetailClient`,
  `ProcessingPoller` (the kick-and-poll client island both the Posteingang and the detail
  page mount while any shown document is `uploaded`/`processing`), and (F1b)
  `IntakeConfirmationPanel` (the detail page's confirmation panel for a `pending_confirmation`
  tabular proposal), `IntakeSettingsClient` (`/dashboard/settings/intake`'s fingerprint list
  and "Zuordnung zurücksetzen").
- `server.ts` (`import "server-only"`): `listDocumentsProjection`,
  `getDocumentDetailProjection`
  (the read models the pages call), `processUploadParts`/`MAX_UPLOAD_PAGES`/
  `MAX_UPLOAD_REQUEST_BYTES` (the upload route's PDF/image validation/assembly),
  `processIntakeUpload` (F1b, extended by decisions/0028-mt940-support.md: the upload route's
  structured-file XML/CSV/TSV/MT940 sniffing/validation, delegating to `processUploadParts` for
  the PDF/image case),
  `contentDispositionHeader` (the download route's header builder),
  `documentListQuerySchema`/`DOCUMENTS_PAGE_SIZE`,
  `DOCUMENT_UPLOAD_ERROR_CODES`/`DocumentUploadErrorCode`, `DOCUMENT_STATUSES`/`DocumentStatus`
  (re-exported from `@/persistence/repositories/contracts`, the persistence-entry door -
  this module never imports `@/persistence/schema/**` directly, only its owner rank may),
  and (F1b) `getDocumentIntakeConfirmationProjection` (an alias of
  `getDocumentDetailProjection`, named for the confirmation UI's own data dependency),
  `listIntakeFingerprintsProjection` (`/dashboard/settings/intake`'s read model).

## Structure

- `core/ports.ts` - `OcrEngine`/`DocumentAnalyzer` and their input/output types
  (decisions/0016-processing-pipeline-and-ai.md; `ExtractedParty`/`InvoiceFields`/
  `OwnCompanyContext` are decisions/0021-extraction-direction-and-invoice-fields.md, C2).
  decisions/0036-guided-extraction.md: `OwnCompanyContext` gained four fields (`aliases`/`ibans`/
  `domains`/`profileText`, now required and mapped from the merged company-profile columns by
  `src/persistence/use-cases/documents-use-cases.ts`'s `toOwnCompanyContext`); `DocumentAnalyzer`
  gained a second method, `analyzeGuided` (the existing `analyze` is untouched but no longer
  called by `processOcrDocument`), returning the new `GuidedAnalysisResult`
  (`counterparty`/`parties`/`reminderDirection` alongside the same title/sender/date/
  summary/invoice fields `analyze` already returns).
- `core/party-roles.ts` (decisions/0036-guided-extraction.md, pure) - `planCounterparty(kind)`/
  `CounterpartyPlan`: a lookup table from `documents.kind` to `{ mode: "derived", ourRole,
  counterpartyRole, relationType }` (6 kinds), `{ mode: "open" }` (`reminder`/`letter`/`contract`/
  `other` - the model still decides), or `{ mode: "none" }` (`bank_statement` - no counterparty
  concept at all). `relationType` comes from this table alone, never from a model answer. Wave 2
  added `isDerivedCounterpartyKind(kind)` (true for exactly the six `"derived"`-mode kinds) -
  `ui/document-detail-client.tsx`'s unclear-direction hint keys off it.
- `core/reminder-direction.ts` (decisions/0036-guided-extraction.md, pure, wired into
  `processOcrDocument` since wave 2) - `resolveReminderDirection({ modelDirection, paymentIban,
  ownIbans })`: a reminder's direction is still the model's own guided-prompt answer, EXCEPT a
  payment IBAN normalizing to one of `ownIbans` forces `"outgoing"`, and a payment IBAN present
  but matching none of them forces `"incoming"` - only with no payment IBAN at all does the
  model's own answer stand.
- `core/self-counterparty-check.ts` (decisions/0036-guided-extraction.md, wave 2, pure) -
  `isCounterpartySelf(counterparty, ownCompany)`: the self-counterparty guard. Sanitizes the
  extracted counterparty first (strips a matching own IBAN/VAT id - a small, deliberate
  duplication of `src/persistence/use-cases/contacts-use-cases.ts`'s own private
  `stripOwnIdentifiers`, not an import, since that file belongs to a different owner and the
  logic is four lines; both copies must be kept in sync, each file's own comment says so), then
  checks `@/modules/contacts`'s `isOwnCompany` against what remains. `processOcrDocument` calls
  this only for a `"derived"`-mode plan's counterparty; a `true` result means the classified
  `kind` was probably wrong, not the counterparty.
- `core/analysis-validation.ts` - `validateAnalysisResult`: the one function both the real
  Mistral analyzer and the fake analyzer call, so every `AnalysisResult` obeys the same
  guarantees regardless of provider (title/sender truncated to 120 chars, date must be a plausible ISO `YYYY-MM-DD` else
  `null`, summary truncated to 300 chars, up to 3 `parties` each clamped/role-defaulted to
  `"mentioned"`, `invoice` parsed via `core/amount-parsing.ts` or `null` when nothing
  invoice-shaped was found). Never throws, but no longer called by `processOcrDocument`
  (decisions/0036-guided-extraction.md) - still exercised by its own unit tests. Its sibling
  `validateGuidedAnalysisResult`/`MAX_GUIDED_PARTIES` (2) is `analyzeGuided`'s own result shape,
  same never-throws guarantee, sharing this file's per-party field mapping
  (`toExtractedContactFields`, extracted from `toExtractedParty` so `analyze`'s `ExtractedParty`
  and the guided `counterparty`'s bare `ExtractedContactData` - no `role` key - stay one
  field-mapping rule, not two).
- `core/amount-parsing.ts` - `parseGermanAmountToCents`/`inferCurrency` (C2): deterministic
  parsing of the model's raw printed-amount text (German `1.083,68`, US `1,083.68`, a bare
  `1083.68`, `EUR 12`, a negative/credit-note amount) into an integer cent amount - the
  model's own arithmetic is never trusted.
- `core/direction.ts` - `decideDirection`/`nonOwnParties`/`resolveLinkRoles` (C2, pure): the
  document's `incoming`/`outgoing`/`unknown` direction and which role to link each non-own
  party under, both decided in code, never from the model's own labels. `decideDirection`
  (decisions/0031, G3) tries, in order: an own-company party's role (`@/modules/contacts`'s
  `isOwnCompany`), then `kind` (`outgoing_invoice`/`incoming_invoice` only, since
  decisions/0036-guided-extraction.md's wave 2 removed `reminder`), then a deterministic
  own-company-in-text check (name via `@/modules/contacts`'s `normalizeName`, or postal code),
  then `unknown`. Only ever called by `processOcrDocument` for a `CounterpartyPlan` of mode
  `"open"` since wave 2 - a `"derived"`-mode kind's direction is `plan.ourRole` directly, never
  through this function; a reminder's direction goes through `core/reminder-direction.ts`
  instead.
- `core/fake-ocr-engine.ts`/`core/fake-document-analyzer.ts` - deterministic fakes, keyed
  only by file name (no randomness, no clock): a small ordered keyword-to-template table
  (most specific first, e.g. `"telekom"` before `"rechnung"`) generates realistic German
  letter text, one OCR block per line; the fake analyzer classifies via keyword search over
  that text and extracts a German `DD.MM.YYYY` date if present.
- `core/searchable-pdf.ts` - `buildSearchablePdf`/`mapBlockToPdfRect`: loads the original PDF
  (`pdf-lib`), draws each OCR block's content as invisible (`opacity: 0`) text positioned by
  mapping its pixel bounding box to PDF points (flips the y axis; light handling for a
  90/270-degree page rotation), or distributes markdown paragraphs down the page when blocks
  are missing. A `type: "table"` block's own content, and the whole-page markdown in the
  fallback path, are run through `core/ocr-text.ts`'s `flattenMarkdownTables` first (P7, D1) -
  the invisible text layer reads as plain text, not raw `| a | b |` markdown, and stays
  consistent with what `documents.ocr_text` stores for the same table.
- `core/winansi.ts` - `sanitizeWinAnsi`: keeps WinAnsi-representable characters (ASCII,
  Latin-1 - which covers German umlauts/ß - plus WinAnsi's extra punctuation), replaces
  anything else with `?`, so `drawText` never throws on an unsupported character.
- `core/ocr-text.ts` - `joinOcrText` (markdown joined across pages, for `documents.ocr_text`):
  strips only Mistral's own self-referential asset placeholder links (an image or link whose
  visible text equals its own target, e.g. both `img-0.jpeg` or both `tbl-3.html`), and
  flattens every real
  markdown table into plain text via the exported `flattenMarkdownTables` (one line per row,
  cells joined by `" | "`, separator rows dropped, empty cells collapsed) instead of deleting
  table rows outright (P7, D1 - the previous behavior threw away an invoice's line items,
  amounts and tax rates). `truncateForAnalysis` caps the text sent to the analyzer prompt at
  6000 characters (a normal one-page invoice, table included, is far under that - verified
  against the real Mistral API at 1701 characters total; a long document's tail, table or
  total included, can still be cut off, `documents.ocr_text` itself is never truncated).
  `flattenMarkdownTables` is also used by `core/searchable-pdf.ts` for a `type: "table"`
  block's own content and the markdown-paragraph fallback, so the invisible PDF text layer
  stays consistent with `ocr_text`.
- `core/types.ts` - `DocumentListItem`,
  `DocumentListView`, `DocumentDetailView`: UI-facing DTOs
  (dates as ISO strings).
- `core/schemas.ts` - Zod input schemas for the three actions and the `/dashboard` list
  query params (`documentListQuerySchema`).
- `core/error-codes.ts` - `DOCUMENT_UPLOAD_ERROR_CODES`/`DocumentUploadErrorCode` (the
  upload route's codes), `DOCUMENT_ACTION_ERROR_CODES`/`DocumentActionErrorCode` (the three
  Server Actions' codes, now including `retry_not_allowed`), and
  `DOCUMENT_PROCESSING_ERROR_CODES`/`DocumentProcessingErrorCode` (the stable codes a
  failed document's own `errorCode` column can hold - `src/platform/mistral`'s codes plus
  `processing_failed`/`unknown_job_kind`) - all `as const` sets the UI translates via
  `Scan.errors`/`DocumentDetail.errors`.
- `core/magic-bytes.ts` - `sniffFileType`: pure PDF/JPEG/PNG signature detection, never the
  client's declared MIME type or file extension.
- `core/pdf-assembly.ts` - `assembleImagesIntoPdf` (one page per image, A4 width, height
  from the image's own aspect ratio) and `validateUploadedPdf` (page count, rejects
  encrypted/unparseable PDFs) - both `pdf-lib`, pure aside from that library's own CPU work,
  no I/O.
- `core/upload-processing.ts` - `processUploadParts`: combines sniffing, validation, and
  assembly into the one function the upload route calls; either exactly one PDF or 1..20
  images, never a mix.
- `core/upload-limits.ts` - `MAX_UPLOAD_REQUEST_BYTES` (4 MB, Vercel's 4.5 MB body limit),
  `MAX_UPLOAD_PAGES` (20).
- `core/upload-client.ts` - `uploadDocument`: the browser-side `fetch` wrapper around
  `POST /api/documents`, published through `client.ts`. `UploadDocumentResult`'s error variant
  carries an optional `existingDocumentId` (F1b: a `duplicate_document` response's link
  target).
- `core/intake-branch.ts` (F1b, extended by decisions/0028-mt940-support.md and
  decisions/0048-app-store-reports.md) -
  `decideIntakeBranch({ mimeType, isCamt053, isMt940, isApplePaymentSummary,
  isGooglePlayEarnings, hasKnownFingerprint })`: pure branching decision table -
  `"ocr"`/`"camt053"`/`"mt940"`/`"apple_payment_summary"`/`"google_play_earnings"`/
  `"tabular_known_source"`/`"tabular_unknown_source"` - the one function `processDocument` (and
  its own unit tests) use to decide between the OCR pipeline and the six non-OCR intake paths.
- `core/intake-upload-processing.ts` (F1b, extended by decisions/0028-mt940-support.md) -
  `processIntakeUpload(parts, maxPages)`: sniffs a single-part upload via `@/modules/intake`'s
  `sniffFileKind`; an XML upload must be a recognized camt.053 document
  (`unsafe_xml`/`unrecognized_xml_format` otherwise), an MT940 file is fully parsed within its
  own hard limits (`empty_mt940_file`/`unreadable_mt940_file`/`mt940_too_large` otherwise), a
  CSV/TSV only needs to be readable and non-empty
  (`empty_tabular_file`/`unreadable_tabular_file` otherwise) - everything else (a single PDF, or
  1..20 images) falls through to `processUploadParts` unchanged. An Apple payment summary or a
  Google Play earnings report both sniff and are stored as an ordinary `text/csv` upload at
  this layer - their own deterministic recognition happens one layer down, in
  `documents-use-cases.ts`'s `processTabularDocument` (decisions/0048-app-store-reports.md).
- `core/intake-result.ts` (F1b, extended by decisions/0048-app-store-reports.md) - the typed,
  discriminated shape stored in `documents.intake_result`
  (`BankStatementIntakeResult`/`TabularConfirmedIntakeResult`/`TabularProposalIntakeResult`/
  `TabularRejectedIntakeResult`), `parseIntakeResult` (a lenient Zod read-back, never throws),
  and the two builders that cap embedded rows/transactions at `MAX_EMBEDDED_ROWS` (500,
  `truncated: true` beyond that) - decisions/0022-intake-wiring.md's "or a compact summary if
  too large". `TabularConfirmedIntakeResult.appStorePayout` (optional) carries an Apple/Google
  report's own stated payout/net total forward for `PaymentsUseCases`'s app-store
  payout-to-bank-credit pairing - `undefined` for every other confirmed tabular source.
- `core/zugferd-extraction.ts` (F1b) - `extractZugferdInvoiceFields(xmlText)`: a narrow
  CII/UN-CEFACT reader (invoice number, total amount, currency, due date, payment IBAN,
  seller/buyer name) for an embedded ZUGFeRD/Factur-X/XRechnung invoice XML
  (`@/modules/intake`'s `extractEmbeddedXml`) - when it finds anything, those fields (and the
  document's `kind`) take priority over the model's own extraction; propagates
  `UnsafeXmlError` for a malicious attachment (never silently swallowed), degrades to `null`
  for a merely malformed or unrecognized one.
- `core/semantic-duplicate.ts` (F1b) - `findSemanticDuplicate(current, others)`: pure
  wrapper around `@/modules/intake`'s `semanticInvoiceKey` (invoice number + `@/modules/contacts`'s
  `normalizeName`-normalized sender + amount) - the "möglicherweise doppelt" hint, computed
  live by `DocumentUseCases.getPossibleDuplicateInvoice` against
  `DocumentRepository.findByInvoiceNumber`'s candidates (the existing `(workspace_id,
  invoice_number)` index), never persisted as its own column.
- `core/content-disposition.ts` - `contentDispositionHeader`: RFC 5987
  `Content-Disposition` header builder (ASCII fallback + `filename*=UTF-8''` encoded form).
- `server/read-models.ts` (published through `server.ts`) - the two read models listed
  above, each backed by `getRequestServices().documents`.
- `actions.ts` - the three Server Actions. `mapUseCaseError` translates a thrown
  `UseCaseError` (`DOCUMENT_ERROR` codes from `src/persistence/use-cases/documents-use-cases.ts`)
  into this module's own codes; `requirePermission(PERMISSIONS.documentsWrite)` gates
  delete/retry - every workspace member has this permission (PRD: any
  member reads/writes documents), not only the admin. `retryProcessingAction`,
  `reclassifyDocumentAction`, and `kickProcessingAction` all call `runDueJobs` via
  `next/server`'s `after()` (`src/platform/jobs/server`). `reclassifyDocumentAction`
  (decisions/0072-correcting-a-document-s-kind.md) calls `DocumentUseCases.reclassifyDocument`
  (refuses anything but a `done` PDF, an account-feeding kind, the current kind, a confirmed
  payment link, a `settled` payment status; otherwise marks the document `processing` and
  enqueues `process-document` with `kindOverride`), then
  `PaymentsUseCases.discardOpenSuggestionsForDocument` (the payments owner deletes the
  document's `suggested` rows; logged, not returned, on failure). The `process-document` job
  handler clears them once more after a `kindOverride` run. In `processOcrDocument`,
  `kindOverride` replaces the classifier call (and the ZUGFeRD seller-name guess) and skips
  `correctInvoiceKind`'s own-IBAN flip; everything else runs as on a normal run.
- `ui/upload-form.tsx` - `/dashboard/scan`'s tabs ("Kamera": `@/modules/scanner/client`'s
  `CameraScanner`, "Datei hochladen": drag-and-drop + file input) and error rendering,
  including a link to `/dashboard/billing` on a quota error. Takes a `canManageBilling`
  prop (`ScanPage` passes `access.permissions.includes(PERMISSIONS.billingManage)`, P3,
  decisions/0017-billing-tiers-and-packages.md): a member without that permission also sees
  a sentence telling them to contact their admin (`Scan.errors.quotaMemberHint`) - they can
  still see the read-only billing page, just not act on it.
- `ui/document-detail-client.tsx` - the detail page's metadata panel: the processing state
  (`ProcessingPoller`, the summary sentence, a per-error-code
  message with "Erneut verarbeiten" once `failed`, a "Testmodus" hint when the fake AI
  provider is bound), the OCR text section, delete with confirmation. Wave 2 of
  decisions/0036-guided-extraction.md added a short hint ("Die Richtung dieses Dokuments konnte
  nicht sicher bestimmt werden...") shown exactly when `core/party-roles.ts`'s
  `isDerivedCounterpartyKind(document.kind)` is true and `document.direction` is `"unknown"` -
  the only way that combination can happen once `"derived"`-mode plans exist at all, i.e. the
  self-counterparty guard fired. decisions/0072 added `KindCorrectionControl` below the header
  for a `done` PDF (`DocumentDetailView.mimeType`), the user's answer to that hint.
- `ui/kind-correction-control.tsx` (decisions/0072-correcting-a-document-s-kind.md) -
  `KindCorrectionControl`: a "Dokumentart ändern" link that opens a select of
  `RECLASSIFIABLE_KINDS` (labels from `DocumentKinds`), the sentence "Das Dokument wird mit
  dieser Dokumentart neu ausgewertet.", and "Neu auswerten" (disabled for the current kind).
  Calls `reclassifyDocumentAction`, shows its translated error code, and on success
  `router.refresh()`es so `ProcessingPoller` picks up the `processing` state.
- `ui/processing-poller.tsx` - `ProcessingPoller`: kicks `runDueJobs` for the caller's
  workspace once when it becomes active, then polls `router.refresh()` every ~3 seconds
  until the server-rendered state says nothing is left in `uploaded`/`processing`.
- `ui/intake-confirmation-panel.tsx` (F1b) - `IntakeConfirmationPanel`: shown on the detail
  page for a `pending_confirmation` `TabularProposalIntakeResult` - the recognized kind/
  platform (editable, scoped to the tabular-relevant kinds) and the column mapping as a table
  (a `<select>` per `SEMANTIC_FIELD`, options limited to the file's real header) are editable;
  the proposal's own `amountSign` is reused as-is (not editable, a documented scope cut,
  decisions/0022-intake-wiring.md). "Bestätigen und importieren" calls `confirmIntakeAction`
  (re-validates server-side regardless of what was edited) and shows any returned validation
  problems; "Ablehnen" calls `rejectIntakeAction`.
- `ui/intake-settings-client.tsx` (F1b) - `IntakeSettingsClient`: `/dashboard/settings/intake`'s
  table of confirmed source fingerprints (kind, platform, use count, last used) with
  "Zuordnung zurücksetzen" per row (`resetIntakeFingerprintAction`).

## Dependencies on other owners

`@/platform/access` (`PERMISSIONS`), `@/platform/access/server` (`requirePermission`,
`workspaceAccess`, `WorkspaceAccessError`), `@/platform/jobs` (`JOB_KINDS`,
`TransientJobError`/`PermanentJobError`), `@/platform/jobs/server` (`runDueJobs`),
`@/platform/mistral` (`MistralRequestError`, reclassified into this pipeline's own job
errors),
`@/persistence/composition/request-services` (`getRequestServices`),
`@/persistence/use-cases/documents-use-cases` (`DOCUMENT_ERROR`),
`@/persistence/use-cases/errors` (`UseCaseError`), `@/persistence/repositories/contracts`
(`DOCUMENT_STATUSES`/`DocumentStatus`/`DOCUMENT_DIRECTIONS`/`DocumentDirection`,
the persistence-entry door - never `schema/**` directly), `@/modules/contacts`
(C2, decisions/0021-extraction-direction-and-invoice-fields.md: `ExtractedContactData`/
`DocumentContactRole`/`isOwnCompany`/`OwnCompanyProfile`; `normalizeName` for F1b's
semantic-duplicate matching - a `modules -> modules` import, allowed by STRUCTURE.md's
`direction` rule), `@/modules/intake` (F1b, decisions/0022-intake-wiring.md:
`sniffFileKind`/`detectCamt053`/`parseCamt053`/`camt053StatementReconciles`/
`extractEmbeddedXml`/`sampleTabular`/`parseTabularRows`/`validateMapping`/
`decodeTextBytes`/`fileHash`/`semanticInvoiceKey`/the classification taxonomy - this
module's own upload-processing/pipeline-branching code is the one consumer of F1a's pure
domain layer), `@/modules/scanner/client`
(`CameraScanner`, the "Kamera" tab -
P2c's owner), `@/shared/action-result` (`ActionResult`), `@/shared/ui-primitives` (`Button`,
`Input`, `Label`). `pdf-lib` (general-purpose library, unrestricted by STRUCTURE.md's
`vendor-sdk` rule) is used in `core/pdf-assembly.ts` and `core/searchable-pdf.ts`.
`@react-email/components` (confined to `server/emails/` by STRUCTURE.md's `vendor-sdk` rule,
extended for this directory in decisions/0016-processing-pipeline-and-ai.md).

## Consumers

`src/app/api/documents/route.ts` (seam, `POST`): `server.ts`'s upload-processing exports,
`@/platform/access`/`@/platform/access/server`, `@/persistence/composition/request-services`.
`src/app/api/documents/[id]/file/route.ts` (seam, `GET`): `contentDispositionHeader`, the
same access/composition imports - streams `documents.getFileForDownload`'s bytes,
workspace-scoped, 404 for another workspace's document id.
`src/app/(app)/dashboard/page.tsx` (seam): `listDocumentsProjection`,
`DOCUMENT_STATUSES`, `documentListQuerySchema`, `ProcessingPoller`,
`kickProcessingAction` - the filter form is a plain `method="get"` form, no client component
needed for filtering itself. `src/app/(app)/dashboard/scan/page.tsx` (seam): `UploadForm`.
`src/app/(app)/dashboard/documents/[id]/page.tsx` (seam): `getDocumentDetailProjection`,
`DocumentDetailClient`,
`kickProcessingAction`, `@/platform/mistral/server`'s `isFakeAiProviderActive`.
`src/app/(app)/dashboard/settings/intake/page.tsx` (seam, F1b, admin-only): 
`listIntakeFingerprintsProjection`, `IntakeSettingsClient`.
`src/modules/dashboard-shell/core/nav-items.ts`: the "Post erfassen" nav entry
(`/dashboard/scan`) and (F1b) the "Erkannte Quellen" entry (`/dashboard/settings/intake`,
`permission: "intake.manage"`).

## Where P2c plugged in, and what P3 completed

- **P2c (camera scanner, implemented)**: `src/modules/scanner`, a client-only capture UI,
  calls `uploadDocument` (`src/modules/documents/client.ts`) with its perspective-corrected
  JPEG pages - the exact same function `ui/upload-form.tsx`'s file-input tab already calls.
- **P3 (billing UI, package purchase, warning e-mails, decisions/0017-billing-tiers-and-packages.md,
  implemented)**: `/dashboard/billing` now exists (`src/modules/billing`), so
  `ui/upload-form.tsx`'s quota-error link resolves; the form also now tells a member without
  `billing.manage` to contact their admin instead of just linking to a page they cannot act
  on. The 80% warning e-mail job (`send-quota-warning`, wired into `job-handlers.ts`'s map)
  lives in `src/modules/billing`/`billing-use-cases.ts`,
  reading `evaluateQuota`'s `totalRatio`/`monthlyRatio` this module's own `createFromUpload`
  already computes on every upload.

## Tests

`tests/schemas.test.ts`, `tests/magic-bytes.test.ts`, `tests/pdf-assembly.test.ts` (small
generated JPEG/PNG buffers, page count/size asserted with `pdf-lib`),
`tests/upload-processing.test.ts`, `tests/actions.test.ts` (session/permission requirements,
Zod rejection without calling the use case, `UseCaseError` code mapping, `revalidatePath`
calls, `retryProcessingAction`/`kickProcessingAction`'s `after()`/`runDueJobs` scheduling),
`tests/upload-form.test.tsx` (Testing Library + jsdom: file selection, error rendering per
stable code, the quota-error billing link, the member-without-`billing.manage` contact hint
- P3, tab switching mounts the camera scanner - mocked).
`tests/analysis-validation.test.ts`, `tests/winansi.test.ts`, `tests/ocr-text.test.ts`
(P7, D1: a realistic German invoice markdown fixture - 7-column table, `19 %` tax rows, a
`Gesamtbetrag` line - proves item names/amounts/tax rates survive `joinOcrText`, plus the
self-referential-placeholder-only stripping and `flattenMarkdownTables` unit cases),
`tests/searchable-pdf.test.ts` (page count unchanged, output differs, a Helvetica font
resource and text-showing operators are present - content streams decompressed for
inspection since pdf-lib Flate-compresses them regardless of `useObjectStreams`; a
`type: "table"` block and the markdown-paragraph-fallback path both flatten table syntax
the same way, D1),
`tests/fake-ocr-engine.test.ts`, `tests/fake-document-analyzer.test.ts` (deterministic
per-file-name templates, including the architecture brief's own `rechnung-telekom.pdf`
worked example - now an incoming invoice with a VAT id, IBAN, amount, and due date, plus the
`ausgangsrechnung.pdf` fixture that builds its sender party from the caller's own company
profile, C2). `tests/amount-parsing.test.ts` (the `1.083,68`/`1,083.68`/`1083.68`/`EUR 12`/
negative-credit-note table) and `tests/direction.test.ts` (the full direction decision
matrix: recipient/sender/absent/mislabelled, plus `resolveLinkRoles`'s role resolution) are
C2's pure-logic tests, extended by G3 (decisions/0031) with the `kind`/document-text priority
levels - including the exact observed real-invoice case (own company absent from `parties`,
the customer mislabeled `sender`, `kind: outgoing_invoice` -> `outgoing`) and the guard that
nothing is invented when `kind` carries no signal and no text evidence exists either.
Wave 1 of decisions/0036-guided-extraction.md replaced this suite's own custom-analyzer test with
wave 2's self-counterparty-guard test and the "musterfirma" end-to-end test below - see there for
why: guided extraction removed the very possibility of the model mislabelling a role at all for a
`"derived"` kind, so that scenario is no longer reachable. `tests/party-roles.test.ts` (one test
per `planCounterparty` table row, every `DocumentKind` covered with no exceptions, plus
`isDerivedCounterpartyKind`'s own suite), `tests/reminder-direction.test.ts` (own-IBAN/foreign-
IBAN/no-IBAN, normalized IBAN comparison), `tests/self-counterparty-check.test.ts` (name/alias/
domain matches, an own IBAN or VAT id stripped before the check so it decides nothing by itself,
never throws on a bare own-company profile), `tests/document-detail-client.test.tsx` (Testing
Library + jsdom, real `de.json` messages: the unclear-direction hint renders for a `"derived"`-
mode kind with `direction: "unknown"`, not for an `"open"`-mode kind, not before processing has
run; decisions/0072: the "Dokumentart ändern" control's visibility, its selectable kinds and
copy, and a translated error code), `tests/analysis-validation.test.ts`'s `validateGuidedAnalysisResult` suite (well-formed/
missing-optional/malformed input, `MAX_GUIDED_PARTIES` truncation, `plan.mode` gating which of
`counterparty`/`parties`/`reminderDirection` a raw answer is even allowed to populate), and
`tests/fake-document-analyzer.test.ts`'s `analyzeGuided` suite (derived-mode counterparty
selection with no `role` key, open-mode parties/truncation, none-mode always empty, a
reminder's guessed direction from the extracted payment IBAN, built directly from the already-
validated `AnalysisResult` rather than re-parsed as raw model JSON - a wave-2 bugfix, see that
file's own header comment). `src/platform/mistral`'s own README documents the guided-prompt and
`analyzeGuided`-adapter tests.

Wave 2's `src/persistence/tests/documents-use-cases.test.ts` additions (`processDocument`'s
"direction, invoice fields, and contact linking" suite): an outgoing invoice whose OCR text
contains the workspace's own brand ("Musterfirma") in the letterhead, its own bank in the footer,
and the customer in the address block ends with exactly one contact link (the customer, role
`recipient`, `relation_type` `customer`), direction `outgoing`, no bank/own-company contact - the
observed real defect, reproduced and proven fixed end to end; the self-counterparty guard itself
(an `outgoing_invoice` whose extracted counterparty is our own alias ends `unknown`, no link,
`payment_status` `not_applicable`, `kind` left as classified); a reminder's `payment_status`
staying `not_applicable` even though direction and amount both resolve; and a new "ZUGFeRD kind
resolution" suite (`resolveZugferdKind`'s own seller/buyer-name-based logic, no classifier call
either way).

Cross-workspace isolation, quota rejections, the row-lock concurrency proof, and
German-stemming search (including, P7/D1, finding a document by an invoice table's own item
name or amount, e.g. "Fachbuch" or "1.083,68") are
`src/persistence/tests/documents-*.test.ts`/`*.db.test.ts`;
`processDocument`/`retryProcessing`/`reassign`'s notification rules are
`src/persistence/tests/documents-use-cases.test.ts` (`src/persistence/README.md`).
`POST /api/documents` and `GET /api/documents/[id]/file` against real Postgres and MinIO are
`tests/integration/http/documents-upload.integration.test.ts` and
`documents-file.integration.test.ts`; the full processing pipeline (upload, then `runDueJobs`
directly, fake AI) against real Postgres and MinIO is
`tests/integration/workflows/processing-pipeline.integration.test.ts`. End-to-end upload ->
inbox -> detail -> delete is `tests/e2e/documents.spec.ts` (tagged `@smoke`);
the processing pipeline and search end to end is
`tests/e2e/processing.spec.ts` (tagged `@smoke`).

F1b (decisions/0022-intake-wiring.md): `tests/intake-branch.test.ts` (the branching decision
table), `tests/intake-upload-processing.test.ts` (route-level XML/CSV/TSV sniffing/validation,
including a synthetic malicious-XML and a quoted-multi-line-header CSV that sniffs as "csv" but
parses to zero data rows), `tests/zugferd-extraction.test.ts` (a synthetic minimal CII invoice,
since no ZUGFeRD fixture exists in `@/modules/intake`'s own fixtures - XXE protection still
propagates), `tests/semantic-duplicate.test.ts`, `tests/intake-result.test.ts` (row-capping,
lenient parse-back). `src/persistence/tests/documents-use-cases.test.ts`'s "intake branching
(F1b)" and "confirmIntake / rejectIntake (F1b)" suites cover camt.053 parsing, fingerprint
precedence over the classifier (a spy classifier that throws if called), the
`pending_confirmation` proposal path, confirm/reject, and `intake_not_pending`; its
"createFromUpload" suite covers the exact-duplicate rejection ordering (before storage and the
quota check). `tests/actions.test.ts` covers `confirmIntakeAction`/`rejectIntakeAction`
checking `documentsWrite` (not admin-only) versus `resetIntakeFingerprintAction` checking the
admin-only `intake.manage`.
`tests/integration/workflows/intake-pipeline.integration.test.ts` (real Postgres + MinIO,
reusing `@/modules/intake`'s own fixtures) covers a camt.053 upload end to end (confirmed,
quota counted once), an exact-duplicate rejection, a malicious-XML rejection, and the full
Musterbank-CSV proposal -> confirm -> fingerprint-saved -> a later file with the same layout
confirming WITHOUT another classifier call. `tests/e2e/intake.spec.ts` (tagged `@smoke`)
covers upload -> "Bestätigung nötig" -> confirm -> kind "Kontoauszug" -> a repeat upload
showing the duplicate message.

F5 (decisions/0027-hardening-and-deletion.md): `src/persistence/tests/documents-use-cases.test.ts`'s
"enqueuePurgeForRejectedIntake" suite (the 30-day boundary, every other `intakeStatus`
excluded however old, cross-workspace scope); `src/persistence/tests/documents-repository.db.test.ts`'s
"listIntakeRejectedBefore" suite proves the same query against real Postgres.
`tests/integration/http/cron-purge-rejected-intake.integration.test.ts` proves the whole
cron end to end (real Postgres + MinIO: the row and its storage object are both actually
gone afterwards). `tests/upload-form.test.tsx` covers the structured-file-only
`file_too_large` hint.
