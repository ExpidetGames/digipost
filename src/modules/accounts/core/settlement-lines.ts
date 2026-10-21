// Owner: src/modules/accounts (F4, decisions/0026-platform-settlements.md). Pure reduction of
// a confirmed `payout_report`/`platform_settlement` document's normalized report rows
// (`@/modules/intake`'s `NormalizedSettlementLine`) into this module's own `SettlementLineDraft`
// - the "how a raw report row becomes clearing-account ledger entries" step, mirroring
// `core/mapping.ts`'s `mapCamt053StatementsToImportable`/`mapTabularRowsToImportable` for the
// bank-statement case. No I/O, no database - `AccountsUseCases.importSettlementReport` calls
// this after re-reading and re-parsing the document's original stored bytes.
//
// Product model (decisions/0026, fixed by the product owner): a payout/settlement report's
// rows are revenue lines (credits), fee lines (debits), and refund lines (debits) on the
// platform's ONE clearing account per workspace; the payout itself is a further debit, one per
// distinct `payoutId` in the report, later paired against the matching bank deposit
// (`transfer_group_id`) - see `accounts-use-cases.ts`'s `importSettlementReport` for that
// pairing step, which this file has no part in (it only builds the drafts).
//
// One raw row can yield UP TO TWO drafts (a charge row's `grossCents`/`feeCents` are two
// separate ledger entries: the sale itself, and the platform's cut of it) plus contributes to
// exactly one synthesized `payout` draft per `payoutId` group - never a draft of its own for
// the payout, since no single row IS the payout (Stripe's own payout-reconciliation export
// never has a dedicated "payout" row; the payout amount is the sum of every line's `netCents`
// sharing that `payoutId`, decisions/0026's own read of the F1a Stripe fixture).
import type { NormalizedSettlementLine } from "@/modules/intake";

// Deliberately this module's OWN literal type, not an import of
// `@/persistence/schema/accounts`'s equal `SettlementLineType` (STRUCTURE.md §5's `direction`
// rule forbids a module importing `@/persistence/schema/**` anyway - see that schema file's
// own header comment for why this specific module cannot instead flip the usual "module owns
// the enum, schema imports it" convention: `@/modules/accounts/core/schemas.ts` already
// imports back from `@/persistence/repositories/contracts`, so a schema-to-module edge here
// would complete a real circular import). Kept in sync by hand with the schema's own
// `SETTLEMENT_LINE_TYPES` - the same "a pure core file uses its own literal union" precedent
// this module's `ImportableTransaction.creditDebit: "credit" | "debit"` (`core/types.ts`)
// already sets for `CREDIT_DEBIT_INDICATORS`.
export type SettlementLineType = "revenue" | "fee" | "refund" | "payout" | "adjustment";

export type SettlementLineDraft = {
  type: SettlementLineType;
  /** `"<type>:row<rowNumber>"` for a row-derived draft, `"payout:<payoutId>"` for a
   * synthesized payout draft - see this file's own header comment and
   * `src/persistence/schema/accounts.ts`'s `settlementLines` table comment for why this shape
   * is deterministic and safe to re-derive on every reimport of the same document. */
  externalLineId: string;
  /** The signed amount for the corresponding `transactions` row on the clearing account:
   * positive for `revenue` (a credit), negative for `fee`/`refund`/`payout`/`adjustment` (a
   * debit) - never re-derived from `grossCents`/`feeCents`/`netCents` a second time by the
   * caller, this is the one place that decides the sign. */
  transactionAmountCents: number;
  /** What the ledger transaction's own `remittanceText` should read - the settlement line's
   * `invoiceNumber` when present (so the existing "reference/remittance text" convention keeps
   * meaning even though this transaction was never actually derived from bank remittance
   * text), falling back to the report's own free-text `description`. */
  remittanceText: string | null;
  grossCents: number | null;
  feeCents: number | null;
  netCents: number | null;
  currency: string | null;
  bookingDate: string | null;
  payoutId: string | null;
  chargeId: string | null;
  invoiceId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  productName: string | null;
  countryOfSale: string | null;
};

