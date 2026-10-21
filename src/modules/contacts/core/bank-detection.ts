// Owner: src/modules/contacts (H-contract.md section 4, decisions/0035-contact-links-
// replace-and-bank-detection.md). Pure: `replaceDocumentLinks`
// (`src/persistence/use-cases/contacts-use-cases.ts`) calls this for every extracted party
// before ever matching/creating a contact, so the workspace's own bank never becomes a
// "Firmenkontakt" (the observed defect: "MUSTERBANK PAYMENTS", carrying the owner's own IBAN,
// stored as a `mentioned` and later `recipient` contact). Called on the party AFTER our own
// identifiers (IBAN, VAT id) have already been stripped from it (see
// `replaceDocumentLinks`'s sanitization step and decisions/0035's "our identifiers are
// stripped before identity checks" section) - a misattributed own-IBAN sitting on an
// otherwise-ordinary customer must never make rule 2 below call it a bank.
//
// Conservative by design: missing a bank is better than swallowing a real customer. The one
// property a footer bank mention never has, whatever else is true about it, is the bank's OWN
// street address - a document naming its payee's bank prints that bank's name/IBAN/BIC, never
// the bank's own building's address. All three rules below therefore require the party to
// have NO address before any of them can fire: a party WITH an address is never treated as a
// bank here, no matter what it is called or what fields it carries - real companies are
// legitimately named "Deutsche Bank Immobilien GmbH", and a real incoming invoice can come
// FROM a bank itself (e.g. an account-fee invoice), whose own sender party legitimately
// carries a full address and its own bank details in the footer.
import { normalizeName } from "./normalizers";
import type { ExtractedContactData } from "./types";

/** Name tokens that, on their own (with no address - see rule 3 below), mark a party as a
 * bank rather than a business contact. Deliberately includes both classic German bank-name
 * components ("Sparkasse", "Volksbank", "Raiffeisen", "Kreditbank", "Bausparkasse") and the
 * payment-processor wording that produced the observed "MUSTERBANK PAYMENTS" false positive
 * ("Payments", "Payment Services"). Matched case-insensitively as a plain substring against
 * the raw (not legal-form-stripped) name, since a bank's own name is the signal here, not a
 * company name that happens to end in a legal form. */
const BANK_NAME_TOKENS = ["bank", "sparkasse", "volksbank", "raiffeisen", "kreditbank", "bausparkasse", "payments", "payment services"];

function isNonBlank(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasAddress(party: ExtractedContactData): boolean {
  return isNonBlank(party.addressLine1) || isNonBlank(party.addressLine2) || isNonBlank(party.postalCode) || isNonBlank(party.city);
}

function hasBankFields(party: ExtractedContactData): boolean {
  return isNonBlank(party.iban) || isNonBlank(party.bic) || isNonBlank(party.bankName);
}

function matchesBankNameToken(rawName: string): boolean {
  const lower = rawName.toLowerCase();
  return BANK_NAME_TOKENS.some((token) => lower.includes(token));
}

/**
 * `true` when `party` is plausibly the workspace's own bank (or the counterparty's bank) -
 * an artifact of the document's footer/payment-details block, not a real business contact.
 *
 * No rule below can ever fire when `party` has an address - see this file's header comment
 * for why that single property, not name or VAT status, is what actually distinguishes a
 * footer bank mention from a real business party (including a real invoice sent BY a bank).
 * Once that guard passes, checked in this order, any one of which is sufficient:
 *
 * 1. `party.name` (normalized) equals the normalized `bankName` of another party in
 *    `allParties` (excluded by reference, never matched against ITS OWN `bankName`) - the
 *    exact footer case that produced "MUSTERBANK PAYMENTS": the invoice's own sender/recipient
 *    party carried `bankName: "MUSTERBANK PAYMENTS"`, and the analyzer also extracted "MUSTERBANK
 *    PAYMENTS" as its own separate party. Excluding self is what lets a real invoice FROM a
 *    bank survive: that bank's own sender/recipient party often restates its own name as its
 *    `bankName` too (a redundant but harmless attribution quirk) - without the address guard
 *    AND the self-exclusion, that would self-match and drop the real supplier.
 * 2. `party` carries a bank field (`iban`/`bic`/`bankName`) and has NOTHING else that would
 *    make it a real business relationship: no VAT id, no customer number, no register data
 *    (address is already ruled out by the guard above).
 * 3. `party.name` matches a `BANK_NAME_TOKENS` entry and has no VAT id.
 */
export function isLikelyBank(party: ExtractedContactData, allParties: readonly ExtractedContactData[]): boolean {
  if (hasAddress(party)) return false;

  const partyNameNormalized = normalizeName(party.name);
  const isNamedAsAnotherPartysBank = allParties.some((other) => {
    if (other === party) return false; // never match a party against its own bankName
    const bankName = other.bankName?.trim();
    return bankName ? normalizeName(bankName) === partyNameNormalized : false;
  });
  if (isNamedAsAnotherPartysBank) return true;

  const vatId = isNonBlank(party.vatId);
  const customerNumber = isNonBlank(party.customerNumber);
  const registerData = isNonBlank(party.registerCourt) || isNonBlank(party.registerNumber);

  if (hasBankFields(party) && !vatId && !customerNumber && !registerData) return true;
  if (!vatId && matchesBankNameToken(party.name)) return true;

  return false;
}
