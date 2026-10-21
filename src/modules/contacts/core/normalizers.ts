// Owner: src/modules/contacts (decisions/0019-contacts.md). Pure functions, no I/O, no
// framework imports - every one of these is unit-tested table-driven
// (`tests/normalizers.test.ts`). German umlauts (ä/ö/ü/ß) are deliberately kept intact
// everywhere: this module never transliterates them (e.g. "ä" -> "ae"), only lowercases,
// strips whitespace/punctuation, or removes a legal-form suffix.

/** VAT id (USt-IdNr.) normalization: uppercase, strip all whitespace. Used both to populate
 * `contacts.vat_id_normalized` and as the strongest matching key
 * (decisions/0019-contacts.md). Does not validate the format - see `format-checks.ts` for
 * that (a separate, non-blocking concern). */
export function normalizeVatId(raw: string): string {
  return raw.toUpperCase().replace(/\s+/g, "");
}

/** IBAN normalization: same shape as `normalizeVatId` (uppercase, strip whitespace) - IBANs
 * are conventionally displayed in space-separated 4-character groups
 * ("DE12 3456 7890 1234 5678 90"), which must not defeat matching against the same IBAN
 * stored without spaces. */
export function normalizeIban(raw: string): string {
  return raw.toUpperCase().replace(/\s+/g, "");
}

/** Legal-form suffixes stripped from the end of a company name for matching purposes,
 * longest (most specific) first so "GmbH & Co. KG" is removed as one unit rather than
 * leaving a dangling "& Co." after a naive "GmbH" strip. Each entry is already lowercased
 * and stripped of periods/commas - `normalizeName` compares against the already-punctuation-
 * stripped working string. */
// "&" is stripped to a plain space before this list is consulted (`normalizeName`'s first
// pass), so "GmbH & Co. KG" reaches this list as the already-collapsed "gmbh co kg" - every
// entry here is written the same, post-"&"-removal way.
const LEGAL_FORM_SUFFIXES = [
  "gmbh co kg",
  "gmbh co",
  "gmbh",
  "mbh",
  "ag co kg",
  "ag",
  "kg",
  "ohg",
  "ug haftungsbeschraenkt",
  "ug",
  "e k",
  "ek",
  "e v",
  "ev",
  "co kg",
].sort((a, b) => b.length - a.length);

/**
 * Name normalization for matching (decisions/0019-contacts.md's matching order, rule 5, and
 * the fallback "customerNumber + name similarity" comparison in rule 4): lowercase, strip
 * punctuation, collapse whitespace, then strip one trailing legal-form suffix (applied
 * repeatedly, since "GmbH & Co. KG" strips as two tokens after punctuation removal turns
 * "Co." into "co"). German umlauts (ä/ö/ü/ß) are kept intact throughout - this is a
 * formatting normalization, not a transliteration.
 *
 * `normalizeName("Musterwerk GmbH") === normalizeName("musterwerk") === "musterwerk"`.
 */
