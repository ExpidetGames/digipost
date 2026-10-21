// Owner: src/modules/documents (decisions/0015-documents-and-quotas.md,
// decisions/0016-processing-pipeline-and-ai.md). Inputs are normalized and re-checked here
// even though the route handler/Server Actions already validated them: use cases are the
// last line of defense (WEBAPP_TEMPLATE_SPEC.md §5.4). No `next/*`, `react`,
// `src/platform/*/client`, or a module's own `server.ts`/`client.ts` (the
// "Neutral-Entrypoint-Regel") - only `Repositories`/`UnitOfWork` from
// `src/persistence/repositories/contracts`, the injected `ObjectStorage`/`OcrEngine`/
// `DocumentAnalyzer` ports, the sibling `BillingUseCases`, and pure logic from `@/modules/billing`
// and `@/modules/documents`'s own neutral `index.ts` (persistence may import modules,
// WEBAPP_TEMPLATE_SPEC.md §4's direction matrix) - never that module's `server.ts`/`client.ts`.
//
// `createFromUpload` is the one method worth reading closely first: it runs a first,
// non-transactional quota pre-check (fails fast, before any storage write, for the common
// case), writes the object to storage, then re-checks the quota *authoritatively* inside a
// transaction that also locks the workspace row (`select ... for update`) - this is what
// serializes two concurrent uploads for the same workspace against the same limit. If the
// transaction throws for any reason (the re-check fails, or any other error), the
// already-stored object is deleted as compensation. It also enqueues the `process-document`
// job in that SAME transaction (decisions/0016-processing-pipeline-and-ai.md's jobqueue
// recipe): the job only ever exists once the document row it processes has actually
// committed.
//
// `processDocument` (P2b) is the job handler's actual body: OCR -> analyze -> build the
// searchable PDF -> link contacts. A `MistralRequestError` (`@/platform/mistral`) is
// reclassified into `@/platform/jobs`'s `TransientJobError`/`PermanentJobError` here - this
// is the one place that translates "why Mistral failed" into "should the job queue retry
// it", so `src/platform/jobs`/`jobs-use-cases.ts` stays domain-free and
// `src/platform/mistral` stays ignorant of the job queue.
//
// C2 (decisions/0021-extraction-direction-and-invoice-fields.md) extends `processDocument`
// with direction/invoice-field extraction and contact linking, on top of the SAME analyzer
// call P2b already made (never a second model call): the workspace's own company profile
// (already a plain column set on `workspaces`, no extra use case needed) is read directly via
// `deps.repos.workspace.findById` - the same "read another owner's repo directly inside a use
// case when the alternative is a whole new cross-module dependency" pattern this file's
// `collectOwnIbans` also uses for `deps.repos.account.listForWorkspace`. Contact linking calls
// `deps.contacts.upsertFromExtraction` (C1's one pipeline entry point,
// `src/persistence/use-cases/contacts-use-cases.ts`) once per non-own party; a failure linking
// one party is logged and skipped rather than failing the whole document (OCR/analysis having
// already succeeded is worth keeping even if a contact link does not go through).
import {
  buildBankStatementIntakeResult,
  buildSearchablePdf,
  buildTabularConfirmedIntakeResult,
  decideDirection,
  decideIntakeBranch,
  extractZugferdInvoiceFields,
  findSemanticDuplicate,
  isCounterpartySelf,
  isReclassifiableKind,
  joinOcrText,
  nonOwnParties,
  parseIntakeResult,
  planCounterparty,
  resolvePaymentIban,
  resolveLinkRoles,
  resolveReminderDirection,
  truncateForAnalysis,
  type DocumentAnalyzer,
  type IntakeResult,
  type OcrEngine,
  type OwnCompanyContext,
  type TabularProposalIntakeResult,
  type ZugferdExtraction,
} from "@/modules/documents";
import { isOwnCompany, normalizeIban, normalizeName, type DocumentContactRole, type OwnCompanyProfile } from "@/modules/contacts";
import {
  APPLE_PAYMENT_SUMMARY_ERROR,
  ApplePaymentSummaryParseError,
  camt053StatementReconciles,
  decodeTextBytes,
  detectApplePaymentSummary,
  detectCamt053,
  detectGooglePlayEarnings,
  extractEmbeddedXml,
  GOOGLE_PLAY_EARNINGS_ERROR,
  GooglePlayEarningsParseError,
  MT940_MIME_TYPE,
  Mt940ParseError,
  mt940StatementReconciles,
  parseApplePaymentSummary,
  parseCamt053,
  parseGooglePlayEarnings,
  parseMt940,
  parseTabularRows,
  sampleTabular,
  validateMapping,
  type AmountSign,
  type ColumnMapping,
  type DocumentKind,
  type IntakeClassifier,
  type IntakeOwnCompany,
  type SettlementPlatform,
} from "@/modules/intake";
import { evaluateQuota, periodKeyFor, type Tier } from "@/modules/billing";
import { MATCHING_DEBOUNCE_MS, PAYMENT_STATUSES, type PaymentStatus } from "@/modules/payments";
import type { MatchPaymentsInput } from "@/persistence/use-cases/payments-use-cases";
import type {
  DocumentDirection,
  DocumentIntakeStatus,
  DocumentRow,
  DocumentStatus,
  DocumentWithRelations,
  IntakeFingerprintRow,
  Repositories,
  UnitOfWork,
} from "@/persistence/repositories/contracts";
import type { BillingUseCases } from "@/persistence/use-cases/billing-use-cases";
import type { ContactUseCases, ReplaceDocumentLinksParty } from "@/persistence/use-cases/contacts-use-cases";
import { UseCaseError } from "@/persistence/use-cases/errors";
import { JOB_KINDS, PermanentJobError, TransientJobError } from "@/platform/jobs";
import { MistralRequestError } from "@/platform/mistral";
import { documentOriginalKey, documentSearchableKey, type ObjectStorage } from "@/platform/object-storage";

export const DOCUMENT_ERROR = {
  notFound: "not_found",
  quotaTotalExceeded: "quota_total_exceeded",
  quotaMonthlyExceeded: "quota_monthly_exceeded",
  /** `retryProcessing` on a document that is not currently `failed` (requirement 9: retry is
   * only offered/allowed for failed documents). */
  retryNotAllowed: "retry_not_allowed",
  /** F1b (decisions/0020-universal-intake.md's "Content-level duplicate detection", the
   * `fileHash` half): `createFromUpload` found an existing document in this workspace with
   * the exact same uploaded bytes. Thrown as `DuplicateDocumentError` (below), which carries
   * the existing document's id for the route's error envelope. */
  duplicateDocument: "duplicate_document",
  /** `confirmIntake`/`rejectIntake` on a document whose `intakeStatus` is not
   * `pending_confirmation`. */
  intakeNotPending: "intake_not_pending",
  /** `confirmIntake`: the (possibly user-edited) mapping still does not validate against the
   * full file. Thrown as `MappingValidationError` (below), which carries the validation
   * problems for the confirmation UI to display. */
  mappingValidationFailed: "mapping_validation_failed",
  /** decisions/0072-correcting-a-document-s-kind.md: `reclassifyDocument` on a document that is
   * not a processed (`done`) PDF - a structured upload (camt.053, MT940, CSV/TSV) has its own
   * intake flow, and a document still processing or failed has no kind worth correcting yet. */
  reclassifyNotAllowed: "reclassify_not_allowed",
  /** `reclassifyDocument` with a kind outside `RECLASSIFIABLE_KINDS` (an account-feeding kind). */
  kindNotSelectable: "kind_not_selectable",
  /** `reclassifyDocument` with the kind the document already has. */
  kindUnchanged: "kind_unchanged",
  /** `reclassifyDocument` on a document with a CONFIRMED payment link: re-extracting it would
   * reset its payment status under money already allocated to it. Remove the link first. */
  paymentLinked: "payment_linked",
  /** `reclassifyDocument` on a document a clearing account settled (decisions/0026,
   * decisions/0068): the clearing booking would outlive the kind it was booked for. */
  paymentSettled: "payment_settled",
} as const;
export type DocumentErrorCode = (typeof DOCUMENT_ERROR)[keyof typeof DOCUMENT_ERROR];

/** Carries the id of the document this upload duplicates, so the route can put it in the
 * error envelope ("Dieses Dokument ist bereits vorhanden" with a link, F1b). */
export class DuplicateDocumentError extends UseCaseError<typeof DOCUMENT_ERROR.duplicateDocument> {
  constructor(readonly existingDocumentId: string) {
    super(DOCUMENT_ERROR.duplicateDocument);
  }
}

/** Carries the mapping validation problems so `confirmIntakeAction` can show them without a
 * second round trip (F1b). */
export class MappingValidationError extends UseCaseError<typeof DOCUMENT_ERROR.mappingValidationFailed> {
  constructor(readonly problems: readonly { rowNumber: number; field: string; code: string; message: string }[]) {
    super(DOCUMENT_ERROR.mappingValidationFailed);
  }
}

/** F5 (decisions/0027-hardening-and-deletion.md): how long a rejected intake document
 * ("Ablehnen" - a tabular proposal a human declined, nothing was ever imported) is kept
 * before the retention cron purges it. Nothing else in this product is ever auto-deleted -
 * business records (confirmed imports, invoices, contacts) have statutory retention
 * obligations a rejected proposal never had in the first place, since it was never accepted
 * as a real record. */
export const RETENTION_DAYS_REJECTED_INTAKE = 30;

