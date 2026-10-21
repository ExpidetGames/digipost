// Owner: src/modules/payments (decisions/0023-payment-matching.md). Pure text-matching
// signals over a bank transaction's remittance text: does a candidate invoice/customer number
// appear in it (tolerant to spacing/case/separators/prefix noise), and how similar is the
// counterparty name to a contact's name (reusing `@/modules/contacts`'s normalizers rather
// than duplicating name-comparison logic a second time, per this phase's own instructions).
import { nameSimilarity, normalizeName } from "@/modules/contacts";

/** Below this length, a normalized ALPHANUMERIC token is too short to search for reliably (a
 * bare "AB" would match almost any remittance text purely by chance) - such a candidate is
 * simply never looked for, not a false "not found". A digit-only candidate does not use this
 * floor at all - it follows its own, stricter rule below (`MIN_DIGIT_ONLY_TOKEN_LENGTH` plus a
 * word-boundary check, or the keyword exception), since a bare number is far more likely to
 * coincidentally appear inside an unrelated date or reference than a candidate containing a
 * letter is. */
const MIN_TOKEN_LENGTH = 4;

/**
 * Security review finding (R1, suspected, low): a digit-only candidate only had to clear the
 * generic 4-character floor above, so a short invoice/customer number like "2026" matched the
 * YEAR inside an ordinary German date ("Rechnung vom 15.03.2026") as a false
 * `invoiceNumberInRemittance` signal - which `core/rules.ts`'s `matchByRules` can turn into a
 * 0.99-confidence auto-confirmed match. A candidate containing at least one letter (the
 * overwhelmingly common shape here, "RE-2026-00002") does not have this problem: a letter
 * embedded in unrelated prose is not something dates or plain numbers produce, so this floor
 * only tightens the DIGIT-ONLY case, exactly as the finding asked - alphanumeric candidates
 * stay exactly as tolerant as before.
 *
 * decisions/0031-direction-from-kind-and-short-invoice-numbers.md tightened this further: a
 * real invoice can have a genuinely short, bare number (a real transaction's remittance text:
 * "Re.Nr. 12 vom 02.07.25 Beratung und Hosting" - "12" is the actual invoice number), which this
 * 5-digit floor made unfindable, so the auto-confirm path could never fire for it even with
 * matching amount. The floor itself stays (a bare, keyword-less short number is still too
 * likely to be date/reference noise) - `hasKeywordPrecededDigitOnlyMatch` below is the one,
 * narrow exception: a short digit-only candidate is still accepted when it is directly
 * preceded by a recognized invoice-number keyword, since that context is exactly the evidence
 * the bare-number case lacks.
 */
const MIN_DIGIT_ONLY_TOKEN_LENGTH = 5;

/**
 * decisions/0031: keywords that, directly preceding a digit-only candidate in the remittance
 * text, are strong enough evidence to waive `MIN_DIGIT_ONLY_TOKEN_LENGTH` for that one
 * candidate. Deliberately a closed, short list (never a generic "any word before a number"
 * rule) - each entry is itself normalized via `normalizeToken` before matching, which already
 * strips spaces/dots/colons/hyphens (and any other separator) between the keyword's own
 * letters, so "Re.Nr.", "Re-Nr", "RE NR" all collapse to the same "RENR" needle.
 */
const INVOICE_NUMBER_KEYWORDS = ["Re.Nr.", "Re-Nr", "RechnungsNr", "Rechnungsnummer", "Rechnung", "RG", "RN", "Inv", "Invoice"];

/** Keeps only letters and digits, uppercased - the same tolerant shape for both the
 * remittance text and every candidate token, so "RE-2026-00002", "RE 2026 00002", and
 * "RE202600002" all normalize identically. */