function rowExternalId(type: SettlementLineType, rowNumber: number): string {
  return `${type}:row${rowNumber}`;
}

/**
 * Builds every settlement-line draft a confirmed report's rows imply: a `revenue`/`refund`
 * draft for each row with a non-null `grossCents` (split by sign - `decomposeSettlement`'s own
 * "positive for a sale, negative for a refund" convention, `@/modules/payments`'s
 * `SettlementLine`), a `fee` draft for each row with a non-zero `feeCents`, and one
 * synthesized `payout` draft per distinct non-null `payoutId` (the negative sum of every
 * `netCents` sharing that id - the amount the platform actually paid out, a debit on the
 * clearing account). A row with neither `grossCents` nor `feeCents` (Apple's report has no
 * `payoutId` at all, decisions/0026's own read of the F1a fixture - every row is still a
 * `revenue`/`refund` line by its `gross`/`net` mapping) simply contributes nothing beyond
 * whatever its own fields already produce.
 */
export function buildSettlementLineDrafts(rows: readonly NormalizedSettlementLine[]): SettlementLineDraft[] {
  const drafts: SettlementLineDraft[] = [];
  const payoutGroups = new Map<string, { netCents: number; currency: string | null; bookingDate: string | null }>();

  for (const row of rows) {
    const remittanceText = row.invoiceNumber ?? row.description ?? null;

    if (row.grossCents !== null) {
      const type: SettlementLineType = row.grossCents >= 0 ? "revenue" : "refund";
      drafts.push({
        type,
        externalLineId: rowExternalId(type, row.rowNumber),
        transactionAmountCents: type === "revenue" ? row.grossCents : row.grossCents, // already negative for a refund
        remittanceText,
        grossCents: row.grossCents,
        feeCents: row.feeCents,
        netCents: row.netCents,
        currency: null,
        bookingDate: row.bookingDate,
        payoutId: row.payoutId,
        chargeId: row.chargeId,
        invoiceId: row.invoiceNumber,
        customerName: row.customerName,
        customerEmail: row.customerEmail,
        productName: row.productName,
        countryOfSale: row.countryOfSale,
      });
    }

    if (row.feeCents !== null && row.feeCents !== 0) {
      drafts.push({
        type: "fee",
        externalLineId: rowExternalId("fee", row.rowNumber),
        transactionAmountCents: -Math.abs(row.feeCents),
        remittanceText,
        grossCents: row.grossCents,
        feeCents: row.feeCents,
        netCents: row.netCents,
        currency: null,
        bookingDate: row.bookingDate,
        payoutId: row.payoutId,
        chargeId: row.chargeId,
        invoiceId: row.invoiceNumber,
        customerName: row.customerName,
        customerEmail: row.customerEmail,
        productName: row.productName,
        countryOfSale: row.countryOfSale,
      });
    }

    if (row.payoutId && row.netCents !== null) {
      const existing = payoutGroups.get(row.payoutId);
      let bookingDate = row.bookingDate ?? existing?.bookingDate ?? null;
      if (existing?.bookingDate && row.bookingDate && row.bookingDate <= existing.bookingDate) bookingDate = existing.bookingDate;
      payoutGroups.set(row.payoutId, { netCents: (existing?.netCents ?? 0) + row.netCents, currency: existing?.currency ?? null, bookingDate });
    }
  }

  for (const [payoutId, group] of payoutGroups) {
    drafts.push({
      type: "payout",
      externalLineId: `payout:${payoutId}`,
      transactionAmountCents: -group.netCents,
      remittanceText: payoutId,
      grossCents: null,
      feeCents: null,
      netCents: group.netCents,
      currency: group.currency,
      bookingDate: group.bookingDate,
      payoutId,
      chargeId: null,
      invoiceId: null,
      customerName: null,
      customerEmail: null,
      productName: null,
      countryOfSale: null,
    });
  }

  return drafts;
}
