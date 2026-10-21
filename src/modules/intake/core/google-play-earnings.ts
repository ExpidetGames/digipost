// Deterministic reader for Google Play's monthly earnings report ("PlayApps_YYYYMM.csv" style
// export, decisions/0048-app-store-reports.md). Self-identifying, exactly like camt.053/MT940/
// Apple's own payment summary in this same directory: an exact, closed header this application
// has no other reason to see, recognized without ever asking the model.
//
// Shape: one row per order/adjustment, `Transaction Type` telling apart a `Charge` (revenue),
// a `Google fee` (Google's own cut, already a negative amount in the source), a `Refund`, a
// `Google fee refund` (a reversed fee, already a positive amount in the source - this reader
// never flips a sign itself, the source states it correctly either way), and anything else
// (`Tax`, ...) treated as a plain adjustment that still counts toward the report's own net but
// produces no `gross`/`fee` ledger draft on its own (mirrors decisions/0026-platform-settlements.md's
// own "a row with neither contributes nothing beyond its own fields" rule). English dates
// (`"Jan 5, 2025"`) and a quoted comma inside them are the reason the generic tabular path
// rejected this file before this phase - see `file-kind.ts`'s quote-aware delimiter count.
import { parse as parseCsvSync } from "csv-parse/sync";

import { parseAmountToCents, US_AMOUNT_FORMAT } from "./amount-parsing";
import type { NormalizedSettlementLine } from "./mapping-validator";

export const GOOGLE_PLAY_EARNINGS_ERROR = {
  notRecognized: "not_google_play_earnings",
  noDataRows: "google_play_earnings_no_rows",
  /** A row's `Transaction Date`/`Amount (Merchant Currency)` could not be parsed - this reader
   * is strict (decisions/0020-universal-intake.md's "code verifies" standard): a report this
   * confident about its own shape never silently drops or zeroes a row it cannot make sense of. */
  unparseableRow: "google_play_earnings_unparseable_row",
} as const;
export type GooglePlayEarningsErrorCode = (typeof GOOGLE_PLAY_EARNINGS_ERROR)[keyof typeof GOOGLE_PLAY_EARNINGS_ERROR];

export class GooglePlayEarningsParseError extends Error {
  override readonly name = "GooglePlayEarningsParseError";
  constructor(
    readonly code: GooglePlayEarningsErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// decisions/0051: recognized by the columns this reader actually reads, not by the full header.
// Google renamed columns in November 2025 ("Product id" -> "Package ID", "Base Plan ID" ->
// "Base Plan or Purchase Option ID") and added "Sales Channel"; an exact full-header match
// rejected those reports. Column positions come from the file's own header row.
const REQUIRED_COLUMNS = [
  "Description",
  "Transaction Date",
  "Transaction Type",
  "Product Title",
  "Buyer Country",
  "Merchant Currency",
  "Amount (Merchant Currency)",
] as const;

// decisions/0052: only Google's own commission counts as a fee line, and only it is deducted
// (`buildSettlementLineDrafts` books a fee as a deduction, because Stripe states its fees as
// positive numbers). Every other row - a charge, a refund, a tax withheld, a REFUNDED fee, an
// unknown future type - goes to the revenue side with its own sign, so no row is ever dropped and
// the imported lines always add up to the report's own net.
const FEE_TRANSACTION_TYPES = ["Google fee"] as const;

function parseCsv(text: string): string[][] {
  return parseCsvSync(text, { relax_column_count: true, relax_quotes: true, skip_empty_lines: true, bom: true }) as string[][];
}

function headerMatches(row: readonly string[]): boolean {
  const names = row.map((cell) => (cell ?? "").trim());
  return REQUIRED_COLUMNS.every((column) => names.includes(column));
}

/** Cheap detection - never throws, mirrors `apple-payment-summary.ts`'s
 * `detectApplePaymentSummary`. */
export function detectGooglePlayEarnings(text: string): boolean {
  try {
    const records = parseCsv(text);
    return headerMatches(records[0] ?? []);
  } catch {
    return false;
  }
}

const GOOGLE_DATE_PATTERN = /^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})$/;
const ENGLISH_MONTH_ABBREVIATIONS: Record<string, number> = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  May: 5,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12,
};

/** `"Jan 5, 2025"` -> `"2025-01-05"` - the one shape `mapping-validator.ts`'s own
 * `parseDateToIso` does not recognize (decisions/0048-app-store-reports.md's own motivation),
 * kept local to this reader rather than added there since this format is never routed through
 * `validateMapping` at all. */
function parseGoogleDate(raw: string): string | null {
  const match = GOOGLE_DATE_PATTERN.exec(raw.trim());
  if (!match) return null;
  const month = ENGLISH_MONTH_ABBREVIATIONS[match[1]!];
  if (!month) return null;
  return `${match[3]}-${String(month).padStart(2, "0")}-${match[2]!.padStart(2, "0")}`;
}

