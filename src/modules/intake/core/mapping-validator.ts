// "The code verifies" half of decisions/0020-universal-intake.md's "AI proposes, code
// verifies" principle, for tabular sources: applies a (model-proposed, already
// column-existence-checked by `parseIntakeClassification`) mapping to every row of the
// source, never just the sample, and either returns fully normalized rows or a precise list
// of per-row problems. Nothing financial is ever produced from a mapping that fails any of
// these checks - `validateMapping` is deliberately strict, not best-effort.
import { detectAmountFormat, parseAmountToCents, type AmountFormat } from "./amount-parsing";
import type { AmountSign, ColumnMapping, SemanticField } from "./classification";
import { computeIdempotencyKeyV2, normalizeReference, OccurrenceCounter } from "./idempotency-key";
import type { TabularSample } from "./tabular-sample";

export type MappingProblemCode =
  | "missing_required_column"
  | "unparseable_date"
  | "unparseable_amount"
  | "inconsistent_sign"
  | "reconciliation_mismatch";

export type MappingProblem = {
  /** 1-based data row number (the header is row 0 and never appears here). */
  rowNumber: number;
  field: SemanticField | "amountSign" | "totals";
  code: MappingProblemCode;
  message: string;
};

export type NormalizedBankTransactionFromMapping = {
  rowNumber: number;
  /** v2 algorithm (`idempotency-key.ts`), same as `camt053-parser.ts`'s: a composite of every
   * discriminator a confirmed tabular mapping can actually provide - booking date, value
   * date, signed amount cents, currency, credit/debit, normalized EndToEndId, normalized
   * reference/description, counterpartyIban, in exactly that order (`tabularIdempotencyKeyFields`
   * below) - never "the first non-empty reference" (R2's fix; see `idempotency-key.ts`'s own
   * header for the full rationale). No own-account IBAN, `AcctSvcrRef`, `NtryRef`, bank
   * transaction code, or mandate id: `SEMANTIC_FIELDS` (decisions/0020) has no such columns
   * for a tabular source, so this composite is deliberately shorter than camt.053's. */
  idempotencyKey: string;
  bookingDate: string;
  valueDate: string | null;
  amountCents: number;
  creditDebit: "credit" | "debit";
  currency: string | null;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  reference: string | null;
  endToEndId: string | null;
};

export type NormalizedSettlementLine = {
  rowNumber: number;
  bookingDate: string | null;
  grossCents: number | null;
  feeCents: number | null;
  netCents: number | null;
  payoutId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  invoiceNumber: string | null;
  chargeId: string | null;
  productName: string | null;
  quantity: number | null;
  countryOfSale: string | null;
  /** F4 (decisions/0026-platform-settlements.md): the mapped `description` column, when the
   * source has one - a report with no dedicated `invoiceNumber` column may still embed one in
   * free text here (e.g. "Rechnung RE-2026-1001"), the same "in metadata/description first"
   * product rule `@/modules/payments`'s `matchSettlementLinesToDocuments` already documents
   * for its own fallback search. Added alongside the original six fields this branch already
   * populated - `SEMANTIC_FIELDS` already had `description` (F1a), this branch simply did not
   * read it yet. */
  description: string | null;
};

export type ValidateMappingResult =
  | { ok: true; kind: "bank_transactions"; transactions: NormalizedBankTransactionFromMapping[] }
  | { ok: true; kind: "settlement_lines"; lines: NormalizedSettlementLine[] }
  | { ok: false; problems: MappingProblem[] };

export type ValidateMappingOptions = {
  /** When the source itself states an expected total (a statement's closing-minus-opening
   * balance, a payout report's declared total), passing it here adds a "does the mapped data
   * actually sum to this" check - skipped entirely when omitted, since most tabular formats
   * (payout/settlement CSVs in particular) carry no such total at all. */
  expectedTotalCents?: number;
};

function columnIndex(header: readonly string[], column: string): number {
  return header.indexOf(column);
}

