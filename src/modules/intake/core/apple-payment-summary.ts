// Deterministic reader for Apple's "iTunes Connect - Zahlungen und Finanzberichte" monthly
// payment summary (decisions/0048-app-store-reports.md). Self-identifying, exactly like
// camt.053/MT940 (decisions/0020-universal-intake.md, decisions/0028-mt940-support.md): the
// title cell and the column header are an exact, closed shape no other CSV this application
// sees plausibly produces by accident, so this file recognizes and parses the report without
// ever asking the model.
//
// The real export (German UI) has a distinctive, ragged CSV shape a generic tabular
// reader/mapper is not built for: a title row whose one quoted cell embeds a TAB before the
// reporting period ("...Finanzberichte<TAB>(Januar, 2025)"), an empty row, the actual header,
// one row per region sold in, an empty row, then a footer cell stating the payout amount and
// currency together ("61.51 EUR") and a second footer line naming the payout bank account.
// `sniffFileKind` already tolerates the title/footer rows' different field counts
// (`file-kind.ts`'s quorum-based delimiter check); this file does the actual structural
// recognition and field extraction.
import { parse as parseCsvSync } from "csv-parse/sync";

import { parseAmountToCents, US_AMOUNT_FORMAT } from "./amount-parsing";
import type { NormalizedSettlementLine } from "./mapping-validator";

export const APPLE_PAYMENT_SUMMARY_ERROR = {
  /** `parseApplePaymentSummary` called on text `detectApplePaymentSummary` would not have
   * recognized - callers are expected to sniff first, mirroring `Mt940ParseError.notMt940`. */
  notRecognized: "not_apple_payment_summary",
  /** The title/header were recognized but no region row followed before the next blank
   * line - a title-only or truncated export. */
  noDataRows: "apple_payment_summary_no_rows",
} as const;
export type ApplePaymentSummaryErrorCode = (typeof APPLE_PAYMENT_SUMMARY_ERROR)[keyof typeof APPLE_PAYMENT_SUMMARY_ERROR];

