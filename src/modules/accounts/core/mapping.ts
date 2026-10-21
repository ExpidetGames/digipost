// Owner: src/modules/accounts (F2). Pure reduction of the two non-OCR bank-statement intake
// shapes (`@/modules/intake`'s `Camt053Statement[]`/`NormalizedBankTransactionFromMapping[]`)
// into this module's own `ImportableStatement`/`ImportableTransaction` (decisions/0024-accounts-and-transactions.md).
// No I/O, no database - the import use case calls these after re-reading and re-parsing the
// document's original stored bytes (never trusting the possibly-truncated `documents.intake_result`
// summary for anything beyond deciding which branch to take, mirroring
// `documents-use-cases.ts`'s own `confirmIntake` re-read pattern).
import type { Camt053Statement } from "@/modules/intake";
import type { NormalizedBankTransactionFromMapping } from "@/modules/intake";

import { computeBalanceMismatch } from "./reconciliation";
import type { ImportableStatement, ImportableTransaction } from "./types";

export function mapCamt053StatementsToImportable(statements: Camt053Statement[]): ImportableStatement[] {
  return statements.map((statement) => ({
    accountIban: statement.accountIban,
    currency: statement.currency,
    openingBalanceCents: statement.openingBalance?.amountCents ?? null,
    closingBalanceCents: statement.closingBalance?.amountCents ?? null,
    transactions: statement.transactions.map(
      (tx): ImportableTransaction => ({
        idempotencyKey: tx.idempotencyKey,
        bookingDate: tx.bookingDate,
        valueDate: tx.valueDate,
        amountCents: tx.amountCents,
        creditDebit: tx.creditDebit,
        currency: tx.currency,
        counterpartyName: tx.counterpartyName,
        counterpartyIban: tx.counterpartyIban,
        counterpartyBic: tx.counterpartyBic,
        remittanceText: tx.remittanceInformation,
        endToEndId: tx.endToEndId,
        mandateId: tx.mandateId,
        creditorId: tx.creditorId,
        bankTxCode: tx.bankTransactionCode,
        bankReference: tx.accountServicerReference ?? tx.entryReference,
        raw: tx,
      }),
    ),
  }));
}

/** A confirmed tabular mapping never carries an own-account IBAN or balance data at all
 * (`@/modules/intake`'s `SEMANTIC_FIELDS` has no such field, decisions/0024's "Tabular sources
 * never carry an own-account IBAN" section) - every CSV/TSV bank-statement import is exactly
 * one `ImportableStatement` with `accountIban: null`, requiring the caller to pass an explicit
 * `accountId` (the "pending account" flow). */
export function mapTabularRowsToImportable(rows: NormalizedBankTransactionFromMapping[]): ImportableStatement {
  return {
    accountIban: null,
    currency: rows[0]?.currency ?? null,
    openingBalanceCents: null,
    closingBalanceCents: null,
    transactions: rows.map(
      (row): ImportableTransaction => ({
        idempotencyKey: row.idempotencyKey,
        bookingDate: row.bookingDate,
        valueDate: row.valueDate,
        amountCents: row.amountCents,
        creditDebit: row.creditDebit,
        currency: row.currency,
        counterpartyName: row.counterpartyName,
        counterpartyIban: row.counterpartyIban,
        counterpartyBic: null,
        remittanceText: row.reference,
        endToEndId: row.endToEndId,
        mandateId: null,
        creditorId: null,
        bankTxCode: null,
        bankReference: null,
        raw: row,
      }),
    ),
  };
}

/** The statement-range/balance summary `import_batches` needs for a set of statements that
 * all resolved to the SAME account (decisions/0024's "one batch per document" design): the
 * earliest booking date across every transaction as `statementFrom`, the latest as
 * `statementTo`, the first (by booking-date order) statement's opening balance and the last's
 * closing balance - a documented simplification for the rare multi-statement-same-account
 * file (a single-statement file, the overwhelming common case, has exactly one value for
 * each). */
export function summarizeStatementsForBatch(statements: ImportableStatement[]): {
  statementFrom: string | null;
  statementTo: string | null;
  openingBalanceCents: number | null;
  closingBalanceCents: number | null;
  balanceMismatch: boolean;
} {
  const allTransactions = statements.flatMap((s) => s.transactions);
  const bookingDates = allTransactions.map((tx) => tx.bookingDate).sort();
  const statementFrom = bookingDates[0] ?? null;
  const statementTo = bookingDates.at(-1) ?? null;

  const withOpening = statements.find((s) => s.openingBalanceCents !== null);
  const withClosing = [...statements].reverse().find((s) => s.closingBalanceCents !== null);

  const balanceMismatch = statements.some((statement) =>
    computeBalanceMismatch({
      openingBalanceCents: statement.openingBalanceCents,
      closingBalanceCents: statement.closingBalanceCents,
      transactionAmountCents: statement.transactions.map((tx) => tx.amountCents),
    }),
  );

  return {
    statementFrom,
    statementTo,
    openingBalanceCents: withOpening?.openingBalanceCents ?? null,
    closingBalanceCents: withClosing?.closingBalanceCents ?? null,
    balanceMismatch,
  };
}
