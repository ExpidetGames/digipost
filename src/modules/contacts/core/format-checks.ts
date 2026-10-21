// Owner: src/modules/contacts (decisions/0019-contacts.md). Pure, non-blocking format
// checks: `isValidIbanFormat`/`isPlausibleVatId` never throw, and `checkContactFormats`
// only ever returns a list of warnings - nothing here rejects an extraction. The manual
// create/update Zod schemas (`schemas.ts`) are the one place a malformed IBAN/VAT actually
// blocks a save (a human is present to fix it immediately); `upsertFromExtraction`
// (`src/persistence/use-cases/contacts-use-cases.ts`) never calls these to reject anything,
// only ever to normalize/store/compare the raw value as given, exactly per the architecture
// brief's "the extraction must never fail for a missing field" - extended here to "a
// malformed one either".
import { CONTACT_FORMAT_WARNING, type ContactFormatWarning } from "./error-codes";

/**
 * IBAN mod-97 checksum (ISO 7064), after a basic shape check (2-letter country code, 2 check
 * digits, 11-30 further alphanumeric characters - covers every real IBAN length). Processes
 * the numeric rearrangement in 7-digit chunks so it works for `Number` without overflowing.
 */
export function isValidIbanFormat(raw: string): boolean {
  const iban = raw.toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) return false;

  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));

  let remainder = 0;
  for (let i = 0; i < numeric.length; i += 7) {
    remainder = Number(`${remainder}${numeric.slice(i, i + 7)}`) % 97;
  }
  return remainder === 1;
}

/**
 * German-aware VAT id (USt-IdNr.) plausibility check: a German VAT id is always
 * `DE` + exactly 9 digits, checked precisely. Any other country prefix (a foreign supplier's
 * VAT id is entirely normal input) is checked only loosely - 2-letter country code plus
 * 2-12 further alphanumeric characters - since this module has no per-country format table
 * and a false "invalid" warning on legitimate foreign input would be worse than a missed one.
 */
export function isPlausibleVatId(raw: string): boolean {
  const vatId = raw.toUpperCase().replace(/\s+/g, "");
  if (vatId.startsWith("DE")) return /^DE[0-9]{9}$/.test(vatId);
  return /^[A-Z]{2}[A-Z0-9]{2,12}$/.test(vatId);
}

/** Combines both checks into the warning codes a caller (the manual Zod schema, or a future
 * C3 "possibly invalid" badge) can translate to copy. Blank/absent input never warns - only a
 * present, malformed value does. */
export function checkContactFormats(input: { iban?: string | null; vatId?: string | null }): ContactFormatWarning[] {
  const warnings: ContactFormatWarning[] = [];
  if (input.iban?.trim() && !isValidIbanFormat(input.iban)) warnings.push(CONTACT_FORMAT_WARNING.invalidIban);
  if (input.vatId?.trim() && !isPlausibleVatId(input.vatId)) warnings.push(CONTACT_FORMAT_WARNING.invalidVatId);
  return warnings;
}