function normalizeToken(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const NORMALIZED_INVOICE_NUMBER_KEYWORDS = Array.from(new Set(INVOICE_NUMBER_KEYWORDS.map(normalizeToken)));

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

function isDigitOnlyToken(normalized: string): boolean {
  return normalized.length > 0 && !/[A-Z]/.test(normalized);
}

/**
 * `true` when `normalizedCandidate` is found in `normalizedText` immediately after one of
 * `NORMALIZED_INVOICE_NUMBER_KEYWORDS` (with no separator between them - already collapsed by
 * `normalizeToken` on both sides) AND is not immediately followed by another digit (the same
 * "not a substring of a longer digit run" word-boundary requirement
 * `hasDigitOnlyWordBoundaryMatch` enforces for the bare-number case, checked here on the
 * trailing side only - the keyword itself already establishes the leading boundary).
 */
function hasKeywordPrecededDigitOnlyMatch(normalizedText: string, normalizedCandidate: string): boolean {
  for (const keyword of NORMALIZED_INVOICE_NUMBER_KEYWORDS) {
    const needle = keyword + normalizedCandidate;
    let fromIndex = 0;
    for (;;) {
      const index = normalizedText.indexOf(needle, fromIndex);
      if (index === -1) break;
      const afterIndex = index + needle.length;
      const after = afterIndex < normalizedText.length ? normalizedText[afterIndex] : undefined;
      if (!isDigit(after)) return true;
      fromIndex = index + 1;
    }
  }
  return false;
}

/**
 * `true` when `normalizedCandidate` occurs in `normalizedText` at a position not immediately
 * bordered by another digit on either side - i.e. it is not merely a substring of a LONGER
 * digit/date run. `normalizeToken` already strips every separator (spaces, dots, hyphens)
 * from both sides before this runs, so a German date like "15.03.2026" normalizes to
 * "...15032026" - the year "2026" is a substring of that longer run, bordered by the digit
 * "3" from "03" on its left, and is rejected here for exactly that reason (on top of already
 * failing `MIN_DIGIT_ONLY_TOKEN_LENGTH`). A genuinely standalone digit-only reference has no
 * adjacent digit on either side once normalized (a letter, punctuation stripped already, or
 * the start/end of the text sits next to it instead).
 */
function hasDigitOnlyWordBoundaryMatch(normalizedText: string, normalizedCandidate: string): boolean {
  let fromIndex = 0;
  for (;;) {
    const index = normalizedText.indexOf(normalizedCandidate, fromIndex);
    if (index === -1) return false;
    const before = index > 0 ? normalizedText[index - 1] : undefined;
    const after = index + normalizedCandidate.length < normalizedText.length ? normalizedText[index + normalizedCandidate.length] : undefined;
    if (!isDigit(before) && !isDigit(after)) return true;
    fromIndex = index + 1;
  }
}

/** One regex alternative per normalized keyword that tolerates the same separators
 * `normalizeToken` strips ("Re Nr", "Re.Nr.", "re-nr"), longest first so "Rechnungsnummer" is
 * tried before "Rechnung". */
const RAW_KEYWORD_ALTERNATION = [...NORMALIZED_INVOICE_NUMBER_KEYWORDS]
  .sort((a, b) => b.length - a.length)
  .map((keyword) => keyword.split("").join("[^A-Za-z0-9]*"))
  .join("|");

/** A keyword, then the digit runs of the number phrase that directly follows it, joined only by
 * "/" or "-" ("Re Nr. 21/ 24", "Rechnung 2024-21"). Matched on the RAW text: `normalizeToken`
 * would glue "21/ 24" into "2124" and lose where the invoice number ends. */
const KEYWORD_NUMBER_PHRASE = new RegExp(`(?:${RAW_KEYWORD_ALTERNATION})[^A-Za-z0-9]*(\\d+(?:\\s*[/-]\\s*\\d+)*)`, "gi");

/** The digit runs of every keyword-introduced number phrase: "Re Nr. 21/ 24" yields
 * `[["21", "24"]]`. The first run is the invoice number in the common German "number/year"
 * form, which is how customers write remittance lines ("Re Nr. 21/ 24" for invoice 21 of 2024). */
function keywordNumberPhrases(remittanceText: string): string[][] {
  const phrases: string[][] = [];
  for (const match of remittanceText.matchAll(KEYWORD_NUMBER_PHRASE)) {
    const phrase = match[1];
    if (phrase) phrases.push(phrase.split(/\s*[/-]\s*/));
  }
  return phrases;
}

/**
 * Returns every candidate (invoice numbers, customer numbers, ...) that appears, in its
 * tolerant normalized form, as a substring of the tolerant normalized remittance text -
 * a plain substring search once both sides are normalized already absorbs spacing, case,
 * separator (`-`, `/`, `.`), and leading/trailing prefix noise ("Rechnungsnummer: RE-2026-00002,
 * vielen Dank" still contains normalized "RE202600002"). An alphanumeric candidate normalizing
 * to fewer than `MIN_TOKEN_LENGTH` characters is skipped entirely (see that constant's own
 * comment); a `null`/empty `remittanceText` yields no matches for anything. The result
 * preserves the original candidate strings (not their normalized form) and their input order,
 * with duplicates removed.
 *
 * A digit-only candidate (no letter at all once normalized) follows its own, stricter rule
 * instead of `MIN_TOKEN_LENGTH`: it must either (a) clear `MIN_DIGIT_ONLY_TOKEN_LENGTH` AND
 * `hasDigitOnlyWordBoundaryMatch`, or (b) - decisions/0031's exception for a real short invoice
 * number like "12" - be immediately preceded by a recognized invoice-number keyword
 * (`hasKeywordPrecededDigitOnlyMatch`), or (c) be the FIRST digit run of a keyword-introduced
 * number phrase (`keywordNumberPhrases`), so "Re Nr. 21/ 24" finds invoice 21 even though the
 * normalized text reads "RENR2124". Only the first run counts here: this positive signal can
 * auto-confirm a match, so it stays strict, and "Re Nr. 21/ 24" never finds invoice 24. See each
 * function's own comment for why a bare number needs a stricter bar than an alphanumeric
 * reference like "RE-2026-00002" does.
 */
export function findInvoiceNumbers(remittanceText: string | null | undefined, candidates: readonly string[]): string[] {
  if (!remittanceText) return [];
  const normalizedText = normalizeToken(remittanceText);
  if (!normalizedText) return [];
  const firstRunsAfterKeyword = new Set(keywordNumberPhrases(remittanceText).map((runs) => runs[0]));

  const found: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    const normalizedCandidate = normalizeToken(candidate);
    if (normalizedCandidate.length === 0) continue;

    if (isDigitOnlyToken(normalizedCandidate)) {
      const clearsBareFloor = normalizedCandidate.length >= MIN_DIGIT_ONLY_TOKEN_LENGTH && hasDigitOnlyWordBoundaryMatch(normalizedText, normalizedCandidate);
      const keywordException = normalizedCandidate.length < MIN_DIGIT_ONLY_TOKEN_LENGTH && hasKeywordPrecededDigitOnlyMatch(normalizedText, normalizedCandidate);
      const firstRunOfPhrase = firstRunsAfterKeyword.has(normalizedCandidate);
      if (clearsBareFloor || keywordException || firstRunOfPhrase) {
        found.push(candidate);
        seen.add(candidate);
      }
      continue;
    }

    if (normalizedCandidate.length < MIN_TOKEN_LENGTH) continue;
    if (normalizedText.includes(normalizedCandidate)) {
      found.push(candidate);
      seen.add(candidate);
    }
  }
  return found;
}