function cellFor(row: readonly string[], header: readonly string[], mapping: ColumnMapping, field: SemanticField): string | null {
  const column = mapping[field];
  if (!column) return null;
  const index = columnIndex(header, column);
  if (index === -1 || index >= row.length) return null;
  const value = row[index];
  return value !== undefined && value.trim().length > 0 ? value.trim() : null;
}

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/;
const GERMAN_DATE_PATTERN = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;
const US_SLASH_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/** Converts a date cell to ISO `YYYY-MM-DD`, or `null` when it matches none of the three
 * shapes `tabular-sample.ts` can detect. A bare `MM/DD/YYYY` slash date is assumed (never
 * `DD/MM/YYYY`) - this application's known tabular sources (Stripe/Apple exports) that use
 * slash dates are always US-formatted; a European slash-dated source would need this
 * disambiguated some other way, a documented limitation rather than a guess. */
function parseDateToIso(value: string): string | null {
  const isoMatch = ISO_DATE_PATTERN.exec(value);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const germanMatch = GERMAN_DATE_PATTERN.exec(value);
  if (germanMatch) return `${germanMatch[3]}-${germanMatch[2]!.padStart(2, "0")}-${germanMatch[1]!.padStart(2, "0")}`;
  const usMatch = US_SLASH_DATE_PATTERN.exec(value);
  if (usMatch) return `${usMatch[3]}-${usMatch[1]!.padStart(2, "0")}-${usMatch[2]!.padStart(2, "0")}`;
  return null;
}

/**
 * The v2 composite field order for a tabular (mapped) bank transaction row - shorter than
 * camt.053's own field list (`camt053IdempotencyKeyFields` in `camt053-parser.ts`) because a
 * confirmed column mapping cannot provide an own-account IBAN, `AcctSvcrRef`, `NtryRef`, a
 * bank transaction code, or a mandate id (decisions/0020's closed `SEMANTIC_FIELDS`
 * vocabulary has no such fields): booking date, value date, signed amount cents, currency,
 * credit/debit, normalized EndToEndId, normalized reference/description, counterparty IBAN.
 */
function tabularIdempotencyKeyFields(tx: {
  bookingDate: string;
  valueDate: string | null;
  amountCents: number;
  currency: string | null;
  creditDebit: "credit" | "debit";
  endToEndId: string | null;
  reference: string | null;
  counterpartyIban: string | null;
}): (string | number | null)[] {
  return [
    tx.bookingDate,
    tx.valueDate,
    tx.amountCents,
    tx.currency,
    tx.creditDebit,
    normalizeReference(tx.endToEndId),
    normalizeReference(tx.reference),
    normalizeReference(tx.counterpartyIban),
  ];
}

/** Determines the amount format to use for a mapped column: detects it fresh from every
 * value actually present across the full data set (more reliable than the 10-row sample's
 * own guess), falling back to plain-point when nothing in the column matches any known
 * shape (e.g. a column of whole-euro integers with no decimal separator at all). */
function resolveAmountFormat(values: string[]): AmountFormat {
  return detectAmountFormat(values) ?? { decimalSeparator: ".", thousandsSeparator: null };
}

function collectColumnValues(rows: readonly (readonly string[])[], header: readonly string[], column: string): string[] {
  const index = columnIndex(header, column);
  if (index === -1) return [];
  return rows.map((row) => row[index] ?? "").filter((value) => value.trim().length > 0);
}

// F4 (decisions/0026-platform-settlements.md) fix: `bookingDate` alone used to be sufficient
// to call a mapping "bank-shape", but `bookingDate` is a field BOTH shapes can map - a
// settlement/payout report has one too (Stripe's own real classifier mapping maps
// `created_utc` to it, `@/modules/intake/core/fake-intake-classifier.ts`'s "stripe-payout"
// rule), and that rule ALSO maps `gross`/`fee`/`net`/`payoutId`/`chargeId` - fields no bank
// mapping in this codebase ever maps. `amount`/`creditDebit` remain a sufficient bank-shape
// signal on their own (every bank-mapping rule maps at least one); `bookingDate` alone is
// still accepted as a fallback (a bank mapping using `separate_credit_debit_columns`/
// `indicator_column` mode maps neither `amount` nor `creditDebit` directly, only via
// `amountSign`) but ONLY when no settlement-specific field is present alongside it - which is
// exactly the discriminator this shape actually needs.
function isBankTransactionMapping(mapping: ColumnMapping): boolean {
  if (mapping.amount || mapping.creditDebit) return true;
  const hasSettlementField = Boolean(mapping.gross || mapping.fee || mapping.net || mapping.payoutId || mapping.chargeId);
  return Boolean(mapping.bookingDate) && !hasSettlementField;
}