export type Document = {
  id: string;
  workspaceId: string;
  uploadedByUserId: string | null;
  uploadedByEmail: string | null;
  originalFileName: string;
  mimeType: string;
  pageCount: number;
  sizeBytes: number;
  storageKey: string;
  searchablePdfKey: string | null;
  status: DocumentStatus;
  errorCode: string | null;
  ocrText: string | null;
  title: string | null;
  sender: string | null;
  documentDate: string | null;
  summary: string | null;
  /** `null` until processing has run at least once; always one of `DOCUMENT_DIRECTIONS`
   * afterwards (decisions/0021-extraction-direction-and-invoice-fields.md, C2). */
  direction: DocumentDirection | null;
  invoiceNumber: string | null;
  totalAmountCents: number | null;
  currency: string | null;
  dueDate: string | null;
  paymentIban: string | null;
  paymentReference: string | null;
  paidNote: string | null;
  /** F1b (decisions/0020-universal-intake.md, decisions/0022-intake-wiring.md): the universal
   * intake recognizer's own taxonomy - "letter" until processing has classified the document. */
  kind: DocumentKind;
  /** F4 (decisions/0026-platform-settlements.md): only set for `kind`
   * `payout_report`/`platform_settlement` - which platform this report came from. */
  platform: SettlementPlatform | null;
  intakeStatus: DocumentIntakeStatus;
  /** Parsed via `@/modules/documents`'s `parseIntakeResult` - `null` for `not_applicable`/
   * never-processed documents, or if the stored payload somehow no longer matches the
   * expected shape. */
  intakeResult: IntakeResult | null;
  /** F3b (decisions/0025-payment-matching-wiring.md). */
  paymentStatus: PaymentStatus;
  paidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  processedAt: Date | null;
};

/** `/dashboard/documents/[id]`'s "linked contacts" panel (C2, decisions/0021's "UI surface"):
 * read directly off `deps.repos.documentContact`/`deps.repos.contact` (both already part of
 * the `Repositories` bundle handed to this use case) rather than through a new
 * `ContactUseCases` method - `src/persistence/use-cases/contacts-use-cases.ts` is C1's own
 * file and is not touched by this phase. `verified` mirrors the contact's own
 * `verified_at is not null` - an unverified link shows the "unbestätigt" badge. */
export type LinkedContactView = {
  contactId: string;
  name: string;
  role: DocumentContactRole;
  verified: boolean;
};

export type ListDocumentsInput = {
  q?: string;
  status?: DocumentStatus;
  /** decisions/0021-extraction-direction-and-invoice-fields.md's inbox filter. */
  direction?: DocumentDirection;
  /** decisions/0022-intake-wiring.md's inbox kind filter. */
  kind?: DocumentKind;
  /** F3b (decisions/0025-payment-matching-wiring.md): "offen/überfällig/bezahlt". */
  paymentStatus?: "open" | "overdue" | "paid";
  /** decisions/0058-inbox-sorts-by-the-document-s-own-date.md: `documentDate` (the default the
   * caller resolves) or `uploaded`. */
  sort?: "documentDate" | "uploaded";
  /** The "Start" work-list page's "Wartet auf Bestätigung" link. */
  intakeStatus?: "pending_confirmation";
  /** decisions/0066-abschluss-check-and-export.md: the inbox's date range, inclusive ISO
   * `YYYY-MM-DD` bounds on the document's EFFECTIVE date (the shared expression the list is
   * already ordered by, never a second notion of a document's date). */
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
};

/** The `process-document` job's payload shape (enqueued by `createFromUpload`,
 * `retryProcessing`, and `reclassifyDocument`, parsed by the composition root's job handler
 * before calling `processDocument`). `kindOverride` (decisions/0072-correcting-a-document-s-kind.md)
 * is set only by `reclassifyDocument`: the OCR branch then uses it instead of asking the
 * classifier, and skips the IBAN-based invoice-kind flip (decisions/0039/0043) - the human's
 * choice wins over that heuristic. Ignored by every non-PDF branch. */
export type ProcessDocumentInput = { workspaceId: string; documentId: string; kindOverride?: DocumentKind };

/** F2 (decisions/0024-accounts-and-transactions.md): the `import-account-transactions` job's
 * payload shape - enqueued the moment a document's `intakeStatus` becomes `confirmed` with
 * kind `bank_statement` (the camt.053 branch, the tabular-known-fingerprint branch, and
 * `confirmIntake` alike), handled by `src/persistence/use-cases/accounts-use-cases.ts`'s
 * `importFromDocument`. Kept as a job (not a direct call into `AccountsUseCases`) so this file
 * never needs an `accounts` dependency of its own - the "handlers registered where they
 * belong" owner-boundary discipline `decisions/0016-processing-pipeline-and-ai.md` describes. */
export type ImportAccountTransactionsInput = { workspaceId: string; documentId: string };

/** The `purge-rejected-intake` job's payload shape (F5, decisions/0027-hardening-and-deletion.md),
 * enqueued by `enqueuePurgeForRejectedIntake` - one job per eligible document, so the job
 * queue's own retry/backoff applies to each deletion independently. */
export type PurgeRejectedIntakeInput = { workspaceId: string; documentId: string };

export interface DocumentUseCases {
  /** F1b generalizes this from "always a PDF" to "any accepted content" (decisions/0020-universal-intake.md):
   * `mimeType`/`extension` describe what was actually stored (`"application/pdf"`/`"pdf"` for
   * a scanned letter/invoice, `"application/xml"`/`"xml"`, `"text/csv"`/`"csv"`, or
   * `"text/tab-separated-values"`/`"tsv"` for a structured intake file, stored as-is).
   * `fileHash` is checked BEFORE any storage write or quota check: an exact repeat upload in
   * this workspace throws `DuplicateDocumentError`, never reaching either
   * (decisions/0020-universal-intake.md's "Content-level duplicate detection"). */
  createFromUpload(input: {
    workspaceId: string;
    uploadedByUserId: string | null;
    originalFileName: string;
    bytes: Uint8Array;
    mimeType: string;
    extension: string;
    pageCount: number;
    fileHash: string;
  }): Promise<Document>;
  /** decisions/0059-generated-document-names.md: a list row also carries the counterparty the
   * inbox names it after, which only this read resolves (see `DocumentListRow`). */
  list(
    workspaceId: string,
    filter: ListDocumentsInput,
  ): Promise<{
    items: (Document & { counterpartyName: string | null; reportPeriod: string | null; statementLastBooking: string | null })[];
    hasMore: boolean;
  }>;
  getById(workspaceId: string, id: string): Promise<Document | null>;
  /** Documents currently stored (any status) - the same count `createFromUpload`'s quota
   * check uses, exposed for `src/modules/billing`'s usage display (P3,
   * decisions/0017-billing-tiers-and-packages.md's "Tarif & Nutzung" page). */
  countStored(workspaceId: string): Promise<number>;
  /** The "Start" work-list page's "Wartet auf Bestätigung" bucket. */
  countPendingIntakeConfirmation(workspaceId: string): Promise<number>;
  /** The "Start" work-list page's "Verarbeitung fehlgeschlagen" bucket. */
  countFailed(workspaceId: string): Promise<number>;
  /** The "Start" work-list page's "Überfällig" bucket (effective payment status, see
   * `DocumentRepository.countOverduePayments`). */
  countOverduePayments(workspaceId: string): Promise<number>;
  /** The bytes to stream for `GET /api/documents/[id]/file`: the searchable PDF once P2b's
   * processing produced one, otherwise the original upload. `null` when the document does
   * not exist in this workspace - the route 404s (never leaks whether it exists elsewhere). */
  getFileForDownload(workspaceId: string, id: string): Promise<{ bytes: Uint8Array; fileName: string } | null>;
  /** `[]` when the document does not exist in this workspace (never an error - mirrors
   * `getById`'s own "just show nothing" contract for a missing id). See `LinkedContactView`'s
   * own doc comment for why this lives here rather than on `ContactUseCases`. */
  getLinkedContacts(workspaceId: string, documentId: string): Promise<LinkedContactView[]>;
  /** F1b's semantic-duplicate hint (decisions/0020-universal-intake.md's `semanticInvoiceKey`,
   * decisions/0022-intake-wiring.md): `null` when the document is not invoice-shaped (missing
   * invoice number/sender/amount) or no other document in the workspace shares the same
   * invoice number/sender/amount. Never deletes anything - purely informational, for the UI's
   * "möglicherweise doppelt" hint and link. */
  getPossibleDuplicateInvoice(workspaceId: string, documentId: string): Promise<{ id: string; originalFileName: string } | null>;
  deleteDocument(input: { workspaceId: string; documentId: string }): Promise<void>;
  /** F5 (decisions/0027-hardening-and-deletion.md): the retention cron's own read - every
   * intake document rejected ("Ablehnen") more than `RETENTION_DAYS_REJECTED_INTAKE` days
   * ago, across EVERY workspace (deliberately unscoped, like the job queue's own cron sweep,
   * `runDueJobs` with no `workspaceId` filter - this is background maintenance work, not a
   * user-facing query). Enqueues a `purge-rejected-intake` job per document (never deletes
   * synchronously here) so the actual deletion runs through the same job-queue retry/backoff
   * machinery as everything else; re-running this against a document whose job has not
   * completed yet is harmless (a duplicate enqueue for an id that is already gone by the time
   * either job runs is a no-op, `job-handlers.ts`'s own `purge-rejected-intake` handler). */
  enqueuePurgeForRejectedIntake(): Promise<{ enqueued: number }>;
  /** The `process-document` job's body (decisions/0016-processing-pipeline-and-ai.md): OCR,
   * analysis, and the searchable PDF. A no-op success if the document no longer exists (deleted
   * while the job was pending). Throws `@/platform/jobs`'s `TransientJobError`/
   * `PermanentJobError` on failure, after recording the document's own `errorCode`. */
  processDocument(input: ProcessDocumentInput): Promise<void>;
  /** Re-enqueues processing for a `failed` document ("Erneut verarbeiten", requirement 9).
   * Rejects with `retry_not_allowed` for a document that is not currently `failed`. */
  retryProcessing(input: { workspaceId: string; documentId: string }): Promise<void>;
  /** "Dokumentart ändern" (decisions/0072-correcting-a-document-s-kind.md): marks a processed
   * PDF `processing` and enqueues `process-document` with `kindOverride: kind`, in one
   * transaction (the same shape as `retryProcessing`). Rejects with `reclassify_not_allowed`
   * (not a `done` PDF), `kind_not_selectable`, `kind_unchanged`, `payment_linked` (a confirmed
   * `document_transactions` row exists), or `payment_settled` (a clearing account settled it).
   * Open payment suggestions are NOT touched here (`document_transactions` belongs to
   * `src/modules/payments`): the caller clears them through `PaymentsUseCases`. */
  reclassifyDocument(input: { workspaceId: string; documentId: string; kind: DocumentKind }): Promise<void>;
  /** "Bestätigen und importieren" (F1b, decisions/0020-universal-intake.md's confirmation
   * step): re-reads the stored original file, re-validates `mapping`/`amountSign` (the
   * proposal as-is, or the user's edited version) against every row, and only on success
   * persists the normalized result, sets `intakeStatus: "confirmed"`, and stores the
   * confirmed fingerprint for the workspace (so the next file with the same layout imports
   * without another model call). Rejects with `intake_not_pending` unless the document is
   * currently `pending_confirmation`, and throws `MappingValidationError` (carrying the
   * problems) when validation still fails. */
  confirmIntake(input: {
    workspaceId: string;
    documentId: string;
    actingUserId: string | null;
    documentKind: DocumentKind;
    platform: SettlementPlatform | null;
    mapping: ColumnMapping;
    amountSign: AmountSign | null;
  }): Promise<Document>;
  /** "Ablehnen": sets `intakeStatus: "rejected"`, nothing is imported. Rejects with
   * `intake_not_pending` unless the document is currently `pending_confirmation`. */
  rejectIntake(input: { workspaceId: string; documentId: string }): Promise<Document>;
  /** `/dashboard/settings/intake`'s admin-only list: every confirmed source layout for this
   * workspace, kind/platform/use count/last used. */
  listIntakeFingerprints(workspaceId: string): Promise<IntakeFingerprintRow[]>;
  /** "Zuordnung zurücksetzen" (admin-only): removes a confirmed source layout entirely, so
   * the next matching file goes through the classifier proposal flow again. A no-op (not an
   * error) when the id does not exist in this workspace - mirrors `deleteDocument`'s own
   * "already gone" tolerance for an idempotent admin action. */
  resetIntakeFingerprint(workspaceId: string, fingerprintId: string): Promise<void>;
}

