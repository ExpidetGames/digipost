// Pure amount/currency parsing for the invoice-shaped extraction fields
// (decisions/0021-extraction-direction-and-invoice-fields.md). The model's own arithmetic is
// never trusted (architecture brief's product decision 8): it is asked for the amount exactly
// as printed on the document (e.g. "1.083,68 EUR"), and this file turns that raw text into an
// integer cent amount deterministically, in code. Used by both the real Mistral adapter's
// validation (`@/platform/mistral/server/mistral-analyzer.ts`, through
// `validateAnalysisResult`) and the deterministic fake analyzer, so both providers give every
// caller the identical guarantee.
//
// Handles German (`1.083,68`, dot thousands / comma decimal) and US/international
// (`1,083.68`, comma thousands / dot decimal) formats, a plain decimal (`1083.68`), a bare
// integer with a currency label (`EUR 12`), and a negative/credit-note amount (a leading `-`,
// a trailing `-`, or accounting-style parentheses).
const CURRENCY_SIGN_RE = /€|\bEUR\b|\bEuro\b/i;
const NEGATIVE_PREFIX_RE = /^\s*-/;
const NEGATIVE_SUFFIX_RE = /-\s*$/;
const PARENTHESIZED_RE = /^\s*\(.*\)\s*$/;

/**
 * `null` for an absent/empty/unparseable input - the caller then leaves `totalAmountCents`
 * `null` rather than guessing (same "extraction must never fail" rule every other field
 * follows). A decimal separator is only recognized as such when exactly 1-2 digits follow it
 * (a real cents part); a 3-digit group after a `.`/`,` is treated as a thousands separator
 * instead (`"1.083"` with no further decimal part is 1083, not 1.083).
 */
export function parseGermanAmountToCents(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const negative = NEGATIVE_PREFIX_RE.test(trimmed) || NEGATIVE_SUFFIX_RE.test(trimmed) || PARENTHESIZED_RE.test(trimmed);

  // Keep only digits, `.`, `,` - strips currency symbols/labels, whitespace, parentheses, and
  // the sign itself (handled separately above, so a lone "-" surviving here would otherwise
  // corrupt the digit-only parsing below).
  const cleaned = trimmed.replace(/[^0-9.,]/g, "");
  if (!cleaned) return null;

  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");

  let integerPart: string;
  let fractionPart = "";

  if (lastComma === -1 && lastDot === -1) {
    integerPart = cleaned;
  } else {
    const decimalIndex = Math.max(lastComma, lastDot);
    const fractionCandidate = cleaned.slice(decimalIndex + 1);
    if (fractionCandidate.length > 0 && fractionCandidate.length <= 2 && /^\d+$/.test(fractionCandidate)) {
      integerPart = cleaned.slice(0, decimalIndex).replace(/[.,]/g, "");
      fractionPart = fractionCandidate;
    } else {
      integerPart = cleaned.replace(/[.,]/g, "");
    }
  }

  if (!/^\d*$/.test(integerPart)) return null;
  const normalizedInteger = integerPart.replace(/^0+(?=\d)/, "") || "0";
  const normalizedFraction = (fractionPart + "00").slice(0, 2);

  const cents = Number(normalizedInteger) * 100 + Number(normalizedFraction);
  if (!Number.isFinite(cents)) return null;
  return negative ? -cents : cents;
}

const ISO_CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * `modelCurrency` wins when it already looks like a plausible ISO 4217 code; otherwise falls
 * back to `"EUR"` when `rawAmountText` contains a euro sign or the word "EUR"/"Euro" (the
 * overwhelmingly common case for this product's German-market documents), and `null`
 * otherwise - never a guessed currency with no textual basis.
 */
export function inferCurrency(rawAmountText: string | null | undefined, modelCurrency: unknown): string | null {
  const candidate = typeof modelCurrency === "string" ? modelCurrency.trim().toUpperCase() : "";
  if (ISO_CURRENCY_RE.test(candidate)) return candidate;
  if (rawAmountText && CURRENCY_SIGN_RE.test(rawAmountText)) return "EUR";
  return null;
}