/**
 * Applies `mapping` (and, for a signed-amount decision, `amountSign`) to every row of
 * `fullRowsIterator` - the whole source, not just `sample`'s 10-row preview. Every date must
 * parse, every mapped amount must parse, the sign semantics `amountSign` describes must hold
 * for every row, and (only when `options.expectedTotalCents` is given) the mapped amounts
 * must sum to it. Any single problem anywhere makes the whole result `{ ok: false }` - this
 * is the strict "code verifies" gate before anything financial is ever persisted.
 */
export function validateMapping(
  sample: TabularSample,
  fullRowsIterator: Iterable<readonly string[]>,
  mapping: ColumnMapping,
  amountSign: AmountSign | null,
  options: ValidateMappingOptions = {},
): ValidateMappingResult {
  const header = sample.header;
  const rows = Array.from(fullRowsIterator);
  const problems: MappingProblem[] = [];

  const bankShape = isBankTransactionMapping(mapping);
  // One `OccurrenceCounter` per `validateMapping` call (i.e. per file): disambiguation of a
  // fully-identical composite (`idempotency-key.ts`) is only meaningful, and only
  // deterministic, within the boundary of one file.
  const occurrenceCounter = new OccurrenceCounter();

  // Pre-resolve an amount format per referenced amount-bearing column, once, from the full
  // column of values rather than per row.
  const amountColumns = new Set<string>();
  if (mapping.amount) amountColumns.add(mapping.amount);
  if (mapping.gross) amountColumns.add(mapping.gross);
  if (mapping.fee) amountColumns.add(mapping.fee);
  if (mapping.net) amountColumns.add(mapping.net);
  if (amountSign?.mode === "signed_column") amountColumns.add(amountSign.column);
  if (amountSign?.mode === "separate_credit_debit_columns") {
    amountColumns.add(amountSign.creditColumn);
    amountColumns.add(amountSign.debitColumn);
  }
  if (amountSign?.mode === "indicator_column") amountColumns.add(amountSign.amountColumn);

  const amountFormatByColumn = new Map<string, AmountFormat>();
  for (const column of amountColumns) {
    amountFormatByColumn.set(column, resolveAmountFormat(collectColumnValues(rows, header, column)));
  }

  function parseAmountColumn(column: string, rowNumber: number, field: MappingProblem["field"], row: readonly string[]): number | null {
    const index = columnIndex(header, column);
    const raw = index === -1 ? undefined : row[index];
    if (raw === undefined || raw.trim().length === 0) return null;
    const format = amountFormatByColumn.get(column)!;
    const cents = parseAmountToCents(raw, format);
    if (cents === null) {
      problems.push({ rowNumber, field, code: "unparseable_amount", message: `Spalte "${column}" enthält keinen gültigen Betrag: "${raw}"` });
    }
    return cents;
  }

  function resolveSignedAmount(rowNumber: number, row: readonly string[]): { amountCents: number; creditDebit: "credit" | "debit" } | null {
    if (!amountSign) {
      const cents = mapping.amount ? parseAmountColumn(mapping.amount, rowNumber, "amount", row) : null;
      if (cents === null) return null;
      return { amountCents: cents, creditDebit: cents < 0 ? "debit" : "credit" };
    }
    if (amountSign.mode === "signed_column") {
      const cents = parseAmountColumn(amountSign.column, rowNumber, "amount", row);
      if (cents === null) return null;
      return { amountCents: cents, creditDebit: cents < 0 ? "debit" : "credit" };
    }
    if (amountSign.mode === "separate_credit_debit_columns") {
      const creditIndex = columnIndex(header, amountSign.creditColumn);
      const debitIndex = columnIndex(header, amountSign.debitColumn);
      const creditRaw = creditIndex === -1 ? "" : (row[creditIndex] ?? "").trim();
      const debitRaw = debitIndex === -1 ? "" : (row[debitIndex] ?? "").trim();
      const hasCredit = creditRaw.length > 0;
      const hasDebit = debitRaw.length > 0;
      if (hasCredit === hasDebit) {
        problems.push({
          rowNumber,
          field: "amountSign",
          code: "inconsistent_sign",
          message: `Genau eine der Spalten "${amountSign.creditColumn}"/"${amountSign.debitColumn}" muss befüllt sein, nicht ${hasCredit ? "beide" : "keine"}.`,
        });
        return null;
      }
      const column = hasCredit ? amountSign.creditColumn : amountSign.debitColumn;
      const cents = parseAmountColumn(column, rowNumber, "amount", row);
      if (cents === null) return null;
      const magnitude = Math.abs(cents);
      return { amountCents: hasCredit ? magnitude : -magnitude, creditDebit: hasCredit ? "credit" : "debit" };
    }
    // indicator_column
    const indicatorIndex = columnIndex(header, amountSign.indicatorColumn);
    const indicatorValue = (indicatorIndex === -1 ? "" : (row[indicatorIndex] ?? "")).trim();
    const isCredit = indicatorValue.toLowerCase() === amountSign.creditValue.toLowerCase();
    const isDebit = indicatorValue.toLowerCase() === amountSign.debitValue.toLowerCase();
    if (!isCredit && !isDebit) {
      problems.push({
        rowNumber,
        field: "amountSign",
        code: "inconsistent_sign",
        message: `Spalte "${amountSign.indicatorColumn}" enthält weder "${amountSign.creditValue}" noch "${amountSign.debitValue}": "${indicatorValue}"`,
      });
      return null;
    }
    const cents = parseAmountColumn(amountSign.amountColumn, rowNumber, "amount", row);
    if (cents === null) return null;
    const magnitude = Math.abs(cents);
    return { amountCents: isCredit ? magnitude : -magnitude, creditDebit: isCredit ? "credit" : "debit" };
  }

  const transactions: NormalizedBankTransactionFromMapping[] = [];
  const lines: NormalizedSettlementLine[] = [];

  rows.forEach((row, index) => {
    const rowNumber = index + 1;

    if (bankShape) {
      const bookingDateRaw = cellFor(row, header, mapping, "bookingDate");
      if (!bookingDateRaw) {
        problems.push({ rowNumber, field: "bookingDate", code: "missing_required_column", message: "Buchungsdatum fehlt in dieser Zeile." });
        return;
      }
      const bookingDate = parseDateToIso(bookingDateRaw);
      if (!bookingDate) {
        problems.push({ rowNumber, field: "bookingDate", code: "unparseable_date", message: `Buchungsdatum nicht lesbar: "${bookingDateRaw}"` });
        return;
      }
      const valueDateRaw = cellFor(row, header, mapping, "valueDate");
      const valueDate = valueDateRaw ? parseDateToIso(valueDateRaw) : null;
      if (valueDateRaw && !valueDate) {
        problems.push({ rowNumber, field: "valueDate", code: "unparseable_date", message: `Valutadatum nicht lesbar: "${valueDateRaw}"` });
      }

      const signed = resolveSignedAmount(rowNumber, row);
      if (!signed) return;

      const currency = cellFor(row, header, mapping, "currency");
      const counterpartyName = cellFor(row, header, mapping, "counterpartyName");
      const counterpartyIban = cellFor(row, header, mapping, "counterpartyIban");
      const reference = cellFor(row, header, mapping, "reference") ?? cellFor(row, header, mapping, "description");
      const endToEndId = cellFor(row, header, mapping, "endToEndId");

      const idempotencyKeyFields = tabularIdempotencyKeyFields({
        bookingDate,
        valueDate,
        amountCents: signed.amountCents,
        currency,
        creditDebit: signed.creditDebit,
        endToEndId,
        reference,
        counterpartyIban,
      });

      transactions.push({
        rowNumber,
        idempotencyKey: computeIdempotencyKeyV2(idempotencyKeyFields, occurrenceCounter.next(idempotencyKeyFields)),
        bookingDate,
        valueDate,
        amountCents: signed.amountCents,
        creditDebit: signed.creditDebit,
        currency,
        counterpartyName,
        counterpartyIban,
        reference,
        endToEndId,
      });
      return;
    }

    // Settlement/payout report shape.
    const bookingDateRaw = cellFor(row, header, mapping, "bookingDate");
    const bookingDate = bookingDateRaw ? parseDateToIso(bookingDateRaw) : null;
    if (bookingDateRaw && !bookingDate) {
      problems.push({ rowNumber, field: "bookingDate", code: "unparseable_date", message: `Datum nicht lesbar: "${bookingDateRaw}"` });
    }

    // F4 (decisions/0026-platform-settlements.md): unlike a bank-shape row, a settlement-line
    // row never runs through `resolveSignedAmount` at all - `gross`/`fee`/`net` are three
    // INDEPENDENTLY mapped columns, not one signed amount. A source whose sale/refund rows
    // literally carry a `-` in the text (Stripe's own CSV export) already parses correctly
    // with no help needed. A source that instead encodes the sign via a SEPARATE indicator
    // column (Apple's "Sales or Return" S/R, `amountSign.mode === "indicator_column"`) does
    // not: `parseAmountColumn` alone would read every row's `gross`/`net` as positive,
    // silently importing a return as if it were a sale. `rowSign` reads that indicator ONCE
    // per row and is applied to every monetary column this row carries - an indicator-column
    // source describes the ROW's own direction (one full sale or one full return), not a
    // property of one specific named column the way `signed_column`/
    // `separate_credit_debit_columns` do (those two modes are left alone here: a report using
    // either already has its sign literally in the text of whichever single column they
    // designate, so applying anything on top would double-flip it).
    function rowSign(): 1 | -1 | null {
      if (!amountSign || amountSign.mode !== "indicator_column") return null;
      const indicatorIndex = columnIndex(header, amountSign.indicatorColumn);
      const indicatorRaw = (indicatorIndex === -1 ? "" : (row[indicatorIndex] ?? "")).trim();
      if (indicatorRaw.toLowerCase() === amountSign.debitValue.toLowerCase()) return -1;
      if (indicatorRaw.toLowerCase() === amountSign.creditValue.toLowerCase()) return 1;
      return null;
    }
    const sign = rowSign();

    function applyRowSign(cents: number | null): number | null {
      return cents === null || sign === null ? cents : sign * Math.abs(cents);
    }

    const grossCents = mapping.gross ? applyRowSign(parseAmountColumn(mapping.gross, rowNumber, "gross", row)) : null;
    const feeCents = mapping.fee ? parseAmountColumn(mapping.fee, rowNumber, "fee", row) : null;
    const netCents = mapping.net ? applyRowSign(parseAmountColumn(mapping.net, rowNumber, "net", row)) : null;

    const quantityRaw = cellFor(row, header, mapping, "quantity");
    const quantity = quantityRaw ? Number.parseInt(quantityRaw, 10) : null;
    if (quantityRaw && Number.isNaN(quantity)) {
      problems.push({ rowNumber, field: "quantity", code: "unparseable_amount", message: `Menge nicht lesbar: "${quantityRaw}"` });
    }

    lines.push({
      rowNumber,
      bookingDate,
      grossCents,
      feeCents,
      netCents,
      payoutId: cellFor(row, header, mapping, "payoutId"),
      customerName: cellFor(row, header, mapping, "customerName"),
      customerEmail: cellFor(row, header, mapping, "customerEmail"),
      invoiceNumber: cellFor(row, header, mapping, "invoiceNumber"),
      chargeId: cellFor(row, header, mapping, "chargeId"),
      productName: cellFor(row, header, mapping, "productName"),
      quantity: quantity && !Number.isNaN(quantity) ? quantity : null,
      countryOfSale: cellFor(row, header, mapping, "countryOfSale"),
      description: cellFor(row, header, mapping, "description"),
    });
  });

  if (problems.length > 0) return { ok: false, problems };

  if (options.expectedTotalCents !== undefined) {
    const actualTotal = bankShape
      ? transactions.reduce((sum, tx) => sum + tx.amountCents, 0)
      : lines.reduce((sum, line) => sum + (line.netCents ?? 0), 0);
    if (actualTotal !== options.expectedTotalCents) {
      return {
        ok: false,
        problems: [
          {
            rowNumber: 0,
            field: "totals",
            code: "reconciliation_mismatch",
            message: `Die Summe der Beträge (${actualTotal} Cent) entspricht nicht dem erwarteten Gesamtbetrag (${options.expectedTotalCents} Cent).`,
          },
        ],
      };
    }
  }

  return bankShape ? { ok: true, kind: "bank_transactions", transactions } : { ok: true, kind: "settlement_lines", lines };
}