export function normalizeName(raw: string): string {
  let s = raw
    .toLowerCase()
    // Strip punctuation (keep letters incl. umlauts/ß, digits, and spaces). "&" is treated
    // as a separator too (a company name's "Müller & Söhne" and a hypothetical
    // "Müller&Söhne" must normalize the same way).
    .replace(/[.,;:!?'"()/\\_&-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let strippedSomething = true;
  while (strippedSomething) {
    strippedSomething = false;
    for (const suffix of LEGAL_FORM_SUFFIXES) {
      if (s === suffix) {
        s = "";
        strippedSomething = true;
        break;
      }
      if (s.endsWith(` ${suffix}`)) {
        s = s.slice(0, -(suffix.length + 1)).trim();
        strippedSomething = true;
        break;
      }
    }
  }

  return s;
}

/** Loose normalization for plain display fields (address lines, phone, email, ...) used
 * only to decide "is this the same value with different formatting" when diffing an
 * extraction against an existing contact (`verification.ts`'s `computeContactUpdatePlan`) -
 * never stored, never used for the strong/weak matching rules. Case-insensitive, trimmed,
 * internal whitespace collapsed. */
export function normalizePlainText(raw: string): string {
  return raw.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Token-based Jaccard similarity between two already-normalized names (see `normalizeName`),
 * in `[0, 1]`. `1` for identical strings (including both empty), `0` when either side is
 * empty and the other is not. Deliberately simple and deterministic (no fuzzy/edit-distance
 * library dependency) - good enough to tell "Musterwerk GmbH" apart from "Musterwerk Handel
 * GmbH" (a real, different company) while still equating "Musterwerk GmbH" with plain
 * "musterwerk".
 */
export function nameSimilarity(normalizedA: string, normalizedB: string): number {
  if (normalizedA === normalizedB) return 1;
  const tokensA = new Set(normalizedA.split(" ").filter(Boolean));
  const tokensB = new Set(normalizedB.split(" ").filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersectionSize = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersectionSize++;
  }
  const unionSize = tokensA.size + tokensB.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

/** The longest a shortened company name may get before `shortenCompanyName` cuts it at a
 * word boundary. Sized so the common German company name survives whole ("Telekom
 * Deutschland" is 21) while a long one still fits a list row. */
export const SHORT_COMPANY_NAME_MAX_LENGTH = 22;

/** See `shortenCompanyName`: display only, never consulted by `normalizeName`. Entries are
 * compared after `normalizeName` has lowercased the token and stripped its punctuation, so
 * "Inc." and "inc" both arrive here as "inc". */
const DISPLAY_ONLY_LEGAL_FORMS = new Set(["inc", "ltd", "limited", "llc", "llp", "corp", "corporation", "plc", "pbc", "bv", "nv", "sa", "sas", "srl", "se", "oy", "aps"]);

/**
 * A company name trimmed down for display (decisions/0059-generated-document-names.md), in
 * its own original casing: the legal form comes off the end, then the rest is cut at a word
 * boundary if it is still longer than `maxLength`.
 *
 * A German legal form is found by asking `normalizeName` rather than by matching a second
 * list of suffixes: a trailing word is dropped whenever dropping it leaves `normalizeName`
 * unchanged, which is exactly the definition of "that word was legal form or punctuation", so
 * "Muster GmbH & Co. KG" shortens to "Muster" without this function knowing what a "KG" is.
 * A non-German one comes off through `DISPLAY_ONLY_LEGAL_FORMS`, which exists only here.
 * Returns the trimmed input unchanged when nothing can be dropped, and never returns "" for a
 * non-empty input.
 */
export function shortenCompanyName(raw: string, maxLength: number = SHORT_COMPANY_NAME_MAX_LENGTH): string {
  const target = normalizeName(raw);
  let words = raw.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";

  // Non-German legal forms, dropped for DISPLAY only and deliberately kept out of
  // `LEGAL_FORM_SUFFIXES` above: that list decides whether two names are the same company
  // (decisions/0019-contacts.md's matching rules), and widening it would change matching
  // behaviour to make a label read better. Here the only cost of being wrong is a slightly
  // shorter name on a row.
  while (words.length > 1 && DISPLAY_ONLY_LEGAL_FORMS.has(normalizeName(words[words.length - 1]!))) {
    words = words.slice(0, -1);
  }

  // Dropping a trailing word that does not change the normalized name removes only legal
  // form or punctuation. A name that is NOTHING but a legal form ("GmbH") normalizes to the
  // empty string, and then every word qualifies - `words.length > 1` keeps one word standing
  // so this never returns "".
  while (words.length > 1 && normalizeName(words.slice(0, -1).join(" ")) === target) {
    words = words.slice(0, -1);
  }

  // A dropped legal form can leave the separator that introduced it behind ("Notion Labs,
  // Inc." -> "Notion Labs,").
  const shortened = words.join(" ").replace(/[,;]+$/, "").trim();
  if (shortened.length <= maxLength) return shortened;

  const cut = shortened.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}
