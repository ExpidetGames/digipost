// Owner: src/modules/contacts (decisions/0019-contacts.md's "Matching order"). Pure: takes
// already-normalized extracted data plus a candidate list (the use case fetches every
// contact in the workspace via `ContactRepository.listAllForWorkspace` - acceptable at this
// product's scale, a small business's own contact book, and it is what keeps this function
// pure and trivially unit-testable) and returns at most one match, strongest rule first.
import { nameSimilarity, normalizeIban, normalizeName, normalizeVatId } from "./normalizers";
import type { ContactMatchCandidate, ExtractedContactData } from "./types";

export type MatchStrength = "strong" | "weak";

/** Which rule produced the match - surfaced so a caller (e.g. a future UI review queue)
 * can explain "why was this document linked to this contact". */
export const MATCH_RULES = {
  vatId: "vat_id",
  register: "register",
  iban: "iban",
  customerNumberAndName: "customer_number_and_name",
  nameAndPostalCode: "name_and_postal_code",
  nameOnlyUnique: "name_only_unique",
} as const;
export type MatchRule = (typeof MATCH_RULES)[keyof typeof MATCH_RULES];

export type MatchResult = { contactId: string; strength: MatchStrength; rule: MatchRule };

/** Weak-match rule 4's "normalized-name similarity" bar - deliberately looser than
 * `OWN_COMPANY_NAME_SIMILARITY_THRESHOLD` (`own-company.ts`): a false positive here only
 * risks filing a document under a slightly-misnamed existing contact instead of creating a
 * new one (correctable later, e.g. via `mergeContacts`), which is a far smaller risk than a
 * false positive in `isOwnCompany` (which would silently drop the workspace's own inbound
 * mail from the contact list entirely). */
const CUSTOMER_NUMBER_NAME_SIMILARITY_THRESHOLD = 0.4;

/** The extracted fields this module needs already normalized (the use case computes these
 * once via `normalizers.ts` before calling `pickBestMatch`). */
export type NormalizedExtractedContact = {
  nameNormalized: string;
  postalCode: string | null;
  vatIdNormalized: string | null;
  registerCourt: string | null;
  registerNumber: string | null;
  ibanNormalized: string | null;
  customerNumber: string | null;
};

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Computes every normalized field `pickBestMatch` (and `ContactRepository.create`'s
 * `nameNormalized`/`vatIdNormalized`/`ibanNormalized` columns) need from one extraction -
 * the single place that decides "empty/whitespace-only counts as not provided". */
export function normalizeExtractedForMatching(extracted: ExtractedContactData): NormalizedExtractedContact {
  return {
    nameNormalized: normalizeName(extracted.name),
    postalCode: trimmedOrNull(extracted.postalCode),
    vatIdNormalized: extracted.vatId?.trim() ? normalizeVatId(extracted.vatId) : null,
    registerCourt: trimmedOrNull(extracted.registerCourt),
    registerNumber: trimmedOrNull(extracted.registerNumber),
    ibanNormalized: extracted.iban?.trim() ? normalizeIban(extracted.iban) : null,
    customerNumber: trimmedOrNull(extracted.customerNumber),
  };
}

/**
 * Strongest match first, each rule tried only when its required extracted field(s) are
 * present:
 *
 * 1. `vat_id_normalized` exact match - strong.
 * 2. `register_court` + `register_number` exact match (both required) - strong.
 * 3. `iban_normalized` exact match - strong, but only when exactly one candidate shares the
 *    IBAN: `contacts` has no unique constraint on `(workspace_id, iban_normalized)`
 *    (decisions/0019-contacts.md explains why - two legal entities can share a bank
 *    account), so more than one candidate sharing an IBAN is genuinely ambiguous and this
 *    rule intentionally yields no match rather than guessing.
 * 4. `customer_number` exact match plus a normalized-name similarity above a low bar - weak.
 *    Ambiguous (more than one candidate satisfies both conditions) yields no match, same
 *    reasoning as rule 3.
 * 5. `name_normalized` + `postal_code` both exact - weak. Same ambiguity handling.
 * 6. (H-contract.md section 3 / decisions/0035) When the extraction has NO postal code at
 *    all, an exact `name_normalized` match against EXACTLY ONE existing candidate is a weak
 *    match - `name_only_unique`. Rule 5 above already covers the postal-code-present case,
 *    so this rule only ever fires when rule 5 could not even be attempted; more than one
 *    candidate sharing the name stays ambiguous, same as every other rule here. This is
 *    what stops a footer party with no postal code (e.g. a company's own brand name
 *    repeated in a document footer) from spawning a new duplicate contact on every single
 *    run - deliberately still name-only, so it is loosened no further than that.
 *
 * No rule matching returns `null` - the caller creates a new contact.
 */
export function pickBestMatch(extracted: NormalizedExtractedContact, candidates: ContactMatchCandidate[]): MatchResult | null {
  if (extracted.vatIdNormalized) {
    const match = candidates.find((c) => c.vatIdNormalized === extracted.vatIdNormalized);
    if (match) return { contactId: match.id, strength: "strong", rule: MATCH_RULES.vatId };
  }

  if (extracted.registerCourt && extracted.registerNumber) {
    const match = candidates.find((c) => c.registerCourt === extracted.registerCourt && c.registerNumber === extracted.registerNumber);
    if (match) return { contactId: match.id, strength: "strong", rule: MATCH_RULES.register };
  }

  if (extracted.ibanNormalized) {
    const matches = candidates.filter((c) => c.ibanNormalized === extracted.ibanNormalized);
    if (matches.length === 1) return { contactId: matches[0].id, strength: "strong", rule: MATCH_RULES.iban };
  }

  if (extracted.customerNumber) {
    const matches = candidates.filter(
      (c) =>
        c.customerNumber === extracted.customerNumber &&
        nameSimilarity(c.nameNormalized, extracted.nameNormalized) >= CUSTOMER_NUMBER_NAME_SIMILARITY_THRESHOLD,
    );
    if (matches.length === 1) return { contactId: matches[0].id, strength: "weak", rule: MATCH_RULES.customerNumberAndName };
  }

  if (extracted.postalCode) {
    const matches = candidates.filter((c) => c.nameNormalized === extracted.nameNormalized && c.postalCode === extracted.postalCode);
    if (matches.length === 1) return { contactId: matches[0].id, strength: "weak", rule: MATCH_RULES.nameAndPostalCode };
  }

  if (!extracted.postalCode && extracted.nameNormalized) {
    const matches = candidates.filter((c) => c.nameNormalized === extracted.nameNormalized);
    if (matches.length === 1) return { contactId: matches[0].id, strength: "weak", rule: MATCH_RULES.nameOnlyUnique };
  }

  return null;
}