export type GooglePlayEarningsResult = {
  /** ISO `YYYY-MM` - the month of the transactions. A file whose rows span more than one
   * calendar month (not expected of a real monthly export) resolves to the EARLIEST month
   * present - a documented limitation, see decisions/0048-app-store-reports.md's "Known
   * limits". */
  period: string;
  /** The sum of every row's own signed `Amount (Merchant Currency)`, matching what the task's
   * own reconciliation calls "net" - revenue minus fees minus refunds, whatever the report's
   * rows actually state. */
  netAmountCents: number;
  /** The report's own `Merchant Currency` column - assumed uniform across every row of one
   * report (every fixture seen so far states the same currency throughout), read from the
   * first data row. Falls back to `"EUR"` for the pathological case of a row with an empty
   * cell there. */
  merchantCurrency: string;
  lines: NormalizedSettlementLine[];
};

/**
 * Parses a Google Play earnings CSV already recognized by `detectGooglePlayEarnings`.
 * Deterministic: no model call, no confirmation gate - see this file's own header comment.
 * Strict like `apple-payment-summary.ts`: throws rather than silently skipping a row it cannot
 * fully parse.
 */
export function parseGooglePlayEarnings(text: string): GooglePlayEarningsResult {
  const records = parseCsv(text);
  const header = records[0] ?? [];
  if (!headerMatches(header)) {
    throw new GooglePlayEarningsParseError(GOOGLE_PLAY_EARNINGS_ERROR.notRecognized, "Not a recognized Google Play earnings report - sniff the file first.");
  }

  const dataRows = records.slice(1);
  if (dataRows.length === 0) {
    throw new GooglePlayEarningsParseError(GOOGLE_PLAY_EARNINGS_ERROR.noDataRows, "Google Play earnings report has no transaction rows.");
  }

  const headerNames = header.map((cell) => (cell ?? "").trim());
  const columnIndex = (name: (typeof REQUIRED_COLUMNS)[number]): number => headerNames.indexOf(name);
  const descriptionIndex = columnIndex("Description");
  const dateIndex = columnIndex("Transaction Date");
  const typeIndex = columnIndex("Transaction Type");
  const productTitleIndex = columnIndex("Product Title");
  const buyerCountryIndex = columnIndex("Buyer Country");
  const amountIndex = columnIndex("Amount (Merchant Currency)");
  const merchantCurrencyIndex = columnIndex("Merchant Currency");
  const merchantCurrency = (dataRows[0]?.[merchantCurrencyIndex] ?? "").trim() || "EUR";

  let netAmountCents = 0;
  const periods = new Set<string>();

  const lines: NormalizedSettlementLine[] = dataRows.map((row, index): NormalizedSettlementLine => {
    const rowNumber = index + 1;
    const dateRaw = row[dateIndex] ?? "";
    const bookingDate = parseGoogleDate(dateRaw);
    if (!bookingDate) {
      throw new GooglePlayEarningsParseError(GOOGLE_PLAY_EARNINGS_ERROR.unparseableRow, `Row ${rowNumber}: unreadable Transaction Date "${dateRaw}".`);
    }
    periods.add(bookingDate.slice(0, 7));

    const amountRaw = row[amountIndex] ?? "";
    const amountCents = parseAmountToCents(amountRaw, US_AMOUNT_FORMAT);
    if (amountCents === null) {
      throw new GooglePlayEarningsParseError(GOOGLE_PLAY_EARNINGS_ERROR.unparseableRow, `Row ${rowNumber}: unreadable Amount (Merchant Currency) "${amountRaw}".`);
    }
    netAmountCents += amountCents;

    const type = (row[typeIndex] ?? "").trim();
    const isFee = (FEE_TRANSACTION_TYPES as readonly string[]).includes(type);
    const orderId = (row[descriptionIndex] ?? "").trim() || null;
    const productName = (row[productTitleIndex] ?? "").trim() || null;

    return {
      rowNumber,
      bookingDate,
      grossCents: isFee ? null : amountCents,
      feeCents: isFee ? amountCents : null,
      netCents: amountCents,
      payoutId: null,
      customerName: null,
      customerEmail: null,
      invoiceNumber: null,
      chargeId: orderId,
      productName,
      quantity: null,
      countryOfSale: (row[buyerCountryIndex] ?? "").trim() || null,
      description: productName ? `${type}: ${productName}` : type || null,
    };
  });

  const period = [...periods].sort()[0] ?? null;
  if (!period) {
    // Unreachable in practice (every row already threw above if its own date failed to
    // parse), kept as a defensive fallback rather than a non-null assertion.
    throw new GooglePlayEarningsParseError(GOOGLE_PLAY_EARNINGS_ERROR.noDataRows, "Google Play earnings report has no dated rows.");
  }

  return { period, netAmountCents, merchantCurrency, lines };
}
