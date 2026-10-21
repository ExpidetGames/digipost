// Locale-aware decimal-amount parsing, shared by `tabular-sample.ts` (format detection for
// the model-facing sample) and `mapping-validator.ts` (turning every row's raw cell into
// cents once a mapping is confirmed). Pure, no I/O.

export type DecimalSeparator = "." | ",";
export type ThousandsSeparator = "." | "," | " " | null;

export type AmountFormat = {
  decimalSeparator: DecimalSeparator;
  thousandsSeparator: ThousandsSeparator;
};

/** German/Austrian convention: "1.083,68" -> 108368 cents. */
export const GERMAN_AMOUNT_FORMAT: AmountFormat = { decimalSeparator: ",", thousandsSeparator: "." };
/** US/UK convention: "1,083.68" -> 108368 cents. */
export const US_AMOUNT_FORMAT: AmountFormat = { decimalSeparator: ".", thousandsSeparator: "," };
/** No thousands grouping observed, decimal comma: "1083,68". */
export const PLAIN_COMMA_AMOUNT_FORMAT: AmountFormat = { decimalSeparator: ",", thousandsSeparator: null };
/** No thousands grouping observed, decimal point: "1083.68". */
export const PLAIN_POINT_AMOUNT_FORMAT: AmountFormat = { decimalSeparator: ".", thousandsSeparator: null };

const GERMAN_THOUSANDS_PATTERN = /^-?\d{1,3}(\.\d{3})+,\d{1,2}$/;
const US_THOUSANDS_PATTERN = /^-?\d{1,3}(,\d{3})+\.\d{1,2}$/;
const PLAIN_COMMA_PATTERN = /^-?\d+,\d{1,2}$/;
const PLAIN_POINT_PATTERN = /^-?\d+\.\d{1,2}$/;

/** Strips a leading/trailing currency symbol or ISO code and surrounding whitespace before
 * format detection/parsing - "1.083,68 EUR", "€ 1.083,68", and "1.083,68" all detect the
 * same way. */
function stripCurrencyDecoration(value: string): string {
  return value
    .trim()
    .replace(/^[€$£]\s*/, "")
    .replace(/\s*[€$£]$/, "")
    .replace(/^(EUR|USD|GBP)\s*/i, "")
    .replace(/\s*(EUR|USD|GBP)$/i, "")
    .trim();
}

/**
 * Detects the dominant amount format among a column's sample values (majority vote across
 * the four known shapes). Returns `null` when no value matches any recognized shape at all -
 * the caller then has nothing to base a decision on.
 */
export function detectAmountFormat(sampleValues: string[]): AmountFormat | null {
  const votes = { german: 0, us: 0, plainComma: 0, plainPoint: 0 };
  for (const raw of sampleValues) {
    const value = stripCurrencyDecoration(raw);
    if (value.length === 0) continue;
    if (GERMAN_THOUSANDS_PATTERN.test(value)) votes.german++;
    else if (US_THOUSANDS_PATTERN.test(value)) votes.us++;
    else if (PLAIN_COMMA_PATTERN.test(value)) votes.plainComma++;
    else if (PLAIN_POINT_PATTERN.test(value)) votes.plainPoint++;
  }
  // A thousands-grouped value is an unambiguous signal (a plain "250,00" is compatible with
  // *either* German or US-without-grouping, but "1.083,68" can only be German) - it always
  // wins over a majority of merely-plain values in the same sample, rather than a flat vote
  // count letting a handful of small, ungrouped amounts outvote the one large one that
  // actually reveals the format.
  if (votes.german > 0 || votes.us > 0) return votes.german >= votes.us ? GERMAN_AMOUNT_FORMAT : US_AMOUNT_FORMAT;
  if (votes.plainComma > 0 || votes.plainPoint > 0) return votes.plainComma >= votes.plainPoint ? PLAIN_COMMA_AMOUNT_FORMAT : PLAIN_POINT_AMOUNT_FORMAT;
  return null;
}

/**
 * Parses one cell into signed cents using a known `format`. Returns `null` when the value,
 * after stripping currency decoration and accounting-style parentheses for negatives, is not
 * a plausible number - `mapping-validator.ts` turns that into a row-level problem rather than
 * silently coercing to zero.
 */
export function parseAmountToCents(rawValue: string, format: AmountFormat): number | null {
  let value = stripCurrencyDecoration(rawValue);
  if (value.length === 0) return null;

  let negative = false;
  const parenMatch = /^\((.*)\)$/.exec(value);
  if (parenMatch) {
    negative = true;
    value = parenMatch[1]!.trim();
  }
  if (value.startsWith("-")) {
    negative = true;
    value = value.slice(1);
  } else if (value.startsWith("+")) {
    value = value.slice(1);
  }

  if (format.thousandsSeparator) {
    value = value.split(format.thousandsSeparator).join("");
  }

  const decimalIndex = value.lastIndexOf(format.decimalSeparator);
  const wholePart = decimalIndex === -1 ? value : value.slice(0, decimalIndex);
  const fractionPart = decimalIndex === -1 ? "" : value.slice(decimalIndex + 1);

  if (wholePart.length === 0 && fractionPart.length === 0) return null;
  if (!/^\d*$/.test(wholePart) || !/^\d*$/.test(fractionPart)) return null;

  const fraction = `${fractionPart}00`.slice(0, 2);
  const cents = Number(wholePart || "0") * 100 + Number(fraction);
  return negative ? -cents : cents;
}