/** decisions/0040: `true` when the WHOLE remittance text, normalized, is exactly the invoice
 * number ("37" for invoice 37). A bare short number is too weak on its own for
 * `findInvoiceNumbers`, but a payer who wrote nothing but the number, paired with an amount exact
 * to the cent, leaves no room for coincidence. The caller must require the exact amount. */
export function isWholeRemittanceInvoiceNumber(remittanceText: string | null | undefined, invoiceNumber: string | null | undefined): boolean {
  if (!remittanceText || !invoiceNumber) return false;
  const normalizedNumber = normalizeToken(invoiceNumber);
  return normalizedNumber.length > 0 && normalizeToken(remittanceText) === normalizedNumber;
}

/** Same tolerant matching as `findInvoiceNumbers`, named separately for callers that look for
 * a workspace's own customer number at a supplier ("Ihre Kundennummer") rather than an
 * invoice number - the matching mechanics are identical, only the semantic meaning of "found"
 * differs to a caller building `MatchReasonCode`s. */
export function findCustomerNumbers(remittanceText: string | null | undefined, candidates: readonly string[]): string[] {
  return findInvoiceNumbers(remittanceText, candidates);
}

/**
 * decisions/0033-contradicting-invoice-number-vetoes-a-match.md: every invoice-number token
 * `remittanceText` EXPLICITLY names, via one of `NORMALIZED_INVOICE_NUMBER_KEYWORDS` (the same
 * closed keyword list decisions/0031 already uses for the short-number exception) - a digit
 * run immediately following the keyword in its normalized form, so "Re.Nr. 12", "Re Nr. 15",
 * and "Rechnung 12" all extract their number regardless of the separator/spacing/case between
 * the keyword and the digits. Deliberately narrower than `findInvoiceNumbers`: a bare number
 * with no preceding keyword, a date, or a number introduced by an unrelated keyword (a
 * customer number - "Kundennummer", "Kd.Nr.", "KdNr" are simply not in this list) never
 * produces a reference here - the text must make an explicit INVOICE claim for a token to
 * count as one, since this function's only consumer (`hasContradictingInvoiceReference`) uses
 * absence of a reference to mean "nothing to contradict", not "found nothing to confirm".
 *
 * Returns a `Set` (not an array) because a text can legitimately name more than one reference
 * at once (a collective payment's remittance line covering several invoices) and every caller
 * only ever needs membership, never order or count. Returns an empty set when
 * `remittanceText` names none.
 *
 * Every plausible READING of a number phrase counts as a reference, because the only consumer
 * is a veto and a veto must fire only when no reading fits: "Re Nr. 21/ 24" yields "2124" (the
 * glued normalized run, which also covers a document numbered "21/24"), "21" (number/year) and
 * "24" (year/number, as in "Rechnung 2024/21"). This fixed a real false veto: invoice 21 paid
 * with "Re Nr. 21/ 24" was blocked because only "2124" was extracted.
 */