function toDocument(row: DocumentWithRelations): Document {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    uploadedByUserId: row.uploadedByUserId,
    uploadedByEmail: row.uploadedByEmail,
    originalFileName: row.originalFileName,
    mimeType: row.mimeType,
    pageCount: row.pageCount,
    sizeBytes: row.sizeBytes,
    storageKey: row.storageKey,
    searchablePdfKey: row.searchablePdfKey,
    status: row.status as DocumentStatus,
    errorCode: row.errorCode,
    ocrText: row.ocrText,
    title: row.title,
    sender: row.sender,
    documentDate: row.documentDate,
    summary: row.summary,
    direction: row.direction as DocumentDirection | null,
    invoiceNumber: row.invoiceNumber,
    totalAmountCents: row.totalAmountCents,
    currency: row.currency,
    dueDate: row.dueDate,
    paymentIban: row.paymentIban,
    paymentReference: row.paymentReference,
    paidNote: row.paidNote,
    kind: row.kind as DocumentKind,
    platform: row.platform,
    intakeStatus: row.intakeStatus as DocumentIntakeStatus,
    intakeResult: parseIntakeResult(row.intakeResult),
    paymentStatus: row.paymentStatus,
    paidAt: row.paidAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    processedAt: row.processedAt,
  };
}

async function mustFindWithRelations(repos: Repositories, workspaceId: string, id: string): Promise<DocumentWithRelations> {
  const row = await repos.document.findById(workspaceId, id);
  if (!row) throw new UseCaseError(DOCUMENT_ERROR.notFound);
  return row;
}

/** Reclassifies a thrown `MistralRequestError` into the job queue's own transient/permanent
 * vocabulary; any other error (a bug, an object-storage failure, ...) is treated as
 * transient, so it is retried and only surfaces via `max_attempts` exhaustion rather than
 * being silently recorded as permanent on its first occurrence. Returns both the code to
 * persist on the document row and the error to actually throw. */
function classifyProcessingError(err: unknown): { code: string; jobError: Error } {
  if (err instanceof MistralRequestError) {
    return { code: err.code, jobError: err.transient ? new TransientJobError(err.code) : new PermanentJobError(err.code) };
  }
  if (err instanceof TransientJobError || err instanceof PermanentJobError) {
    return { code: err.code, jobError: err };
  }
  return { code: "processing_failed", jobError: new TransientJobError("processing_failed") };
}

/** `WorkspaceRow`'s `company_*` columns (decisions/0019-contacts.md's "own-company
 * exclusion", extended by decisions/0034-extended-company-profile.md and wave 2 of
 * decisions/0036-guided-extraction.md) -> the two shapes the guided extraction pipeline needs:
 * the full prompt context (`OwnCompanyContext`) and the minimal comparison shape `isOwnCompany`
 * takes (`OwnCompanyProfile`, `@/modules/contacts`). Read directly off the already-fetched
 * `WorkspaceRow` - no separate `workspaces` use-case call needed, the columns are already
 * plain fields on that row. `null` context when the admin has not filled in ANY part of the
 * company profile yet (every field still at its default) - the analyzer still runs, it simply
 * gets no "das sind wir" hint.
 *
 * `aliases` is passed through EXACTLY as stored (trimmed/de-duplicated, original casing) rather
 * than `normalizeName`d the way `toOwnCompanyProfile`'s own `aliases` field is: this is prompt
 * text a model reads, not a value compared for exact equality, and a real document is far more
 * likely to print "Musterfirma" than "musterfirma". `ibans`/`domains` are already normalized at
 * write time (`workspaces-use-cases.ts`'s `updateCompanyProfile`) and pass through unchanged
 * either way. `profileText` is the trimmed free text as stored, capped defensively again inside
 * the prompt builders themselves (`src/platform/mistral/server/prompts.ts`) even though it is
 * already capped on write. */
function toOwnCompanyContext(workspace: {
  name: string;
  companyAddressLine1: string | null;
  companyAddressLine2: string | null;
  companyPostalCode: string | null;
  companyCity: string | null;
  companyCountry: string | null;
  companyVatId: string | null;
  companyAliases: string[];
  companyIbans: string[];
  companyDomains: string[];
  companyProfileText: string | null;
}): OwnCompanyContext {
  const hasAnyProfileData = Boolean(
    workspace.companyAddressLine1 ||
      workspace.companyPostalCode ||
      workspace.companyCity ||
      workspace.companyVatId ||
      workspace.companyAliases.length > 0 ||
      workspace.companyIbans.length > 0 ||
      workspace.companyDomains.length > 0 ||
      workspace.companyProfileText,
  );
  if (!hasAnyProfileData) return null;
  return {
    name: workspace.name,
    addressLine1: workspace.companyAddressLine1,
    addressLine2: workspace.companyAddressLine2,
    postalCode: workspace.companyPostalCode,
    city: workspace.companyCity,
    country: workspace.companyCountry,
    vatId: workspace.companyVatId,
    aliases: workspace.companyAliases,
    ibans: workspace.companyIbans,
    domains: workspace.companyDomains,
    profileText: workspace.companyProfileText,
  };
}

/**
 * decisions/0034-extended-company-profile.md (H1): `aliases` are normalized here with
 * `normalizeName`, matching `OwnCompanyProfile.aliases`'s own documented contract ("already
 * normalized with `normalizeName`") - the `workspaces` row itself stores them trimmed/
 * de-duplicated but NOT name-normalized, so the admin's settings form shows back exactly what
 * they typed ("Musterfirma", not "musterfirma"). `ibans`/`domains` are already normalized at
 * write time (`workspaces-use-cases.ts`'s `updateCompanyProfile`), so they pass through
 * unchanged.
 */
function toOwnCompanyProfile(workspace: {
  name: string;
  companyPostalCode: string | null;
  companyVatId: string | null;
  companyAliases: string[];
  companyIbans: string[];
  companyDomains: string[];
  companyTaxNumber: string | null;
  companyRegisterCourt: string | null;
  companyRegisterNumber: string | null;
}): OwnCompanyProfile {
  return {
    name: workspace.name,
    postalCode: workspace.companyPostalCode,
    vatId: workspace.companyVatId,
    aliases: workspace.companyAliases.map((alias) => normalizeName(alias)).filter(Boolean),
    ibans: workspace.companyIbans,
    domains: workspace.companyDomains,
    taxNumber: workspace.companyTaxNumber,
    registerCourt: workspace.companyRegisterCourt,
    registerNumber: workspace.companyRegisterNumber,
  };
}

/**
 * Resolves a self-identified ZUGFeRD invoice's `kind` (`"outgoing_invoice"`/
 * `"incoming_invoice"`) WITHOUT a model call - wave 2 of decisions/0036-guided-extraction.md
 * needs `kind` before the (guided) analyzer ever runs, so the previous fallback (guessing from
 * the ungated `analyze()` call's own extracted parties, i.e. a result that itself only existed
 * because the analyzer had already run) no longer fits the new ordering. `extractZugferdInvoiceFields`
 * already reads the CII XML's own seller/buyer names directly - a strictly more reliable
 * source than asking a model to re-derive the same two names from OCR text, and one that
 * needs no analyzer call at all, matching the "self-identifying format, no classifier" rule
 * camt.053/MT940 already follow. Same default bias as the previous fallback: when the seller
 * is not recognizably us (including when NEITHER name matches, or both do - a malformed
 * document), the kind defaults to `"incoming_invoice"`, the common case for a plain scanned
 * letter.
 */
