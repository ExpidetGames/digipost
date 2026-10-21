// Neutral validation for a manually created/edited contact (WEBAPP_TEMPLATE_SPEC.md §2.5:
// every boundary is parsed with Zod). C3 builds the Server Action that calls these; they are
// provided now so C3's action layer and this module's own use-case contract agree on shape
// from day one. Unlike `upsertFromExtraction` (which must never fail on a malformed value,
// `format-checks.ts`'s header comment), a human editing a contact by hand gets a hard
// validation error for a malformed IBAN/VAT id - they are present to fix it immediately.
import { z } from "zod";

import { isPlausibleVatId, isValidIbanFormat } from "./format-checks";
import { CONTACT_RELATION_TYPES, DOCUMENT_CONTACT_ROLES } from "./types";

/** `/dashboard/contacts` search params (same "filter state lives in the URL" convention as
 * `src/modules/documents/core/schemas.ts`'s `documentListQuerySchema`). */

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

export const contactListQuerySchema = z.preprocess(
  blankToUndefined,
  z.object({
    q: z.string().trim().max(200).optional(),
    relationType: z.enum(CONTACT_RELATION_TYPES).optional(),
    unverified: z.literal("1").optional(),
    page: z.coerce.number().int().min(1).catch(1),
  }),
);

/** An optional text field: blank/whitespace-only input is treated as "not provided"
 * (`undefined`), matching how `verification.ts`'s `isBlank` already treats an extracted
 * value - the manual and automated paths agree on what "empty" means. */
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined));
}

const ibanField = optionalText(34).refine((value) => value === undefined || isValidIbanFormat(value), {
  message: "invalid_iban_format",
});
const vatIdField = optionalText(20).refine((value) => value === undefined || isPlausibleVatId(value), {
  message: "invalid_vat_format",
});

const contactFieldsSchema = {
  name: z.string().trim().min(1).max(200),
  legalForm: optionalText(60),
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  postalCode: optionalText(20),
  city: optionalText(120),
  country: optionalText(2),
  vatId: vatIdField,
  taxNumber: optionalText(30),
  registerCourt: optionalText(120),
  registerNumber: optionalText(30),
  leitwegId: optionalText(60),
  iban: ibanField,
  bic: optionalText(11),
  bankName: optionalText(120),
  accountHolder: optionalText(200),
  sepaCreditorId: optionalText(35),
  phone: optionalText(40),
  email: z.string().trim().toLowerCase().max(320).pipe(z.email()).optional().or(z.literal("").transform(() => undefined)),
  website: optionalText(200),
  contactPerson: optionalText(120),
  customerNumber: optionalText(60),
  supplierNumber: optionalText(60),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).optional(),
  relationType: z.enum(CONTACT_RELATION_TYPES).optional(),
  notes: optionalText(2000),
};

/** All fields for creating a contact by hand - only `name` is required, matching the
 * `contacts` table itself. */
export const manualContactCreateSchema = z.object(contactFieldsSchema);
export type ManualContactCreateInput = z.infer<typeof manualContactCreateSchema>;

/** Same shape, `name` still required (a manual save always re-supplies the full form) -
 * kept as a distinct export so create/update can diverge later without a breaking rename. */
export const manualContactUpdateSchema = z.object(contactFieldsSchema);
export type ManualContactUpdateInput = z.infer<typeof manualContactUpdateSchema>;

// --- C3 additions below: input schemas for the contacts UI's Server Actions
// (`src/modules/contacts/actions.ts`), same file as the manual field schemas above since
// they are small wrappers around the same `contactFieldsSchema`/plain id shapes.

export const updateContactInputSchema = manualContactUpdateSchema.extend({ contactId: z.uuid() });
export type UpdateContactInput = z.infer<typeof updateContactInputSchema>;

export const verifyContactInputSchema = z.object({ contactId: z.uuid() });
export const deleteContactInputSchema = z.object({ contactId: z.uuid() });

// decisions/0037-correction-buttons.md: "Das sind wir" / "Das ist unsere Bank" - both take
// only the contact id, exactly like `deleteContactInputSchema`; kept as their own named
// schemas (rather than reusing that one) for the same reason `verifyContactInputSchema` is
// separate from it despite the identical shape - each action gets its own name at the
// schema/action boundary even when two shapes happen to coincide today.
export const markContactAsOwnCompanyInputSchema = z.object({ contactId: z.uuid() });
export const markContactAsOwnBankInputSchema = z.object({ contactId: z.uuid() });

// `sourceId === targetId` is deliberately NOT rejected here: the use case's own
// `cannot_merge_self` error code (`src/persistence/use-cases/contacts-use-cases.ts`) is the
// single source of truth for that check, so the UI shows the same stable, translated error
// message regardless of which layer caught it.
export const mergeContactsInputSchema = z.object({ sourceId: z.uuid(), targetId: z.uuid() });

export const acceptProposalInputSchema = z.object({ proposalId: z.uuid() });
export const rejectProposalInputSchema = z.object({ proposalId: z.uuid() });

export const unlinkDocumentInputSchema = z.object({
  documentId: z.uuid(),
  contactId: z.uuid(),
  role: z.enum(DOCUMENT_CONTACT_ROLES),
});