export function extractInvoiceReferences(remittanceText: string | null | undefined): ReadonlySet<string> {
  const references = new Set<string>();
  if (!remittanceText) return references;
  const normalizedText = normalizeToken(remittanceText);
  if (!normalizedText) return references;

  for (const runs of keywordNumberPhrases(remittanceText)) {
    for (const run of runs) references.add(run);
  }

  for (const keyword of NORMALIZED_INVOICE_NUMBER_KEYWORDS) {
    let fromIndex = 0;
    for (;;) {
      const index = normalizedText.indexOf(keyword, fromIndex);
      if (index === -1) break;
      const digitsStart = index + keyword.length;
      let digitsEnd = digitsStart;
      while (digitsEnd < normalizedText.length && isDigit(normalizedText[digitsEnd])) digitsEnd++;
      if (digitsEnd > digitsStart) references.add(normalizedText.slice(digitsStart, digitsEnd));
      fromIndex = index + 1;
    }
  }
  return references;
}

/**
 * decisions/0033: `true` when `remittanceText` explicitly names at least one invoice
 * reference (`extractInvoiceReferences`) and `invoiceNumber` - the CANDIDATE document's own
 * invoice number, normalized the same tolerant way - is not one of them. This is strong
 * NEGATIVE evidence (the text contradicts the candidate) meant to VETO a match in code,
 * regardless of how well the amount happens to line up or how confident an AI arbiter claims
 * to be - the real defect this exists for: a transaction whose remittance text read "Re Nr.
 * 15" was suggested by the AI arbiter for document 12 anyway (amount also differed, 905,00 vs
 * 480,00 EUR), with the model's own explanation noting the contradiction and suggesting the
 * match regardless.
 *
 * `false` (never a veto) when `invoiceNumber` is `null`/empty (a document with no invoice
 * number at all has nothing for the text to contradict) or when the text names no reference at
 * all (a bare amount match with no textual invoice mention either way is unaffected - this
 * function only fires on an explicit, actual contradiction, never on mere silence). `false`
 * also when the candidate's own number IS one of several references the text names (a
 * collective payment's remittance line naming more than one invoice matches as long as the
 * candidate is any one of them).
 */
