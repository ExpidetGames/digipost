// Owner: src/modules/contacts (decisions/0019-contacts.md's "own-company exclusion",
// extended by decisions/0034-extended-company-profile.md). Pure: the pipeline (C2) calls this
// before `upsertFromExtraction` so the workspace's own company (extracted as the "recipient"
// of its own incoming mail, or occasionally misidentified as a sender on a reply/carbon copy,
// or its own bank/brand name mistaken for a business contact) never becomes a contact of
// itself.
import { nameSimilarity, normalizeName, normalizePlainText, normalizeVatId } from "./normalizers";
import type { ExtractedContactData, OwnCompanyProfile } from "./types";

/** Deliberately stricter than `matching.ts`'s weak-match thresholds: a false positive here
 * would silently drop a real business partner's mail from the contact list (mistaking them
 * for the workspace's own company), which is a worse failure than the reverse (a missed
 * own-company exclusion just means the workspace's own address shows up as a contact once,
 * harmless and correctable by deleting it). */
export const OWN_COMPANY_NAME_SIMILARITY_THRESHOLD = 0.8;

/** Extracts a lowercased host from a website (bare domain or full URL) or an e-mail address,
 * for comparing against `OwnCompanyProfile.domains` (already lowercased, host only). Mirrors
 * `src/persistence/use-cases/workspaces-use-cases.ts`'s `normalizeCompanyDomain` closely
 * enough that the two agree on what "the same host" means, but is kept local to this file (a
 * party's `website`/`email` fields need slightly different handling - an email's host is
 * everything after `@`, a website may be a bare domain or a full URL) rather than shared
 * across the module boundary. `null` for blank input or an email with no `@`. */
function hostFromWebsite(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim().toLowerCase();
  if (!trimmed) return null;
  let value = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  value = value.split(/[/?#]/, 1)[0] ?? value;
  value = value.replace(/^www\./, "");
  value = value.split(":", 1)[0] ?? value;
  return value || null;
}

function hostFromEmail(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim().toLowerCase();
  if (!trimmed || !trimmed.includes("@")) return null;
  const host = trimmed.slice(trimmed.lastIndexOf("@") + 1);
  return host || null;
}

/**
 * `true` when `extracted` plausibly IS the workspace's own company. Decision order
 * (decisions/0034-extended-company-profile.md), the first rule that fires wins - the free
 * `profileText` on `OwnCompanyProfile` (there is none on this type: it is never carried this
 * far, only into the analyzer's prompt) is deliberately never consulted here, only the
 * structured fields below:
 *
 * 1. VAT id match (normalized) - strong, on its own.
 * 2. `registerCourt` AND `registerNumber` BOTH match (loosely, on the court name) - strong,
 *    just as unambiguous as a VAT id but sometimes present when one is not.
 * 3. Normalized party name equals the normalized company name, or equals any entry of
 *    `ownCompany.aliases` (already normalized) - whole-name equality only, NEVER a substring:
 *    "Software" must not match "Mobile Software AG", and a generic alias like a bare legal
 *    form is rejected up front by `updateCompanyProfile`'s own guard specifically so this rule
 *    can never over-match on one.
 * 4. Party website/e-mail host equals any entry of `ownCompany.domains` (already lowercased,
 *    host only).
 * 5. Postal code exact match AND normalized-name similarity at or above
 *    `OWN_COMPANY_NAME_SIMILARITY_THRESHOLD` - weak, needs both (the original, pre-decisions/0034
 *    rule).
 * 6. Otherwise not own.
 *
 * **Deliberately NOT a rule: a party's own `iban` matching one of `ownCompany.ibans`.**
 * `ownCompany.ibans` still exists (the column, validation, and settings UI are all real - H2's
 * reminder-direction logic and H3's bank-detection/IBAN-stripping both key off it), but
 * whether a document's payment IBAN belongs to us is decided from the DOCUMENT's own payment
 * fields, never from which PARTY the model happened to attach an extracted `iban` to. On a
 * real outgoing invoice the only IBAN printed is ours (as payee) - but the model's attribution
 * of that IBAN to a specific party in its `parties` array is exactly the kind of per-run
 * unreliable signal this whole feature moves away from (see decisions/0031/0032's own findings
 * about role labels). Trusting it here would let a real customer the model mislabeled with our
 * IBAN silently vanish from the contact book instead of being linked - the single most
 * dangerous failure mode this ADR exists to prevent, worse than the defect it was meant to
 * fix. H3's `replaceDocumentLinks` still strips our IBAN off of any party's own record before
 * it is ever written to a contact, independently of whether that party is "own company".
 *
 * `ownCompany` fields that are `null`/empty (an admin has not filled in that part of the
 * company profile yet) simply never satisfy a rule - this function never throws and never
 * matches on missing data.
 */
export function isOwnCompany(
  extracted: Pick<ExtractedContactData, "name" | "postalCode" | "vatId" | "registerCourt" | "registerNumber" | "website" | "email">,
  ownCompany: OwnCompanyProfile,
): boolean {
  // 1. VAT id.
  const extractedVatId = extracted.vatId?.trim();
  const ownVatId = ownCompany.vatId?.trim();
  if (extractedVatId && ownVatId && normalizeVatId(extractedVatId) === normalizeVatId(ownVatId)) {
    return true;
  }

  // 2. Register court + number, both required.
  const extractedCourt = extracted.registerCourt?.trim();
  const extractedNumber = extracted.registerNumber?.trim();
  const ownCourt = ownCompany.registerCourt?.trim();
  const ownNumber = ownCompany.registerNumber?.trim();
  if (
    extractedCourt &&
    extractedNumber &&
    ownCourt &&
    ownNumber &&
    normalizePlainText(extractedCourt) === normalizePlainText(ownCourt) &&
    normalizePlainText(extractedNumber) === normalizePlainText(ownNumber)
  ) {
    return true;
  }

  // 3. Whole-name equality against the own name or an alias - never a substring.
  const normalizedExtractedName = normalizeName(extracted.name);
  const normalizedOwnName = normalizeName(ownCompany.name);
  if (normalizedExtractedName) {
    if (normalizedOwnName && normalizedExtractedName === normalizedOwnName) return true;
    if (ownCompany.aliases.includes(normalizedExtractedName)) return true;
  }

  // 4. Own web/e-mail domain.
  const extractedHost = hostFromWebsite(extracted.website) ?? hostFromEmail(extracted.email);
  if (extractedHost && ownCompany.domains.includes(extractedHost)) return true;

  // 5. Postal code + name similarity (the original rule, kept as the last, weakest resort).
  const extractedPostalCode = extracted.postalCode?.trim();
  const ownPostalCode = ownCompany.postalCode?.trim();
  if (extractedPostalCode && ownPostalCode && extractedPostalCode === ownPostalCode) {
    const similarity = nameSimilarity(normalizedExtractedName, normalizedOwnName);
    if (similarity >= OWN_COMPANY_NAME_SIMILARITY_THRESHOLD) return true;
  }

  return false;
}
