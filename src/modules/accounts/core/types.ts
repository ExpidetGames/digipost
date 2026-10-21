// Owner: src/modules/accounts (F2, decisions/0024-accounts-and-transactions.md). Pure types
// shared by this module's mapping/reconciliation logic and the persistence use case.

/** The common shape both non-OCR bank-statement intake branches (camt.053 and a confirmed
 * tabular mapping, `@/modules/intake`) are reduced to before insertion - everything
 * `transactions` needs a value for, `idempotencyKey` taken verbatim from the intake module. */
export type ImportableTransaction = {
  idempotencyKey: string;
  bookingDate: string;
  valueDate: string | null;
  amountCents: number;
  creditDebit: "credit" | "debit";
  currency: string | null;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  counterpartyBic: string | null;
  remittanceText: string | null;
  endToEndId: string | null;
  mandateId: string | null;
  creditorId: string | null;
  bankTxCode: string | null;
  bankReference: string | null;
  /** The source intake object, verbatim - stored as-is in `transactions.raw`. */
  raw: unknown;
};

/** One resolved "statement" worth of transactions plus whatever balance/date-range
 * information the source carries - a camt.053 statement carries all of it; a confirmed
 * tabular mapping carries only the transactions themselves (`@/modules/intake`'s
 * `SEMANTIC_FIELDS` has no own-account-IBAN or balance fields at all, decisions/0024's
 * "Tabular sources never carry an own-account IBAN" section). */
export type ImportableStatement = {
  /** `null` when the source carries no own-account IBAN (every tabular/CSV source, and a
   * camt.053 statement whose own `Acct/Id` used a non-IBAN identifier). */
  accountIban: string | null;
  currency: string | null;
  openingBalanceCents: number | null;
  closingBalanceCents: number | null;
  transactions: ImportableTransaction[];
};

export type ImportOutcome =
  | { status: "pending_account"; reason: "missing_iban" }
  | {
      status: "imported";
      accountId: string;
      accountCreated: boolean;
      batchId: string;
      rowsTotal: number;
      rowsImported: number;
      rowsDuplicate: number;
      balanceMismatch: boolean;
    }
  | {
      /** F4 (decisions/0026-platform-settlements.md): a confirmed `payout_report`/
       * `platform_settlement` document imported into its platform's clearing account - no
       * `import_batches` row (that table's `balanceMismatch`/statement-range shape is specific
       * to a bank statement; a settlement report reconciles via `decomposeSettlement` instead,
       * computed at read time by the payments read-model, never persisted here). */
      status: "settlement_imported";
      accountId: string;
      accountCreated: boolean;
      linesTotal: number;
      linesImported: number;
      linesDuplicate: number;
    };