export function hasContradictingInvoiceReference(remittanceText: string | null | undefined, invoiceNumber: string | null | undefined): boolean {
  if (!invoiceNumber) return false;
  const references = extractInvoiceReferences(remittanceText);
  if (references.size === 0) return false;
  // The document's own number is read as leniently as the text: payers routinely drop a letter
  // prefix or leading zeros ("RE-2026-00002" paid as "Re Nr. 2026-00002"), and a veto must never
  // fire on a difference that is only formatting.
  const normalized = normalizeToken(invoiceNumber);
  const digitsOnly = normalized.replace(/[A-Z]/g, "");
  const readings = [normalized, digitsOnly, stripLeadingZeros(digitsOnly)].filter((reading) => reading.length > 0);
  const referenceReadings = new Set([...references].flatMap((reference) => [reference, stripLeadingZeros(reference)]));
  return !readings.some((reading) => referenceReadings.has(reading));
}

function stripLeadingZeros(digits: string): string {
  return digits.replace(/^0+(?=\d)/, "");
}

/**
 * Jaccard token similarity (`@/modules/contacts`'s `nameSimilarity`) between two raw
 * (not-yet-normalized) names, in `[0, 1]`. `0` when either side is `null`/empty - deliberately
 * not `1` for "both absent", unlike `nameSimilarity` itself, since "we have no name to compare"
 * must never read as "the names match" to a caller building a match reason.
 */
export function counterpartyNameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0;
  const full = nameSimilarity(normalizeName(a), normalizeName(b));
  // decisions/0046: card payments carry the merchant name, then a comma and a location or URL
  // ("AUTOMATTIC,AUTOMATTIC.CO", "IONOS SE,MONTABAUR"); the suffix counts as extra words and
  // pushed a clear vendor match below the threshold. The name before the first comma is compared
  // too, and the better score wins, so this can only raise a similarity, never lower it.
  const merchantA = a.split(",")[0]!.trim();
  const merchantB = b.split(",")[0]!.trim();
  if (merchantA === a.trim() && merchantB === b.trim()) return full;
  return Math.max(full, nameSimilarity(normalizeName(merchantA), normalizeName(merchantB)), nameSimilarity(normalizeName(merchantA), normalizeName(b)));
}

/** decisions/0071: a card charge's statement descriptor is "MERCHANT *REFERENCE" ("FACEBK
 * *4TXV8WLN2B"), and the merchant prints the same reference on its receipt ("Referenznummer:
 * 4TXV8WLN2B"). The reference is the part directly after the asterisk. */
const STATEMENT_REFERENCE = /\*\s*([A-Za-z0-9]{6,})(?![A-Za-z0-9])/g;

/** A reference must not be an ordinary word or a short number: mixed letters and digits from 6
 * characters, or digits only from 8. */
function isPlausibleStatementReference(token: string): boolean {
  const hasDigit = /\d/.test(token);
  const hasLetter = /[A-Za-z]/.test(token);
  if (hasDigit && hasLetter) return token.length >= 6;
  return hasDigit && token.length >= 8;
}

/** decisions/0071: every card-descriptor reference a transaction carries, read from its
 * counterparty name and its remittance text (banks put the descriptor in either). Uppercased and
 * deduplicated; empty when the transaction is not a card charge in that shape. */
export function extractStatementReferences(tx: { counterpartyName: string | null; remittanceText: string | null }): string[] {
  const references = new Set<string>();
  for (const text of [tx.counterpartyName, tx.remittanceText]) {
    if (!text) continue;
    for (const match of text.matchAll(STATEMENT_REFERENCE)) {
      const token = match[1]!;
      if (isPlausibleStatementReference(token)) references.add(token.toUpperCase());
    }
  }
  return [...references];
}

/** decisions/0071: `true` when the document's own text names one of `references` as a whole
 * token (never inside a longer letter/digit run), case-insensitively. */
export function documentNamesStatementReference(documentText: string | null | undefined, references: readonly string[]): boolean {
  if (!documentText || references.length === 0) return false;
  const upper = documentText.toUpperCase();
  return references.some((reference) => new RegExp(`(?<![A-Z0-9])${reference}(?![A-Z0-9])`).test(upper));
}
