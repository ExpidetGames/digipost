// Owner: src/modules/documents (decisions/0015-documents-and-quotas.md, architecture brief's
// product decision 2). Only repositories of this owner write to this table (§5.7 "only the
// owner writes").
//
// `documents`: `search_vector` is a Postgres `GENERATED ALWAYS AS (...) STORED` column
// (`customType` + `.generatedAlwaysAs`, drizzle-kit emits the generated-column DDL itself -
// see decisions/0015 for why this needed no custom-SQL fallback), weighted
// `to_tsvector('german', ...)` over title (A), sender (A), original_file_name (B), ocr_text
// (C), backed by a GIN index for `websearch_to_tsquery('german', ...)` search
// (architecture brief). The generated expression references columns by their actual
// (snake_case) database names directly in raw SQL, not through drizzle's column proxy: a
// generated column's expression is emitted verbatim into the migration, and referencing a
// sibling column through `t.title` is not meaningful while the table object is still being
// constructed.
import { check, customType, date, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { DOCUMENT_KINDS, SETTLEMENT_PLATFORMS } from "@/modules/intake";
import { PAYMENT_STATUSES, type PaymentStatus } from "@/modules/payments";

import { user } from "./auth";
import { workspaces } from "./workspaces";

// `PAYMENT_STATUSES` (`@/modules/payments`) is an `as const` OBJECT (like `MATCH_REASON_CODES`),
// not an array like `DOCUMENT_DIRECTIONS`/`DOCUMENT_STATUSES` above - `Object.values` gives
// drizzle's `text({ enum: [...] })` the string-literal array it needs.
const PAYMENT_STATUS_VALUES = Object.values(PAYMENT_STATUSES) as [PaymentStatus, ...PaymentStatus[]];

export const DOCUMENT_STATUSES = ["uploaded", "processing", "done", "failed"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** C2 (decisions/0021-extraction-direction-and-invoice-fields.md): whether a document is
 * addressed TO the workspace's own company (`incoming`), sent BY it (`outgoing`), or the
 * pipeline could not determine either (`unknown`). `null` until processing has run at least
 * once (same lifecycle as `title`/`sender`/... - a freshly `uploaded` document has none of
 * these yet); once `markDone` runs, `direction` is always one of the three values below, never
 * left `null` again. Decided entirely in application code from the extracted parties and the
 * workspace's own company profile via `@/modules/contacts`'s `isOwnCompany` - never trusted
 * from the model directly. */
export const DOCUMENT_DIRECTIONS = ["incoming", "outgoing", "unknown"] as const;
export type DocumentDirection = (typeof DOCUMENT_DIRECTIONS)[number];

/** F1b (decisions/0020-universal-intake.md's "verify-then-confirm-then-fingerprint" flow,
 * wired by decisions/0022-intake-wiring.md): whether a document's own intake result still
 * needs a human decision. `pending_confirmation` - an unrecognized tabular source's proposed
 * kind/mapping is stored in `intakeResult`, awaiting "Bestätigen und importieren"/"Ablehnen".
 * `confirmed` - a self-identifying format (camt.053), a known fingerprint's mapping, or a
 * user's explicit confirmation. `rejected` - the user declined the proposal; nothing was
 * imported. `not_applicable` (the default) - every OCR'd document (a scanned letter, invoice,
 * ...): the "kind" classification for these is informational only, never gated by this
 * fraud-conscious confirmation flow (that only applies to tabular financial imports, see
 * decisions/0020's "Context"). */
export const DOCUMENT_INTAKE_STATUSES = ["pending_confirmation", "confirmed", "rejected", "not_applicable"] as const;
export type DocumentIntakeStatus = (typeof DOCUMENT_INTAKE_STATUSES)[number];

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const documents = pgTable(
  "documents",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    uploadedByUserId: uuid().references(() => user.id, { onDelete: "set null" }),
    originalFileName: text().notNull(),
    // The MIME type of the stored `original.<ext>` object: "application/pdf" for a direct PDF
    // upload or an image upload (always assembled into a PDF before storage,
    // decisions/0015-documents-and-quotas.md, "Upload"); F1b (decisions/0020-universal-intake.md)
    // extends this to "application/xml", "text/csv", "text/tab-separated-values" for a
    // structured file, stored as-is (never assembled/converted) - `processDocument` branches
    // on this column to decide OCR vs. the intake pipeline.
    mimeType: text().notNull(),
    pageCount: integer().notNull(),
    sizeBytes: integer().notNull(),
    storageKey: text().notNull(),
    // F1b: sha256 of the exact uploaded bytes (`@/modules/intake`'s `fileHash`) - `null` for a
    // document created before this column existed. `createFromUpload` rejects an exact repeat
    // upload (same workspace, same hash) with `duplicate_document` before ever writing to
    // storage or counting against the quota (decisions/0020-universal-intake.md's
    // "Content-level duplicate detection", the `fileHash` half).
    fileHash: text(),
    // F1b: the universal intake recognizer's own taxonomy (`@/modules/intake`'s
    // `DOCUMENT_KINDS`), set once processing has classified the document - self-identified
    // deterministically for camt.053/ZUGFeRD, or via `IntakeClassifier` otherwise. Defaults to
    // "letter" (the common case, and the safe default for a document not yet processed).
    kind: text({ enum: DOCUMENT_KINDS }).notNull().default("letter"),
    // decisions/0072-correcting-a-document-s-kind.md: the kind a human chose ("Dokumentart
    // ändern"). Every later processing run of this document uses it instead of the classifier,
    // so a retry can never undo the correction. `null` means the classifier decides.
    manualKind: text({ enum: DOCUMENT_KINDS }),
    // F4 (decisions/0026-platform-settlements.md): only meaningful for `kind`
    // `payout_report`/`platform_settlement` - which platform (Stripe, Apple, ...) this report
    // came from, carried up from `intakeResult.platform` (already stored there since F1a/F1b)
    // as its own column purely for querying/indexing (resolving the platform's clearing
    // account, finding "does this workspace already have a report for this period") without
    // parsing the jsonb column - the same "duplicate onto a top-level column for query
    // convenience" precedent `kind` itself already set for `intakeResult.documentKind`. `null`
    // for every other document (never set for an OCR'd letter/invoice, even one whose sender
    // happens to be a platform).
    platform: text({ enum: SETTLEMENT_PLATFORMS }),
    intakeStatus: text({ enum: DOCUMENT_INTAKE_STATUSES }).notNull().default("not_applicable"),
    // The validated classification and, for a tabular file, the normalized rows/settlement
    // lines (or a compact summary when too large to embed) - the shape F2/F4 will consume.
    // See `decisions/0022-intake-wiring.md` for the exact per-`intakeStatus` payload shape.
    intakeResult: jsonb(),
    searchablePdfKey: text(),
    status: text({ enum: DOCUMENT_STATUSES }).notNull().default("uploaded"),
    errorCode: text(),
    ocrText: text(),
    ocrBlocks: jsonb(),
    title: text(),
    sender: text(),
    documentDate: date({ mode: "string" }),
    summary: text(),
    // C2 (decisions/0021-extraction-direction-and-invoice-fields.md): direction plus the
    // invoice-shaped fields extracted from the SAME analyzer call as
    // title/sender/documentDate/summary above (never a second model call). All
    // nullable: a non-invoice document (or one where the model found nothing invoice-shaped)
    // simply leaves every one of these `null`, same "extraction must never fail on a missing
    // field" rule the existing analysis fields already follow.
    direction: text({ enum: DOCUMENT_DIRECTIONS }),
    invoiceNumber: text(),
    // Parsed in code from the model's raw amount text (German/US decimal and thousands
    // separators alike, `@/modules/documents`'s `parseGermanAmountToCents`) - the model's own
    // arithmetic is never trusted (architecture brief's product decision 8). Negative for a
    // credit note.
    totalAmountCents: integer(),
    currency: text(),
    dueDate: date({ mode: "string" }),
    paymentIban: text(),
    paymentReference: text(),
    paidNote: text(),
    // F3b (decisions/0025-payment-matching-wiring.md): a stored, denormalized projection of
    // this document's own payment-matching state (`@/modules/payments`'s `PaymentStatus`) -
    // recomputed by `PaymentsUseCases` whenever a matching decision actually happens
    // (confirm/reject/link/unlink, or a matching run), never derived inline on every read (the
    // aggregate over `document_transactions` needed for that is not cheap to repeat per inbox
    // row). Defaults to `not_applicable`; set to `open` the moment `markDone` extracts a
    // direction and a total amount (an invoice-shaped document). A due date passing without any
    // new matching event does NOT update this column - `resolveDisplayStatus` upgrades it to
    // `overdue` for DISPLAY purposes only, at read time (see that function's own header comment
    // for why persisting a live clock-driven transition here was rejected).
    paymentStatus: text({ enum: PAYMENT_STATUS_VALUES }).notNull().default("not_applicable"),
    // Set once, the moment `paymentStatus` first becomes `paid`/`settled`/`no_document_needed`
    // - never cleared automatically afterwards (a later `unlink` reopening the document leaves
    // the historical `paidAt` in place until a fresh confirm overwrites it; see
    // decisions/0025's "paid_at" section for why clearing it automatically was rejected).
    paidAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp({ withTimezone: true }),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`(
        setweight(to_tsvector('german', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('german', coalesce(sender, '')), 'A') ||
        setweight(to_tsvector('german', coalesce(original_file_name, '')), 'B') ||
        setweight(to_tsvector('german', coalesce(ocr_text, '')), 'C')
      )`,
    ),
  },
  (t) => [
    check("documents_status_check", sql`${t.status} in ('uploaded', 'processing', 'done', 'failed')`),
    index("documents_workspace_created_idx").on(t.workspaceId, t.createdAt.desc()),
    index("documents_workspace_status_idx").on(t.workspaceId, t.status),
    index("documents_search_vector_idx").using("gin", t.searchVector),
    // C2: looking up "have we seen this invoice number before" (dedup/support lookups) -
    // not unique (the same supplier's invoice-number sequence is not guaranteed unique
    // workspace-wide across different senders, and a `null` invoice number is the common
    // case for a non-invoice document).
    index("documents_workspace_invoice_number_idx").on(t.workspaceId, t.invoiceNumber),
    // F1b: `createFromUpload`'s exact-duplicate check (`findByFileHash`) and the inbox's kind
    // filter, both scoped per workspace like every other document lookup.
    index("documents_workspace_file_hash_idx").on(t.workspaceId, t.fileHash),
    index("documents_workspace_kind_idx").on(t.workspaceId, t.kind),
    // F4: resolving a platform's clearing account and checking "is there already a report for
    // this platform/period" without a jsonb scan.
    index("documents_workspace_platform_idx").on(t.workspaceId, t.platform),
    index("documents_workspace_intake_status_idx").on(t.workspaceId, t.intakeStatus),
    // F3b: the inbox's "offen/überfällig/bezahlt" filter and "Offene Posten"'s own listing.
    index("documents_workspace_payment_status_idx").on(t.workspaceId, t.paymentStatus),
    check(
      "documents_payment_status_check",
      sql`${t.paymentStatus} in ('open', 'partially_paid', 'paid', 'overdue', 'settled', 'no_document_needed', 'not_applicable')`,
    ),
  ],
);
