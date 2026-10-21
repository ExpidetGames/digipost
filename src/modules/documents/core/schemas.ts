// Neutral validation for the documents module's Server Action inputs and list/search query
// params (WEBAPP_TEMPLATE_SPEC.md §2.5: every boundary is parsed with Zod).
import { z } from "zod";

import { SEMANTIC_FIELDS, SETTLEMENT_PLATFORMS } from "@/modules/intake";
import { DOCUMENT_DIRECTIONS, DOCUMENT_KINDS, DOCUMENT_STATUSES } from "@/persistence/repositories/contracts";
import { isoDateQueryFieldSchema } from "@/shared/date-range";

import { RECLASSIFIABLE_KINDS } from "./reclassification";

export const deleteDocumentInputSchema = z.object({
  documentId: z.uuid(),
});

export const retryProcessingInputSchema = z.object({
  documentId: z.uuid(),
});

/** "Dokumentart ändern" (decisions/0072-correcting-a-document-s-kind.md): only the kinds a
 * human may assign to a PDF (`RECLASSIFIABLE_KINDS`), an account-feeding kind is invalid input. */
export const reclassifyDocumentInputSchema = z.object({
  documentId: z.uuid(),
  kind: z.enum(RECLASSIFIABLE_KINDS),
});

export const kickProcessingInputSchema = z.object({
  /** Capped generously below - the client only ever kicks a handful of due jobs for its own
   * workspace, this is not a general-purpose limit override. */
  limit: z.coerce.number().int().min(1).max(20).catch(5),
});

/** How the inbox is ordered (decisions/0058-inbox-sorts-by-the-document-s-own-date.md).
 * `documentDate` is the default: it sorts by the date the document itself carries (the
 * invoice date), falling back to the upload time for a document that has none, which is
 * every tabular import (a bank statement or an app-store report covers a period, not a day).
 * `uploaded` is the old behaviour, "what arrived here last". */
export const DOCUMENT_SORTS = ["documentDate", "uploaded"] as const;
export type DocumentSort = (typeof DOCUMENT_SORTS)[number];

/** decisions/0062-an-empty-search-param-means-absent.md: a `method="get"` filter form submits
 * EVERY field, so an untouched `<select>` or text input arrives as `""`. Without this, `""`
 * fails the field's own validation (`z.uuid()`, `z.enum()`, a date regex), the whole
 * `safeParse` fails, and the page falls back to "no filters at all" - the user picks one
 * filter, presses the button, and watches every filter disappear. Applied to the whole object
 * so a field added later is covered without anyone remembering this. */
function blankToUndefined(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, raw]) => [key, raw === "" ? undefined : raw]));
}

/** `/dashboard` search params (architecture brief: "search/filter state lives in the URL").
 * `direction` (decisions/0021-extraction-direction-and-invoice-fields.md) is the inbox's
 * "Eingang"/"Ausgang"/"Alle" filter - `undefined` (no param, or an unrecognized value) means
 * "Alle", never a hard validation error on a stale bookmarked URL. */
export const documentListQuerySchema = z.preprocess(
  blankToUndefined,
  z.object({
    q: z.string().trim().max(200).optional(),
    status: z.enum(DOCUMENT_STATUSES).optional(),
    direction: z.enum(DOCUMENT_DIRECTIONS).optional(),
    // F1b (decisions/0022-intake-wiring.md): the inbox kind filter - `undefined` is "Alle Arten".
    kind: z.enum(DOCUMENT_KINDS).optional(),
    // F3b (decisions/0025-payment-matching-wiring.md): "offen/überfällig/bezahlt".
    paymentStatus: z.enum(["open", "overdue", "paid"]).optional(),
    // The "Start" work-list page's "Wartet auf Bestätigung" link - only this one value is
    // ever offered as a filter, same narrowing as `paymentStatus` above.
    intakeStatus: z.literal("pending_confirmation").optional(),
    // decisions/0066-abschluss-check-and-export.md: the inbox's own date range ("Von"/"Bis"),
    // and what the Abschluss's check links carry so a period-scoped count opens a
    // period-scoped list. Matched against the document's EFFECTIVE date, the one the inbox
    // already sorts by. An unusable value (a stale bookmark, `2025-02-31`) silently means "no
    // bound", like every other filter here.
    from: isoDateQueryFieldSchema,
    to: isoDateQueryFieldSchema,
    // decisions/0058-inbox-sorts-by-the-document-s-own-date.md. `.catch` (not `.optional`):
    // this always resolves to a sort, so neither the page nor the repository needs a fallback
    // of its own, and a stale bookmarked URL with a removed value silently gets the default.
    sort: z.enum(DOCUMENT_SORTS).catch("documentDate"),
    page: z.coerce.number().int().min(1).catch(1),
  }),
);

export const DOCUMENTS_PAGE_SIZE = 50;

// --- F1b (decisions/0020-universal-intake.md, decisions/0022-intake-wiring.md): the
// confirmation UI's own Server Action inputs. `columnMapping`/`amountSign` mirror
// `@/modules/intake`'s `ColumnMapping`/`AmountSign` shapes exactly - validated here (rather
// than importing `@/modules/intake`'s own Zod internals, which are not exported) since a
// Server Action boundary is untrusted input regardless of what produced it client-side. ---

// `z.partialRecord`, not `z.record`: a plain enum-keyed `z.record` in this Zod version
// requires every enum key to be present, which a real column mapping (only some semantic
// fields ever apply to a given source) never is.
const columnMappingInputSchema = z.partialRecord(z.enum(SEMANTIC_FIELDS), z.string().min(1));

const amountSignInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("signed_column"), column: z.string().min(1) }),
  z.object({ mode: z.literal("separate_credit_debit_columns"), creditColumn: z.string().min(1), debitColumn: z.string().min(1) }),
  z.object({
    mode: z.literal("indicator_column"),
    amountColumn: z.string().min(1),
    indicatorColumn: z.string().min(1),
    creditValue: z.string().min(1),
    debitValue: z.string().min(1),
  }),
]);

export const confirmIntakeInputSchema = z.object({
  documentId: z.uuid(),
  documentKind: z.enum(DOCUMENT_KINDS),
  platform: z.enum(SETTLEMENT_PLATFORMS).nullable(),
  mapping: columnMappingInputSchema,
  amountSign: amountSignInputSchema.nullable(),
});

export const rejectIntakeInputSchema = z.object({
  documentId: z.uuid(),
});

export const resetIntakeFingerprintInputSchema = z.object({
  fingerprintId: z.uuid(),
});