/** The classifier's view of the user's company (decisions/0043). */
function toIntakeOwnCompany(context: OwnCompanyContext | null, ownIbans: ReadonlySet<string>): IntakeOwnCompany | null {
  if (!context) return null;
  const address = [context.addressLine1, [context.postalCode, context.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return {
    name: context.name,
    aliases: context.aliases ?? [],
    address: address || null,
    ibans: [...ownIbans],
    domains: context.domains ?? [],
    profileText: context.profileText ?? null,
  };
}

/** decisions/0039 and 0043: a verified payment IBAN overrules the classifier's invoice direction. */
function correctInvoiceKind(classifiedKind: DocumentKind, paysToOwnAccount: boolean, paysToForeignAccount: boolean): DocumentKind {
  if (classifiedKind === "incoming_invoice" && paysToOwnAccount) return "outgoing_invoice";
  if (classifiedKind === "outgoing_invoice" && paysToForeignAccount) return "incoming_invoice";
  return classifiedKind;
}

/** Our own accounts: the company profile's IBANs plus every bank account imported from our own
 * statements (`accounts.iban`, read-only here, owned by `src/modules/accounts`), normalized. */
async function collectOwnIbans(deps: DocumentUseCaseDeps, workspaceId: string, profileIbans: readonly string[]): Promise<Set<string>> {
  const accounts = await deps.repos.account.listForWorkspace(workspaceId);
  const ibans = [...profileIbans, ...accounts.map((account) => account.iban).filter((iban): iban is string => Boolean(iban))];
  return new Set(ibans.map((iban) => normalizeIban(iban)));
}

/** Kinds whose `payment_status` is always `not_applicable`: see the comment where
 * `processOcrDocument` computes `isInvoiceShaped`. */
const NEVER_PAYMENT_MATCHED_KINDS: ReadonlySet<DocumentKind> = new Set<DocumentKind>(["reminder", "platform_settlement", "payout_report"]);

function resolveZugferdKind(zugferd: ZugferdExtraction, ownCompany: OwnCompanyProfile): DocumentKind {
  const isOwnPartyName = (name: string | null) => (name ? isOwnCompany({ name }, ownCompany) : false);
  return isOwnPartyName(zugferd.sellerName) ? "outgoing_invoice" : "incoming_invoice";
}

type DocumentUseCaseDeps = {
  repos: Repositories;
  uow: UnitOfWork;
  objectStorage: ObjectStorage;
  billing: BillingUseCases;
  contacts: ContactUseCases;
  ocrEngine: OcrEngine;
  analyzer: DocumentAnalyzer;
  /** F1b (decisions/0020-universal-intake.md): the universal intake recognizer's own port -
   * classifies OCR text (kind) and an unrecognized tabular source's sample (kind + column
   * mapping proposal). */
  intakeClassifier: IntakeClassifier;
  now?: () => Date;
  generateId?: () => string;
};

/**
 * The OCR/PDF branch (`decideIntakeBranch`'s `"ocr"`): OCR, guided extraction, a searchable
 * PDF, direction, invoice fields, contact linking, and payment matching
 * (decisions/0016-processing-pipeline-and-ai.md,
 * decisions/0021-extraction-direction-and-invoice-fields.md, F1b's `documents.kind`).
 *
 * Rewired by wave 2 of decisions/0036-guided-extraction.md (H-contract.md, H2-wave2.md): `kind`
 * is now classified BEFORE the analyzer ever runs (a self-identified ZUGFeRD invoice resolves
 * its own kind from the XML's seller/buyer names via `resolveZugferdKind`, never needing a
 * model call; every other document asks `IntakeClassifier` on the OCR text, exactly as before,
 * just moved earlier), `planCounterparty(kind)` derives the workspace's own role from `kind` in
 * code, and `deps.analyzer.analyzeGuided` asks the model exactly one narrow, kind-specific
 * question instead of "list every company on this document". Direction and the parties to link
 * both come from `plan.mode` now: a `"derived"` kind's direction is `plan.ourRole` directly
 * (guarded by `isCounterpartySelf`, see below), an `"open"` kind's direction still goes through
 * `decideDirection`'s own kind/party-role priority order (decisions/0031/0032, now fed by the
 * guided analyzer's smaller `parties` array instead of the old ungated one), and a `"none"` kind
 * (a scanned bank statement) has no counterparty concept at all. Every extracted party is
 * written via ONE `replaceDocumentLinks` call (H-contract.md section 3, decisions/0035) instead
 * of a per-party `upsertFromExtraction` loop.
 */
async function processOcrDocument(
  deps: DocumentUseCaseDeps,
  input: { workspaceId: string; documentId: string; doc: DocumentWithRelations; pdfBytes: Uint8Array; kindOverride?: DocumentKind },
): Promise<void> {
  const { workspaceId, documentId, doc, pdfBytes, kindOverride } = input;

  const workspace = await deps.repos.workspace.findById(workspaceId);
  if (!workspace) throw new UseCaseError(DOCUMENT_ERROR.notFound);

  // decisions/0020-universal-intake.md's other self-identifying format: read FIRST, before
  // any model call - when present, its fields take priority over the analyzer's own
  // extraction (never the other way around).
  const embeddedXmlBytes = await extractEmbeddedXml(pdfBytes).catch((err: unknown) => {
    console.error("[documents] failed to read a PDF's embedded attachments", { workspaceId, documentId, err });
    return null;
  });
  const zugferd = embeddedXmlBytes ? extractZugferdInvoiceFields(decodeTextBytes(embeddedXmlBytes)) : null;

  const ocrResult = await deps.ocrEngine.recognize({ pdfBytes, fileName: doc.originalFileName });
  const ocrText = joinOcrText(ocrResult.pages);

  const ownCompanyProfile = toOwnCompanyProfile(workspace);
  const ownCompanyContext = toOwnCompanyContext(workspace);

  // Guided extraction (decisions/0036-guided-extraction.md): classify `kind` FIRST, before any
  // guided analyzer call - the whole point of the fix is deriving our own role from the kind
  // in code and asking the model one narrow, kind-specific question, which needs `kind` to
  // already be known.
  // decisions/0072-correcting-a-document-s-kind.md: a human's "Dokumentart ändern" replaces
  // the whole kind decision - no classifier call, no ZUGFeRD seller-name guess.
  const ownIbans = await collectOwnIbans(deps, workspaceId, ownCompanyProfile.ibans);
  let classifiedKind: DocumentKind;
  if (kindOverride) {
    classifiedKind = kindOverride;
  } else if (zugferd) {
    classifiedKind = resolveZugferdKind(zugferd, ownCompanyProfile);
  } else {
    const classification = await deps.intakeClassifier.classify({ kind: "text", text: ocrText, ownCompany: toIntakeOwnCompany(ownCompanyContext, ownIbans) });
    classifiedKind = classification.documentKind;
  }

  const classifiedPlan = planCounterparty(classifiedKind);

  const guided = await deps.analyzer.analyzeGuided({
    text: truncateForAnalysis(ocrText),
    fileName: doc.originalFileName,
    ownCompany: ownCompanyContext,
    kind: classifiedKind,
    plan: classifiedPlan,
  });

  // decisions/0039: our own IBAN as the payment IBAN is a fact that overrules the classifier. An
  // invoice we have to pay carries the supplier's IBAN, never ours, so an "incoming_invoice"
  // asking for payment to one of our accounts is our own outgoing invoice (observed: invoice 35,
  // classified incoming once, which sent payment matching looking for a debit). Our accounts are
  // the profile's IBANs plus every bank account imported from our statements. The counterparty the
  // model returned is the non-us party either way; only its role flips.
  // decisions/0040: the payment IBAN is verified against the OCR text (checksum, presence, repair
  // of a mis-copy), never stored as the model typed it. ZUGFeRD's XML field is structured data.
  const paymentIban = zugferd?.paymentIban ? normalizeIban(zugferd.paymentIban) : resolvePaymentIban(guided.invoice?.paymentIban, ocrText, ownIbans);
  const paysToOwnAccount = paymentIban !== null && ownIbans.has(paymentIban);
  // decisions/0043, the mirror rule: our own outgoing invoices ask for payment to one of our
  // accounts, so an "outgoing_invoice" whose verified payment IBAN is someone else's is a supplier's
  // invoice to us. Only once at least one own account is known, and only for a checksum-verified
  // IBAN taken from the OCR text (decisions/0040).
  const paysToForeignAccount = paymentIban !== null && ownIbans.size > 0 && !ownIbans.has(paymentIban);
  // decisions/0072: a kind a human chose is never flipped by this heuristic - it exists to
  // catch the classifier's mistakes, and the human just corrected exactly that.
  const kind = kindOverride ? kindOverride : correctInvoiceKind(classifiedKind, paysToOwnAccount, paysToForeignAccount);
  const plan = kind === classifiedKind ? classifiedPlan : planCounterparty(kind);
  if (kind !== classifiedKind) {
    console.info("[documents] payment IBAN is our own account - corrected the classified kind", { workspaceId, documentId, classifiedKind, kind });
  }

  const searchablePdfBytes = await buildSearchablePdf(pdfBytes, ocrResult.pages);
  const searchablePdfKey = documentSearchableKey({ workspaceId, documentId });
  await deps.objectStorage.putObject({ key: searchablePdfKey, body: searchablePdfBytes, contentType: "application/pdf" });

  // Direction and the parties to link both come from `plan.mode` - never from a per-party role
  // hint the model was never even asked for in `"derived"` mode (H-contract.md section 2).
  let direction: DocumentDirection;
  let linkParties: ReplaceDocumentLinksParty[] = [];
  let selfCounterpartySuspected = false;

  if (plan.mode === "derived") {
    if (guided.counterparty && isCounterpartySelf(guided.counterparty, ownCompanyProfile)) {
      // The self-counterparty guard (H2-wave2.md, promised to the owner): the extracted
      // counterparty resolves to the workspace's OWN company after stripping any of our own
      // identifiers the model may have mis-attributed to it. That means the classified `kind`
      // was probably wrong (e.g. an incoming invoice misread as outgoing), not the
      // counterparty extraction - trusting `plan.ourRole` here would silently invert a real
      // business relationship. Direction becomes `"unknown"` (so `payment_status` stays
      // `not_applicable` and nothing enters matching with a possibly inverted direction),
      // nothing is linked, and `kind` is left as classified - a human can still correct it
      // with "Dokumentart ändern" (decisions/0072), and `ui/document-detail-client.tsx`'s unclear-direction hint
      // (`isDerivedCounterpartyKind`) makes the situation visible on the detail page too.
      direction = "unknown";
      selfCounterpartySuspected = true;
      console.warn("[documents] guided counterparty resolved to the workspace's own company - kind may be misclassified", {
        workspaceId,
        documentId,
        kind,
      });
    } else {
      direction = plan.ourRole === "sender" ? "outgoing" : "incoming";
      if (guided.counterparty) {
        linkParties = [{ role: plan.counterpartyRole, relationType: plan.relationType, extracted: guided.counterparty }];
      }
    }
  } else if (plan.mode === "open") {
    // decisions/0031/0032: `kind` still outranks the model's own party-role hints for every
    // kind that keeps an open question (a reminder, a letter, a contract, an authority letter
    // that resolved to `"open"` some other way) - unchanged logic, just fed the guided
    // analyzer's own (smaller, bank/payment-provider-excluded) `parties` array instead of the
    // old ungated `analyze()` call's. A reminder is the one kind whose direction is asked of
    // the model directly instead (H-contract.md section 5): `resolveReminderDirection`
    // overrules the model's own answer whenever the document's own payment IBAN settles it.
    direction =
      kind === "reminder"
        ? resolveReminderDirection({
            modelDirection: guided.reminderDirection,
            paymentIban,
            ownIbans: [...ownIbans],
          })
        : decideDirection(guided.parties, ownCompanyProfile, kind, ocrText);

    const others = nonOwnParties(guided.parties, ownCompanyProfile);
    const resolved = resolveLinkRoles(others, direction);
    linkParties = resolved.map(({ party, role }) => ({ role, relationType: null, extracted: party }));
  } else {
    // mode "none" (a scanned bank statement, H-contract.md section 2): no counterparty concept
    // at all - never asked for one, never links anything, direction stays "unknown".
    direction = "unknown";
  }

  // ZUGFeRD's own invoice fields take priority over the model's, field by field (never a
  // wholesale replacement - the model may still have found something ZUGFeRD's minimal reader
  // does not extract, e.g. a payment reference/note).
  const modelInvoice = guided.invoice ? { ...guided.invoice, paymentIban } : null;
  const invoice = zugferd
    ? {
        invoiceNumber: zugferd.invoiceNumber ?? guided.invoice?.invoiceNumber ?? null,
        totalAmountCents: zugferd.totalAmountCents ?? guided.invoice?.totalAmountCents ?? null,
        currency: zugferd.currency ?? guided.invoice?.currency ?? null,
        dueDate: zugferd.dueDate ?? guided.invoice?.dueDate ?? null,
        paymentIban,
        paymentReference: guided.invoice?.paymentReference ?? null,
        paidNote: guided.invoice?.paidNote ?? null,
      }
    : modelInvoice;

  // F3b (decisions/0025-payment-matching-wiring.md): `open` for an invoice-shaped document (a
  // direction was decided AND an amount was extracted), `not_applicable` for everything else
  // (a plain letter, a document whose direction stayed `unknown`, an invoice the model found
  // no amount for) - computed here, once, rather than by the repository
  // (WEBAPP_TEMPLATE_SPEC.md §5.3: no business logic in a repository). Three kinds are never
  // payment-matched, whatever direction/amount were found (decisions/0036's "Payment status"):
  // a reminder repeats a receivable its original invoice already tracks, so counting it would
  // double it; a platform settlement or payout report describes money flowing TO the workspace
  // and is reconciled by the settlement flow (decisions/0026), while an `incoming` document is
  // matched against debits (`src/modules/payments/core/direction.ts`), which would pair it
  // with an unrelated outgoing payment.
  const isInvoiceShaped = !NEVER_PAYMENT_MATCHED_KINDS.has(kind) && direction !== "unknown" && (invoice?.totalAmountCents ?? null) !== null;
  const paymentStatus = isInvoiceShaped ? PAYMENT_STATUSES.open : PAYMENT_STATUSES.notApplicable;

  await deps.uow.transaction(async (repos) => {
    await repos.document.markDone(workspaceId, documentId, {
      ocrText,
      ocrBlocks: ocrResult.pages.map((page) => ({ index: page.index, blocks: page.blocks })),
      title: guided.title,
      sender: guided.sender,
      documentDate: guided.documentDate,
      summary: guided.summary,
      searchablePdfKey,
      direction,
      invoiceNumber: invoice?.invoiceNumber ?? null,
      totalAmountCents: invoice?.totalAmountCents ?? null,
      currency: invoice?.currency ?? null,
      dueDate: invoice?.dueDate ?? null,
      paymentIban: invoice?.paymentIban ?? null,
      paymentReference: invoice?.paymentReference ?? null,
      paidNote: invoice?.paidNote ?? null,
      kind,
      paymentStatus,
    });

    // F3b: "after every document reaches `done` with invoice fields (C2)" - only when this
    // document actually has something to match (skips a plain letter, a reminder, ...).
    // `runMatching` re-evaluates the WHOLE workspace, not only this one document, so it also
    // picks up any transaction that was waiting on exactly this invoice.
    // decisions/0041: debounced, so a bulk upload of hundreds of receipts runs matching once,
    // shortly after the last document, instead of once per document (each run asks the AI
    // arbiter about every open transaction).
    if (isInvoiceShaped) {
      const scheduledAt = (deps.now ?? (() => new Date()))();
      await repos.jobs.scheduleDebounced({
        kind: JOB_KINDS.matchPayments,
        workspaceId,
        payload: { workspaceId, trigger: "document_done" } satisfies MatchPaymentsInput,
        runAt: new Date(scheduledAt.getTime() + MATCHING_DEBOUNCE_MS),
        now: scheduledAt,
      });
    }
  });

  // H-contract.md section 3 (decisions/0035): ONE `replaceDocumentLinks` call replaces every
  // existing link for this document with exactly `linkParties` - a reprocessing run therefore
  // produces exactly the links of its own run, never a pile-up of an earlier run's
  // contradictory sender+recipient guesses. Called even with an EMPTY `linkParties` (mode
  // `"none"`, or a suspected self-counterparty): `replaceDocumentLinks` still needs to run in
  // that case, to clear out whatever an earlier, different-`kind` run may have linked. Run
  // AFTER `markDone`'s own transaction commits (its own transaction, H3's own concurrency-safe
  // design): a contact-linking failure is logged and skipped rather than failing an otherwise-
  // successful OCR/analysis run.
  let linkResult = { linked: 0, created: 0, proposalsCreated: 0, skippedOwnCompany: 0, skippedBank: 0 };
  try {
    linkResult = await deps.contacts.replaceDocumentLinks({
      workspaceId,
      documentId,
      ownCompany: ownCompanyProfile,
      ownIbans: ownCompanyProfile.ibans,
      parties: linkParties,
    });
  } catch (linkErr) {
    console.error("[documents] failed to replace document contact links", { workspaceId, documentId, linkErr });
  }

  console.info("[documents] processed document", {
    workspaceId,
    documentId,
    direction,
    kind,
    planMode: plan.mode,
    zugferdDetected: zugferd !== null,
    kindOverridden: kindOverride !== undefined,
    selfCounterpartySuspected,
    ...linkResult,
  });
}

/** F2 (decisions/0024-accounts-and-transactions.md) + F4 (decisions/0026-platform-settlements.md):
 * every confirmed `documentKind` `AccountsUseCases.importFromDocument` knows how to import -
 * a bank statement into a `bank` account, a payout/settlement report into its platform's
 * `clearing` account. Kept as one small predicate rather than inlining the three-way OR at
 * each of this file's three enqueue points. */
function isAccountsImportableKind(documentKind: DocumentKind): boolean {
  return documentKind === "bank_statement" || documentKind === "payout_report" || documentKind === "platform_settlement";
}

/** The camt.053 branch (`decideIntakeBranch`'s `"camt053"`): deterministic parse, no model
 * call, always `intakeStatus: "confirmed"` (decisions/0020-universal-intake.md, decision 1 -
 * a format that identifies itself unambiguously is never gated by human confirmation). */
async function processCamt053Document(
  deps: DocumentUseCaseDeps,
  input: { workspaceId: string; documentId: string; bytes: Uint8Array },
): Promise<void> {
  const { workspaceId, documentId, bytes } = input;
  const text = decodeTextBytes(bytes);

  const detection = detectCamt053(text);
  if (!detection) {
    // The upload route only ever stores an XML file it already confirmed was camt.053
    // (`processIntakeUpload`) - reaching here means the stored bytes no longer match what was
    // validated at upload time, a data-integrity problem worth surfacing loudly rather than
    // silently guessing at another format.
    throw new PermanentJobError("unrecognized_xml_format");
  }

  const parseResult = parseCamt053(text);
  const transactions = parseResult.statements.flatMap((statement) => statement.transactions);
  const allStatementsReconcile = parseResult.statements.every((statement) => camt053StatementReconciles(statement));
  const intakeResult = buildBankStatementIntakeResult({ statementCount: parseResult.statements.length, allStatementsReconcile, transactions });

  await deps.repos.document.markIntakeResult(workspaceId, documentId, { kind: "bank_statement", platform: null, intakeStatus: "confirmed", intakeResult });

  // F2 (decisions/0024-accounts-and-transactions.md): a camt.053 statement is always
  // self-identifying and therefore always `confirmed` (decisions/0020, decision 1) - the
  // import into `src/modules/accounts` is triggered right here, every time.
  await deps.repos.jobs.enqueue({
    kind: JOB_KINDS.importAccountTransactions,
    workspaceId,
    payload: { workspaceId, documentId } satisfies ImportAccountTransactionsInput,
  });

  console.info("[documents] processed camt.053 statement", {
    workspaceId,
    documentId,
    statementCount: parseResult.statements.length,
    transactionCount: transactions.length,
    allStatementsReconcile,
  });
}

/** The MT940 branch (`decideIntakeBranch`'s `"mt940"`): deterministic parse, no model call,
 * always `intakeStatus: "confirmed"`, treated exactly like the camt.053 branch above
 * (decisions/0028-mt940-support.md) - `Mt940Statement` is the same shape as `Camt053Statement`,
 * so `buildBankStatementIntakeResult` and the accounts-import hook work unmodified. */
async function processMt940Document(
  deps: DocumentUseCaseDeps,
  input: { workspaceId: string; documentId: string; bytes: Uint8Array },
): Promise<void> {
  const { workspaceId, documentId, bytes } = input;
  const text = decodeTextBytes(bytes);

  let parseResult;
  try {
    parseResult = parseMt940(text);
  } catch (err) {
    if (err instanceof Mt940ParseError) {
      // The upload route only ever stores an MT940 file it already fully parsed within its
      // own hard limits (`processIntakeUpload`) - reaching either of these here means the
      // stored bytes no longer match what was validated at upload time, a data-integrity
      // problem worth surfacing loudly rather than silently guessing at another format.
      throw new PermanentJobError(err.code === "not_mt940" ? "unrecognized_mt940_format" : "mt940_too_large");
    }
    throw err;
  }

  const transactions = parseResult.statements.flatMap((statement) => statement.transactions);
  const allStatementsReconcile = parseResult.statements.every((statement) => mt940StatementReconciles(statement));
  const intakeResult = buildBankStatementIntakeResult({ statementCount: parseResult.statements.length, allStatementsReconcile, transactions });

  await deps.repos.document.markIntakeResult(workspaceId, documentId, { kind: "bank_statement", platform: null, intakeStatus: "confirmed", intakeResult });

  // F2 (decisions/0024-accounts-and-transactions.md): an MT940 statement is always
  // self-identifying and therefore always `confirmed` (decisions/0020, decision 1, extended by
  // decisions/0028-mt940-support.md) - the import into `src/modules/accounts` is triggered
  // right here, every time, exactly like the camt.053 branch.
  await deps.repos.jobs.enqueue({
    kind: JOB_KINDS.importAccountTransactions,
    workspaceId,
    payload: { workspaceId, documentId } satisfies ImportAccountTransactionsInput,
  });

  console.info("[documents] processed MT940 statement", {
    workspaceId,
    documentId,
    statementCount: parseResult.statements.length,
    transactionCount: transactions.length,
    allStatementsReconcile,
  });
}

/** The Apple payment-summary branch (`decideIntakeBranch`'s `"apple_payment_summary"`,
 * decisions/0048-app-store-reports.md): deterministic parse, no model call, always
 * `intakeStatus: "confirmed"`, `kind: "payout_report"` - the report itself states a payout, the
 * same shape decisions/0026's Stripe fixture already models this kind on. */
async function processApplePaymentSummaryDocument(
  deps: DocumentUseCaseDeps,
  input: { workspaceId: string; documentId: string; text: string },
): Promise<void> {
  const { workspaceId, documentId, text } = input;

  let parsed: ReturnType<typeof parseApplePaymentSummary>;
  try {
    parsed = parseApplePaymentSummary(text);
  } catch (err) {
    if (err instanceof ApplePaymentSummaryParseError) {
      // Detection already ran on these exact bytes before this branch was chosen
      // (`processTabularDocument`) - reaching either error here means the stored bytes no
      // longer match what was recognized, a data-integrity problem worth surfacing loudly
      // rather than silently guessing at another format (mirrors `processCamt053Document`'s
      // own reasoning for its own `PermanentJobError`).
      throw new PermanentJobError(err.code === APPLE_PAYMENT_SUMMARY_ERROR.noDataRows ? "apple_payment_summary_no_rows" : "unrecognized_apple_payment_summary");
    }
    throw err;
  }

  const intakeResult: IntakeResult = buildTabularConfirmedIntakeResult({
    documentKind: "payout_report",
    platform: "apple",
    rows: parsed.lines,
    appStorePayout: { platform: "apple", period: parsed.period, payoutAmountCents: parsed.payoutAmountCents, payoutCurrency: parsed.payoutCurrency },
  });

  await deps.repos.document.markIntakeResult(workspaceId, documentId, { kind: "payout_report", platform: "apple", intakeStatus: "confirmed", intakeResult });

  // F4 (decisions/0026-platform-settlements.md): a payout/settlement report always imports
  // into its platform's clearing account, the same job kind every settlement-shaped kind uses.
  await deps.repos.jobs.enqueue({
    kind: JOB_KINDS.importAccountTransactions,
    workspaceId,
    payload: { workspaceId, documentId } satisfies ImportAccountTransactionsInput,
  });

  console.info("[documents] processed Apple payment summary", {
    workspaceId,
    documentId,
    period: parsed.period,
    lineCount: parsed.lines.length,
    payoutAmountCents: parsed.payoutAmountCents,
  });
}

/** The Google Play earnings branch (`decideIntakeBranch`'s `"google_play_earnings"`,
 * decisions/0048-app-store-reports.md): deterministic parse, no model call, always
 * `intakeStatus: "confirmed"`, `kind: "platform_settlement"` - the report is the platform's own
 * earnings statement (charges/fees/refunds), never a payout total on its own. */
async function processGooglePlayEarningsDocument(
  deps: DocumentUseCaseDeps,
  input: { workspaceId: string; documentId: string; text: string },
): Promise<void> {
  const { workspaceId, documentId, text } = input;

  let parsed: ReturnType<typeof parseGooglePlayEarnings>;
  try {
    parsed = parseGooglePlayEarnings(text);
  } catch (err) {
    if (err instanceof GooglePlayEarningsParseError) {
      const codeByError: Record<string, string> = {
        [GOOGLE_PLAY_EARNINGS_ERROR.unparseableRow]: "google_play_earnings_unparseable_row",
        [GOOGLE_PLAY_EARNINGS_ERROR.noDataRows]: "google_play_earnings_no_rows",
        [GOOGLE_PLAY_EARNINGS_ERROR.notRecognized]: "unrecognized_google_play_earnings",
      };
      throw new PermanentJobError(codeByError[err.code] ?? "unrecognized_google_play_earnings");
    }
    throw err;
  }

  const intakeResult: IntakeResult = buildTabularConfirmedIntakeResult({
    documentKind: "platform_settlement",
    platform: "google",
    rows: parsed.lines,
    appStorePayout: { platform: "google", period: parsed.period, payoutAmountCents: parsed.netAmountCents, payoutCurrency: parsed.merchantCurrency },
  });

  await deps.repos.document.markIntakeResult(workspaceId, documentId, { kind: "platform_settlement", platform: "google", intakeStatus: "confirmed", intakeResult });

  await deps.repos.jobs.enqueue({
    kind: JOB_KINDS.importAccountTransactions,
    workspaceId,
    payload: { workspaceId, documentId } satisfies ImportAccountTransactionsInput,
  });

  console.info("[documents] processed Google Play earnings report", {
    workspaceId,
    documentId,
    period: parsed.period,
    lineCount: parsed.lines.length,
    netAmountCents: parsed.netAmountCents,
  });
}

/** Builds and persists the `pending_confirmation` proposal for a tabular source with no
 * confirmed fingerprint yet (`decideIntakeBranch`'s `"tabular_unknown_source"`, also the
 * fallback when a previously-confirmed mapping stops validating - see
 * `processTabularDocument`'s own comment for why). Asks the classifier once, then validates
 * its (column-existence-checked) proposal against every row before storing the proposal - a
 * failing validation is still stored (and still `pending_confirmation`, never silently
 * dropped): the confirmation UI shows the problems either way, per
 * decisions/0020-universal-intake.md's decision 4. */
async function proposeTabularIntake(
  deps: DocumentUseCaseDeps,
  input: { workspaceId: string; documentId: string; sample: ReturnType<typeof sampleTabular>; fullRows: string[][] },
): Promise<void> {
  const { workspaceId, documentId, sample, fullRows } = input;

  const classification = await deps.intakeClassifier.classify({ kind: "tabular", sample });
  const mapping = classification.columnMapping ?? {};

  const validation =
    classification.columnMapping === null
      ? ({
          ok: false as const,
          problems: [
            {
              rowNumber: 0,
              field: "totals" as const,
              code: "missing_required_column" as const,
              message: "Das Modell konnte keine Spaltenzuordnung vorschlagen.",
            },
          ],
        })
      : validateMapping(sample, fullRows, mapping, classification.amountSign);

  const intakeResult: TabularProposalIntakeResult = {
    type: "tabular_proposal",
    documentKind: classification.documentKind,
    platform: classification.platform,
    reason: classification.reason,
    columnMapping: mapping,
    amountSign: classification.amountSign,
    sampleHeader: sample.header,
    sampleRows: sample.rows,
    rowCount: sample.rowCount,
    validation: validation.ok ? { ok: true } : { ok: false, problems: validation.problems },
  };

  await deps.repos.document.markIntakeResult(workspaceId, documentId, {
    kind: classification.documentKind,
    platform: classification.platform,
    intakeStatus: "pending_confirmation",
    intakeResult,
  });
}

/** The tabular branch (CSV/TSV, `decideIntakeBranch`'s `"apple_payment_summary"`/
 * `"google_play_earnings"`/`"tabular_known_source"`/`"tabular_unknown_source"`): a recognized
 * app-store report is parsed deterministically first, ahead of the generic AI-mapping path
 * (decisions/0048-app-store-reports.md); a known fingerprint applies its stored mapping without
 * a model call; anything else goes through `proposeTabularIntake`. */
async function processTabularDocument(
  deps: DocumentUseCaseDeps,
  input: { workspaceId: string; documentId: string; doc: DocumentWithRelations; bytes: Uint8Array },
): Promise<void> {
  const { workspaceId, documentId, doc, bytes } = input;
  const text = decodeTextBytes(bytes);
  const delimiter = doc.mimeType === "text/tab-separated-values" ? ("\t" as const) : undefined;
  const sample = sampleTabular(text, { delimiter });
  const fullRows = parseTabularRows(text, { delimiter: sample.delimiter, quoteChar: sample.quoteChar });

  const isApplePaymentSummary = detectApplePaymentSummary(text);
  const isGooglePlayEarnings = !isApplePaymentSummary && detectGooglePlayEarnings(text);
  const known = await deps.repos.intakeFingerprint.findByFingerprint(workspaceId, sample.fingerprint);
  const branch = decideIntakeBranch({
    mimeType: doc.mimeType,
    isCamt053: false,
    isMt940: false,
    isApplePaymentSummary,
    isGooglePlayEarnings,
    hasKnownFingerprint: known !== null,
  });

  if (branch === "apple_payment_summary") {
    await processApplePaymentSummaryDocument(deps, { workspaceId, documentId, text });
    return;
  }
  if (branch === "google_play_earnings") {
    await processGooglePlayEarningsDocument(deps, { workspaceId, documentId, text });
    return;
  }
  if (branch === "tabular_unknown_source" || !known) {
    await proposeTabularIntake(deps, { workspaceId, documentId, sample, fullRows });
    return;
  }

  const mapping = known.columnMapping as ColumnMapping;
  const amountSign = known.amountSign as AmountSign | null;
  const validated = validateMapping(sample, fullRows, mapping, amountSign);

  if (!validated.ok) {
    // The confirmed source's layout silently changed since it was last confirmed (a judgment
    // call, decisions/0022-intake-wiring.md): rather than silently importing data that no
    // longer validates, or failing the whole document, this is treated exactly like a
    // brand-new, never-seen source - a fresh proposal for a human to review again. The stale
    // fingerprint itself is left alone; a human reconfirming it (or resetting it from
    // `/dashboard/settings/intake`) is what fixes it going forward.
    await proposeTabularIntake(deps, { workspaceId, documentId, sample, fullRows });
    return;
  }

  const rows = validated.kind === "bank_transactions" ? validated.transactions : validated.lines;
  const knownPlatform = known.platform as SettlementPlatform | null;
  const intakeResult = buildTabularConfirmedIntakeResult({ documentKind: known.documentKind as DocumentKind, platform: knownPlatform, rows });

  await deps.repos.document.markIntakeResult(workspaceId, documentId, {
    kind: known.documentKind as DocumentKind,
    platform: knownPlatform,
    intakeStatus: "confirmed",
    intakeResult,
  });
  await deps.repos.intakeFingerprint.touchUsage(known.id);

  // F2 (decisions/0024-accounts-and-transactions.md), extended by F4
  // (decisions/0026-platform-settlements.md): a bank-statement-shaped confirmed mapping
  // triggers the accounts import into a bank account; a settlement/payout report
  // (`payout_report`/`platform_settlement`) triggers the SAME job kind, which
  // `AccountsUseCases.importFromDocument` branches on internally by the document's own
  // `kind` - kept as one job kind rather than two so this file (and the composition root's
  // job-handler map) never needs to know F4 exists.
  if (isAccountsImportableKind(known.documentKind)) {
    await deps.repos.jobs.enqueue({
      kind: JOB_KINDS.importAccountTransactions,
      workspaceId,
      payload: { workspaceId, documentId } satisfies ImportAccountTransactionsInput,
    });
  }
}

export function createDocumentUseCases(deps: DocumentUseCaseDeps): DocumentUseCases {
  const now = deps.now ?? (() => new Date());
  const generateId = deps.generateId ?? (() => crypto.randomUUID());

  return {
    async createFromUpload({ workspaceId, uploadedByUserId, originalFileName, bytes, mimeType, extension, pageCount, fileHash }) {
      const workspace = await deps.repos.workspace.findById(workspaceId);
      if (!workspace) throw new UseCaseError(DOCUMENT_ERROR.notFound);

      // F1b's exact-duplicate check (decisions/0020-universal-intake.md's "Content-level
      // duplicate detection"): runs BEFORE the quota pre-check and BEFORE any storage write -
      // a repeat upload of the exact same bytes must never count against the quota or ever
      // touch storage a second time.
      const duplicate = await deps.repos.document.findByFileHash(workspaceId, fileHash);
      if (duplicate) throw new DuplicateDocumentError(duplicate.id);

      // Pre-check (non-transactional): fail fast, before any storage write, for the common
      // case of a workspace that is simply over its limit. Not authoritative on its own -
      // the transaction below re-checks with the workspace row locked.
      const preStored = await deps.repos.document.countByWorkspace(workspaceId);
      const preUsage = await deps.billing.getUsage(workspaceId, now());
      const preCheck = evaluateQuota({
        tier: workspace.tier as Tier,
        storedDocuments: preStored,
        createdThisMonth: preUsage.createdThisMonth,
        extraMonthlyQuota: preUsage.extraMonthlyQuota,
        adding: 1,
      });
      if (!preCheck.allowed) throw new UseCaseError(preCheck.code);

      const documentId = generateId();
      const storageKey = documentOriginalKey({ workspaceId, documentId, extension });
      await deps.objectStorage.putObject({ key: storageKey, body: bytes, contentType: mimeType });

      try {
        const created = await deps.uow.transaction(async (repos) => {
          const lockedWorkspace = await repos.workspace.lockForUpdate(workspaceId);
          if (!lockedWorkspace) throw new UseCaseError(DOCUMENT_ERROR.notFound);

          // Re-checked with the workspace row locked (the authoritative check), but the
          // duplicate check itself is NOT re-run here: `fileHash` has a workspace-scoped
          // index but no unique constraint (a document may legitimately have `fileHash: null`
          // for a pre-F1b row), so the tiny race window between the pre-check above and this
          // transaction (two uploads of the identical file landing at nearly the same instant)
          // is accepted as a rare, low-impact edge case - the same trade-off this codebase
          // already makes for weak contact-matching races (decisions/0019-contacts.md).
          const stored = await repos.document.countByWorkspace(workspaceId);
          const period = periodKeyFor(now());
          const usage = await deps.billing.getUsage(workspaceId, now(), repos);
          const check = evaluateQuota({
            tier: lockedWorkspace.tier as Tier,
            storedDocuments: stored,
            createdThisMonth: usage.createdThisMonth,
            extraMonthlyQuota: usage.extraMonthlyQuota,
            adding: 1,
          });
          if (!check.allowed) throw new UseCaseError(check.code);

          const row = await repos.document.create({
            id: documentId,
            workspaceId,
            uploadedByUserId,
            originalFileName,
            mimeType,
            pageCount,
            sizeBytes: bytes.byteLength,
            storageKey,
            fileHash,
          });

          await deps.billing.recordDocumentsCreated(repos, {
            workspaceId,
            period,
            count: 1,
            totalRatio: check.totalRatio,
            monthlyRatio: check.monthlyRatio,
          });

          // Enqueued in the SAME transaction as the document insert
          // (decisions/0016-processing-pipeline-and-ai.md): the job only ever exists once
          // the row it processes has actually committed.
          await repos.jobs.enqueue({
            kind: JOB_KINDS.processDocument,
            workspaceId,
            payload: { workspaceId, documentId } satisfies ProcessDocumentInput,
          });

          return row;
        });

        return toDocument(await mustFindWithRelations(deps.repos, workspaceId, created.id));
      } catch (err) {
        // Compensation: the object is already in storage; whatever failed inside the
        // transaction, it must not stay orphaned there with no matching row.
        await deps.objectStorage.deleteObject(storageKey).catch((cleanupErr: unknown) => {
          console.error("[documents] failed to delete orphaned object after a failed upload transaction", cleanupErr);
        });
        throw err;
      }
    },

    async list(workspaceId, filter) {
      const result = await deps.repos.document.list(workspaceId, filter);
      return {
        items: result.items.map((row) => ({ ...toDocument(row), counterpartyName: row.counterpartyName, reportPeriod: row.reportPeriod, statementLastBooking: row.statementLastBooking })),
        hasMore: result.hasMore,
      };
    },

    async getById(workspaceId, id) {
      const row = await deps.repos.document.findById(workspaceId, id);
      return row ? toDocument(row) : null;
    },

    async countStored(workspaceId) {
      return deps.repos.document.countByWorkspace(workspaceId);
    },

    async countPendingIntakeConfirmation(workspaceId) {
      return deps.repos.document.countPendingIntakeConfirmation(workspaceId);
    },

    async countFailed(workspaceId) {
      return deps.repos.document.countFailed(workspaceId);
    },

    async countOverduePayments(workspaceId) {
      return deps.repos.document.countOverduePayments(workspaceId);
    },

    async getFileForDownload(workspaceId, id) {
      const row = await deps.repos.document.findById(workspaceId, id);
      if (!row) return null;
      const key = row.searchablePdfKey ?? row.storageKey;
      const bytes = await deps.objectStorage.getObject(key);
      return { bytes, fileName: row.originalFileName };
    },

    async getLinkedContacts(workspaceId, documentId) {
      const doc = await deps.repos.document.findById(workspaceId, documentId);
      if (!doc) return [];

      const links = await deps.repos.documentContact.listForDocument(workspaceId, documentId);
      const contacts = await Promise.all(links.map((link) => deps.repos.contact.findById(workspaceId, link.contactId)));

      return links.map((link, index) => ({
        contactId: link.contactId,
        name: link.contactName,
        role: link.role as DocumentContactRole,
        verified: Boolean(contacts[index]?.verifiedAt),
      }));
    },

    async getPossibleDuplicateInvoice(workspaceId, documentId) {
      const doc = await deps.repos.document.findById(workspaceId, documentId);
      if (!doc || !doc.invoiceNumber) return null;

      const candidates = await deps.repos.document.findByInvoiceNumber(workspaceId, doc.invoiceNumber, documentId);
      const match = findSemanticDuplicate(
        { id: doc.id, invoiceNumber: doc.invoiceNumber, sender: doc.sender, totalAmountCents: doc.totalAmountCents },
        candidates.map((c) => ({ id: c.id, invoiceNumber: doc.invoiceNumber, sender: c.sender, totalAmountCents: c.totalAmountCents })),
      );
      if (!match) return null;

      const matchedCandidate = candidates.find((c) => c.id === match.id);
      return matchedCandidate ? { id: matchedCandidate.id, originalFileName: matchedCandidate.originalFileName } : null;
    },

    async deleteDocument({ workspaceId, documentId }) {
      const row: DocumentRow | null = await deps.repos.document.deleteById(workspaceId, documentId);
      if (!row) throw new UseCaseError(DOCUMENT_ERROR.notFound);

      const keys = [row.storageKey, row.searchablePdfKey].filter((key): key is string => key !== null);
      await Promise.all(
        keys.map((key) =>
          deps.objectStorage.deleteObject(key).catch((err: unknown) => {
            console.error(`[documents] failed to delete storage object ${key} after deleting its document row`, err);
          }),
        ),
      );
    },

    async enqueuePurgeForRejectedIntake() {
      const cutoff = new Date(now().getTime() - RETENTION_DAYS_REJECTED_INTAKE * 24 * 60 * 60 * 1000);
      const eligible = await deps.repos.document.listIntakeRejectedBefore(cutoff);

      for (const doc of eligible) {
        await deps.repos.jobs.enqueue({
          kind: JOB_KINDS.purgeRejectedIntake,
          workspaceId: doc.workspaceId,
          payload: { workspaceId: doc.workspaceId, documentId: doc.id } satisfies PurgeRejectedIntakeInput,
        });
      }

      return { enqueued: eligible.length };
    },

    async processDocument({ workspaceId, documentId, kindOverride }) {
      const doc = await deps.repos.document.findById(workspaceId, documentId);
      if (!doc) return; // deleted while the job was pending: nothing left to process.

      await deps.repos.document.markProcessing(workspaceId, documentId);

      try {
        const bytes = await deps.objectStorage.getObject(doc.storageKey);

        if (doc.mimeType === "application/pdf") {
          // decisions/0072: the kind a human chose is stored on the document, so every later run
          // (a retry, "Erneut verarbeiten") keeps it, not only the job the correction enqueued.
          const forcedKind = kindOverride ?? doc.manualKind ?? undefined;
          await processOcrDocument(deps, { workspaceId, documentId, doc, pdfBytes: bytes, kindOverride: forcedKind });
        } else if (doc.mimeType === "application/xml") {
          await processCamt053Document(deps, { workspaceId, documentId, bytes });
        } else if (doc.mimeType === MT940_MIME_TYPE) {
          await processMt940Document(deps, { workspaceId, documentId, bytes });
        } else {
          // text/csv or text/tab-separated-values (the only other `mimeType`s
          // `processIntakeUpload` ever stores) - decidesIntakeBranch's "tabular_*" arm.
          await processTabularDocument(deps, { workspaceId, documentId, doc, bytes });
        }
      } catch (err) {
        const classified = classifyProcessingError(err);
        await deps.repos.document.markFailed(workspaceId, documentId, classified.code);
        throw classified.jobError;
      }
    },

    async confirmIntake({ workspaceId, documentId, actingUserId, documentKind, platform, mapping, amountSign }) {
      const doc = await deps.repos.document.findById(workspaceId, documentId);
      if (!doc) throw new UseCaseError(DOCUMENT_ERROR.notFound);
      if (doc.intakeStatus !== "pending_confirmation") throw new UseCaseError(DOCUMENT_ERROR.intakeNotPending);

      const bytes = await deps.objectStorage.getObject(doc.storageKey);
      const text = decodeTextBytes(bytes);
      const delimiter = doc.mimeType === "text/tab-separated-values" ? ("\t" as const) : undefined;
      const sample = sampleTabular(text, { delimiter });
      const fullRows = parseTabularRows(text, { delimiter: sample.delimiter, quoteChar: sample.quoteChar });

      const validated = validateMapping(sample, fullRows, mapping, amountSign);
      if (!validated.ok) throw new MappingValidationError(validated.problems);

      const rows = validated.kind === "bank_transactions" ? validated.transactions : validated.lines;
      const intakeResult: IntakeResult = buildTabularConfirmedIntakeResult({ documentKind, platform, rows });

      await deps.repos.document.confirmIntake(workspaceId, documentId, { kind: documentKind, platform, intakeResult });
      await deps.repos.intakeFingerprint.upsertConfirmed({
        workspaceId,
        fingerprint: sample.fingerprint,
        documentKind,
        platform,
        columnMapping: mapping,
        amountSign,
        confirmedByUserId: actingUserId,
      });

      // F2 (decisions/0024-accounts-and-transactions.md), extended by F4
      // (decisions/0026-platform-settlements.md): "re-runnable from the UI" - a human
      // confirming a tabular proposal as `bank_statement`/`payout_report`/
      // `platform_settlement` triggers the same import the automatic pipeline branches
      // trigger for camt.053/a known fingerprint.
      if (isAccountsImportableKind(documentKind)) {
        await deps.repos.jobs.enqueue({
          kind: JOB_KINDS.importAccountTransactions,
          workspaceId,
          payload: { workspaceId, documentId } satisfies ImportAccountTransactionsInput,
        });
      }

      return toDocument(await mustFindWithRelations(deps.repos, workspaceId, documentId));
    },

    async rejectIntake({ workspaceId, documentId }) {
      const doc = await deps.repos.document.findById(workspaceId, documentId);
      if (!doc) throw new UseCaseError(DOCUMENT_ERROR.notFound);
      if (doc.intakeStatus !== "pending_confirmation") throw new UseCaseError(DOCUMENT_ERROR.intakeNotPending);

      await deps.repos.document.rejectIntake(workspaceId, documentId);
      return toDocument(await mustFindWithRelations(deps.repos, workspaceId, documentId));
    },

    async listIntakeFingerprints(workspaceId) {
      return deps.repos.intakeFingerprint.listForWorkspace(workspaceId);
    },

    async resetIntakeFingerprint(workspaceId, fingerprintId) {
      await deps.repos.intakeFingerprint.remove(workspaceId, fingerprintId);
    },

    async retryProcessing({ workspaceId, documentId }) {
      const doc = await deps.repos.document.findById(workspaceId, documentId);
      if (!doc) throw new UseCaseError(DOCUMENT_ERROR.notFound);
      if (doc.status !== "failed") throw new UseCaseError(DOCUMENT_ERROR.retryNotAllowed);

      await deps.uow.transaction(async (repos) => {
        await repos.document.markProcessing(workspaceId, documentId);
        await repos.jobs.enqueue({
          kind: JOB_KINDS.processDocument,
          workspaceId,
          payload: { workspaceId, documentId } satisfies ProcessDocumentInput,
        });
      });
    },

    async reclassifyDocument({ workspaceId, documentId, kind }) {
      const doc = await deps.repos.document.findById(workspaceId, documentId);
      if (!doc) throw new UseCaseError(DOCUMENT_ERROR.notFound);
      if (doc.mimeType !== "application/pdf" || doc.status !== "done") throw new UseCaseError(DOCUMENT_ERROR.reclassifyNotAllowed);
      if (!isReclassifiableKind(kind)) throw new UseCaseError(DOCUMENT_ERROR.kindNotSelectable);
      if (doc.kind === kind) throw new UseCaseError(DOCUMENT_ERROR.kindUnchanged);
      // `settled` is the one payment status a clearing account writes (decisions/0026's fee
      // invoices, decisions/0068's supplier clearing accounts) - money booked against this
      // document's current kind, with no confirmed link of its own to remove first.
      if (doc.paymentStatus === PAYMENT_STATUSES.settled) throw new UseCaseError(DOCUMENT_ERROR.paymentSettled);

      await deps.uow.transaction(async (repos) => {
        // Read-only use of `src/modules/payments`' table (the "read another owner's repo inside a
        // use case" pattern `collectOwnIbans` uses too), inside the same transaction as the
        // status change: a confirmed allocation means money is booked against this document,
        // and re-extraction would reset `payment_status`/`paid_at` underneath it.
        const links = await repos.documentTransaction.listForDocument(workspaceId, documentId);
        if (links.some((link) => link.status === "confirmed")) throw new UseCaseError(DOCUMENT_ERROR.paymentLinked);

        await repos.document.markProcessingWithManualKind(workspaceId, documentId, kind);
        await repos.jobs.enqueue({
          kind: JOB_KINDS.processDocument,
          workspaceId,
          payload: { workspaceId, documentId, kindOverride: kind } satisfies ProcessDocumentInput,
        });
      });
    },
  };
}
