// The self-counterparty guard (H2-wave2.md's "the self-counterparty check", promised to the
// owner alongside decisions/0036-guided-extraction.md's wave 2). The residual weak spot of
// "the kind decides the roles" is a WRONG KIND, not a wrong counterparty: an incoming invoice
// misclassified as outgoing would otherwise silently turn the supplier into "the customer".
// Cheap and deterministic: after sanitizing (stripping our own IBAN/VAT id from the extracted
// counterparty - the same rule H3's `replaceDocumentLinks` applies, see below), check whether
// what is left still resolves to the workspace's OWN company via `@/modules/contacts`'s
// `isOwnCompany` (name/alias/domain/register/postal-code rule). If it does, the classified
// `kind` was probably wrong - `processOcrDocument` responds by setting `direction` to
// `"unknown"` and not linking this party at all, rather than trusting a role assignment built
// on a shaky foundation.
//
// Deliberately duplicates the small sanitizing step `src/persistence/use-cases/contacts-use-cases.ts`'s
// private `stripOwnIdentifiers` already performs (H-contract.md's file-ownership table: that
// file belongs to a different agent and does not export the helper). The logic is four lines -
// compare two already-normalized identifiers and null them out on a match - duplicating it
// here is preferable to widening that file's public surface for something this small. Both
// copies must be kept in sync if the sanitizing rule itself ever changes; each file's own
// comment cross-references the other.
import { isOwnCompany, normalizeIban, normalizeVatId, type ExtractedContactData, type OwnCompanyProfile } from "@/modules/contacts";

function sanitizeForSelfCheck(extracted: ExtractedContactData, ownCompany: OwnCompanyProfile): ExtractedContactData {
  const normalizedOwnIbans = new Set(ownCompany.ibans.map((iban) => normalizeIban(iban)));
  const normalizedOwnVatId = ownCompany.vatId?.trim() ? normalizeVatId(ownCompany.vatId) : null;

  const trimmedIban = extracted.iban?.trim();
  const ownIban = trimmedIban ? normalizedOwnIbans.has(normalizeIban(trimmedIban)) : false;
  const trimmedVatId = extracted.vatId?.trim();
  const ownVatId = normalizedOwnVatId !== null && trimmedVatId ? normalizeVatId(trimmedVatId) === normalizedOwnVatId : false;

  if (!ownIban && !ownVatId) return extracted;
  return { ...extracted, ...(ownIban ? { iban: null } : {}), ...(ownVatId ? { vatId: null } : {}) };
}

/**
 * `true` when a `"derived"`-mode plan's extracted counterparty is plausibly the workspace's
 * OWN company. The model's attribution of an IBAN or VAT id to a specific party is exactly the
 * kind of unreliable per-run signal this whole feature moves away from (decisions/0031/0032's
 * own findings) - stripping them BEFORE `isOwnCompany` ever runs means this check only ever
 * fires on the reliable structural signals (a whole-name/alias match, a domain match, matching
 * register data, or postal-code-plus-name-similarity), never on an identifier the model may
 * have hung on the wrong party.
 */
export function isCounterpartySelf(counterparty: ExtractedContactData, ownCompany: OwnCompanyProfile): boolean {
  const sanitized = sanitizeForSelfCheck(counterparty, ownCompany);
  return isOwnCompany(sanitized, ownCompany);
}
