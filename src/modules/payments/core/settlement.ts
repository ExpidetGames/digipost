// Owner: src/modules/payments (decisions/0023-payment-matching.md). F4's own pure arithmetic,
// built here rather than in a future F4-owned module because it is exactly that: arithmetic,
// with no I/O of its own, over `@/modules/intake`'s already-normalized settlement lines
// (`NormalizedSettlementLine` from `core/mapping-validator.ts`) and this module's own
// `MatchableDocument`. Product decision (F3a brief): "Platform payouts (Stripe, Apple, ...)
// are NOT matched against invoices directly; F4 decomposes them via clearing accounts" - a
// platform payout transaction (`MatchableTransaction.isPlatformPayout`) is one lump sum
// covering many individual sales, and this file is what breaks that lump sum back down into
// the individual outgoing invoices it actually paid for.
import { counterpartyNameSimilarity, findInvoiceNumbers } from "./text-signals";
import type { MatchableDocument } from "./types";

/** One line of a payout/settlement report, in this module's own shape - deliberately not a
 * re-import of `@/modules/intake/core/mapping-validator.ts`'s `NormalizedSettlementLine`:
 * that type carries several fields (`payoutId`, `chargeId`, `productName`, `quantity`,
 * `countryOfSale`, `rowNumber`) this file's arithmetic never uses, and importing it here would
 * make this module depend on `@/modules/intake`'s exact field set for fields it does not
 * need. F3b maps `NormalizedSettlementLine` into this shape at the call site - see this
 * module's own README ("Public contract for F3b"). */
export type SettlementLine = {
  /** Positive for a sale, negative for a refund - `decomposeSettlement` splits these apart by
   * sign rather than requiring a caller to pre-split them. */
  grossCents: number;
  /** Always stored as a positive magnitude regardless of the source report's own sign
   * convention - a "fee" is a cost by definition. */
  feeCents: number;
  netCents: number;
  invoiceNumber: string | null;
  /** Free text (a payout report's own "description"/"memo" column) that may embed an invoice
   * number even when no dedicated column for one exists - `matchSettlementLinesToDocuments`
   * searches this the same tolerant way `findInvoiceNumbers` searches a bank transaction's
   * remittance text. */
  description: string | null;
  customerName: string | null;
  bookingDate: string | null;
};

export type SettlementDecomposition = {
  /** Sum of every positive `grossCents` line. */
  grossCents: number;
  /** Sum of every refund (negative `grossCents`) line, as a positive magnitude. */
  refundCents: number;
  /** Sum of every line's `feeCents`. */
  feeCents: number;
  /** `grossCents - feeCents - refundCents`, computed FROM the lines - compared against
   * `payoutCents` (the amount actually paid out, from the bank transaction) to see whether
   * the report and the bank agree. */
  expectedNetCents: number;
  /** `expectedNetCents - payoutCents` - `0` when the report and the actual payout agree
   * exactly. */
  discrepancyCents: number;
  balanced: boolean;
};

/**
 * Asserts (by computing, never by throwing) that `gross - fees - refunds = net`: sums every
 * line's gross/fee/refund contribution and compares the result against the payout amount
 * actually received (`payoutCents`, the bank transaction's own amount) - a real settlement
 * report and its payout can legitimately disagree by a few cents (a currency-conversion
 * rounding difference, a fee charged in a later period) or by a lot (a report matched to the
 * wrong payout entirely), so this function reports the discrepancy rather than deciding for
 * the caller whether it is acceptable.
 */
export function decomposeSettlement(lines: readonly SettlementLine[], payoutCents: number): SettlementDecomposition {
  let grossCents = 0;
  let refundCents = 0;
  let feeCents = 0;

  for (const line of lines) {
    if (line.grossCents >= 0) grossCents += line.grossCents;
    else refundCents += -line.grossCents;
    feeCents += Math.abs(line.feeCents);
  }

  const expectedNetCents = grossCents - feeCents - refundCents;
  const discrepancyCents = expectedNetCents - payoutCents;

  return { grossCents, refundCents, feeCents, expectedNetCents, discrepancyCents, balanced: discrepancyCents === 0 };
}

export type SettlementLineMatch = {
  line: SettlementLine;
  documentId: string | null;
  matchRule: "invoice_number" | "customer_amount_date" | null;
};

const CUSTOMER_NAME_MATCH_THRESHOLD = 0.4;
const CUSTOMER_AMOUNT_DATE_WINDOW_DAYS = 14;

function daysBetween(dateA: string, dateB: string): number {
  return Math.round((new Date(dateA).getTime() - new Date(dateB).getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * Matches each settlement line to at most one of `outgoingDocuments`, invoice number first
 * (an exact `invoiceNumber` match, or the line's own `description` text naming one of the
 * documents' invoice numbers - "in metadata/description first", F3a brief), falling back to
 * customer name + amount + date proximity only when no invoice number match was found. A line
 * matching neither has `documentId: null` - never a guessed match with no real evidence.
 * `outgoingDocuments` is expected to already be filtered to `direction: "outgoing"` by the
 * caller (a platform settlement only ever pays for the workspace's own outgoing sales).
 */
export function matchSettlementLinesToDocuments(lines: readonly SettlementLine[], outgoingDocuments: readonly MatchableDocument[]): SettlementLineMatch[] {
  const withInvoiceNumbers = outgoingDocuments.filter((doc): doc is MatchableDocument & { invoiceNumber: string } => doc.invoiceNumber !== null);

  return lines.map((line) => {
    const byInvoiceNumber = withInvoiceNumbers.find((doc) => {
      if (line.invoiceNumber && findInvoiceNumbers(line.invoiceNumber, [doc.invoiceNumber]).length > 0) return true;
      if (line.description && findInvoiceNumbers(line.description, [doc.invoiceNumber]).length > 0) return true;
      return false;
    });
    if (byInvoiceNumber) return { line, documentId: byInvoiceNumber.id, matchRule: "invoice_number" as const };

    const byCustomerAmountDate = outgoingDocuments.find((doc) => {
      const nameOk = counterpartyNameSimilarity(line.customerName, doc.contactName) >= CUSTOMER_NAME_MATCH_THRESHOLD;
      const amountOk = doc.totalAmountCents === line.grossCents;
      const dateOk = line.bookingDate === null || doc.documentDate === null || Math.abs(daysBetween(doc.documentDate, line.bookingDate)) <= CUSTOMER_AMOUNT_DATE_WINDOW_DAYS;
      return nameOk && amountOk && dateOk;
    });
    if (byCustomerAmountDate) return { line, documentId: byCustomerAmountDate.id, matchRule: "customer_amount_date" as const };

    return { line, documentId: null, matchRule: null };
  });
}