export class ApplePaymentSummaryParseError extends Error {
  override readonly name = "ApplePaymentSummaryParseError";
  constructor(
    readonly code: ApplePaymentSummaryErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const TITLE_DE = "iTunes Connect - Zahlungen und Finanzberichte";
// GUESS, not verified against a real English-locale export (the owner's own report is
// German-only) - decisions/0048-app-store-reports.md's "Known limits" documents this
// explicitly. If a real English report ever surfaces with different column names, this table
// (and its fixture) needs updating; until then this is this reader's best-effort guess at
// Apple's own English column names, mirrored 1:1 from the German ones' meaning.
const TITLE_EN = "iTunes Connect - Payments and Financial Reports";

// Column order is meaningful (index-based lookup below), not just presence: region+currency,
// units sold, gross sales in local currency, the same before tax, VAT, adjustments,
// withholding tax, total owed in local currency, exchange rate to the bank currency, proceeds
// IN THE BANK CURRENCY (the field this reader actually books), bank account currency.
// decisions/0053: the columns Apple actually varies between months (a "Saldo" column appears,
// "Teilsaldo vor Steuern" and even "Wechselkurs" can be missing), so a report is recognized by
// the few columns this reader reads, found by name in the file's own header row.
const REQUIRED_COLUMNS = {
  de: { region: "Land oder Region (Währung)", units: "Verkaufte Einheiten", proceeds: "Gewinn", bankCurrency: "Bankkontowährung" },
  // GUESS (see TITLE_EN's own comment): Apple's English wording for the same four columns.
  en: { region: "Country or Region (Currency)", units: "Units Sold", proceeds: "Proceeds", bankCurrency: "Bank Account Currency" },
} as const;

/** decisions/0054: a month whose payout was returned (a blocked bank account) carries its amount
 * into the next report's "Saldo" column, and that month's "Gewinn" then contains the carried money
 * as well. Both columns only exist in such a month. */
const CARRIED_BALANCE_COLUMNS = {
  de: { carried: "Saldo", exchangeRate: "Wechselkurs" },
  // GUESS, like the rest of the English wording.
  en: { carried: "Balance", exchangeRate: "Exchange Rate" },
} as const;


const GERMAN_MONTHS: Record<string, number> = {
  Januar: 1,
  Februar: 2,
  März: 3,
  April: 4,
  Mai: 5,
  Juni: 6,
  Juli: 7,
  August: 8,
  September: 9,
  Oktober: 10,
  November: 11,
  Dezember: 12,
};
const ENGLISH_MONTHS: Record<string, number> = {
  January: 1,
  February: 2,
  March: 3,
  April: 4,
  May: 5,
  June: 6,
  July: 7,
  August: 8,
  September: 9,
  October: 10,
  November: 11,
  December: 12,
};

function parseCsv(text: string): string[][] {
  return parseCsvSync(text, { relax_column_count: true, relax_quotes: true, skip_empty_lines: false, bom: true }) as string[][];
}

/** The title cell is one quoted CSV field with the report name and the reporting period
 * joined by a literal tab character (confirmed against the owner's own real export) - never a
 * second CSV column, since the period text itself contains a comma ("Januar, 2025") that would
 * otherwise look like another field. */
function splitTitleCell(cell: string): { title: string; periodRaw: string } | null {
  const tabIndex = cell.indexOf("\t");
  if (tabIndex === -1) return null;
  return { title: cell.slice(0, tabIndex).trim(), periodRaw: cell.slice(tabIndex + 1).trim() };
}

const PERIOD_PATTERN = /^\(([^,]+),\s*(\d{4})\)$/;

function periodFromRaw(periodRaw: string, months: Record<string, number>): string | null {
  const match = PERIOD_PATTERN.exec(periodRaw);
  if (!match) return null;
  const month = months[match[1]!.trim()];
  if (!month) return null;
  return `${match[2]}-${String(month).padStart(2, "0")}`;
}

function trimRow(row: string[]): string[] {
  return row.map((cell) => cell.trim());
}

/** A header row "matches" when its cells equal `expected` in order - trailing empty cells
 * (the file's own trailing comma) are ignored, but nothing in between may differ: this is a
 * self-identifying format, an approximate match would risk silently misreading an unrelated
 * report as Apple's. */
function resolveColumns(row: string[], language: "de" | "en"): ApplePreamble["columns"] | null {
  const names = trimRow(row);
  const wanted = REQUIRED_COLUMNS[language];
  const optional = CARRIED_BALANCE_COLUMNS[language];
  const region = names.indexOf(wanted.region);
  const units = names.indexOf(wanted.units);
  const proceeds = names.indexOf(wanted.proceeds);
  const bankCurrency = names.indexOf(wanted.bankCurrency);
  if (region === -1 || units === -1 || proceeds === -1 || bankCurrency === -1) return null;
  const carried = names.indexOf(optional.carried);
  const exchangeRate = names.indexOf(optional.exchangeRate);
  return { region, units, proceeds, carried: carried === -1 ? null : carried, exchangeRate: exchangeRate === -1 ? null : exchangeRate };
}

type ApplePreamble = {
  headerRowIndex: number;
  language: "de" | "en";
  period: string;
  columns: { region: number; units: number; proceeds: number; carried: number | null; exchangeRate: number | null };
};

/** Cheap-ish structural recognition shared by `detectApplePaymentSummary` and
 * `parseApplePaymentSummary`: the title cell (row 0) names Apple's report in one of the two
 * known languages and states a parseable period, AND one of the next few rows is an exact
 * header match in that same language. Both conditions must hold - a title alone (a differently
 * shaped report happening to reuse Apple's own product name somewhere) is not enough. */
function findPreamble(records: readonly string[][]): ApplePreamble | null {
  const titleCell = records[0]?.[0];
  if (!titleCell) return null;
  const split = splitTitleCell(titleCell);
  if (!split) return null;

  let language: "de" | "en";
  let period: string | null;
  if (split.title === TITLE_DE) {
    language = "de";
    period = periodFromRaw(split.periodRaw, GERMAN_MONTHS);
  } else if (split.title === TITLE_EN) {
    language = "en";
    period = periodFromRaw(split.periodRaw, ENGLISH_MONTHS);
  } else {
    return null;
  }
  if (!period) return null;

  const searchLimit = Math.min(records.length, 10);
  for (let index = 1; index < searchLimit; index++) {
    const columns = resolveColumns(records[index] ?? [], language);
    if (columns) return { headerRowIndex: index, language, period, columns };
  }
  return null;
}

/** Cheap detection for `sniffFileKind`-adjacent branching (`decideIntakeBranch`) - never
 * throws, mirrors `detectCamt053`'s own "a bare boolean-ish check" role. */
export function detectApplePaymentSummary(text: string): boolean {
  try {
    return findPreamble(parseCsv(text)) !== null;
  } catch {
    return false;
  }
}

function periodEndIsoDate(period: string): string {
  const [year, month] = period.split("-").map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${period}-${String(lastDay).padStart(2, "0")}`;
}

const FOOTER_AMOUNT_PATTERN = /^([\d.,]+)\s+([A-Z]{3})$/;

/** The footer states the payout total and its currency in ONE cell, at the same column index
 * as the "Gewinn"/"Proceeds" column above it ("61.51 EUR") - scanned for from the first row
 * after the data block, stopping at the first match (the very next non-blank row in every
 * fixture seen so far; scanning a few more costs nothing and tolerates an extra blank line). */
/** The carried balance of `row`, converted with the report's own exchange rate into the bank's
 * account currency - `0` when this report has no carried-balance column or this row none. */
function carriedInBankCurrency(row: readonly string[], columns: ApplePreamble["columns"]): number {
  if (columns.carried === null) return 0;
  const carriedRaw = (row[columns.carried] ?? "").trim();
  if (!carriedRaw) return 0;
  const carriedCents = parseAmountToCents(carriedRaw, US_AMOUNT_FORMAT);
  if (carriedCents === null) return 0;
  const rateRaw = columns.exchangeRate === null ? "" : (row[columns.exchangeRate] ?? "").trim();
  const rate = rateRaw ? Number.parseFloat(rateRaw) : 1;
  if (!Number.isFinite(rate) || rate <= 0) return carriedCents;
  return Math.round(carriedCents * rate);
}

function findPayoutFooter(records: readonly string[][], fromIndex: number, proceedsColumnIndex: number): { amountCents: number; currency: string } | null {
  const searchLimit = Math.min(records.length, fromIndex + 10);
  for (let index = fromIndex; index < searchLimit; index++) {
    const cell = (records[index]?.[proceedsColumnIndex] ?? "").trim();
    const match = FOOTER_AMOUNT_PATTERN.exec(cell);
    if (!match) continue;
    const amountCents = parseAmountToCents(match[1]!, US_AMOUNT_FORMAT);
    if (amountCents !== null) return { amountCents, currency: match[2]! };
  }
  return null;
}

export type ApplePaymentSummaryResult = {
  /** ISO `YYYY-MM`, from the title cell's own stated reporting period. */
  period: string;
  /** The stated payout total, exact to the cent, from the footer cell - or, when the footer is
   * missing (a truncated/edited export), the sum of every region's own proceeds
   * (decisions/0048-app-store-reports.md's own documented fallback). */
  payoutAmountCents: number;
  payoutCurrency: string;
  lines: NormalizedSettlementLine[];
};

/**
 * Parses an Apple payment-summary CSV already recognized by `detectApplePaymentSummary`.
 * Deterministic: no model call, no confirmation gate (decisions/0020-universal-intake.md,
 * decision 1's rationale for a self-identifying format, extended here the same way
 * decisions/0028-mt940-support.md extended it for MT940). Throws `ApplePaymentSummaryParseError`
 * for anything a caller should have already ruled out by sniffing first, or for a title/header
 * match with no actual data rows - never a silent partial import.
 */
export function parseApplePaymentSummary(text: string): ApplePaymentSummaryResult {
  const records = parseCsv(text);
  const preamble = findPreamble(records);
  if (!preamble) {
    throw new ApplePaymentSummaryParseError(APPLE_PAYMENT_SUMMARY_ERROR.notRecognized, "Not a recognized Apple payment summary - sniff the file first.");
  }

  const dataRows: string[][] = [];
  for (let index = preamble.headerRowIndex + 1; index < records.length; index++) {
    const row = records[index] ?? [];
    if (trimRow(row).every((cell) => cell.length === 0)) break; // the blank row ending the region block
    dataRows.push(row);
  }
  if (dataRows.length === 0) {
    throw new ApplePaymentSummaryParseError(APPLE_PAYMENT_SUMMARY_ERROR.noDataRows, "Apple payment summary has no region rows.");
  }

  // Every region row's own proceeds are already stated in the bank's account currency (the
  // "Gewinn"/"Proceeds" column, converted from that region's local-currency sale by Apple's
  // own stated exchange rate) - this reader never re-derives a conversion itself.
  let proceedsSumCents = 0;
  const lines: NormalizedSettlementLine[] = dataRows.map((row, index): NormalizedSettlementLine => {
    const region = (row[preamble.columns.region] ?? "").trim() || null;
    const unitsRaw = (row[preamble.columns.units] ?? "").trim();
    const units = unitsRaw ? Number.parseInt(unitsRaw, 10) : null;
    const proceedsRaw = (row[preamble.columns.proceeds] ?? "").trim();
    const proceedsCents = parseAmountToCents(proceedsRaw, US_AMOUNT_FORMAT) ?? 0;
    proceedsSumCents += proceedsCents;
    // decisions/0054: the carried balance of a returned payout was already booked as that earlier
    // month's revenue, so only what this month newly earned becomes a line. The payout total
    // below still comes from the footer and keeps covering both.
    const earnedCents = proceedsCents - carriedInBankCurrency(row, preamble.columns);

    return {
      rowNumber: index + 1,
      bookingDate: periodEndIsoDate(preamble.period),
      grossCents: earnedCents,
      feeCents: null,
      netCents: earnedCents,
      payoutId: null,
      customerName: null,
      customerEmail: null,
      invoiceNumber: null,
      chargeId: null,
      productName: null,
      quantity: units !== null && !Number.isNaN(units) ? units : null,
      countryOfSale: region,
      description: region,
    };
  });

  const footer = findPayoutFooter(records, preamble.headerRowIndex + dataRows.length + 1, preamble.columns.proceeds);
  const bankCurrency = (dataRows[0]?.[10] ?? "").trim() || "EUR";

  return {
    period: preamble.period,
    payoutAmountCents: footer?.amountCents ?? proceedsSumCents,
    payoutCurrency: footer?.currency ?? bankCurrency,
    lines,
  };
}
