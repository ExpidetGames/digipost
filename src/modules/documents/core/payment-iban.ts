// Owner: src/modules/documents (decisions/0040). Pure. The payment IBAN is taken from the OCR text
// by code, not copied by the model: on a batch of nine real invoices the OCR text held the right
// IBAN every time, while the model's copy was correct only six times (one had two digits dropped,
// "DE35 2000 00 0123 ..." for "DE35 2000 0000 0123 ...", two were left empty). The model only
// tells which IBAN it meant; an IBAN has a checksum, so the code can verify every candidate.
import { isValidIbanFormat, normalizeIban } from "@/modules/contacts";

/** Country code, check digits, then 11 to 30 alphanumerics, tolerating the usual groups of four
 * separated by single spaces. Candidates are verified with the mod-97 checksum afterwards. */
const IBAN_CANDIDATE = /\b[A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]){11,30}\b/g;

/** Every checksum-valid IBAN in the text, normalized, de-duplicated, in order of appearance. A
 * greedy match can swallow the next word ("DE19 ... 51 BIC"), so each candidate is shortened from
 * the end until it validates. */
export function extractValidIbans(text: string | null | undefined): string[] {
  if (!text) return [];
  const found: string[] = [];
  for (const match of text.toUpperCase().matchAll(IBAN_CANDIDATE)) {
    let candidate = match[0].replace(/\s+/g, "");
    while (candidate.length >= 15 && !isValidIbanFormat(candidate)) candidate = candidate.slice(0, -1);
    if (candidate.length >= 15 && !found.includes(candidate)) found.push(candidate);
  }
  return found;
}

/**
 * The payment IBAN to store, or `null` when none can be verified:
 *
 * 1. The model named an IBAN that is valid and appears in the text: take it.
 * 2. The model named one that is invalid or absent from the text (a mis-copy): take the valid text
 *    IBAN with the same country code and check digits that differs from it by at most four
 *    characters, if exactly one does.
 * 3. The model named none: take the single valid IBAN in the text, unless it is one of our own.
 *    Our own IBAN appears on a supplier's direct-debit invoice as the account being DEBITED, not
 *    as the payee, so without the model naming it as the payment IBAN it must not become one
 *    (it would also flip the kind to outgoing, decisions/0039).
 */
export function resolvePaymentIban(modelIban: string | null | undefined, ocrText: string | null | undefined, ownIbans: ReadonlySet<string>): string | null {
  const valid = extractValidIbans(ocrText);

  if (modelIban) {
    const named = normalizeIban(modelIban);
    if (valid.includes(named)) return named;
    const repairs = valid.filter((iban) => iban.slice(0, 4) === named.slice(0, 4) && editDistance(iban, named) <= 4);
    return repairs.length === 1 ? repairs[0]! : null;
  }

  return valid.length === 1 && !ownIbans.has(valid[0]!) ? valid[0]! : null;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}
