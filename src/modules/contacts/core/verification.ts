// Owner: src/modules/contacts (decisions/0019-contacts.md's "Verification semantics" and
// "no-silent-overwrite rule"). Pure: `computeContactUpdatePlan` never mutates anything and
// never reaches a database - `src/persistence/use-cases/contacts-use-cases.ts`'s
// `upsertFromExtraction` is the only caller, applying the returned `fillPatch` and inserting
// the returned `proposals`.
//
// The rule is the same regardless of whether the existing contact is currently verified or
// not: an EMPTY field is filled directly; a NON-EMPTY field that already holds a different
// (post-normalization) value never gets silently overwritten - it becomes a proposal
// instead, review-gated (`acceptProposal`/`rejectProposal`), specifically because the data
// comes from scanned paper and a changed IBAN on a supplier invoice is a classic German
// invoice-fraud pattern. The verified/unverified distinction matters elsewhere:
// `upsertFromExtraction` resets `verified_at` to `null` whenever `fillPatch` is non-empty
// (ANY pipeline-made change, even filling a previously-empty field, un-verifies the contact
// again) - that reset happens in the use case, not here, since it is a whole-row concern.
import { normalizeIban, normalizePlainText, normalizeVatId } from "./normalizers";
import { COMPARABLE_CONTACT_FIELDS, type ComparableContactField, type ExtractedContactData } from "./types";

export type ContactFieldPatch = Partial<Record<ComparableContactField, string | number>>;

export type FieldProposal = {
  field: ComparableContactField;
  /** The contact's current value, stringified for storage in `contact_change_proposals`
   * (`payment_terms_days` is the one numeric field in `COMPARABLE_CONTACT_FIELDS`). */
  currentValue: string;
  proposedValue: string;
};

/** The existing contact's current value for every comparable field - a plain record, not
 * the persistence layer's `ContactRow`, so this module stays independent of
 * `src/persistence` (same reasoning as `ContactMatchCandidate` in `types.ts`). */
export type ExistingContactForDiff = Record<ComparableContactField, string | number | null>;

function isBlank(value: string | number | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  return typeof value === "string" && value.trim() === "";
}

/** Whether `current` (already on the contact) and `extractedRaw` (freshly extracted) are the
 * "same value" once formatting noise is normalized away - the exact rule the architecture
 * brief's "no proposal when values are equal after normalization" requirement names. */
function isUnchanged(field: ComparableContactField, current: string | number, extractedRaw: string | number): boolean {
  if (field === "paymentTermsDays") return Number(current) === Number(extractedRaw);
  if (field === "vatId") return normalizeVatId(String(current)) === normalizeVatId(String(extractedRaw));
  if (field === "iban") return normalizeIban(String(current)) === normalizeIban(String(extractedRaw));
  return normalizePlainText(String(current)) === normalizePlainText(String(extractedRaw));
}

/**
 * Diffs one extraction against an already-matched contact's current field values. For every
 * comparable field the extraction actually provided (non-blank):
 *
 * - the contact's current value is blank -> added to `fillPatch` (trimmed, if a string);
 * - the current value is non-blank and equal after normalization -> ignored (no-op, proves
 *   "no proposal when values are equal after normalization");
 * - the current value is non-blank and different -> added to `proposals`, never to
 *   `fillPatch` (the no-silent-overwrite rule).
 *
 * `name` is never part of this diff: it is what drove the match in the first place
 * (`matching.ts`), and `contacts.name` is `NOT NULL` so it is never blank to begin with.
 */
export function computeContactUpdatePlan(
  existing: ExistingContactForDiff,
  extracted: ExtractedContactData,
): { fillPatch: ContactFieldPatch; proposals: FieldProposal[] } {
  const fillPatch: ContactFieldPatch = {};
  const proposals: FieldProposal[] = [];

  for (const field of COMPARABLE_CONTACT_FIELDS) {
    const rawExtracted = extracted[field];
    if (isBlank(rawExtracted)) continue;
    const extractedValue = typeof rawExtracted === "string" ? rawExtracted.trim() : (rawExtracted as number);

    const currentValue = existing[field];
    if (isBlank(currentValue)) {
      fillPatch[field] = extractedValue;
      continue;
    }
    // `isBlank` above is a plain boolean check, not a type predicate, so TypeScript cannot
    // narrow `currentValue` from `string | number | null` on its own - safe to assert
    // non-null here, since `isBlank` already ruled out `null` (and an empty string) for us.
    const currentNonBlank = currentValue as string | number;

    if (isUnchanged(field, currentNonBlank, extractedValue)) continue;

    proposals.push({ field, currentValue: String(currentNonBlank), proposedValue: String(extractedValue) });
  }

  return { fillPatch, proposals };
}
